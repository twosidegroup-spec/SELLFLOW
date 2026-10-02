/**
 * Session and business context.
 *
 * One store holds everything the app needs to decide what to render: whether a
 * user is signed in, whether they have finished onboarding, which organization
 * and store they are working in, and their role (which determines whether the
 * UI offers write actions at all).
 *
 * Role is mirrored here for UI purposes only. It is never a security boundary --
 * RLS in the database is what actually enforces access, and every write goes
 * through a server function that re-checks. Hiding a button is a courtesy, not
 * a protection.
 */

import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import type { Json, MemberRole, OrganizationRow, StoreRow } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { readJson, StorageKeys, writeJson } from '@/lib/storage';

export type AuthStatus =
  | 'loading'
  /** No valid session. The seller must authenticate. */
  | 'signed-out'
  /** Signed in, but the business behind this account could not be read. */
  | 'workspace-unavailable'
  /** Signed in, with no business yet. */
  | 'needs-onboarding'
  | 'ready';

interface SessionState {
  status: AuthStatus;
  user: User | null;
  organization: OrganizationRow | null;
  store: StoreRow | null;
  stores: StoreRow[];
  role: MemberRole | null;
  /** The reason the workspace could not be loaded, for the error screen. */
  workspaceError: AppError | null;

  /** Called once at startup and on every auth change. */
  bootstrap: () => Promise<void>;
  handleSession: (session: Session | null) => Promise<void>;
  setWorkspace: (organization: OrganizationRow, store: StoreRow, stores: StoreRow[]) => void;
  switchStore: (storeId: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  organization: null,
  store: null,
  stores: [],
  role: null,
  workspaceError: null,

  bootstrap: async () => {
    if (!isConfigured) {
      // No backend means no session. The root layout renders a configuration
      // error rather than letting the user into an app that cannot work.
      set({ status: 'signed-out', user: null });
      return;
    }

    try {
      const { data, error } = await getSupabase().auth.getSession();
      if (error) throw error;
      await get().handleSession(data.session);
    } catch {
      set({ status: 'signed-out', user: null });
    }
  },

  handleSession: async (session) => {
    if (!session?.user) {
      set({
        status: 'signed-out',
        user: null,
        organization: null,
        store: null,
        stores: [],
        role: null,
        workspaceError: null,
      });
      return;
    }

    set({ status: 'loading', user: session.user });
    await get().refreshWorkspace();
  },

  /**
   * Loads the user's organizations, their membership role, and their stores,
   * then restores the previously selected store.
   *
   * The first membership is treated as "the" business. Multi-store multi-org is
   * supported by the schema; switching organizations is a Settings action
   * rather than something surfaced in the main navigation, because almost every
   * seller has exactly one business and a switcher would be friction for them.
   *
   * A READ FAILURE is not a SIGN-OUT. A seller on a bad connection whose
   * membership query times out was being dropped to the sign-in screen as if
   * their password were wrong, losing their place mid-task and inviting them to
   * re-authenticate against a backend that is merely unavailable. The session
   * is still valid -- the server keeps enforcing RLS either way -- so the
   * honest state is "signed in, business unavailable", with a retry.
   */
  refreshWorkspace: async () => {
    const user = get().user;
    if (!user || !isConfigured) {
      set({ status: 'signed-out' });
      return;
    }

    const supabase = getSupabase();

    const { data: memberships, error: membershipError } = await supabase
      .from('organization_members')
      .select('org_id, role')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1);

    if (membershipError) {
      set({ status: 'workspace-unavailable', workspaceError: AppError.from(membershipError) });
      return;
    }

    const membership = memberships?.[0];
    if (!membership) {
      // Signed in, but no business yet -> onboarding.
      set({
        status: 'needs-onboarding',
        organization: null,
        store: null,
        stores: [],
        role: null,
        workspaceError: null,
      });
      return;
    }

    const [organizationResult, storesResult] = await Promise.all([
      supabase
        .from('organizations')
        .select('*')
        .eq('id', membership.org_id)
        .single(),
      supabase
        .from('stores')
        .select('*')
        .eq('org_id', membership.org_id)
        .eq('is_archived', false)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true }),
    ]);

    if (organizationResult.error || storesResult.error) {
      set({
        status: 'workspace-unavailable',
        workspaceError: AppError.from(organizationResult.error ?? storesResult.error),
      });
      return;
    }

    const stores = (storesResult.data ?? []) as StoreRow[];

    if (stores.length === 0) {
      // An organization always gets a store at creation, so this means the
      // data is inconsistent. Treat as not-ready rather than crash.
      set({ status: 'needs-onboarding', role: membership.role, workspaceError: null });
      return;
    }

    const rememberedId = await readJson<string>(StorageKeys.activeStore);
    const store =
      stores.find((candidate) => candidate.id === rememberedId) ??
      stores.find((candidate) => candidate.is_default) ??
      stores[0]!;

    set({
      status: 'ready',
      user,
      organization: organizationResult.data as OrganizationRow,
      store,
      stores,
      role: membership.role,
      workspaceError: null,
    });
  },

  setWorkspace: (organization, store, stores) => {
    set({
      status: 'ready',
      organization,
      store,
      stores,
    });
    void writeJson(StorageKeys.activeStore, store.id);
  },

  switchStore: async (storeId) => {
    const store = get().stores.find((candidate) => candidate.id === storeId);
    if (!store) return;
    set({ store });
    await writeJson(StorageKeys.activeStore, store.id);
  },

  signOut: async () => {
    if (isConfigured) {
      try {
        await getSupabase().auth.signOut();
      } catch {
        // Even if the network call fails, clear local state so the user is not
        // left looking at a signed-in shell they cannot use.
      }
    }
    set({
      status: 'signed-out',
      user: null,
      organization: null,
      store: null,
      stores: [],
      role: null,
      workspaceError: null,
    });
  },
}));

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Whether the current user may create or modify records.
 *
 * Staff are read-only. Drives whether write actions are rendered at all, so a
 * staff account sees a clean read-only app instead of a wall of buttons that
 * fail when pressed.
 */
export function canWrite(role: MemberRole | null): boolean {
  return role === 'owner' || role === 'manager';
}

/** Whether the current user may manage stores, members and business settings. */
export function isOwner(role: MemberRole | null): boolean {
  return role === 'owner';
}

/** Narrow an untyped RPC payload. PostgREST returns `Json` for jsonb columns. */
export function asRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, Json | undefined>;
}
