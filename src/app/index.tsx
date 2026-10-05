/**
 * Entry route — SellFlow V2.
 *
 * Decides where to send the seller from session state, and is the first thing
 * that renders. Every branch produces a real screen:
 *
 *   no backend configured -> SetupRequired   (names the problem)
 *   still resolving      -> LoadingState
 *   business unreachable -> ErrorState + retry
 *   signed out           -> /welcome
 *   no business yet      -> /register
 *   ready                -> /(app)
 *
 * There is no branch that renders nothing. `workspace-unavailable` is a distinct
 * state on purpose: the session is valid but the business behind it could not be
 * read, which is a connection problem, not an authentication one. Redirecting it
 * to a sign-in form would tell a seller their password was wrong when it was not,
 * and would throw away the screen they were standing on.
 */

import { Redirect } from 'expo-router';

import { isConfigured } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { ErrorState, LoadingState, SetupRequired } from '@/components/ui';

export default function Index() {
  const status = useSession((state) => state.status);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const workspaceError = useSession((state) => state.workspaceError);

  if (!isConfigured) return <SetupRequired />;

  if (status === 'loading') {
    return <LoadingState label="Loading your business" />;
  }

  if (status === 'workspace-unavailable') {
    return (
      <ErrorState
        title={workspaceError?.title ?? 'Could not reach your business'}
        action={workspaceError?.action ?? 'Check your connection and try again.'}
        onRetry={() => void refreshWorkspace()}
      />
    );
  }

  if (status === 'signed-out') return <Redirect href="/welcome" />;
  if (status === 'needs-onboarding') return <Redirect href="/register" />;

  return <Redirect href="/(app)" />;
}