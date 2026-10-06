/**
 * Mounts payment detection for as long as the app is genuinely usable.
 *
 * WHY THIS IS ITS OWN COMPONENT
 *
 * `useSmsListener` is a hook, so it can only be called from a component. It used to
 * have no caller at all: every hook in `src/features/payments/sms/` was written,
 * tested and then never mounted, which meant detection was described in the product
 * copy and implemented in the codebase but did not run. This component is the missing
 * wire, and keeping it tiny and separate means the decision about WHEN to listen is in
 * one readable place rather than smeared through a layout.
 *
 * WHY IT IS GATED ON THE LOCK
 *
 * The listener receives payment messages. Running it while the app is locked would
 * deliver money information to a locked device, and would queue events for a seller who
 * has not proved they are present. Detection resumes when they unlock.
 *
 * It is also gated on a real workspace. With no org there is nothing to attribute an
 * event to, and an event attributed to no tenant is worse than no event: it would sit
 * unmatched forever with nobody able to see it.
 */

import { useSmsListener } from '@/features/payments/sms/hooks';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';

export function PaymentDetection({ enabled }: { enabled: boolean }) {
  const orgId = useSession((state) => state.organization?.id);
  const isLocked = useLock((state) => state.isLocked);
  const hasPasscode = useLock((state) => state.hasPasscode);

  // `locked` only means anything when there is a passcode to be locked behind.
  const locked = hasPasscode && isLocked;

  /*
   * Three conditions, all of which must hold. Written out rather than combined into
   * the call so that reading this function tells you exactly what is and is not
   * running, which is the standard this project holds automation to.
   */
  useSmsListener(orgId, enabled && !locked && Boolean(orgId));

  return null;
}