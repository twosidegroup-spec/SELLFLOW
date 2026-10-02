/**
 * Shared customer order forms.
 *
 * Two very different callers live here, and keeping them apart matters:
 *
 *   Seller side  (this module's queries/mutations) uses the signed-in client,
 *   so RLS applies and everything is scoped to the seller's own business.
 *
 *   Customer side (`fetchPublicForm`, `submitPublicRequest`) uses an ANONYMOUS
 *   key on purpose. A customer filling a form on their own phone has no SellFlow
 *   account and must not be made to create one. The only thing standing between
 *   that stranger and the database is the two SECURITY DEFINER functions from
 *   migration 0019, so this module must never widen what it asks for -- it calls
 *   those functions by name and nothing else.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@supabase/supabase-js';

import { getSupabase } from '@/lib/supabase';
import { AppError, isOfflineError } from '@/lib/errors';
import type {
  OrderRequestRow,
  PublicOrderForm,
} from '@/lib/database.types';

// ---------------------------------------------------------------------------
// Customer side -- anonymous
// ---------------------------------------------------------------------------

/** A throwaway client for callers who are not signed in. */
function anonymousClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new AppError(
      'App is not set up',
      'The public order link needs the Supabase URL and anon key.',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Reads a shared form. Rejects on an invalid, revoked, or expired link -- the
 * three are reported differently to the seller but identically to a stranger,
 * because distinguishing them would let someone probe for live links.
 */
export async function fetchPublicForm(token: string): Promise<PublicOrderForm> {
  const { data, error } = await anonymousClient().rpc('public_order_form', {
    p_token: token,
  });

  if (error) {
    throw linkError(error);
  }

  return {
    store_name: (data as { store_name?: string | null }).store_name ?? null,
    business_name: (data as { business_name?: string | null }).business_name ?? null,
    label: (data as { label?: string }).label ?? 'Customer order form',
    expires_at: (data as { expires_at?: string }).expires_at ?? '',
    products: ((data as { products?: { name: string; price: number }[] }).products ?? []).map(
      (product) => ({ name: product.name, price: Number(product.price) }),
    ),
  };
}

/**
 * Turns a link failure into something a customer can act on.
 *
 * `invalid_link`, `link_revoked` and `link_expired` all collapse to one message:
 * telling a stranger which of the three it was would turn this form into an
 * oracle for guessing live shop links.
 */
function linkError(error: { code?: string; message?: string }): AppError {
  const message = error.message ?? '';
  if (message.includes('link_expired')) {
    return new AppError(
      'This link has expired',
      'Ask the shop for a new order link.',
      { cause: error },
    );
  }
  if (message.includes('link_revoked')) {
    return new AppError(
      'This link is no longer active',
      'Ask the shop for a new order link.',
      { cause: error },
    );
  }
  if (message.includes('name_required')) {
    return new AppError('Please write your name', 'The shop needs to know who the order is for.', {
      cause: error,
    });
  }
  if (message.includes('items_required')) {
    return new AppError(
      'Please list what you want',
      'Add at least one product before sending.',
      { cause: error },
    );
  }
  if (message.includes('invalid_link')) {
    return new AppError(
      'This link is not working',
      'Check the link, or ask the shop to send a new one.',
      { cause: error },
    );
  }
  if (message.includes('invalid_quantity')) {
    return new AppError(
      'Check the quantities',
      'Each product must be between 1 and 1000.',
      { cause: error },
    );
  }
  return AppError.from(error);
}

export interface PublicRequestLine {
  name: string;
  quantity: number;
  size?: string;
}

export interface PublicRequestPayload {
  name: string;
  phone?: string;
  items: PublicRequestLine[];
  address?: string;
  thana?: string;
  district?: string;
  message?: string;
}

export async function submitPublicRequest(
  token: string,
  payload: PublicRequestPayload,
): Promise<{ id: string }> {
  const { data, error } = await anonymousClient().rpc('submit_order_request', {
    p_token: token,
    p_payload: payload as unknown as Record<string, unknown>,
  });

  if (error) throw linkError(error);
  return { id: String((data as { id?: string }).id ?? '') };
}

// ---------------------------------------------------------------------------
// Seller side -- signed in
// ---------------------------------------------------------------------------

export interface CreatedForm {
  id: string;
  /**
   * The plaintext link. Shown exactly once, because only its hash is stored --
   * a lost link is fixed by minting another form, not by recovering this.
   */
  token: string;
  expiresAt: string;
}

export function useCreateOrderForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      storeId,
      label,
      days,
    }: {
      storeId: string;
      label: string;
      days: number;
    }): Promise<CreatedForm> => {
      const { data, error } = await getSupabase().rpc('create_order_form', {
        p_store_id: storeId,
        p_label: label,
        p_expires_days: days,
      });
      if (error) throw AppError.from(error);

      const row = data as { id?: string; token?: string; expires_at?: string };
      return {
        id: String(row.id ?? ''),
        token: String(row.token ?? ''),
        expiresAt: String(row.expires_at ?? ''),
      };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['order-requests'] }),
  });
}

export function useRevokeOrderForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (formId: string) => {
      const { error } = await getSupabase().rpc('revoke_order_form', {
        p_form_id: formId,
      });
      if (error) throw AppError.from(error);
      return true;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['order-requests'] }),
  });
}

export function useOrderRequests(storeId: string | undefined) {
  return useQuery({
    queryKey: ['order-requests', storeId],
    enabled: Boolean(storeId),
    queryFn: async (): Promise<OrderRequestRow[]> => {
      const { data, error } = await getSupabase()
        .from('order_requests')
        .select('*')
        .eq('store_id', storeId as string)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        if (isOfflineError(error)) throw AppError.from(error);
        throw AppError.from(error);
      }

      return (data ?? []) as unknown as OrderRequestRow[];
    },
  });
}

export function useDecideOrderRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      requestId,
      status,
      orderId,
    }: {
      requestId: string;
      status: 'accepted' | 'declined';
      orderId?: string | null;
    }) => {
      const { error } = await getSupabase().rpc('decide_order_request', {
        p_request_id: requestId,
        p_status: status,
        p_order_id: orderId ?? null,
      });
      if (error) throw AppError.from(error);
      return true;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['order-requests'] }),
  });
}

/**
 * Reads one request, for filling in the order screen.
 *
 * Not a query hook on purpose: it is called once, when the seller opens a
 * request, and re-fetching it would risk re-applying the draft.
 */
export async function fetchOrderRequest(
  requestId: string,
): Promise<OrderRequestRow | null> {
  const { data, error } = await getSupabase()
    .from('order_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();

  if (error) throw AppError.from(error);
  return (data as unknown as OrderRequestRow | null) ?? null;
}

/** Full shareable link for a freshly minted form. */
export function orderFormUrl(token: string): string {
  // During development the app is served from the dev server rather than a real
  // domain, so the origin has to come from the running config.
  const origin =
    process.env.EXPO_PUBLIC_WEB_ORIGIN ??
    (typeof window !== 'undefined' ? window.location.origin : 'https://app.sellflow.app');
  return `${origin}/order-form/${token}`;
}
