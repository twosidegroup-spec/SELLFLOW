param(
  [switch]$Recreate
)

# Applies the full migration set to the local verification database and then runs
# the functional test suite. This is the single command to run after any database
# change -- `npm run db:verify`.
#
# Error handling is explicit rather than exception-based: psql writes NOTICE and
# error text to stderr, which PowerShell would otherwise surface as terminating
# errors even on a fully successful run.
$ErrorActionPreference = 'Continue'

$container = 'sellflow-pg'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-Psql {
  param([string]$Sql, [string[]]$Files = @())
  $args = @('exec', '-i', $container, 'psql', '-U', 'postgres', '-d', 'sellflow', '-v', 'ON_ERROR_STOP=1', '-f', '-')
  if ($Files.Count -gt 0) {
    $content = ($Files | ForEach-Object { Get-Content -LiteralPath $_ -Raw }) -join "`n"
    $content | docker @args 2>&1
  } else {
    $Sql | docker @args 2>&1
  }
}

if ($Recreate) {
  docker rm -f $container 2>&1 | Out-Null
  docker run -d --name $container -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sellflow -p 55432:5432 postgres:16-alpine | Out-Null
  Start-Sleep -Seconds 12
  docker exec $container pg_isready -U postgres | Out-Null
  Write-Host "Database container ready."
}

Write-Host "`nApplying migrations..."
docker exec $container psql -U postgres -d sellflow -c "drop schema public cascade; create schema public; grant all on schema public to postgres; grant all on schema public to public;" 2>&1 | Out-String | Out-Null

Invoke-Psql -Files @((Join-Path $root 'supabase/test/auth_shim.sql')) | Out-Null

$failed = $false
foreach ($file in (Get-ChildItem (Join-Path $root 'supabase/migrations/*.sql') | Sort-Object Name)) {
  $out = Invoke-Psql -Files @($file.FullName)
  if ($out | Select-String -Pattern 'ERROR|FATAL') {
    $failed = $true
    Write-Host "  FAILED $($file.Name)" -ForegroundColor Red
    $out | Select-String 'ERROR|FATAL' -Context 1, 2 | ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host "  ok  $($file.Name)"
  }
}

if ($failed) { exit 1 }

Write-Host "`nRunning functional tests..."
$failed = $false
foreach ($suite in @('verify.sql', 'verify_courier.sql', 'verify_ops.sql')) {
  $path = Join-Path $root "supabase/test/$suite"
  if (-not (Test-Path -LiteralPath $path)) { continue }

  Write-Host "  $suite"
  $out = Invoke-Psql -Files @($path)
  if ($out | Select-String -Pattern 'ERROR|FATAL') {
    $failed = $true
    $out | Select-String 'ERROR|FATAL' -Context 2, 4 | ForEach-Object { Write-Host "    $_" }
  }
}

if ($failed) { exit 1 }
Write-Host "  All SellFlow database checks passed." -ForegroundColor Green
