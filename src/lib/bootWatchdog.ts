/**
 * Boot watchdog.
 *
 * WHY THIS EXISTS
 *
 * Every wait in the startup path can hang forever: SecureStore's Keystore, a
 * Supabase network request with no timeout, a `refreshSession()` that never
 * settles. A hung promise is worse than a thrown one, because a throw at least
 * reaches an error boundary. A hang leaves the loading state on screen with no
 * error, no retry and no explanation -- the second way this app produces a blank
 * screen.
 *
 * So startup is given a deadline. When it passes, the seller is told the app took
 * too long to start and offered a retry. The underlying work is deliberately NOT
 * cancelled: it may still be in flight, and abandoning it could leave a session
 * write half-done. The retry remounts the subtree, which re-runs bootstrap from a
 * clean slate.
 *
 * WHY THE LOGIC IS NOT A HOOK
 *
 * `useBootWatchdog` is a two-line wrapper over `createBootDeadline`. The timer
 * bookkeeping -- arming, clearing, and the stale-timer guard that stops one
 * attempt's deadline firing into the next -- is where the real defects live, and
 * it is unreachable from a test because React hooks need a renderer this suite
 * deliberately does not bring in. Extracting it makes the risky part directly
 * testable, which is why it is a factory rather than inline in the hook.
 *
 * The deadline is generous on purpose. It converts an indefinite hang into a
 * screen with a button; it must not race a healthy cold start on slow signal.
 */

import { useCallback, useEffect, useState } from 'react';

export const BOOT_TIMEOUT_MS = 15_000;

export type BootPhase = 'pending' | 'ready' | 'timed-out';

export interface BootDeadline {
  /** The phase for a given "startup has settled" answer. */
  phase(satisfied: boolean): BootPhase;
  /**
   * Arm the deadline. Returns a disposer that disarms it.
   *
   * @param attempt identifies which attempt armed this timer, so a stale timer
   *   from a previous attempt cannot time out the current one.
   */
  arm(attempt: number, onTimeout: () => void): () => void;
}

export function createBootDeadline(timeoutMs: number = BOOT_TIMEOUT_MS): BootDeadline {
  /*
   * One live timer at a time, enforced by token rather than a shared flag.
   *
   * A single `disarmed` boolean is not enough. Arming twice sets it false twice,
   * so the FIRST timer still sees `false`, fires, and reports a timeout for an
   * attempt that was already replaced -- which is the exact bug this is here to
   * prevent, reached by a different route. A token per arm makes the previous
   * timer's check fail on identity instead.
   */
  let liveToken: object | null = null;

  return {
    phase(satisfied: boolean): BootPhase {
      return satisfied ? 'ready' : 'pending';
    },

    arm(_attempt: number, onTimeout: () => void): () => void {
      const token = {};
      liveToken = token;

      const timer = setTimeout(() => {
        if (liveToken !== token) return;
        liveToken = null;
        onTimeout();
      }, timeoutMs);

      return () => {
        if (liveToken === token) liveToken = null;
        clearTimeout(timer);
      };
    },
  };
}

/**
 * Whether a timer armed for `armedAttempt` may still fire.
 *
 * Exported because it is the single rule that makes retry safe, and it is easier
 * to test directly than to infer from timer ordering.
 */
export function isCurrentAttempt(armedAttempt: number, currentAttempt: number): boolean {
  return armedAttempt === currentAttempt;
}

/** The key that forces a fresh attempt at the startup subtree. */
export function attemptKey(attempt: number): string {
  return `boot-${attempt}`;
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export interface BootWatchdog {
  phase: BootPhase;
  /** Increments on every retry; key a subtree with it to force a remount. */
  attempt: number;
  retry: () => void;
}

export function useBootWatchdog(satisfied: boolean, timeoutMs = BOOT_TIMEOUT_MS): BootWatchdog {
  /*
   * State is one integer, `attempt`, and `timedOutAt` records WHICH attempt
   * gave up.
   *
   * An earlier version kept a mutable ref and wrote it during render, and called
   * setState synchronously inside the effect. Both are refactor hazards the React
   * compiler lint rules are right to reject: reading a ref during render is not
   * safe under concurrent rendering, and a synchronous setState in an effect
   * forces a second render pass before anything is painted. Deriving the phase
   * from state instead removes both.
   */
  const [attempt, setAttempt] = useState(0);
  const [timedOutAt, setTimedOutAt] = useState<number | null>(null);
  const [deadline] = useState(() => createBootDeadline(timeoutMs));

  // Derived during render, not stored. `satisfied` winning outright is what stops
  // a deadline that fired moments earlier from lingering over a healthy app.
  const phase: BootPhase = satisfied
    ? 'ready'
    : timedOutAt !== null && isCurrentAttempt(timedOutAt, attempt)
      ? 'timed-out'
      : 'pending';

  useEffect(() => {
    // Nothing is armed once startup has settled. A live deadline at that point
    // would replace a working app with a timeout screen seconds after it finished
    // starting.
    if (satisfied) return undefined;

    return deadline.arm(attempt, () => setTimedOutAt(attempt));
  }, [satisfied, deadline, attempt]);

  const retry = useCallback(() => {
    setTimedOutAt(null);
    setAttempt((current) => current + 1);
  }, []);

  return { phase, attempt, retry };
}