/**
 * Creates a real seller account for on-device verification.
 *
 * Distinct from the probes: this one is NOT deleted immediately, because the point
 * is to sign in with it on the emulator. It prints the credentials so the UI can be
 * driven by hand, and `cleanup-device-account.mjs` removes it afterwards.
 *
 * The email carries a `devtest` prefix so cleanup can find it, and so an account
 * left behind by an interrupted run is identifiable rather than looking like a real
 * seller.
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Supabase env not set.');
  process.exit(1);
}

const PASSWORD = 'DeviceTest-2026-xk9';
const stamp = Date.now();
const email = `devtest-${stamp}@example.invalid`;
const fullName = 'Device Test Seller';
const businessName = `Device Test Biz ${stamp}`;

const client = createClient(url, anonKey, { auth: { persistSession: false } });

const { data, error } = await client.auth.signUp({
  email,
  password: PASSWORD,
  options: { data: { full_name: fullName } },
});
if (error) {
  console.error('signUp failed:', error.message);
  process.exit(1);
}

const { data: boot, error: bootError } = await client.rpc('bootstrap_business', {
  p_business_name: businessName,
  p_store_name: null,
  p_store_code: null,
});
if (bootError) {
  console.error('bootstrap_business failed:', bootError.message);
  process.exit(1);
}

const orgId = boot?.id ?? boot?.org_id;

const { error: accountError } = await client.rpc('create_payment_account', {
  p_org_id: orgId,
  p_provider: 'bkash',
  p_account_number: '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  p_account_type: 'personal',
  p_label: null,
});
if (accountError) console.error('create_payment_account failed (continuing):', accountError.message);

const { data: stores } = await client.from('stores').select('id, code, name').eq('org_id', orgId).limit(1);
const storeId = stores?.[0]?.id;

/*
 * SEED DATA
 *
 * An empty business proves only that the empty states work. Verifying products,
 * customers and orders means looking at rows, and at arithmetic computed from them, so
 * this seeds enough of a shop to drive every Phase 6 screen.
 *
 * Two products on purpose, differing in the one way that matters for honesty: one has
 * a cost price and one does not. Any screen that shows a confident profit figure for
 * the second is wrong, and a seeded shop is where that shows up.
 */
const catalogue = [
  { name: 'Cotton Saree', sku: 'SAR-001', selling_price: 1200, cost_price: 700, threshold: 3, qty: 12 },
  { name: 'TWS Earbuds', sku: 'EAR-009', selling_price: 950, cost_price: null, threshold: 5, qty: 8 },
  { name: 'Unstitched Three Piece', sku: 'TPC-014', selling_price: 1650, cost_price: 1100, threshold: 2, qty: 4 },
];

const seeded = { products: [], customers: [], orders: [] };

for (const item of catalogue) {
  const { data: product, error: productError } = await client
    .from('products')
    .insert({
      org_id: orgId,
      name: item.name,
      sku: item.sku,
      selling_price: item.selling_price,
      cost_price: item.cost_price,
      low_stock_threshold: item.threshold,
      track_inventory: true,
    })
    .select()
    .single();

  if (productError) {
    console.error(`product ${item.name} failed:`, productError.message);
    continue;
  }
  seeded.products.push(product.id);

  // Stock goes through adjust_stock so the ledger has a real opening entry.
  const { error: stockError } = await client.rpc('adjust_stock', {
    p_store_id: storeId,
    p_product_id: product.id,
    p_variant_id: null,
    p_delta: item.qty,
    p_reason: 'initial',
    p_note: 'device test opening stock',
  });
  if (stockError) console.error(`stock ${item.name} failed:`, stockError.message);
}

for (const person of [
  { name: 'Rakib Hasan', phone: '01712345678', district: 'Dhaka', thana: 'Mirpur' },
  { name: 'Nusrat Jahan', phone: '01812345679', district: 'Dhaka', thana: 'Uttara' },
  { name: 'Shahin Alam', phone: '01912345680', district: 'Chattogram', thana: 'Kotwali' },
]) {
  const { data: customer, error: customerError } = await client
    .from('customers')
    .insert({ org_id: orgId, ...person, address: 'House 4, Road 7' })
    .select()
    .single();

  if (customerError) console.error(`customer ${person.name} failed:`, customerError.message);
  else seeded.customers.push(customer.id);
}

// One paid order, one cash-on-delivery order, and one cancelled. Between them they
// exercise the payment boundary, the COD receivable and a restock.
if (seeded.products.length >= 2 && seeded.customers.length >= 1) {
  const orders = [
    {
      label: 'paid',
      args: {
        items: [{ product_id: seeded.products[0], variant_id: null, quantity: 2, line_discount: 0 }],
        delivery_charge: 0,
        amount_paid: 2400,
        is_cod: false,
      },
    },
    {
      label: 'cod',
      args: {
        items: [{ product_id: seeded.products[1], variant_id: null, quantity: 1, line_discount: 0 }],
        delivery_charge: 60,
        amount_paid: 0,
        is_cod: true,
      },
    },
    {
      label: 'unpaid',
      args: {
        items: [{ product_id: seeded.products[2], variant_id: null, quantity: 1, line_discount: 0 }],
        delivery_charge: 0,
        amount_paid: 0,
        is_cod: false,
      },
    },
  ];

  for (const order of orders) {
    const { data: orderId, error: orderError } = await client.rpc('create_order', {
      p_store_id: storeId,
      p_customer_id: seeded.customers[0],
      p_items: order.args.items,
      p_discount: 0,
      p_delivery_charge: order.args.delivery_charge,
      p_amount_paid: order.args.amount_paid,
      p_payment_method: 'cash',
      p_notes: `device test ${order.label}`,
      p_client_ref: crypto.randomUUID(),
      p_is_cod: order.args.is_cod,
      p_delivery_address: order.args.is_cod ? 'House 4, Road 7, Mirpur' : null,
      p_delivery_thana: order.args.is_cod ? 'Mirpur' : null,
      p_delivery_district: order.args.is_cod ? 'Dhaka' : null,
    });

    if (orderError) console.error(`order ${order.label} failed:`, orderError.message);
    else if (typeof orderId === 'string') seeded.orders.push({ label: order.label, id: orderId });
  }

  // Move the unpaid one along so the pipeline has more than one stage on screen.
  if (seeded.orders.find((o) => o.label === 'unpaid')) {
    const { error: moveError } = await client.rpc('set_order_status', {
      p_order_id: seeded.orders.find((o) => o.label === 'unpaid').id,
      p_to_status: 'confirmed',
      p_note: 'device test',
    });
    if (moveError) console.error('status move failed:', moveError.message);
  }
}

console.log(
  JSON.stringify(
    {
      email,
      password: PASSWORD,
      orgId,
      store: stores?.[0],
      stamp,
      seeded: {
        products: seeded.products.length,
        customers: seeded.customers.length,
        orders: seeded.orders.length,
      },
    },
    null,
    2,
  ),
);

/*
 * Persisted so cleanup does not need to be told the email, and so an interrupted
 * run leaves a recoverable record rather than an unidentifiable orphan.
 */
const { writeFileSync } = await import('node:fs');
writeFileSync('.device-test-account.json', JSON.stringify({ email, stamp }, null, 2));
void spawnSync;
