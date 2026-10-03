/**
 * Auto-push to origin/main after a commit.
 *
 * WHY THIS IS A BACKGROUND JOB
 *
 * The previous version was a blocking shell hook. It ran `git push` inline,
 * which meant a slow network made `git commit` look hung, and if the parent
 * process was killed the push died with it -- leaving the branch locally ahead
 * of origin with no record of why. That is exactly the failure that stranded
 * commit 00c1eee.
 *
 * The fix is not "make the command return faster" by weakening anything. The
 * commit is already durable locally, so the push is fire-and-forget by nature.
 * The work here is making that safe and observable:
 *
 *   - a lock, so two pushes never race
 *   - a status file, so a background failure cannot be silent
 *   - redaction, so a credential in a remote URL never reaches the log
 *   - never --force, and never touching the worktree or history
 *
 * MODES
 *
 *   (no flag)      launch a detached push and return immediately. This is what
 *                  the post-commit hook calls.
 *   --now          run the push in the foreground. For a deliberate retry.
 *   --wait         block until the background push finishes, then report.
 *                  This is how a script or CI confirms the push really landed
 *                  instead of trusting an exit code from a launcher that has
 *                  not finished yet.
 *   --status       print the last outcome and exit.
 *
 * Environment:
 *   SELLFLOW_NO_AUTOPUSH=1   skip one launch
 *   SELLFLOW_AUTOPUSH_LOG=<path>   override the log location
 *
 * State lives under .git/auto-push/, which is not part of the worktree, so
 * nothing here can show up in `git status` or be committed by accident.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';

const BRANCH = 'main';
const REMOTE = 'origin';

/**
 * A lock older than this is assumed to belong to a process that died, and is
 * taken over. Generous enough that a genuinely slow push is never interrupted,
 * short enough that an overnight crash does not block pushes forever.
 */
const STALE_LOCK_MS = 15 * 60 * 1000;

const gitBin = process.env.SELLFLOW_GIT_BIN || 'git';

function stateDir() {
  const root = git(['rev-parse', '--absolute-git-dir']);
  if (!root) return null;
  return join(root, 'auto-push');
}

function logPath(dir) {
  return process.env.SELLFLOW_AUTOPUSH_LOG || join(dir, 'auto-push.log');
}

/** Runs git synchronously and returns trimmed stdout, or null on failure. */
function git(args, cwd = process.cwd()) {
  const result = spawnSync(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

/**
 * Removes anything that could carry a secret out of text we are about to write
 * down. `git push` echoes the remote URL on failure, and a remote configured
 * with an embedded token would otherwise land in a log file that outlives the
 * session.
 */
function redact(text) {
  return String(text ?? '')
    // https://user:token@host -> https://user@host
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
    // Authorization / token-ish headers or query params
    .replace(/((?:authorization|apikey|api_key|token|access_token)["'\s:=]+)[^\s"',}]+/gi, '$1<redacted>')
    // Well-known credential shapes, belt and braces
    .replace(/\b(?:sbp|sb_secret|ghp|gho|ghs|github_pat)_[A-Za-z0-9_]+/g, '<redacted>')
    // Credentials embedded in an scp-style git remote
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s]+:[^/\s]+@/gim, '$1***:***@');
}

function log(dir, line) {
  try {
    appendFileSync(logPath(dir), `${new Date().toISOString()} ${redact(line)}\n`, 'utf8');
  } catch {
    // A log that cannot be written must never take the commit down with it.
  }
}

function writeStatus(dir, status) {
  try {
    writeFileSync(join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

function readStatus(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decides whether a push is warranted at all.
 *
 * Returns { skip, reason } rather than pushing, so every refusal is recorded
 * with a reason instead of silently doing nothing.
 */
function preflight(dir) {
  if (process.env.SELLFLOW_NO_AUTOPUSH === '1') {
    return { skip: true, reason: 'disabled by SELLFLOW_NO_AUTOPUSH' };
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return { skip: true, reason: 'not a git repository' };
  if (branch !== BRANCH) return { skip: true, reason: `on branch ${branch}, not ${BRANCH}` };

  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  if (gitDir) {
    const g = join(gitDir, '');
    if (existsSync(join(g, 'MERGE_HEAD'))) return { skip: true, reason: 'mid-merge' };
    if (existsSync(join(g, 'rebase-merge')) || existsSync(join(g, 'rebase-apply'))) {
      return { skip: true, reason: 'mid-rebase' };
    }
  }

  if (!existsSync(join(process.cwd(), '.git')) && !gitDir) {
    return { skip: true, reason: 'no repository' };
  }

  const remote = git(['remote', 'get-url', REMOTE]);
  if (!remote) return { skip: true, reason: `no ${REMOTE} remote` };

  const head = git(['rev-parse', 'HEAD']);
  const upstream = git(['rev-parse', '--verify', '--quiet', '@{u}']);

  // Nothing to push: compared locally, without contacting the network. This is
  // what makes a repeated invocation cheap and idempotent.
  if (head && upstream && head === upstream) {
    return { skip: true, reason: 'already up to date', head };
  }

  return { skip: false, head, branch, remote };
}

function acquireLock(dir) {
  const lockFile = join(dir, 'lock.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists, which makes creation atomic on every
      // platform rather than a check-then-write race.
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;

      // Someone holds it. Break it only if that holder is demonstrably gone.
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockFile, 'utf8'));
      } catch {
        /* unreadable lock is treated as stale below */
      }

      const age = holder?.startedAt ? Date.now() - holder.startedAt : Infinity;
      let alive = false;
      if (holder?.pid) {
        try {
          process.kill(holder.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }

      if (alive && age < STALE_LOCK_MS) return false;

      log(
        dir,
        `taking over lock from pid ${holder?.pid ?? 'unknown'} (alive=${alive}, ageMs=${age}) -- previous push did not finish`,
      );
      try {
        rmSync(lockFile, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function updateLockOwner(dir, pid) {
  try {
    const file = join(dir, 'lock.json');
    const holder = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...holder, pid }));
  } catch {
    /* best effort: a missing lock is handled by the staleness rules */
  }
}

function releaseLock(dir) {
  try {
    rmSync(join(dir, 'lock.json'), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * The actual push. Never forces, never touches the worktree.
 *
 * Loops while HEAD is ahead of the remote. A commit made while this push was in
 * flight would otherwise never be pushed: its own launch is declined (the lock is
 * held), and this push has already sent the older ref. So "pushed" is only true
 * once the branch tip is genuinely on the remote.
 */
function performPush(dir, meta) {
  const startedAt = new Date().toISOString();
  const MAX_ROUNDS = 5;
  let sent = 0;
  let lastResult = 'already-up-to-date';

  writeStatus(dir, { state: 'running', commit: meta.head, startedAt });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const head = git(['rev-parse', 'HEAD']);
    const upstream = git(['rev-parse', '--verify', '--quiet', '@{u}']);
    if (head && upstream && head === upstream) break;

    log(dir, `push round ${round}: ${head?.slice(0, 7)} -> ${REMOTE}/${BRANCH}`);
    sent += 1;

    const result = spawnSync(gitBin, ['push', REMOTE, `${BRANCH}:${BRANCH}`], {
      encoding: 'utf8',
      windowsHide: true,
    });

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    if (result.status !== 0) {
      // A rejected push leaves the branch diverged. Report it precisely and
      // leave the decision to a human -- this tool never forces and never
      // rebases. Retrying cannot help, so stop here.
      const rejected = /non-fast-forward|fetch first|rejected/i.test(combined);
      const status = {
        state: 'failed',
        commit: head,
        finishedAt: new Date().toISOString(),
        result: rejected ? 'remote-rejected' : 'push-failed',
        exitCode: result.status,
        message: rejected
          ? 'Remote rejected the push (non-fast-forward). Fetch and reconcile: git fetch origin && git rebase origin/main'
          : 'Push failed. Check credentials or connectivity, then retry: node scripts/auto-push.mjs --now',
      };
      writeStatus(dir, status);
      log(dir, `push FAILED (${status.result}, exit ${result.status})\n${redact(combined)}`);
      return status;
    }

    lastResult = /Everything up-to-date/i.test(combined) ? 'already-up-to-date' : 'pushed';
  }

  const finalHead = git(['rev-parse', 'HEAD']);
  const finalUpstream = git(['rev-parse', '--verify', '--quiet', '@{u}']);
  const settled = finalHead && finalUpstream && finalHead === finalUpstream;

  const status = {
    state: settled ? 'done' : 'failed',
    commit: finalHead,
    finishedAt: new Date().toISOString(),
    result: settled ? lastResult : 'incomplete-after-retries',
    rounds: sent,
    message: settled ? undefined : `HEAD is still ahead of ${REMOTE}/${BRANCH} after ${sent} push attempt(s)`,
  };
  writeStatus(dir, status);
  log(dir, `push ok (${status.result}, ${sent} round(s))`);
  return status;
}

function runNow(dir) {
  const pre = preflight(dir);
  if (pre.skip) {
    log(dir, `skipped: ${pre.reason}`);
    console.log(`auto-push: skipped (${pre.reason})`);
    return { state: 'skipped', reason: pre.reason };
  }

  if (!acquireLock(dir)) {
    console.log('auto-push: a push is already running; not starting another');
    return { state: 'skipped', reason: 'already-running' };
  }

  try {
    const status = performPush(dir, pre);
    const short = pre.head?.slice(0, 7) ?? 'HEAD';
    if (status.state === 'done') {
      console.log(`auto-push: ${status.result} ${short} -> ${REMOTE}/${BRANCH}`);
      return status;
    }
    console.error(`auto-push: FAILED ${short} (${status.result}) -- the commit is safe locally`);
    console.error(`  ${status.message}`);
    return status;
  } finally {
    releaseLock(dir);
  }
}

function launch(dir) {
  const pre = preflight(dir);
  if (pre.skip) {
    log(dir, `skipped: ${pre.reason}`);
    // Only the routine skips are silent; the rest still report.
    if (pre.reason !== 'disabled by SELLFLOW_NO_AUTOPUSH') {
      console.log(`auto-push: skipped (${pre.reason})`);
    }
    return { state: 'skipped', reason: pre.reason };
  }

  if (!acquireLock(dir)) {
    log(dir, 'skipped: a push is already running');
    // Declining is correct -- the running push re-checks HEAD and carries this
    // commit with it -- but saying so beats saying nothing, because a commit
    // whose launch printed nothing looks like a commit nobody pushed.
    console.log('auto-push: a push is already in flight; it will carry this commit too');
    return { state: 'skipped', reason: 'already-running' };
  }

  // fileURLToPath, NOT new URL(...).pathname: the pathname keeps percent-encoding,
  // so a repo path containing a space (which this one does) produces a path that
  // does not exist. The worker then died instantly and silently, because its
  // stdio was ignored -- the push simply never happened. That is the precise
  // failure mode this script exists to make impossible.
  const scriptPath = fileURLToPath(import.meta.url);

  const child = spawn(
    process.execPath,
    [scriptPath, '--worker'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );

  // A spawn that fails outright must be loud. Without this the lock is held by
  // a process that never ran, and nothing is ever pushed.
  child.on('error', (err) => {
    log(dir, `spawn failed: ${err.message}`);
    writeStatus(dir, {
      state: 'failed',
      result: 'spawn-failed',
      finishedAt: new Date().toISOString(),
      message: `Could not start the background push: ${err.message}`,
    });
    releaseLock(dir);
  });

  child.unref();

  // Hand ownership to the worker immediately.
  //
  // This line is load-bearing. The lock is created with the LAUNCHER's pid, and
  // the launcher is about to exit -- so a second commit arriving a moment later
  // would see a dead pid, decide the lock was abandoned, take it over, and start
  // a competing push. Recording the worker's pid (which outlives the launcher)
  // is what makes the lock mean "a push is in flight" rather than "a launcher
  // is mid-spawn".
  updateLockOwner(dir, child.pid);

  log(dir, `launched background push for ${pre.head?.slice(0, 7)} (pid ${child.pid})`);
  console.log(
    `auto-push: ${pre.head?.slice(0, 7)} queued in background — check: node scripts/auto-push.mjs --wait`,
  );
  return { state: 'launched', pid: child.pid };
}

/** Worker: the lock is already held by the launcher that spawned us. */
function worker(dir) {
  const pre = preflight(dir);
  if (pre.skip) {
    log(dir, `worker skipped: ${pre.reason}`);
    writeStatus(dir, { state: 'skipped', reason: pre.reason, finishedAt: new Date().toISOString() });
    releaseLock(dir);
    return;
  }
  try {
    performPush(dir, pre);
  } finally {
    releaseLock(dir);
  }
}

async function waitForCompletion(dir, timeoutMs = Number(process.env.SELLFLOW_AUTOPUSH_WAIT_MS) || 120_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const status = readStatus(dir);
    if (status && status.state !== 'running') return status;

    // A lock whose owner is gone means the worker died without recording an
    // outcome. Report that plainly instead of polling until the timeout, which
    // is how a wait can appear to hang forever.
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8'));
    } catch {
      /* no lock: fall through to the status check */
    }

    if (holder?.pid) {
      let alive = true;
      try {
        process.kill(holder.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        return {
          state: 'abandoned',
          reason: `push worker pid ${holder.pid} exited without recording an outcome; retry with: node scripts/auto-push.mjs --now`,
        };
      }
    } else if (!existsSync(join(dir, 'lock.json'))) {
      return { state: 'unknown', reason: 'lock released with no terminal status' };
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return { state: 'timeout', reason: `no completion within ${timeoutMs}ms` };
}

async function main() {
  const dir = stateDir();
  if (!dir) {
    console.log('auto-push: not a git repository; nothing to do');
    return;
  }
  mkdirSync(dir, { recursive: true });

  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);

  if (has('--status')) {
    console.log(JSON.stringify(readStatus(dir) ?? { state: 'never-run' }, null, 2));
    return;
  }

  if (has('--worker')) {
    worker(dir);
    return;
  }

  if (has('--now')) {
    const status = runNow(dir);
    process.exitCode = status.state === 'failed' ? 1 : 0;
    return;
  }

  if (has('--wait')) {
    const status = await waitForCompletion(dir);
    console.log(JSON.stringify(status, null, 2));
    // Only a completed push is a success. 'unknown', 'abandoned' and 'timeout'
    // all mean the push did not demonstrably land, and reporting those as
    // success is exactly how a stranded commit goes unnoticed.
    process.exitCode = status.state === 'done' ? 0 : 1;
    return;
  }

  launch(dir);
}

await main();