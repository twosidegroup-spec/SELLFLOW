/**
 * Payment boundary: the client cannot write the ledger, and the native SMS
 * adapter stays inside its contract.
 *
 * These are static assertions over the source rather than runtime tests, and
 * that is the point. The rules being defended are architectural:
 *
 *   * The five payment tables are readable and NOT writable from the app. The
 *     database enforces this with revoked grants (migration 0024); this enforces
 *     it at authoring time by failing the build when the types say `never` and
 *     when someone reaches past them.
 *   * Every payment mutation goes through the engine's RPCs. A new one cannot be
 *     added without being listed here, so the trust boundary stays reviewable.
 *   * record_payment is not called from the payment feature. Settlement belongs
 *     to the engine; a client-side shortcut would bypass the audit trail.
 *
 * Phase 2 replaced the last two assertions, which asserted that no SMS
 * permission and no receiver existed, with a larger set about what the adapter
 * must now do instead. Nothing was removed to make room: the previous rule
 * ("app.json declares no SMS permission") is still enforced verbatim, and the new
 * rules are strictly additional -- permission surface, no inbox access, no raw
 * message retention anywhere, no service-role key, no matching in the client, and
 * ingestion through exactly one function.
 *
 * It also pins the data the review queue needs, so "why didn't SellFlow match
 * this?" cannot silently lose its answer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const REPO = resolve(import.meta.dirname, '..');
const SRC = join(REPO, 'src');
const MODULE = join(REPO, 'modules', 'sellflow-sms');
const PLUGIN = join(REPO, 'plugins', 'withSellflowSms.js');

const PAYMENT_TABLES = [
  'payment_accounts',
  'payment_intents',
  'payment_events',
  'payment_matches',
  'payment_audit_logs',
];

/**
 * Money functions that predate the engine and are still legitimately called by
 * the app -- record_payment is how a seller records a cash payment by hand.
 *
 * They are NOT engine functions. The engine calls record_payment itself; the
 * payment feature must not (asserted separately below). The orders feature is the
 * one caller allowed to invoke it directly.
 */
const LEGACY_MONEY_RPCS = new Set(['record_payment', 'record_refund']);
const ENGINE_RPCS = new Set([
  'create_payment_account',
  'set_payment_account_status',
  'create_payment_intent',
  'cancel_payment_intent',
  'ingest_payment_event',
  'match_payment_event',
  'assign_payment_match',
  'reject_payment_match',
  'expire_stale_payment_intents',
  'payment_normalize_bk_number',
  'payment_provider_method',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every file under a directory, any extension. For the native module's Kotlin. */
function walkAll(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (f) => relative(REPO, f).replace(/\\/g, '/');
const read = (f) => readFileSync(f, 'utf8');

/**
 * Removes comments before scanning.
 *
 * This matters more than it looks. features/payments/mutations.ts documents its
 * own guarantee in prose -- "there is no `.insert()`, no `.update()`" -- so a
 * scanner that reads comments reports that file as violating the very rule it
 * states. The comment is worth keeping; the scanner has to be the smarter one.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

/** Source with comments removed, for pattern scanning. */
function code(f) {
  return stripComments(read(f));
}

describe('payment boundary', () => {
  test('all five payment tables exist in the generated types', () => {
    const types = read(join(SRC, 'lib', 'database.types.ts'));
    for (const table of PAYMENT_TABLES) {
      assert.ok(
        types.includes(`${table}: {`),
        `${table} must be declared in database.types.ts`,
      );
    }
  });

  test('payment tables are Insert: never and Update: never', () => {
    const types = read(join(SRC, 'lib', 'database.types.ts'));

    for (const table of PAYMENT_TABLES) {
      const start = types.indexOf(`${table}: {`);
      assert.ok(start > -1, `${table} missing`);
      // The block is short and fixed-shape; a window is enough and avoids
      // depending on the exact formatting of the file.
      const block = types.slice(start, start + 400);

      assert.match(block, /Insert: never;/, `${table} must be Insert: never`);
      assert.match(block, /Update: never;/, `${table} must be Update: never`);
    }
  });

  test('no source file writes a payment table directly', () => {
    const writeCalls = /\.(insert|upsert|update|delete)\s*\(/;
    const offenders = [];

    for (const file of files) {
      const src = code(file);

      for (const match of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
        const table = match[1];
        if (!PAYMENT_TABLES.includes(table)) continue;

        // Look only at the statement the .from() belongs to, so an unrelated
        // later .update() in the same file is not misattributed.
        const statement = src.slice(match.index, match.index + 400).split(';')[0];
        if (writeCalls.test(statement)) {
          offenders.push(`${rel(file)} -> .from('${table}') then a write call`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `the app must never write payment tables directly:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the payment feature contains no table writes at all', () => {
    const dir = join(SRC, 'features', 'payments');
    assert.ok(existsSync(dir), 'features/payments must exist');

    const offenders = [];
    for (const file of walk(dir)) {
      const src = code(file);
      if (/\.(insert|upsert|delete)\s*\(/.test(src)) {
        offenders.push(`${rel(file)} contains an insert/upsert/delete call`);
      }
      if (/\.update\s*\(/.test(src)) {
        offenders.push(`${rel(file)} contains an update call`);
      }
    }

    assert.deepEqual(offenders, [], offenders.join('\n  '));
  });

  test('every payment RPC the app calls is a known engine function', () => {
    const called = new Map();

    for (const file of files) {
      const src = code(file);
      for (const match of src.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)) {
        const name = match[1];
        if (!called.has(name)) called.set(name, new Set());
        called.get(name).add(rel(file));
      }
    }

    const paymentish = [...called.keys()].filter(
      (n) => n.startsWith('payment_') || n.includes('payment') || n.startsWith('match_') || n.startsWith('assign_') || n.startsWith('ingest_'),
    );

    const unknown = paymentish.filter(
      (n) => !ENGINE_RPCS.has(n) && !LEGACY_MONEY_RPCS.has(n),
    );

    assert.deepEqual(
      unknown,
      [],
      `these payment RPCs are not in the reviewed allow-lists:\n  ${unknown.join('\n  ')}`,
    );

    // A legacy money RPC may only be called from the orders feature, which is
    // the manual-payment path. Anywhere else it is a bypass.
    for (const [name, callers] of called) {
      if (!LEGACY_MONEY_RPCS.has(name)) continue;
      for (const caller of callers) {
        assert.ok(
          caller.startsWith('src/features/orders/'),
          `${name} is only for the manual-payment path; ${caller} must go through the payment engine instead`,
        );
      }
    }

    // The engine surface the app actually depends on should not shrink silently.
    for (const required of [
      'create_payment_account',
      'create_payment_intent',
      'ingest_payment_event',
      'match_payment_event',
      'assign_payment_match',
      'reject_payment_match',
    ]) {
      assert.ok(called.has(required), `the app should call ${required}`);
    }
  });

  test('the payment feature never calls record_payment directly', () => {
    for (const file of walk(join(SRC, 'features', 'payments'))) {
      const src = code(file);
      assert.ok(
        !/rpc\(\s*['"]record_payment['"]/.test(src),
        `${rel(file)} calls record_payment. Settlement belongs to the engine: the engine calls it, so the audit trail records the event as the cause.`,
      );
    }
  });

  test('the four payment screens exist and are registered', () => {
    const screens = [
      'src/app/(app)/payments.tsx',
      'src/app/(app)/payment-review.tsx',
      'src/app/(app)/payment-account/new.tsx',
      'src/app/(app)/payment-intent/new.tsx',
    ];

    for (const screen of screens) {
      assert.ok(existsSync(join(REPO, screen)), `${screen} must exist`);
    }

    const layout = read(join(SRC, 'app', '(app)', '_layout.tsx'));
    for (const name of [
      'payments',
      'payment-review',
      'payment-account/new',
      'payment-intent/new',
    ]) {
      assert.ok(
        layout.includes(`name="${name}"`),
        `${name} must be registered in the (app) stack`,
      );
    }
  });

  test('payment screens read through the feature layer, not the tables', () => {
    const screens = [
      'src/app/(app)/payments.tsx',
      'src/app/(app)/payment-review.tsx',
      'src/app/(app)/payment-account/new.tsx',
      'src/app/(app)/payment-intent/new.tsx',
    ];

    for (const screen of screens) {
      const src = code(join(REPO, screen));

      assert.ok(
        /@\/features\/payments\//.test(src),
        `${screen} should take payment data from @/features/payments`,
      );

      // No direct Supabase table access for payment tables.
      for (const table of PAYMENT_TABLES) {
        assert.ok(
          !new RegExp(`\\.from\\(\\s*['"]${table}['"]`).test(src),
          `${screen} must not read payment table '${table}' directly`,
        );
      }

      assert.ok(
        !/getSupabase\(\)/.test(src),
        `${screen} should not hold a Supabase client; mutations belong in the feature layer`,
      );
    }
  });

  test('the review queue can answer why a payment did not match', () => {
    // The queue selects '*', so the columns it can show are guaranteed by the
    // row type rather than by the select string. Assert the guarantee where it
    // actually lives.
    const types = read(join(SRC, 'lib', 'database.types.ts'));
    const start = types.indexOf('export type PaymentEventRow');
    assert.ok(start > -1, 'PaymentEventRow must exist');
    const rowType = types.slice(start, types.indexOf('export type PaymentMatchRow'));

    for (const column of [
      'amount',
      'provider',
      'receiver_account',
      'sender_account',
      'transaction_id',
      'detected_at',
      'mismatch_reason',
      'status',
      'payment_account_id',
    ]) {
      assert.ok(
        rowType.includes(column),
        `PaymentEventRow must carry ${column} for the review queue to show it`,
      );
    }

    const queries = read(join(SRC, 'features', 'payments', 'queries.ts'));

    // Rejected candidates must be readable, or a seller cannot see why an order
    // was ruled out.
    assert.ok(
      queries.includes('payment_matches'),
      'the review queue must read payment_matches, including rejected candidates',
    );

    // The queue must select the states that need a human, and must not select
    // the ones already settled.
    assert.ok(
      queries.includes("'review_required'"),
      'the queue must include payments awaiting a decision',
    );
    assert.ok(queries.includes("'unmatched'"), "the queue must include payments with no waiting order");
  });

  test('the review screen surfaces the refusal reason and candidates', () => {
    const screen = read(join(REPO, 'src/app/(app)/payment-review.tsx'));

    for (const needle of [
      'reasonCopy', // machine reason -> seller-facing sentence
      'PaymentEventStatusBadge',
      'PaymentMatchBadge', // confidence per candidate
      'payment_matches', // candidates, not just the winner
      'transaction_id',
      'sender_account',
      'providerLabel',
    ]) {
      assert.ok(screen.includes(needle), `payment-review must use ${needle}`);
    }
  });

  test('the intent form takes its amount and order from the real order', () => {
    const form = read(join(REPO, 'src/app/(app)/payment-intent/new.tsx'));

    assert.ok(form.includes('useOrderPaymentContext'), 'must read the actual order');
    assert.ok(form.includes('outstanding'), 'must default to the outstanding amount');
    assert.ok(form.includes('useCreatePaymentIntent'), 'must create a real intent');
    // toMajor, not money(): money() is the read path and would multiply by 100.
    assert.ok(
      form.includes('toMajor'),
      'expected_amount is a major-unit column and must use toMajor',
    );
  });

  test('the account form uses the real RPC and shows the canonical number', () => {
    const form = read(join(REPO, 'src/app/(app)/payment-account/new.tsx'));

    assert.ok(form.includes('useCreatePaymentAccount'), 'must use the real mutation');
    assert.ok(form.includes('normalizeBdNumber'), 'must normalise what was typed');
    assert.ok(
      form.includes('features/payments/normalize'),
      'must use the shared, tested normaliser rather than a second copy',
    );
  });

  // ---------------------------------------------------------------------------
  // Native SMS adapter -- Phase 2
  //
  // Phase 1 ended with two assertions that read "no SMS permission exists
  // anywhere" and "no SMS parsing or receiver has been implemented yet". Both are
  // gone, and in their place is a set of rules about what the adapter IS allowed
  // to do. That is a stricter position, not a looser one: before, any SMS code at
  // all failed the build; now, specific SMS code passes and specific violations
  // fail.
  // ---------------------------------------------------------------------------

  test('no SMS permission is declared in app configuration', () => {
    // Still true, and deliberately still asserted.
    //
    // RECEIVE_SMS reaches the manifest through plugins/withSellflowSms.js rather
    // than through app.json, so the configuration a reviewer reads does not quietly
    // grow a restricted permission next to the icon paths. The plugin is the whole
    // native SMS surface and has its own assertions below.
    const appJson = read(join(REPO, 'app.json'));
    const easJson = read(join(REPO, 'eas.json'));
    const combined = `${appJson}\n${easJson}`;

    for (const permission of [
      'RECEIVE_SMS',
      'READ_SMS',
      'SEND_SMS',
      'WRITE_SMS',
      'RECEIVE_MMS',
      'RECEIVE_WAP_PUSH',
      'READ_CALL_LOG',
      'WRITE_CALL_LOG',
    ]) {
      assert.ok(
        !combined.includes(permission),
        `${permission} must not be declared in app.json or eas.json`,
      );
    }
  });

  test('the native SMS surface lives in one config plugin', () => {
    assert.ok(existsSync(PLUGIN), 'plugins/withSellflowSms.js must exist');

    const appJson = read(join(REPO, 'app.json'));
    assert.match(
      appJson,
      /"\.\/plugins\/withSellflowSms"/,
      'app.json must register the plugin, or no permission is granted and no receiver runs',
    );

    const plugin = require(PLUGIN);

    // Exactly the permission the feature needs, and nothing else.
    assert.equal(plugin.RECEIVE_SMS, 'android.permission.RECEIVE_SMS');
    assert.equal(
      plugin.SMS_RECEIVED_ACTION,
      'android.provider.Telephony.SMS_RECEIVED',
    );
    assert.equal(plugin.RECEIVER_CLASS, 'com.sellflow.sms.SellflowSmsReceiver');

    const granted = ['android.permission.RECEIVE_SMS'];
    const forbidden = [
      'android.permission.READ_SMS',
      'android.permission.SEND_SMS',
      'android.permission.WRITE_SMS',
      'android.permission.RECEIVE_MMS',
      'android.permission.RECEIVE_WAP_PUSH',
      // Gates SMS_DELIVER, which only the default SMS app may receive. SellFlow is
      // not a default SMS handler, so requesting it would be requesting a
      // permission this feature cannot use.
      'android.permission.BROADCAST_SMS',
      'android.permission.BROADCAST_WAP_PUSH',
      'android.permission.READ_CONTACTS',
      'android.permission.GET_ACCOUNTS',
      'android.permission.READ_CALL_LOG',
      'android.permission.WRITE_CALL_LOG',
    ];

    for (const permission of forbidden) {
      assert.ok(
        !granted.includes(permission),
        `${permission} must never be requested: reading the inbox is a far broader permission than reading one payment notification`,
      );
      assert.ok(
        plugin.FORBIDDEN_PERMISSIONS.includes(permission),
        `${permission} must be on the plugin's removal list, so an unrelated edit cannot widen the permission surface`,
      );
    }

    // The plugin's own source may not name a forbidden permission as something it
    // adds. `FORBIDDEN_PERMISSIONS` is the only legitimate place they appear, and
    // they have to appear there, so the check is on the add path rather than the
    // whole file.
    const added = plugin.FORBIDDEN_PERMISSIONS.filter((permission) =>
      new RegExp(`buildPermission[^}]*${permission.replace(/\./g, '\\.')}`).test(plugin),
    );
    assert.deepEqual(added, [], 'buildPermission must only ever add RECEIVE_SMS');
  });

  test('the module manifest declares no SMS surface of its own', () => {
    // Everything comes from the plugin. A library manifest arriving through
    // autolinking would make the permission diff invisible, which is what
    // docs/google-play-sms-policy.md forbids.
    //
    // Comments are stripped first, and they have to be: the file explains at length
    // why it is empty, and an unstripped scan reports the explanation as a
    // violation.
    // XML comments are stripped too, and they have to be: the file explains at
    // length why it is empty, and an unstripped scan reports the explanation as a
    // violation.
    const manifest = read(join(MODULE, 'android', 'src', 'main', 'AndroidManifest.xml'))
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');

    for (const token of ['uses-permission', 'receiver', 'SMS', 'sms']) {
      assert.ok(
        !manifest.includes(token),
        `the module manifest must not declare ${token}: the plugin owns the whole SMS surface`,
      );
    }
  });

  test('JavaScript never touches the SMS transport or a message body', () => {
    // The privacy contract's enforcement point. If any of these appear in src/, the
    // app has started reading messages itself instead of receiving normalised
    // candidates from the native layer, and every guarantee about storage and
    // transmission is no longer structurally true.
    //
    // RECEIVE_SMS is deliberately absent from this list. JavaScript is *supposed* to
    // name it: `PermissionsAndroid.PERMISSIONS.RECEIVE_SMS` is how the OS prompt is
    // raised, and React Native already knows the constant. What matters is that the
    // name appears only in a permission request and never as a declared permission,
    // which the app-configuration assertion above covers.
    const banned = [
      /Telephony\./,
      /BroadcastReceiver/,
      /getMessagesFromIntent/,
      /\bSmsMessage\b/,
      /pdus/i,
      /sms_body/i,
      /content:\/\/sms/,
      /SmsManager/,
      /createFromPdu/,
    ];

    const offenders = [];
    for (const file of files) {
      const src = code(file);
      for (const pattern of banned) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `JavaScript must never handle the SMS transport:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('no raw message body is persisted, transmitted or logged', () => {
    // The queue record and everything the adapter sends are checked by shape: the
    // forbidden keys cannot appear in the durable type, and the ingest payload is
    // built in exactly one function, which is asserted to contain none of them.
    const smsDir = join(SRC, 'features', 'payments', 'sms');
    assert.ok(existsSync(smsDir), 'features/payments/sms must exist');

    const forbiddenKeys = [
      /['"`]messageBody['"`]/,
      /['"`]body['"`]\s*:/,
      /['"`]sms_body['"`]/,
      /['"`]message['"`]\s*:/,
      /['"`]text['"`]\s*:/,
    ];

    const offenders = [];
    for (const file of walk(smsDir)) {
      const src = code(file);
      for (const pattern of forbiddenKeys) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `the adapter stores structured fields, never message text:\n  ${offenders.join('\n  ')}`,
    );

    // The only deliberate exception: the development diagnostics panel, which
    // takes a pasted string to parse in memory. It must be the single occurrence,
    // it must be behind __DEV__, and it must not reach the queue.
    // Comments are stripped, because this file explains in prose that the
    // output has no path to ingestion, and a scan that read the explanation would
    // report it as a violation.
    const diagnostics = code(join(smsDir, 'diagnostics.ts'));
    assert.ok(
      /parseMessageForDiagnostics/.test(diagnostics),
      'diagnostics must go through the native parser',
    );
    assert.ok(
      !/ingest_payment_event/.test(diagnostics),
      'diagnostics must have no path to the ingestion boundary',
    );
    assert.ok(
      !/writeJson|writeString|AsyncStorage|readQueue|writeQueue/.test(diagnostics),
      'diagnostics must not read or write storage',
    );

    const screen = read(join(SRC, 'app', '(app)', 'payment-sms.tsx'));
    // Matched as a shape rather than a literal so the guard survives the panel
    // gaining or losing a prop. The security property is all three parts: it is a
    // `__DEV__ ? ... : null` ternary, the truthy branch is the panel itself, and the
    // false branch is null. A raw message body must have no route into a production
    // bundle, so this cannot be relaxed to "it renders somewhere in development".
    assert.match(
      screen,
      /\{__DEV__\s*\?\s*<DiagnosticsPanel\b[^>]*\/>\s*:\s*null\}/,
      'the diagnostics panel must only render in a development build',
    );

    // Exactly one caller, and it is the dev-only screen.
    //
    // The individual guarantees above would each still hold if a second caller
    // appeared somewhere that could persist its result -- a cache, an analytics
    // breadcrumb, an error report. A pasted message body is the one piece of data in
    // this feature that a human can put into it, so the surface that accepts one has
    // to stay a single, development-gated screen rather than a reusable helper.
    const callers = walkAll(SRC).filter((file) => {
      const relativePath = relative(REPO, file).replace(/\\/g, '/');
      // The module that *defines* runDiagnostics is not a caller.
      if (relativePath === 'src/features/payments/sms/diagnostics.ts') return false;
      return /\b(runDiagnostics|parseMessageForDiagnostics)\b/.test(readFileSync(file, 'utf8'));
    });
    assert.deepEqual(
      callers.map((file) => relative(REPO, file).replace(/\\/g, '/')),
      ['src/app/(app)/payment-sms.tsx'],
      'only the development diagnostics screen may parse a pasted message',
    );

    // And the dev panel must clear what it was given, so the raw text cannot be
    // screenshotted out of the field after the parse has read it.
    const parseAt = screen.indexOf('runDiagnostics({');
    const clearAt = screen.indexOf("setText('')");
    assert.ok(
      parseAt > -1 && clearAt > parseAt,
      'the parser check must clear the pasted message once it has been parsed',
    );
  });

  test('the native module keeps the message body inside one function', () => {
    const kotlinRoot = join(MODULE, 'android', 'src');
    assert.ok(existsSync(kotlinRoot), 'the native module must exist');

    // messageBody may be read by a provider adapter and by the parser pipeline. It
    // must never be copied onto a candidate, a queue row, an event map or a log, so
    // the files that touch it are enumerated rather than trusted.
    //
    // The test tree is excluded: ProviderParserTest deliberately names the field to
    // assert on it, which is how the leak would be caught rather than committed.
    const mainRoot = join(kotlinRoot, 'main');
    assert.ok(existsSync(mainRoot), 'the module must have main sources');

    const filesThatReadIt = [];
    for (const file of walkAll(mainRoot)) {
      const src = readFileSync(file, 'utf8');
      if (/\bmessageBody\b/.test(src)) {
        filesThatReadIt.push(relative(REPO, file).replace(/\\/g, '/'));
      }
    }

    assert.ok(
      filesThatReadIt.length > 0,
      'the message body must be read somewhere, or the fixtures prove nothing',
    );

    const allowed = [
      'providers/BkashAdapter.kt',
      'providers/NagadAdapter.kt',
      'providers/RocketAdapter.kt',
      'providers/UpayAdapter.kt',
      'providers/ProviderAdapter.kt',
      'providers/ProviderRegistry.kt',
      'SellflowSmsReceiver.kt',
      'SellflowSmsModule.kt',
    ];

    for (const file of filesThatReadIt) {
      assert.ok(
        allowed.some((suffix) => file.endsWith(suffix)),
        `${file} must not handle a raw message body: only the parsing pipeline may`,
      );
    }

    // The queue and the candidate are the two artefacts that outlive a message, so
    // they are asserted explicitly rather than by enumeration.
    const queue = readFileSync(
      join(mainRoot, 'java', 'com', 'sellflow', 'sms', 'CandidateQueue.kt'),
      'utf8',
    );
    assert.ok(
      !/\bmessageBody\b/.test(queue),
      'CandidateQueue must never see a message body: it is the durable artefact',
    );

    const module = readFileSync(
      join(mainRoot, 'java', 'com', 'sellflow', 'sms', 'SellflowSmsModule.kt'),
      'utf8',
    );
    // The only permitted appearance is the diagnostics entry point's parameter,
    // which exists so a real captured message can be checked against the real
    // parser. What must not exist is any path from there to a queue row.
    assert.ok(
      !/put\(KEY_BODY|messageBody,/.test(module),
      'the event map must never carry message text',
    );
  });

  test('the adapter posts through exactly one ingestion function', () => {
    const smsDir = join(SRC, 'features', 'payments', 'sms');

    const callers = new Map();
    for (const file of walk(smsDir)) {
      const src = code(file);
      for (const match of src.matchAll(/ingest_payment_event|match_payment_event/g)) {
        const name = match[0];
        if (!callers.has(name)) callers.set(name, new Set());
        callers.get(name).add(rel(file));
      }
    }

    // Both are the engine's, and only the engine's. A new RPC here would be a new
    // door into the ledger.
    for (const name of ['ingest_payment_event', 'match_payment_event']) {
      assert.ok(callers.has(name), `the adapter must call ${name}`);
    }

    const allowedEngines = new Set(['ingest_payment_event', 'match_payment_event']);
    for (const name of callers.keys()) {
      assert.ok(allowedEngines.has(name), `${name} is not an approved ingestion RPC`);
    }

    // The argument mapping lives in exactly one place.
    const builder = read(join(smsDir, 'ingest.ts'));
    assert.ok(
      /export function buildIngestArgs/.test(builder),
      'the ingest payload must be built in one reviewed function',
    );
    assert.ok(
      /p_source: SMS_EVENT_SOURCE/.test(builder),
      'the adapter must send source = sms and nothing else',
    );
    assert.ok(
      /SMS_EVENT_SOURCE: PaymentEventSource = 'sms'/.test(read(join(smsDir, 'types.ts'))),
      'the only source value an SMS adapter may send is sms',
    );
  });

  test('the client implements no matching, scoring or settlement', () => {
    // The engine owns every financial decision. A second implementation in the app
    // would be a second set of bugs against real money, so the code that would
    // constitute one is asserted absent.
    //
    // Patterns are code shapes, not vocabulary: the adapter legitimately SAYS the
    // word "settle" in a sentence explaining that the engine does it, and banning
    // the word would flag the explanation while missing the implementation.
    const smsDir = join(SRC, 'features', 'payments', 'sms');

    const banned = [
      /record_payment/,
      /amount_paid/,
      /payment_status/,
      /\.settle\(/,
      /settle_event/,
      /settleEvent/,
      /score_payment_match/,
      /scorePaymentMatch/,
      /compareAmount/,
      /isPaid/,
      /markAsPaid/,
    ];

    const offenders = [];
    for (const file of walk(smsDir)) {
      const src = code(file);
      for (const pattern of banned) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `the adapter detects payments, it never decides one was paid:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('no privileged credential is reachable from the client', () => {
    // The APK is extractable, so anything privileged inside it is public. The
    // service key belongs to no client; money writes go through a session.
    const banned = [
      /service_role/i,
      /SERVICE_ROLE/i,
      /supabase.{0,20}service.{0,20}key/i,
      /eyJhbGciOi[A-Za-z0-9_-]{10,}/,
    ];

    const offenders = [];
    for (const file of [...walk(SRC), ...walk(MODULE)]) {
      const src = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `no privileged credential may exist in app code:\n  ${offenders.join('\n  ')}`,
    );

    // And the reason a relay cannot use the service key at all: the money-writing
    // RPCs are not granted to it. Asserted again here because this is the file a
    // reader checks first.
    const grants = read(join(REPO, 'supabase', 'migrations', '0024_payment_grants.sql'));
    assert.match(
      grants,
      /service_role can settle a payment without a session/,
      'the least-privilege assertion must still be in place',
    );
    assert.match(
      grants,
      /revoke all on function[\s\S]*settle_event_to_intent/,
      'the settlement function must still be revoked from every client role',
    );
  });

  test('the adapter keeps one idempotency key per event', () => {
    const smsDir = join(SRC, 'features', 'payments', 'sms');

    const queue = read(join(smsDir, 'queue.ts'));
    // Minted once, in one place. A key generated per attempt is how one SMS becomes
    // three payments.
    assert.ok(
      /export function newClientRef/.test(queue),
      'the idempotency key must have exactly one source',
    );

    const minters = [];
    for (const file of walk(smsDir)) {
      const src = code(file);
      if (/newClientRef\(\)/.test(src)) minters.push(rel(file));
    }
    assert.deepEqual(
      [...minters].sort(),
      [
        'src/features/payments/sms/listener.ts',
        'src/features/payments/sms/queue.ts',
      ],
      'the key may be minted by the queue and the listener, and nowhere else',
    );

    // Retrying must reuse the key, never replace it. One call site is the whole
    // guarantee: a second `newClientRef()` in the listener would be a second chance
    // to turn one payment into two.
    const listener = read(join(smsDir, 'listener.ts'));
    const mints = [...listener.matchAll(/newClientRef\(\)/g)];
    assert.equal(
      mints.length,
      1,
      'the listener may mint an idempotency key exactly once, when an event is first queued',
    );
    assert.match(
      listener,
      /ingestNativeCandidates[\s\S]*clientRef: newClientRef\(\)/,
      'and that call must be on the first-queue path',
    );

    // And the queue itself never invents one, so a retry cannot quietly become a new
    // payment: the only occurrence in queue.ts is the declaration.
    const queueOccurrences = [...queue.matchAll(/newClientRef\(\)/g)];
    assert.equal(
      queueOccurrences.length,
      1,
      'queue.ts declares newClientRef exactly once and must never call it',
    );
    assert.match(queue, /export function newClientRef\(\)/);
  });

  test('every provider has its own adapter, not one shared parser', () => {
    const providersDir = join(MODULE, 'android', 'src', 'main', 'java', 'com', 'sellflow', 'sms', 'providers');
    assert.ok(existsSync(providersDir), 'the providers package must exist');

    for (const provider of ['Bkash', 'Nagad', 'Rocket', 'Upay']) {
      assert.ok(
        existsSync(join(providersDir, `${provider}Adapter.kt`)),
        `${provider}Adapter.kt must exist: one provider, one file`,
      );
    }

    // Each adapter must contribute its own wording rather than delegating to a
    // shared table, which is what would turn four providers into one parser.
    for (const provider of ['Bkash', 'Nagad', 'Rocket', 'Upay']) {
      const src = readFileSync(join(providersDir, `${provider}Adapter.kt`), 'utf8');
      assert.match(src, /override val transferAnchors/, `${provider} must declare its own anchors`);
    }

    const registry = readFileSync(join(providersDir, 'ProviderRegistry.kt'), 'utf8');
    for (const provider of ['BkashAdapter()', 'NagadAdapter()', 'RocketAdapter()', 'UpayAdapter()']) {
      assert.ok(registry.includes(provider), `${provider} must be registered`);
    }
  });

  test('the adapter is registered as a local Expo module and autolinks', () => {
    // Without this the app builds and runs, the permission is granted, and no SMS
    // is ever received -- the most expensive kind of silent failure.
    const config = read(join(MODULE, 'expo-module.config.json'));
    const parsed = JSON.parse(config);

    assert.deepEqual(parsed.platforms, ['android'], 'the module must be Android-only');
    assert.deepEqual(
      parsed.android.modules,
      ['com.sellflow.sms.SellflowSmsModule'],
      'SDK 57 requires the module class to be declared; it does not scan sources',
    );

    // `./modules` at the app root is where Expo autolinking looks by default
    // (`expo-modules-autolinking` resolves `nativeModulesDir` to `./modules` when
    // unset), so no config key is needed -- and `expo.autolinking` is not part of
    // the SDK 57 app-config schema, so adding one would fail `expo-doctor`.
    assert.ok(
      existsSync(MODULE),
      'the module must live in ./modules, the default autolinking directory',
    );
    assert.ok(
      existsSync(join(MODULE, 'index.ts')),
      'the module must have a JavaScript entry point',
    );
    assert.ok(
      existsSync(join(MODULE, 'android', 'build.gradle')),
      'the module must have an Android library build file',
    );
  });
});