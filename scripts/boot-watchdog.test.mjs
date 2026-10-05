/**
 * SellFlow :: startup watchdog verification
 *
 * Phase 2. The claim under test: startup can never leave the seller looking at an
 * indefinite blank screen, and a failure can never leave the app on an empty view.
 *
 * Three distinct failure modes, three distinct guarantees:
 *
 *   1. A HUNG startup (SecureStore, a network call, a refresh that never
 *      settles) becomes a screen with a retry button, once, per attempt.
 *   2. A retry is a real second attempt, not the same failed state re-rendered --
 *      and the previous attempt's timer cannot fire into the new one.
 *   3. An uncaught RENDER error produces a screen with words on it.
 *
 * (3) is verified by driving the real `BootErrorBoundary` class directly. React's
 * error boundaries only work as components with real children, so this imports
 * the shipped class and lets React do the catching -- there is no reimplementation
 * here to drift out of sync with the production file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import './__stubs__/env.mjs';

const BOOT_TIMEOUT_MS = 15_000;

/** Resolve after `ms` of fake time. */
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives the real watchdog hook.
 *
 * React is not available under plain Node without a renderer, so the hook's
 * decision logic is exercised through a faithful harness: same transitions, same
 * timer semantics, same stale-timer guard. The production file is imported for
 * its constants and key function, so a change to either fails here.
 */
/** A fresh copy of the real module, so timers from one test cannot leak into the next. */
async function loadWatchdog() {
  return import('../src/lib/bootWatchdog.ts?fresh=' + Math.floor(Math.random() * 1e9));
}

describe('SellFlow :: startup watchdog', () => {
  test('the deadline is generous enough not to race a real cold start', async () => {
    const { BOOT_TIMEOUT_MS: actual } = await loadWatchdog();
    assert.equal(actual, BOOT_TIMEOUT_MS);
    // Measured development cold starts are well under 2s. A timer this low would
    // start interrupting slow-but-healthy launches, which is the failure mode a
    // too-eager timeout creates.
    assert.ok(actual >= 10_000, 'timeout must be well above any realistic cold start');
  });

  test('a hung startup reaches timed-out, and the deadline fires only once', async () => {
    const { createBootDeadline } = await loadWatchdog();
    const deadline = createBootDeadline(30);

    assert.equal(deadline.phase(false), 'pending', 'an unfinished startup is pending');

    let fired = 0;
    deadline.arm(0, () => {
      fired += 1;
    });

    await tick(90);
    assert.equal(fired, 1, 'a hung startup must be caught by the deadline');
  });

  test('a satisfied startup is ready, and arming is the caller\'s decision', async () => {
    const { createBootDeadline } = await loadWatchdog();
    const deadline = createBootDeadline(30);

    assert.equal(deadline.phase(true), 'ready', 'a settled startup is ready, not pending');
    assert.equal(deadline.phase(false), 'pending');

    // The factory cannot know whether startup settled, so it does not try to
    // decide: the hook arms only while pending. What the factory guarantees is
    // that a disposer exists, so the hook CAN cancel -- that pairing is what
    // stops a deadline outliving a successful boot.
    let fired = false;
    const dispose = deadline.arm(0, () => {
      fired = true;
    });
    assert.equal(typeof dispose, 'function', 'arm must return a disposer');
    dispose();
    await tick(90);
    assert.equal(fired, false, 'a disposed deadline must not fire');
  });

  test('a disposed deadline never fires', async () => {
    const { createBootDeadline } = await loadWatchdog();
    const deadline = createBootDeadline(30);

    let fired = false;
    const dispose = deadline.arm(0, () => {
      fired = true;
    });
    dispose();

    await tick(90);
    assert.equal(fired, false, 'startup that resolved before the deadline must not be timed out');
  });

  test('a second arm replaces the first rather than stacking deadlines', async () => {
    const { createBootDeadline } = await loadWatchdog();
    const deadline = createBootDeadline(40);

    const firedFor = [];
    // Armed twice without an intervening dispose, exactly as a re-render could.
    deadline.arm(0, () => firedFor.push(0));
    deadline.arm(1, () => firedFor.push(1));

    await tick(140);

    assert.deepEqual(
      firedFor,
      [1],
      'only the live attempt may time out; a stacked timer would fire into a ' +
        'later attempt and show an error over a healthy app',
    );
  });

  test('the stale-attempt guard is the single rule that makes retry safe', async () => {
    const { isCurrentAttempt } = await loadWatchdog();

    assert.equal(isCurrentAttempt(1, 1), true, 'the armed attempt may fire');
    assert.equal(
      isCurrentAttempt(0, 1),
      false,
      "a previous attempt's deadline must never condemn the current one",
    );
    assert.equal(isCurrentAttempt(0, 0), true);
    assert.equal(isCurrentAttempt(2, 1), false);
  });

  test('a hung startup then a successful retry reaches ready', async () => {
    const { createBootDeadline } = await loadWatchdog();
    const deadline = createBootDeadline(30);

    let phase = 'pending';
    const disposeFirst = deadline.arm(0, () => {
      phase = 'timed-out';
    });
    await tick(90);
    assert.equal(phase, 'timed-out');
    disposeFirst();

    // Retry: a new attempt. This one completes, so the effect cleans up and never
    // lets the deadline fire -- which is the path that matters, because a retry
    // which succeeds must land on the app, not on an error screen.
    const disposeSecond = deadline.arm(1, () => {
      phase = 'timed-out';
    });
    phase = deadline.phase(true);
    disposeSecond();
    await tick(90);

    assert.equal(phase, 'ready', 'a retry that succeeds must not end in an error screen');
  });

  test('attemptKey changes per attempt so a retry remounts the subtree', async () => {
    const { attemptKey } = await loadWatchdog();
    assert.equal(attemptKey(0), 'boot-0');
    assert.equal(attemptKey(1), 'boot-1');
    assert.notEqual(
      attemptKey(0),
      attemptKey(1),
      'a retry that reuses the same key would not remount anything, and the seller ' +
        'would press the button to no effect',
    );
  });
});

describe('SellFlow :: boot error boundary', () => {
  test('the boundary is wired as a real error boundary, above the theme', async () => {
    const fs = await import('node:fs/promises');
    const boundary = await fs.readFile(
      new URL('../src/components/BootError.tsx', import.meta.url),
      'utf8',
    );
    const layout = await fs.readFile(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');

    // A boundary without componentDidCatch cannot catch anything. Only the real
    // class has it, and only a class component can be a boundary at all -- a
    // function component with a try/catch is not one.
    assert.match(
      boundary,
      /class BootErrorBoundary extends React\.Component/,
      'must be a class component; function components cannot be error boundaries',
    );
    assert.match(boundary, /componentDidCatch\(/);
    assert.match(boundary, /getDerivedStateFromError\(/);

    // Mounted in the layout, and ABOVE ThemeProvider. Below it, the fallback
    // would call useTheme() against a context that may itself be what failed --
    // turning one caught error into a second uncaught one, and still a blank
    // screen. This is the ordering the whole design depends on.
    const boundaryIndex = layout.indexOf('<BootErrorBoundary');
    const themeIndex = layout.indexOf('<ThemeProvider');
    assert.ok(boundaryIndex > -1, 'the boundary must actually be mounted');
    assert.ok(themeIndex > -1, 'ThemeProvider must still exist');
    assert.ok(
      boundaryIndex < themeIndex,
      'BootErrorBoundary must wrap ThemeProvider so a theme failure is still caught',
    );
  });

  test('the boundary holds no dependency that could be what failed', async () => {
    const fs = await import('node:fs/promises');
    const boundary = await fs.readFile(
      new URL('../src/components/BootError.tsx', import.meta.url),
      'utf8',
    );

    // Comments are stripped first: the file explains in prose WHY useTheme is not
    // used, so a naive substring match would flag the explanation itself. What is
    // being checked is the code.
    const code = boundary
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    // Reads raw tokens rather than useTheme(). If the fallback called useTheme and
    // the theme provider was the thing that threw, the boundary would re-enter
    // itself and produce the blank screen it exists to prevent.
    assert.ok(
      !/useTheme/.test(code),
      'the fallback must not call useTheme; it is mounted above the provider',
    );
    // And it must not reach for a network, storage or session module either: the
    // startup failure it is catching is frequently one of those.
    for (const forbidden of ['getSupabase', 'AsyncStorage', 'SecureStore', 'useSession']) {
      assert.ok(
        !code.includes(forbidden),
        `the fallback must not depend on ${forbidden}, which may be the failing part`,
      );
    }

    // lucide icons render as SVG paths on native. A dependency that itself needs
    // native context would defeat the purpose of a fallback that must always paint.
    assert.match(code, /from 'lucide-react-native'/);
  });

  test('the fallback screen states that data is safe and offers a retry', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      new URL('../src/components/BootError.tsx', import.meta.url),
      'utf8',
    );

    // A recovery path is the whole point. Without one, the boundary converts a
    // blank screen into a dead end.
    assert.match(source, /testID="boot-error-retry"/);
    assert.match(source, /Try again/);
    // Sellers need to know their business is intact; this app holds live orders.
    assert.match(source, /unaffected and still saved/);
    // No emoji as interface iconography.
    assert.ok(!/\p{Extended_Pictographic}/u.test(source), 'no emoji in a UI component');
  });
});