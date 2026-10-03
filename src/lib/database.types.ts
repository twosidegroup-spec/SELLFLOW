/**
 * Generated-shape database types.
 *
 * These mirror `supabase/migrations/*` exactly. If you change the schema, run
 * `supabase gen types typescript --linked` and replace this file rather than
 * editing it by hand -- a drift between these types and the real columns is the
 * kind of bug that only shows up as a runtime failure in production.
 *
 * Money columns are `number` because PostgREST returns `numeric` as a JSON
 * number. numeric(14,2) tops out around 1e12, comfortably inside the range
 * JavaScript represents exactly, so the wire value is safe. Convert to integer
 * minor units with `toMinor` before doing any arithmetic -- see src/lib/money.ts.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MemberRole = 'owner' | 'manager' | 'staff';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'packaging'
  | 'packed'
  | 'shipped'
  | 'on_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned'
  | 'failed_delivery';

export type CourierProvider = 'pathao' | 'redx' | 'manual';

export type ShipmentState =
  | 'requested'
  | 'created'
  | 'picked'
  | 'in_transit'
  | 'at_hub'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'cancelled';

export type SettlementState = 'expected' | 'collected' | 'settled' | 'refunded' | 'returned';

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

export type PaymentMethod = 'cash' | 'bkash' | 'nagad' | 'rocket' | 'card' | 'bank' | 'other';

export type InventoryReason =
  | 'initial'
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'adjustment'
  | 'damage';

export type ExpenseCategory =
  | 'advertising'
  | 'packaging'
  | 'delivery'
  | 'sourcing'
  | 'software'
  | 'salary'
  | 'rent'
  | 'utilities'
  | 'miscellaneous';

export type NotificationKind =
  | 'new_order'
  | 'low_stock'
  | 'payment_due'
  | 'order_status'
  | 'account';

/**
 * Every table carries timestamps.
 *
 * Declared as a type alias rather than an interface on purpose: supabase-js
 * constrains `Row` to `Record<string, unknown>`, and TypeScript only gives
 * *type aliases* an implicit index signature. A single `interface` anywhere in
 * this file silently degrades every derived Row type to `never`.
 */
type RowBase = {
  created_at: string;
  updated_at: string;
};

export type ProfileRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export type OrganizationRow = RowBase & {
  id: string;
  name: string;
  currency: string;
  allow_negative_stock: boolean;
  default_delivery_fee: number;
  created_by: string;
}

export type OrganizationMemberRow = {
  id: string;
  org_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
}

export type StoreRow = RowBase & {
  id: string;
  org_id: string;
  /**
   * IANA zone that decides where this store's business day starts.
   *
   * Null is possible on a row written before migration 0021; `store_timezone()`
   * falls back to UTC in that case rather than failing.
   */
  timezone: string | null;
  name: string;
  code: string | null;
  address: string | null;
  phone: string | null;
  is_default: boolean;
  is_archived: boolean;
}

export type ProductRow = RowBase & {
  id: string;
  org_id: string;
  name: string;
  sku: string | null;
  category: string | null;
  selling_price: number;
  cost_price: number | null;
  low_stock_threshold: number;
  track_inventory: boolean;
  image_url: string | null;
  notes: string | null;
  is_archived: boolean;
  created_by: string | null;
}

export type ProductVariantRow = RowBase & {
  id: string;
  org_id: string;
  product_id: string;
  name: string;
  sku: string | null;
  selling_price: number | null;
  cost_price: number | null;
  is_archived: boolean;
}

export type InventoryRow = RowBase & {
  id: string;
  org_id: string;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

export type InventoryMovementRow = {
  id: string;
  org_id: string;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  delta: number;
  reason: InventoryReason;
  reference_type: 'order' | 'manual' | null;
  reference_id: string | null;
  note: string | null;
  balance_after: number;
  created_by: string | null;
  created_at: string;
}

export type CustomerRow = RowBase & {
  id: string;
  org_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  district: string | null;
  thana: string | null;
  notes: string | null;
  is_archived: boolean;
  created_by: string | null;
}

export type OrderRow = RowBase & {
  id: string;
  org_id: string;
  store_id: string;
  customer_id: string | null;
  order_number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  items_total: number;
  discount: number;
  delivery_charge: number;
  total: number;
  cost_total: number;
  /** What the seller pays the courier. Distinct from `delivery_charge`. */
  courier_cost: number;
  /** Per-order packaging and handling. */
  other_cost: number;
  profit: number;
  amount_paid: number;
  is_cod: boolean;
  cod_amount: number;
  cod_settled: boolean;
  cod_settled_at: string | null;
  cod_payout_reference: string | null;
  courier_name: string | null;
  courier_provider: CourierProvider | null;
  tracking_id: string | null;
  tracking_url: string | null;
  shipment_status: ShipmentState | null;
  shipped_at: string | null;
  failure_reason: string | null;
  delivery_name: string | null;
  delivery_phone: string | null;
  delivery_address: string | null;
  delivery_district: string | null;
  delivery_thana: string | null;
  client_ref: string | null;
  notes: string | null;
  placed_at: string;
  created_by: string | null;
}

export type ShipmentRow = RowBase & {
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  connection_id: string | null;
  provider: CourierProvider;
  provider_label: string | null;
  state: ShipmentState;
  external_status: string | null;
  external_status_label: string | null;
  tracking_id: string | null;
  tracking_url: string | null;
  cod_amount: number;
  courier_charge: number | null;
  attempt_no: number;
  idempotency_key: string;
  confirmed_at: string | null;
  picked_at: string | null;
  delivered_at: string | null;
  closed_at: string | null;
  failure_reason: string | null;
  external_payload: Json;
  created_by: string | null;
}

export type ShipmentEventRow = {
  id: string;
  org_id: string;
  shipment_id: string;
  state: ShipmentState | null;
  external_status: string | null;
  label: string;
  note: string | null;
  source: 'courier' | 'seller' | 'system';
  occurred_at: string;
  created_at: string;
}

export type SettlementRow = RowBase & {
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  state: SettlementState;
  expected_amount: number;
  settled_amount: number;
  currency_note: string | null;
  settled_at: string | null;
  payout_reference: string | null;
  notes: string | null;
}

export type CourierConnectionRow = RowBase & {
  id: string;
  org_id: string;
  provider: CourierProvider;
  label: string;
  is_active: boolean;
  /** Opaque pointer into Supabase Vault. Never the secret itself. */
  vault_secret_id: string | null;
  external_store_id: string | null;
  notes: string | null;
}

export type CourierLocationRow = RowBase & {
  id: string;
  org_id: string;
  provider: CourierProvider;
  kind: 'city' | 'zone' | 'area';
  external_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  fetched_at: string;
}

export type OrderItemRow = {
  id: string;
  org_id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  sku: string | null;
  unit_price: number;
  unit_cost: number | null;
  quantity: number;
  line_discount: number;
  line_total: number;
  created_at: string;
}

export type PaymentRow = {
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  amount: number;
  method: PaymentMethod;
  is_refund: boolean;
  paid_at: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export type ExpenseRow = RowBase & {
  id: string;
  org_id: string;
  store_id: string | null;
  amount: number;
  category: ExpenseCategory;
  incurred_on: string;
  description: string | null;
  note: string | null;
  created_by: string | null;
}

export type OrderStatusHistoryRow = {
  id: string;
  org_id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export type NotificationRow = {
  id: string;
  org_id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  data: Json;
  read_at: string | null;
  created_at: string;
}

export type OrderFormRow = {
  id: string;
  org_id: string;
  store_id: string;
  label: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * A request a customer submitted through a shared link. Deliberately holds no
 * price and no product id: the customer supplies intent, the seller supplies
 * the money.
 */
export type OrderRequestRow = {
  id: string;
  form_id: string;
  org_id: string;
  store_id: string;
  customer_name: string;
  customer_phone: string | null;
  items: { name: string; quantity: number; size: string }[];
  address: string | null;
  thana: string | null;
  district: string | null;
  message: string | null;
  status: 'new' | 'accepted' | 'declined';
  order_id: string | null;
  decided_at: string | null;
  created_at: string;
};

export type PublicOrderForm = {
  store_name: string | null;
  business_name: string | null;
  label: string;
  expires_at: string;
  products: { name: string; price: number }[];
};
export type NotificationPreferenceRow = RowBase & {
  org_id: string;
  user_id: string;
  new_order: boolean;
  low_stock: boolean;
  payment_due: boolean;
  order_status: boolean;
  account: boolean;
}

/**
 * `Database` is shaped for supabase-js's generic parameter. Every table, view
 * and RPC is declared so the client is fully typed end to end -- a typo in a
 * column name becomes a compile error rather than a runtime 400.
 */
// ---------------------------------------------------------------------------
// Payment detection engine (migrations 0022-0024)
//
// `payment_provider` records which MFS reported a payment; `payment_method`
// (above) records how the seller says they took the money. They are separate
// because the MFS set grows faster -- Upay has no payment_method value and
// records as 'other'. See docs/payment-engine.md.
// ---------------------------------------------------------------------------

export type PaymentEventSource = 'sms' | 'api' | 'manual' | 'import';

export type PaymentProvider = 'bkash' | 'nagad' | 'rocket' | 'upay';

export type PaymentAccountStatus = 'pending' | 'connected' | 'disconnected' | 'error';

export type PaymentIntentType = 'order' | 'subscription' | 'invoice' | 'other';

export type PaymentIntentStatus =
  | 'open'
  | 'matched'
  | 'partially_paid'
  | 'expired'
  | 'cancelled'
  | 'mismatched';

/**
 * Lifecycle of one detected payment.
 *
 * `duplicate` is a real outcome and not an error: a phone that reconnects and
 * re-reads the same SMS is recorded, and never credited twice.
 */
export type PaymentEventStatus =
  | 'detected'
  | 'matched'
  | 'confirmed'
  | 'unmatched'
  | 'mismatch'
  | 'duplicate'
  | 'rejected'
  | 'review_required';

/**
 * How the engine matched, and how much it trusts itself.
 *
 * Only `strong` auto-settles, and only when exactly one candidate reaches it.
 * `manual` means a person decided; the underlying signals are still stored, so
 * "the engine was sure" stays distinguishable from "the seller was sure".
 */
export type PaymentMatchStrength = 'strong' | 'medium' | 'weak' | 'manual';

export type PaymentMatchStatus = 'candidate' | 'accepted' | 'rejected';

export type PaymentAuditActor = 'seller' | 'system';

export type PaymentAccountRow = RowBase & {
  id: string;
  org_id: string;
  provider: PaymentProvider;
  /** Digits as the seller typed them. Matching uses the normalised form. */
  account_number: string;
  account_type: string;
  label: string | null;
  status: PaymentAccountStatus;
  is_active: boolean;
  created_by: string | null;
  updated_at: string;
  last_seen_at: string | null;
};

export type PaymentIntentRow = RowBase & {
  id: string;
  org_id: string;
  type: PaymentIntentType;
  /** orders.id for 'order'. Polymorphic, so deliberately not a foreign key. */
  reference_id: string | null;
  payment_account_id: string | null;
  expected_amount: number;
  currency: string;
  expected_customer_phone: string | null;
  expected_customer_name: string | null;
  status: PaymentIntentStatus;
  expires_at: string;
  settled_amount: number | null;
  settled_at: string | null;
  settled_payment_event_id: string | null;
  client_ref: string | null;
  created_by: string | null;
  updated_at: string;
};

export type PaymentEventRow = RowBase & {
  id: string;
  org_id: string;
  payment_account_id: string;
  provider: PaymentProvider;
  receiver_account: string;
  sender_account: string | null;
  amount: number;
  currency: string;
  transaction_id: string;
  transaction_timestamp: string | null;
  detected_at: string;
  source: PaymentEventSource;
  /** Hash of the raw transport message. Never the message itself. */
  fingerprint: string | null;
  status: PaymentEventStatus;
  receiver_account_normalized: string | null;
  sender_account_normalized: string | null;
  mismatch_reason: string | null;
  review_note: string | null;
  client_ref: string | null;
  detected_by: string | null;
  matched_intent_id: string | null;
  payment_id: string | null;
  created_by: string | null;
  updated_at: string;
};

/** No `updated_at`: a match row is a decision record, not mutable state. */
export type PaymentMatchRow = {
  id: string;
  created_at: string;
  org_id: string;
  payment_event_id: string;
  payment_intent_id: string;
  strength: PaymentMatchStrength;
  status: PaymentMatchStatus;
  reason_code: string;
  reason_detail: string | null;
  amount_delta: number | null;
  account_matched: boolean;
  provider_matched: boolean;
  amount_matched: boolean;
  /** null when the payer could not be verified -- distinct from false. */
  customer_phone_matched: boolean | null;
  within_window: boolean;
  created_by: string | null;
};

export type PaymentAuditLogRow = {
  /** bigint identity column, so a number rather than a string. */
  id: number;
  org_id: string;
  actor_kind: PaymentAuditActor;
  /** null when actor_kind is 'system': a machine is not a person. */
  actor_id: string | null;
  action: string;
  payment_event_id: string | null;
  payment_intent_id: string | null;
  payment_account_id: string | null;
  payment_match_id: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: Json;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Omit<ProfileRow, 'created_at' | 'updated_at'> & Partial<Pick<ProfileRow, 'created_at' | 'updated_at'>>;
        Update: Partial<Omit<ProfileRow, 'id'>>;
        Relationships: [];
      };
      organizations: {
        Row: OrganizationRow;
        Insert: Partial<Omit<OrganizationRow, 'id' | 'created_at' | 'updated_at'>> & Pick<OrganizationRow, 'name' | 'created_by'>;
        Update: Partial<Omit<OrganizationRow, 'id'>>;
        Relationships: [];
      };
      organization_members: {
        Row: OrganizationMemberRow;
        Insert: Partial<Omit<OrganizationMemberRow, 'id' | 'created_at'>> & Pick<OrganizationMemberRow, 'org_id' | 'user_id'>;
        Update: Partial<Omit<OrganizationMemberRow, 'id' | 'org_id' | 'user_id'>>;
        Relationships: [];
      };
      stores: {
        Row: StoreRow;
        Insert: Partial<Omit<StoreRow, 'id' | 'created_at' | 'updated_at'>> & Pick<StoreRow, 'org_id' | 'name'>;
        Update: Partial<Omit<StoreRow, 'id' | 'org_id'>>;
        Relationships: [];
      };
      products: {
        Row: ProductRow;
        Insert: Partial<Omit<ProductRow, 'id' | 'created_at' | 'updated_at'>> & Pick<ProductRow, 'org_id' | 'name'>;
        Update: Partial<Omit<ProductRow, 'id' | 'org_id'>>;
        Relationships: [];
      };
      product_variants: {
        Row: ProductVariantRow;
        Insert: Partial<Omit<ProductVariantRow, 'id' | 'created_at' | 'updated_at'>> & Pick<ProductVariantRow, 'org_id' | 'product_id' | 'name'>;
        Update: Partial<Omit<ProductVariantRow, 'id' | 'org_id' | 'product_id'>>;
        Relationships: [];
      };
      inventory: {
        Row: InventoryRow;
        Insert: Partial<Omit<InventoryRow, 'id' | 'created_at' | 'updated_at'>> & Pick<InventoryRow, 'org_id' | 'store_id' | 'product_id'>;
        Update: Partial<Omit<InventoryRow, 'id' | 'org_id' | 'store_id' | 'product_id'>>;
        Relationships: [];
      };
      order_forms: {
        Row: OrderFormRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      order_requests: {
        Row: OrderRequestRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      inventory_movements: {
        Row: InventoryMovementRow;
        Insert: Partial<Omit<InventoryMovementRow, 'id' | 'created_at'>> & Pick<InventoryMovementRow, 'org_id' | 'store_id' | 'product_id' | 'delta' | 'reason' | 'balance_after'>;
        Update: never;
        Relationships: [];
      };
      customers: {
        Row: CustomerRow;
        Insert: Partial<Omit<CustomerRow, 'id' | 'created_at' | 'updated_at'>> & Pick<CustomerRow, 'org_id' | 'name'>;
        Update: Partial<Omit<CustomerRow, 'id' | 'org_id'>>;
        Relationships: [];
      };
      orders: {
        Row: OrderRow;
        Insert: Partial<Omit<OrderRow, 'id' | 'created_at' | 'updated_at'>> & Pick<OrderRow, 'org_id' | 'store_id' | 'order_number'>;
        Update: Partial<Omit<OrderRow, 'id' | 'org_id' | 'store_id' | 'order_number'>>;
        Relationships: [];
      };
      order_items: {
        Row: OrderItemRow;
        Insert: Partial<Omit<OrderItemRow, 'id' | 'created_at'>> & Pick<OrderItemRow, 'org_id' | 'order_id' | 'product_name' | 'unit_price' | 'quantity' | 'line_total'>;
        Update: never;
        Relationships: [];
      };
      payments: {
        Row: PaymentRow;
        Insert: Partial<Omit<PaymentRow, 'id' | 'created_at'>> & Pick<PaymentRow, 'org_id' | 'store_id' | 'order_id' | 'amount'>;
        Update: never;
        Relationships: [];
      };
      expenses: {
        Row: ExpenseRow;
        Insert: Partial<Omit<ExpenseRow, 'id' | 'created_at' | 'updated_at'>> & Pick<ExpenseRow, 'org_id' | 'amount'>;
        Update: Partial<Omit<ExpenseRow, 'id' | 'org_id'>>;
        Relationships: [];
      };
      order_status_history: {
        Row: OrderStatusHistoryRow;
        Insert: Partial<Omit<OrderStatusHistoryRow, 'id' | 'created_at'>> & Pick<OrderStatusHistoryRow, 'org_id' | 'order_id' | 'to_status'>;
        Update: never;
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: Partial<Omit<NotificationRow, 'id' | 'created_at'>> & Pick<NotificationRow, 'org_id' | 'user_id' | 'kind' | 'title'>;
        Update: Partial<Omit<NotificationRow, 'id' | 'org_id' | 'user_id' | 'kind' | 'title'>>;
        Relationships: [];
      };
      notification_preferences: {
        Row: NotificationPreferenceRow;
        Insert: Partial<Omit<NotificationPreferenceRow, 'created_at' | 'updated_at'>> & Pick<NotificationPreferenceRow, 'org_id' | 'user_id'>;
        Update: Partial<Omit<NotificationPreferenceRow, 'created_at' | 'updated_at'>>;
        Relationships: [];
      };
      shipments: {
        Row: ShipmentRow;
        Insert: Partial<Omit<ShipmentRow, 'id' | 'created_at' | 'updated_at'>> & Pick<ShipmentRow, 'org_id' | 'store_id' | 'order_id' | 'provider' | 'idempotency_key'>;
        Update: Partial<Omit<ShipmentRow, 'id' | 'org_id' | 'store_id' | 'order_id'>>;
        Relationships: [];
      };
      shipment_events: {
        Row: ShipmentEventRow;
        Insert: Partial<Omit<ShipmentEventRow, 'id' | 'created_at'>> & Pick<ShipmentEventRow, 'org_id' | 'shipment_id' | 'label'>;
        Update: never;
        Relationships: [];
      };
      settlements: {
        Row: SettlementRow;
        Insert: Partial<Omit<SettlementRow, 'id' | 'created_at' | 'updated_at'>> & Pick<SettlementRow, 'org_id' | 'store_id' | 'order_id'>;
        Update: Partial<Omit<SettlementRow, 'id' | 'org_id' | 'store_id' | 'order_id'>>;
        Relationships: [];
      };
      courier_connections: {
        Row: CourierConnectionRow;
        Insert: Partial<Omit<CourierConnectionRow, 'id' | 'created_at' | 'updated_at'>> & Pick<CourierConnectionRow, 'org_id' | 'provider' | 'label'>;
        Update: Partial<Omit<CourierConnectionRow, 'id' | 'org_id'>>;
        Relationships: [];
      };
courier_locations: {
          Row: CourierLocationRow;
          Insert: Partial<Omit<CourierLocationRow, 'id' | 'created_at' | 'updated_at'>> & Pick<CourierLocationRow, 'org_id' | 'kind' | 'external_id' | 'name'>;
          Update: never;
          Relationships: [];
        };
        // Payment engine.
        //
        // `Insert: never` and `Update: never` are load-bearing, not shorthand.
        // 0024 revokes INSERT/UPDATE/DELETE from anon and authenticated, so a
        // direct write is already denied at runtime -- but a denied write is a
        // failed request someone will retry. Making the payload types `never`
        // turns any attempt to write the ledger from the app into a TypeScript
        // compile error instead, at the point of writing the code.
        //
        // Every mutation goes through an RPC below.
        payment_accounts: {
          Row: PaymentAccountRow;
          Insert: never;
          Update: never;
          Relationships: [];
        };
        payment_intents: {
          Row: PaymentIntentRow;
          Insert: never;
          Update: never;
          Relationships: [];
        };
        payment_events: {
          Row: PaymentEventRow;
          Insert: never;
          Update: never;
          Relationships: [];
        };
        payment_matches: {
          Row: PaymentMatchRow;
          Insert: never;
          Update: never;
          Relationships: [];
        };
        payment_audit_logs: {
          Row: PaymentAuditLogRow;
          Insert: never;
          Update: never;
          Relationships: [];
        };
      };
      Views: Record<string, never>;
    Functions: {
      // --- Payment engine (0022-0024) ---------------------------------------
      // These are the ONLY way the app touches the payment tables. Each one
      // re-authorises server-side; the client is never trusted for org_id.
      create_payment_account: {
        Args: {
          p_org_id: string;
          p_provider: PaymentProvider;
          p_account_number: string;
          p_account_type?: string;
          p_label?: string | null;
        };
        Returns: PaymentAccountRow;
      };
      set_payment_account_status: {
        Args: {
          p_account_id: string;
          p_status: PaymentAccountStatus;
          p_is_active?: boolean | null;
        };
        Returns: PaymentAccountRow;
      };
      create_payment_intent: {
        Args: {
          p_type: PaymentIntentType;
          p_reference_id: string | null;
          p_payment_account_id: string;
          p_expected_amount: number;
          p_expected_customer_phone?: string | null;
          p_expected_customer_name?: string | null;
          p_expires_at?: string | null;
          p_client_ref?: string | null;
        };
        Returns: PaymentIntentRow;
      };
      cancel_payment_intent: {
        Args: { p_intent_id: string; p_reason?: string | null };
        Returns: PaymentIntentStatus;
      };
      /**
       * The single write path for a detected payment.
       *
       * Idempotent on (provider, account, transaction id) at the database
       * level: re-delivering the same transaction returns the original event
       * with `duplicate: true` instead of creating a second ledger row.
       */
      ingest_payment_event: {
        Args: {
          p_payment_account_id: string;
          p_provider: PaymentProvider;
          p_receiver_account: string;
          p_sender_account: string | null;
          p_amount: number;
          p_transaction_id: string;
          p_transaction_timestamp?: string | null;
          p_source?: PaymentEventSource;
          p_fingerprint?: string | null;
          p_client_ref?: string | null;
          p_detected_by?: string | null;
        };
        /** `{ event_id, status, duplicate, message }` */
        Returns: Json;
      };
      /**
       * Scores every plausible intent and auto-settles only an unambiguous
       * strong match. A replay reports `already_processed: true` and
       * `settled: false`, so a retried request can never be mistaken for a fresh
       * confirmation.
       */
      match_payment_event: {
        Args: { p_event_id: string };
        Returns: Json;
      };
      /** The seller's decision. Everything automatic refuses is settleable here. */
      assign_payment_match: {
        Args: { p_event_id: string; p_intent_id: string; p_note?: string | null };
        Returns: Json;
      };
      reject_payment_match: {
        Args: { p_event_id: string; p_reason?: string | null };
        Returns: boolean;
      };
      expire_stale_payment_intents: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** Pure. Canonicalises a BD number to 01XXXXXXXXX for matching. */
      payment_normalize_bk_number: {
        Args: { p_raw: string };
        Returns: string;
      };
      /** Pure. Upay has no payment_method value and maps to 'other'. */
      payment_provider_method: {
        Args: { p_provider: PaymentProvider };
        Returns: PaymentMethod;
      };
      bootstrap_business: {
        Args: { p_business_name: string; p_store_name?: string | null; p_store_code?: string | null };
        Returns: Json;
      };
      delete_product: {
        Args: { p_product_id: string };
        Returns: boolean;
      };
      delete_customer: {
        Args: { p_customer_id: string };
        Returns: boolean;
      };
      create_order_form: {
        Args: { p_store_id: string; p_label?: string | null; p_expires_days?: number };
        Returns: Json;
      };
      revoke_order_form: {
        Args: { p_form_id: string };
        Returns: boolean;
      };
      decide_order_request: {
        Args: { p_request_id: string; p_status: string; p_order_id?: string | null };
        Returns: boolean;
      };
      public_order_form: {
        Args: { p_token: string };
        Returns: Json;
      };
      submit_order_request: {
        Args: { p_token: string; p_payload: Json };
        Returns: Json;
      };
      adjust_stock: {
        Args: {
          p_store_id: string;
          p_product_id: string;
          p_variant_id?: string | null;
          p_delta: number;
          p_reason: InventoryReason;
          p_note?: string | null;
        };
        Returns: number;
      };
      set_stock: {
        Args: {
          p_store_id: string;
          p_product_id: string;
          p_variant_id?: string | null;
          p_target: number;
          p_reason: InventoryReason;
          p_note?: string | null;
        };
        Returns: number;
      };
      create_order: {
        Args: {
          p_store_id: string;
          p_customer_id?: string | null;
          p_items: Json;
          p_discount?: number;
          p_delivery_charge?: number;
          p_amount_paid?: number;
          p_payment_method?: PaymentMethod;
          p_notes?: string | null;
          p_client_ref?: string | null;
          p_placed_at?: string | null;
          p_delivery_name?: string | null;
          p_delivery_phone?: string | null;
          p_delivery_address?: string | null;
          p_delivery_district?: string | null;
          p_delivery_thana?: string | null;
          p_courier_cost?: number;
          p_other_cost?: number;
          p_is_cod?: boolean;
        };
        Returns: string;
      };
      allowed_order_statuses: { Args: { p_order_id: string }; Returns: OrderStatus[] };
      set_order_status: {
        Args: { p_order_id: string; p_to_status: OrderStatus; p_note?: string | null };
        Returns: OrderStatus;
      };
      record_payment: {
        Args: {
          p_order_id: string;
          p_amount: number;
          p_method?: PaymentMethod;
          p_paid_at?: string | null;
          p_note?: string | null;
          /** Added in 0012. A retry with the same key records the money once. */
          p_idempotency_key?: string | null;
        };
        Returns: number;
      };
      record_refund: {
        Args: {
          p_order_id: string;
          p_amount: number;
          p_method?: PaymentMethod;
          p_note?: string | null;
          /** Added in 0012. A retry with the same key refunds once. */
          p_idempotency_key?: string | null;
        };
        Returns: number;
      };
      get_dashboard: { Args: { p_store_id: string; p_today: string }; Returns: Json };
      get_customer_stats: { Args: { p_customer_id: string }; Returns: Json };
      get_sales_report: { Args: { p_store_id: string; p_from: string; p_to: string }; Returns: Json };
      get_top_products: {
        Args: { p_store_id: string; p_from: string; p_to: string; p_limit?: number };
        Returns: Json[];
      };

      // ---- Courier ------------------------------------------------------
      courier_supports_api: { Args: { p_provider: CourierProvider }; Returns: boolean };
      order_dispatch_blocker: { Args: { p_order_id: string }; Returns: string | null };
      register_shipment: {
        Args: {
          p_order_id: string;
          p_provider: CourierProvider;
          p_idempotency_key: string;
          p_connection_id?: string | null;
          p_cod_amount?: number | null;
          p_tracking_id?: string | null;
          p_tracking_url?: string | null;
          p_external_payload?: Json | null;
        };
        Returns: Json;
      };
      confirm_shipment: {
        Args: {
          p_shipment_id: string;
          p_tracking_id: string;
          p_tracking_url?: string | null;
          p_courier_charge?: number | null;
          p_external_status?: string | null;
          p_external_status_label?: string | null;
          p_external_payload?: Json | null;
        };
        Returns: Json;
      };
      fail_shipment: {
        Args: {
          p_shipment_id: string;
          p_reason: string;
          p_state?: ShipmentState;
          p_external_status?: string | null;
        };
        Returns: Json;
      };
      apply_shipment_update: {
        Args: {
          p_shipment_id: string;
          p_state: ShipmentState;
          p_label: string;
          p_external_status?: string | null;
          p_source?: string;
          p_occurred_at?: string | null;
          p_delivered_at?: string | null;
        };
        Returns: Json;
      };
      record_settlement: {
        Args: {
          p_order_id: string;
          p_state: SettlementState;
          p_amount?: number | null;
          p_payout_reference?: string | null;
          p_notes?: string | null;
        };
        Returns: Json;
      };
      get_couriers: { Args: { p_org_id: string }; Returns: Json };
      get_courier_locations: { Args: { p_org_id: string; p_parent?: string | null }; Returns: Json };

      // ---- Operations ---------------------------------------------------
      get_analytics: { Args: { p_store_id: string; p_from: string; p_to: string }; Returns: Json };
      get_product_performance: {
        Args: { p_store_id: string; p_from: string; p_to: string; p_limit?: number };
        Returns: Json;
      };
      get_finance: { Args: { p_store_id: string; p_from: string; p_to: string }; Returns: Json };
      get_product_stats: {
        Args: {
          p_store_id: string;
          p_product_id: string;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      find_duplicate_customers: {
        Args: { p_org_id: string; p_name: string; p_phone: string; p_limit?: number };
        Returns: Json;
      };
      order_status_label: { Args: { p_status: OrderStatus }; Returns: string };
    };
    Enums: {
      member_role: MemberRole;
      order_status: OrderStatus;
      payment_status: PaymentStatus;
      payment_method: PaymentMethod;
      inventory_reason: InventoryReason;
      expense_category: ExpenseCategory;
      notification_kind: NotificationKind;
      courier_provider: CourierProvider;
      shipment_state: ShipmentState;
settlement_state: SettlementState;
        payment_event_source: PaymentEventSource;
        payment_provider: PaymentProvider;
        payment_account_status: PaymentAccountStatus;
        payment_intent_type: PaymentIntentType;
        payment_intent_status: PaymentIntentStatus;
        payment_event_status: PaymentEventStatus;
        payment_match_strength: PaymentMatchStrength;
        payment_match_status: PaymentMatchStatus;
        payment_audit_actor: PaymentAuditActor;
      };
    CompositeTypes: Record<string, never>;
  };
}

/** Convenience alias for a row of table `T`. */
export type TableRow<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

/** Convenience alias for the insert payload of table `T`. */
export type TableInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
