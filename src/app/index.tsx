/**
 * Entry route.
 *
 * Decides where to send the user based on session state. While the session is
 * being restored we hold here with a loading state rather than letting the
 * guard layouts flicker between "loading" and "signed out".
 *
 * `workspace-unavailable` is a distinct state on purpose. It means the session
 * is valid but the business behind it could not be read, which is a connection
 * or backend problem and not an authentication one. Redirecting it to sign-in
 * would tell a seller their password was wrong when it was not, and would
 * throw away the screen they were on. It gets its own screen with a retry.
 */

import { Redirect } from 'expo-router';

import { isConfigured } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { ErrorState, LoadingState, SetupRequired } from '@/components/ui';

export default function Index() {
  const status = useSession((state) => state.status);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const workspaceError = useSession((state) => state.workspaceError);

  // No backend means nothing can be saved. Say so rather than offering an app
  // that silently discards the seller's work.
  if (!isConfigured) {
    return <SetupRequired />;
  }

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

  if (status === 'signed-out') {
    return <Redirect href="/sign-in" />;
  }

  if (status === 'needs-onboarding') {
    return <Redirect href="/onboarding" />;
  }

  return <Redirect href="/(app)" />;
}