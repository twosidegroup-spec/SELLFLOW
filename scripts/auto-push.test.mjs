/**
 * Auto-push: behaviour tests.
 *
 * These use a real git and a real remote. There is no git shim, because the
 * failure this exists to prevent was an environmental one and a mocked git would
 * not have reproduced it:
 *
 *   - a REJECTED push is produced by genuine divergence: a second clone commits
 *     straight to the remote, so local main is behind and git refuses. Real
 *     non-fast-forward, real exit code.
 *   - a SLOW push is produced by a real blackhole: an ssh:// remote pointing at
 *     a local socket that accepts and never speaks. git genuinely blocks in the
 *     handshake, which is exactly the condition that made `git commit` look hung.
 *   - an INTERRUPTED push is produced by killing the worker mid-handshake.
 *
 * Every scenario runs in a throwaway repository under the OS temp directory.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'auto-push.mjs');

const roots = [];
const servers = [];

function sh(cmd, cwd, env = {}) {
  const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A socket that accepts connections and then says nothing, ever.
 *
 * Accepted sockets are tracked and destroyed in cleanup. Leaving them open
 * keeps a referenced handle in the event loop, and the test runner then hangs
 * after every test has already passed.
 */
function blackhole() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  servers.push({ server, sockets });
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
  });
}

function makeRepo(name) {
  const root = mkdtempSync(join(tmpdir(), `autopush-${name}-`));
  roots.push(root);

  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  sh('git init -q -b main', work);
  sh('git config user.email t@example.test', work);
  sh('git config user.name Test', work);
  sh('git commit -q --allow-empty -m "init"', work);

  const bare = join(root, 'remote.git');
  sh(`git init -q --bare "${bare}"`, root);
  sh(`git remote add origin "${bare}"`, work);
  sh('git push -q -u origin main', work);

  cpSync(SCRIPT, join(work, 'auto-push.mjs'));

  return { root, work, bare };
}

/** Makes local main genuinely behind the remote, so a push is rejected. */
function diverge(repo) {
  const other = join(repo.root, 'other');
  mkdirSync(other, { recursive: true });
  sh(`git clone -q "${repo.bare}" "${other}"`, repo.root);
  sh('git config user.email o@example.test', other);
  sh('git config user.name Other', other);
  // The bare repo's HEAD still points at the default branch, so the clone lands
  // on the wrong branch. Check out main explicitly or the commit below never
  // becomes the divergence we are trying to create.
  sh('git checkout -q -B main origin/main', other);
  sh('git commit -q --allow-empty -m "remote moved first"', other);
  const pushed = sh('git push -q origin main', other);
  assert.equal(pushed.status, 0, `diverge setup failed: ${pushed.stderr}`);
}

function repointRemoteToBlackhole(repo, port) {
  sh(`git remote set-url origin "ssh://git@127.0.0.1:${port}/x.git"`, repo.work);
}

function repointRemoteToReal(repo) {
  sh(`git remote set-url origin "${repo.bare}"`, repo.work);
}

function run(repo, args = [], env = {}) {
  return sh(`node auto-push.mjs ${args}`, repo.work, env);
}

function state(repo) {
  const file = join(repo.work, '.git', 'auto-push', 'status.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function lock(repo) {
  const file = join(repo.work, '.git', 'auto-push', 'lock.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function commit(repo, message) {
  sh(`git commit -q --allow-empty -m "${message}"`, repo.work);
}

function headsEqual(repo) {
  return (
    sh('git rev-parse HEAD', repo.work).stdout.trim() ===
    sh('git rev-parse origin/main', repo.work).stdout.trim()
  );
}

describe('auto-push', () => {
  after(() => {
    for (const { server, sockets } of servers) {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      try {
        server.close();
        server.unref();
      } catch {
        /* ignore */
      }
    }
    for (const dir of roots) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* windows can hold a handle briefly */
      }
    }
  });

  // 1
  test('1. a normal commit is pushed and origin advances', () => {
    const repo = makeRepo('normal');
    commit(repo, 'add a thing');
    assert.equal(headsEqual(repo), false, 'precondition: something to push');

    const result = run(repo, ['--now']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headsEqual(repo), true, 'origin/main should equal HEAD');
    assert.equal(state(repo).state, 'done');
    assert.equal(sh('git rev-list --count main', repo.bare).stdout.trim(), '2');
  });

  // 2
  test('2. a clean repository is skipped without contacting the remote', async () => {
    const repo = makeRepo('clean');
    // A blackhole remote proves preflight never reaches the network.
    const port = await blackhole();
    repointRemoteToBlackhole(repo, port);

    const started = Date.now();
    const result = run(repo, ['--now']);
    assert.ok(Date.now() - started < 5000, 'skip must be decided locally');
    assert.match(result.stdout, /already up to date/);
    assert.equal(state(repo), null, 'a skip must not be recorded as a push');
  });

  // 3
  test('3. a slow push does not block the caller', async () => {
    const repo = makeRepo('slow');
    const port = await blackhole();
    repointRemoteToBlackhole(repo, port);
    commit(repo, 'slow one');

    // The launcher must return while git is still stuck in the handshake.
    const started = Date.now();
    const result = run(repo);
    const elapsed = Date.now() - started;

    assert.equal(result.status, 0, 'launching must never fail a commit');
    assert.ok(elapsed < 8000, `launch took ${elapsed}ms; a blocked push must not block the commit`);
    assert.match(result.stdout, /background/);
    assert.ok(lock(repo), 'the worker should hold the lock while it runs');

    // Give the detached worker time to be genuinely stuck, then confirm the
    // wait reports an abandoned push instead of hanging.
    await sleep(1500);
    const waited = run(repo, ['--wait'], { SELLFLOW_AUTOPUSH_WAIT_MS: '4000' });
    assert.notEqual(waited.status, 0, 'a push that cannot finish must not report success');
    assert.match(waited.stdout, /"state": "(timeout|abandoned|unknown)"/);
  });

  // 4
  test('4. an interrupted push can be retried safely', async () => {
    const repo = makeRepo('interrupt');
    const port = await blackhole();
    repointRemoteToBlackhole(repo, port);
    commit(repo, 'interrupted');

    run(repo);
    await sleep(1200);

    const held = lock(repo);
    assert.ok(held?.pid, 'worker holds the lock while pushing');

    // Interrupt it the way a killed parent would.
    try {
      process.kill(held.pid, 'SIGKILL');
    } catch {
      /* may already be gone */
    }
    await sleep(500);

    // The lock is left behind by a killed worker; a retry must be able to take
    // it over rather than refusing forever.
    repointRemoteToReal(repo);
    const retry = run(repo, ['--now']);
    assert.equal(retry.status, 0, `retry must succeed: ${retry.stderr}`);
    assert.equal(state(repo).state, 'done');
    assert.equal(headsEqual(repo), true, 'the interrupted commit lands on retry');
  });

  // 5
  test('5. repeated invocation is idempotent', () => {
    const repo = makeRepo('repeat');
    commit(repo, 'once');

    assert.equal(run(repo, ['--now']).status, 0);
    const second = run(repo, ['--now']);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already up to date/);
    assert.equal(sh('git rev-list --count main', repo.bare).stdout.trim(), '2', 'pushed exactly once');
  });

  // 6
  test('6. concurrent invocations cannot both push', async () => {
    const repo = makeRepo('concurrent');
    const port = await blackhole();
    repointRemoteToBlackhole(repo, port);
    commit(repo, 'racing');

    // Fire several launches in the same tick, the way rapid commits would.
    const launched = Array.from({ length: 5 }, () => sh('node auto-push.mjs', repo.work));
    for (const r of launched) assert.equal(r.status, 0, 'launching must never fail a commit');

    // Exactly one may take the lock; the rest must decline rather than race.
    const queued = launched.filter((r) => /queued in background/.test(r.stdout));
    const declined = launched.filter((r) => /already in flight/.test(r.stdout));
    assert.equal(queued.length, 1, `exactly one launch may start a push, got ${queued.length}`);
    assert.equal(declined.length, 4, 'the other four must decline, visibly');

    await sleep(1200);
    const holder = lock(repo);
    assert.ok(holder?.pid, 'exactly one worker should hold the lock');

    // The stuck worker is abandoned; once the remote is reachable again the
    // branch must still be able to reach the remote, with no commit lost.
    repointRemoteToReal(repo);
    try {
      process.kill(holder.pid, 'SIGKILL');
    } catch {
      /* may already be gone */
    }
    await sleep(400);

    const retry = run(repo, ['--now']);
    assert.equal(retry.status, 0, `a later push must succeed: ${retry.stderr}`);
    assert.equal(headsEqual(repo), true, 'no commit may be stranded by the race');
    assert.equal(
      sh('git rev-list --count main', repo.bare).stdout.trim(),
      '2',
      'remote holds exactly the commits it should',
    );
  });

  // 7
  test('7. a rejected push is reported clearly and never forced', () => {
    const repo = makeRepo('rejected');
    diverge(repo);
    commit(repo, 'will be rejected');

    const result = run(repo, ['--now']);
    assert.equal(result.status, 1, 'a rejection must be a failure');

    const st = state(repo);
    assert.equal(st.state, 'failed');
    assert.equal(st.result, 'remote-rejected');
    assert.match(st.message, /rebase/, 'should say how to reconcile');
    assert.equal(
      sh('git rev-list --count main', repo.bare).stdout.trim(),
      '2',
      'the remote is untouched: nothing was forced through',
    );
  });

  // 8
  test('8. a retry after a rejection succeeds without force', () => {
    const repo = makeRepo('retry');
    diverge(repo);
    commit(repo, 'first try');

    assert.equal(run(repo, ['--now']).status, 1);
    assert.equal(state(repo).state, 'failed');

    // Reconcile the way the message says to, then push.
    sh('git fetch -q origin && git rebase -q origin/main', repo.work);
    const retry = run(repo, ['--now']);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(state(repo).state, 'done');
    assert.equal(headsEqual(repo), true);
  });

  // Explicit guarantees from the brief.
  test('9. a failed push leaves the worktree and history untouched', () => {
    const repo = makeRepo('worktree');
    commit(repo, 'worktree untouched');
    diverge(repo);

    const treeBefore = sh('git rev-parse HEAD^{tree}', repo.work).stdout.trim();
    const statusBefore = sh('git status --porcelain', repo.work).stdout;
    const countBefore = sh('git rev-list --count main', repo.work).stdout.trim();

    run(repo, ['--now']);

    assert.equal(sh('git status --porcelain', repo.work).stdout, statusBefore);
    assert.equal(sh('git rev-parse HEAD^{tree}', repo.work).stdout.trim(), treeBefore);
    assert.equal(sh('git rev-list --count main', repo.work).stdout.trim(), countBefore);
  });

  test('10. credentials in a remote URL are never written to the log', () => {
    const repo = makeRepo('redact');
    // A remote that carries a token in the URL, and will fail.
    sh(
      'git remote set-url origin "https://someone:s3cr3t-token@127.0.0.1:9/nope.git"',
      repo.work,
    );
    commit(repo, 'leaky remote');

    run(repo, ['--now']);

    const logFile = join(repo.work, '.git', 'auto-push', 'auto-push.log');
    assert.ok(existsSync(logFile), 'a failure must be logged');
    const log = readFileSync(logFile, 'utf8');
    assert.ok(!log.includes('s3cr3t-token'), `token leaked into log:\n${log}`);
    assert.match(log, /push FAILED/, 'the failure itself is still recorded');
  });

  test('11. the outcome is discoverable after the fact', () => {
    const repo = makeRepo('status');
    commit(repo, 'observable');

    run(repo);
    const out = run(repo, ['--status']);
    assert.match(out.stdout, /"state"/);

    // A --wait must terminate and report, not hang.
    const waited = run(repo, ['--wait']);
    assert.match(waited.stdout, /"state"/);
  });

  test('12. only main is ever pushed', () => {
    const repo = makeRepo('branch');
    sh('git checkout -q -b feature', repo.work);
    commit(repo, 'on a feature branch');

    const result = run(repo, ['--now']);
    assert.match(result.stdout, /skipped \(on branch feature/);
    assert.equal(state(repo), null);
  });

  test('13. SELLFLOW_NO_AUTOPUSH suppresses a push', () => {
    const repo = makeRepo('disabled');
    commit(repo, 'suppressed');

    const result = run(repo, ['--now'], { SELLFLOW_NO_AUTOPUSH: '1' });
    assert.match(result.stdout, /skipped/);
    assert.equal(headsEqual(repo), false, 'nothing was pushed');
  });

  test('14. the post-commit hook never fails a commit', () => {
    const repo = makeRepo('hook');
    const hook = join(REPO, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(hook), 'the hook must be installed');

    cpSync(hook, join(repo.work, '.git', 'hooks', 'post-commit'));
    commit(repo, 'via the hook');

    // The hook fired for real. It must not have changed the commit, and it must
    // have left the branch pushable.
    assert.equal(sh('git rev-list --count main', repo.work).stdout.trim(), '2');
    assert.equal(run(repo, ['--now']).status, 0);
  });
});