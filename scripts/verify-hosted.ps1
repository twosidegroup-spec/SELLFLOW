# Runs SellFlow's verification suites against the LINKED HOSTED Supabase project
# via `supabase test db --linked`, which is the only authenticated SQL path
# available (the database password is not on this machine).
#
# Two things make this safe enough to point at production:
#
#   * Every suite included here wraps itself in `begin; ... rollback;`.
#     verify_concurrency.sql is EXCLUDED because it commits fixtures by design
#     and creates the dblink extension.
#   * Hosted has no pgTAP extension, so each suite is wrapped in hand-written TAP
#     output (a plan line and a single `ok`). If a suite raises, psql exits
#     non-zero and the `ok` is never printed, so pg_prove fails it.
#
# The session timezone is pinned to Asia/Dhaka to match the local runner.
# A final leak check proves nothing was committed.

[CmdletBinding()]
param(
    [string]$SuiteDir = 'supabase/test',
    [string]$WorkDir  = "$env:TEMP\sellflow-hosted-verify"
)

$ErrorActionPreference = 'Stop'

# Pinned for comparability with `npm run db:test`.
$timezone = 'Asia/Dhaka'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Get-ChildItem $WorkDir -Filter '*.sql' -ErrorAction SilentlyContinue | Remove-Item -Force

# Suites that must never run against a live project.
$excluded = @{
    'verify_concurrency.sql' = 'commits fixtures by design and creates the dblink extension'
}

$files = @()
$blocked = @()

foreach ($suite in (Get-ChildItem $SuiteDir -Filter 'verify*.sql' | Sort-Object Name)) {
    if ($excluded.ContainsKey($suite.Name)) {
        Write-Output ("  EXCLUDE  {0,-30} {1}" -f $suite.Name, $excluded[$suite.Name])
        continue
    }

    $text = Get-Content $suite.FullName -Raw

    # Refuse anything that could escape the transaction.
    if ($text -match '(?m)^\s*commit\s*;' -or $text -match 'create\s+extension' -or
        $text -notmatch '(?m)^\s*begin\s*;' -or $text -notmatch '(?m)^\s*rollback\s*;') {
        Write-Output ("  REFUSE   {0,-30} not provably transactional" -f $suite.Name)
        continue
    }

    # Behavioural suites need a test user. Supabase's CLI login role cannot write
    # the auth schema, and profiles -> auth.users is a foreign key, so no fixture
    # can be created. Those suites are verified locally against byte-identical
    # migrations; only read-only contracts can be checked on hosted.
    if ($text -match '(?i)insert\s+into\s+auth\.users') {
        $blocked += $suite.Name
        Write-Output ("  HOSTED-SKIP {0,-26} needs auth.users fixtures; CLI role cannot write auth" -f $suite.Name)
        continue
    }

    # Keep \set (it carries ON_ERROR_STOP), drop \echo (stray output breaks TAP),
    # and drop any TAP lines the suite emits itself. This wrapper owns the TAP
    # stream: two plan lines, or two `ok` lines, is a parse error.
    $body = foreach ($line in (Get-Content $suite.FullName)) {
        if ($line -match '^\s*\\echo') { continue }
        if ($line -match "^\s*select\s+'1\.\.1'\s*;") { continue }
        if ($line -match "^\s*select\s+'ok\s") { continue }
        $line
    }

    $wrapper = @(
        "`set timezone = '$timezone';"
        "select '1..1';"
        ($body -join "`n")
        "select 'ok 1 - $($suite.Name)';"
    ) -join "`n"

    $target = Join-Path $WorkDir $suite.Name
    Set-Content -Path $target -Value $wrapper -Encoding utf8
    $files += $target
    Write-Output ("  STAGED   {0,-30} transactional, wrapped for TAP" -f $suite.Name)
}

# Leak check.
#
# pg_stat_user_tables is used rather than counting rows, because 0024 revoked
# SELECT on the payment tables from every role this test connects as -- so a
# row count is not merely inconvenient, it is impossible. Cumulative
# insert/update/delete counters are readable from the catalog and are a
# STRONGER signal anyway: they stay at zero unless a row was ever written,
# whereas a count of zero cannot distinguish "empty" from "unreadable".
$leak = @'
\set ON_ERROR_STOP on
select '1..1';
do $probe$
declare
  v_writes text;
begin
  select string_agg(
           s.relname || '(ins=' || coalesce(t.n_tup_ins::text, '0')
           || ',upd=' || coalesce(t.n_tup_upd::text, '0')
           || ',del=' || coalesce(t.n_tup_del::text, '0') || ')', ', ')
  into v_writes
  from pg_stat_user_tables s
  left join pg_stat_all_tables t on t.relid = s.relid
  where s.relname in ('payment_accounts','payment_intents','payment_events',
                      'payment_matches','payment_audit_logs')
    and (coalesce(t.n_tup_ins,0) <> 0
      or coalesce(t.n_tup_upd,0) <> 0
      or coalesce(t.n_tup_del,0) <> 0);

  if v_writes is not null then
    raise exception 'HOSTED LEAK: the payment tables have been written: %', v_writes;
  end if;
end
$probe$;
select 'ok 1 - the payment tables have never been written on hosted';
'@
$leakPath = Join-Path $WorkDir 'zz_leak_check.sql'
Set-Content -Path $leakPath -Value $leak -Encoding utf8
$files += $leakPath
Write-Output ("  STAGED   {0,-30} leak check (committed state)" -f 'zz_leak_check.sql')

Write-Output ''
Write-Output "  running $($files.Count) file(s) against the linked project..."
Write-Output ''

# The CLI writes progress to stderr ("Initialising login role...", image pulls).
# Under -ErrorActionPreference Stop a native command's stderr becomes a
# terminating error, so relax it here and judge success by the exit code.
$ErrorActionPreference = 'Continue'

# One invocation per file: pg_prove merges multiple files into a single TAP
# stream and then expects test numbers to keep counting up, so two files that
# each start at 1 are reported as "out of sequence".
$failed = @()
foreach ($f in $files) {
    Write-Output ("  --- {0}" -f (Split-Path $f -Leaf))
    & npx --yes supabase@2.119.0 test db --linked $f | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed += (Split-Path $f -Leaf) }
}

$ErrorActionPreference = 'Stop'
$code = if ($failed.Count -gt 0) { 1 } else { 0 }

Write-Output ''
Write-Output "  ran $($files.Count) file(s) against the linked project"
foreach ($f in $failed) { Write-Output "  FAILED: $f" }
Write-Output "  supabase test db exit code: $code"
exit $code