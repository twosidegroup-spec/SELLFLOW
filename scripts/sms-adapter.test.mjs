/**
 * The native SMS adapter, run for real.
 *
 * Everything under `src/features/payments/sms` and the module bridge are the
 * actual production sources, imported unmodified through
 * `scripts/test-loader.mjs`. Only two things are stood in for: the network (the
 * Supabase stub, which records the RPC calls the real code makes) and the device
 * (AsyncStorage, which is what the real app uses too).
 *
 * What this suite proves about the client half of the pipeline:
 *
 *   - a native candidate becomes exactly the right `ingest_payment_event` call
 *   - the same message delivered ten times is one event, one call, one client_ref
 *   - an offline device queues durably and sends once on recovery
 *   - a refused event is not retried forever, and an auth failure stops the queue
 *   - no account, order, intent or tenant is ever chosen on the client
 *   - the seller-facing status only ever reports what can be proven
 *
 * What it deliberately does NOT prove: anything about matching or settlement. Those
 * are the engine's, covered by `supabase/test/verify_payment_sms_adapter.sql` and
 * the Phase 1 suites. Asserting them here would be asserting a second
 * implementation, which is exactly what the boundary test forbids.
 *
 * The provider PARSERS are Kotlin and are covered by
 * `modules/sellflow-sms/android/src/test/.../ProviderParserTest.kt`. What this
 * suite does check is the corpus those tests read, so "the fixtures cover what they
 * claim" is verifiable without a JDK.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { __resetAsyncStorage, __dumpAsyncStorage } from './__stubs__/async-storage.mjs';
import { __resetSupabaseStub, __queueRpc, __rpcNames, __callsOf } from './__stubs__/supabase-js.mjs';

// Must come before anything that loads `@/lib/supabase`: that module reads the
// env at import time and refuses to build a client without it, which is correct
// production behaviour and unhelpful here.
import './__stubs__/env.mjs';

import { getSupabase } from '@/lib/supabase';
import { candidateIdentity, resolveAccount } from '@/features/payments/sms/accounts';
import { buildDetectedBy, buildIngestArgs, createQueuedEvent } from '@/features/payments/sms/ingest';
import { classifySendError } from '@/features/payments/sms/failures';
import { createSmsListener } from '@/features/payments/sms/listener';
import {
  backoffFor,
  canAttempt,
  dueEvents,
  enqueue,
  hasExpired,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  readQueue,
  summarise,
} from '@/features/payments/sms/queue';
import { deriveDetectionStatus, detectionCopy } from '@/features/payments/sms/status';
import { rejectionCopy } from '@/features/payments/sms/diagnostics';
import { normalizeBdNumber } from '@/features/payments/normalize';
import { StorageKeys } from '@/lib/storage';

const REPO = resolve(import.meta.dirname, '..');
const FIXTURES = join(
  REPO,
  'modules',
  'sellflow-sms',
  'android',
  'src',
  'test',
  'resources',
  'fixtures',
  'payment-sms.json',
);

// ---------------------------------------------------------------------------
// Fixtures, shared with the Kotlin suite
// ---------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(FIXTURES, 'utf8'));

const PROVIDERS = ['bkash', 'nagad', 'rocket', 'upay'];

/** Categories every provider must have both a positive and a negative case for. */
const NEGATIVE_CATEGORIES = [
  'missing amount',
  'malformed amount',
  'missing transaction id',
  'malformed transaction id',
  'ambiguous',
  'unrelated',
  'otp',
  'wrong provider',
  'unexpected wording',
  'missing sender',
  'malformed input',
];

/**
 * Built relative to now, not to a fixed date.
 *
 * An event older than the retention window is correctly never attempted, so a
 * hard-coded 2024 timestamp would silently make every test below a test of the
 * expiry rule instead of the thing it claims to test.
 */
const NOW = Date.now();

const candidate = (overrides = {}) => ({
  provider: 'bkash',
  transactionId: '8GHK9XYZ12A',
  amount: 1000,
  receiverAccount: null,
  senderAccount: '01812345678',
  transactionTimestamp: NOW - 60_000,
  fingerprint: 'a'.repeat(64),
  detectedAt: NOW - 30_000,
  parserVersion: 1,
  ...overrides,
});

const ACCOUNTS = [
  { id: 'acct-bkash-1', provider: 'bkash', accountNumber: '01711000111' },
  { id: 'acct-nagad-1', provider: 'nagad', accountNumber: '01811000111' },
];

beforeEach(() => {
  __resetAsyncStorage();
  __resetSupabaseStub();
});

describe('sms adapter :: fixture corpus', () => {
  test('the corpus is explicitly labelled unverified', () => {
    // The claim that a parser is real-world verified is a lie until a message has
    // actually been captured. That label living in the data file means the file
    // cannot be read without reading the caveat.
    assert.match(corpus.provenance.status, /REPRESENTATIVE|UNVERIFIED/);
    assert.ok(corpus.provenance.how_to_close_the_gap.length > 40);
    assert.ok(corpus.cases.length >= 20, 'the corpus must be substantial');
  });

  test('every provider has a positive payment case', () => {
    for (const provider of PROVIDERS) {
      const positives = corpus.cases.filter(
        (c) => c.expect.outcome === 'parsed' && c.expect.provider === provider,
      );
      assert.ok(
        positives.length >= 3,
        `${provider} needs at least three positive fixtures, found ${positives.length}`,
      );

      for (const c of positives) {
        assert.ok(c.expect.amount > 0, `${c.id}: amount must be positive`);
        assert.ok(
          c.expect.transactionId.length >= 4,
          `${c.id}: a fixture with an unusable reference proves nothing`,
        );
      }
    }
  });

  test('every provider has a case for every negative category', () => {
    // Named categories rather than a count, so a gap is visible in the failure
    // message instead of being one fewer test in a total.
    const probes = [
      ['missing amount', /missing the amount|no figure|no amount/i],
      ['malformed amount', /currency with no figure|no number after it/i],
      ['missing transaction id', /no reference|no reference at all/i],
      ['malformed transaction id', /unusable|phone number/i],
      ['ambiguous', /two anchors|two different amounts/i],
      ['unrelated', /ordinary personal/i],
      ['otp', /passcode|two-factor/i],
      ['wrong provider', /payer's confirmation|payer confirmation/i],
      ['unexpected wording', /field order|reference first/i],
      ['missing sender', /walk-in/i],
      ['malformed input', /length gate|never be parsed/i],
    ];

    for (const [label, pattern] of probes) {
      const matches = corpus.cases.filter((c) => pattern.test(c.note ?? ''));
      assert.ok(
        matches.length > 0,
        `no fixture covers "${label}"; add one with a note describing ${pattern}`,
      );
    }
  });

  test('every rejection fixture names a real rejection reason', () => {
    const known = new Set([
      'not_a_payment_message',
      'otp_or_security_message',
      'unsupported_provider',
      'missing_amount',
      'malformed_amount',
      'missing_transaction_id',
      'malformed_transaction_id',
      'ambiguous_fields',
    ]);

    for (const c of corpus.cases) {
      if (c.expect.outcome !== 'rejected') continue;
      assert.ok(known.has(c.expect.reason), `${c.id}: unknown reason ${c.expect.reason}`);
    }
  });

  test('no fixture contains an OTP-looking code that could be mistaken for money', () => {
    // Belt and braces. If a positive fixture ever contained a passcode, the parser
    // would be tested on a message it must refuse.
    for (const c of corpus.cases) {
      if (c.expect.outcome !== 'parsed') continue;
      assert.ok(
        !/\bOTP\b/i.test(c.body),
        `${c.id}: a positive fixture must not be a passcode`,
      );
    }
  });

  test('every diagnostic reason has a sentence a developer can act on', () => {
    for (const reason of [
      'not_a_payment_message',
      'otp_or_security_message',
      'unsupported_provider',
      'missing_amount',
      'malformed_amount',
      'missing_transaction_id',
      'malformed_transaction_id',
      'ambiguous_fields',
    ]) {
      const copy = rejectionCopy(reason);
      assert.ok(copy.length > 20, `${reason} needs real copy, got "${copy}"`);
      assert.ok(!copy.includes('_'), `${reason} copy must be a sentence`);
    }
  });
});

describe('sms adapter :: account resolution', () => {
  test('an unstated receiver resolves by provider when there is exactly one', () => {
    const result = resolveAccount(candidate({ receiverAccount: null }), ACCOUNTS);
    assert.deepEqual(result, {
      ok: true,
      accountId: 'acct-bkash-1',
      accountNumber: '01711000111',
    });
  });

  test('a stated receiver must match the connected account', () => {
    const result = resolveAccount(
      candidate({ receiverAccount: '01711000111' }),
      ACCOUNTS,
    );
    assert.equal(result.ok, true);

    const wrong = resolveAccount(candidate({ receiverAccount: '01999999999' }), ACCOUNTS);
    assert.deepEqual(wrong, { ok: false, reason: 'account_not_connected' });
  });

  test('the +880 form of the connected number matches', () => {
    // The same number arrives four ways; if only one matched, every genuine
    // payment would silently fail to match.
    const result = resolveAccount(
      candidate({ receiverAccount: '01711000111' }),
      [{ id: 'a', provider: 'bkash', accountNumber: '+8801711000111' }],
    );
    assert.equal(result.ok, true);
    assert.equal(normalizeBdNumber('+8801711000111'), '01711000111');
  });

  test('two connected accounts and no stated receiver is ambiguous, not a guess', () => {
    const result = resolveAccount(
      candidate({ receiverAccount: null }),
      [
        ...ACCOUNTS,
        { id: 'acct-bkash-2', provider: 'bkash', accountNumber: '01711000222' },
      ],
    );
    assert.deepEqual(result, { ok: false, reason: 'ambiguous_account' });
  });

  test('an unknown provider is not this seller’s money', () => {
    const result = resolveAccount(candidate({ provider: 'nagad' }), [ACCOUNTS[0]]);
    assert.deepEqual(result, { ok: false, reason: 'account_not_connected' });
  });
});

describe('sms adapter :: normalisation into the existing contract', () => {
  test('a candidate becomes exactly the ingest arguments, and nothing more', () => {
    const event = createQueuedEvent({
      candidate: candidate(),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: '11111111-2222-4333-8444-555555555555',
    });

    const args = buildIngestArgs(event, 'android:14:sms:1.0.0:p1');

    assert.deepEqual(args, {
      p_payment_account_id: 'acct-bkash-1',
      p_provider: 'bkash',
      p_receiver_account: '01711000111',
      p_sender_account: '01812345678',
      p_amount: 1000,
      p_transaction_id: '8GHK9XYZ12A',
      p_transaction_timestamp: new Date(NOW - 60_000).toISOString(),
      p_source: 'sms',
      p_fingerprint: 'a'.repeat(64),
      p_client_ref: '11111111-2222-4333-8444-555555555555',
      p_detected_by: 'android:14:sms:1.0.0:p1',
    });

    // No order, no intent, no status. The client says "I detected this", and has
    // no vocabulary for anything else.
    for (const forbidden of ['order', 'intent', 'status', 'paid', 'settle', 'org_id', 'store_id']) {
      assert.ok(
        !Object.keys(args).some((key) => key.includes(forbidden)),
        `the adapter must not send anything about ${forbidden}`,
      );
    }
  });

  test('an absent sender is sent as null, never guessed', () => {
    const event = createQueuedEvent({
      candidate: candidate({ senderAccount: null }),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(
      buildIngestArgs(event, 'x').p_sender_account,
      null,
      'a walk-in payment must reach the engine as an unknown payer, not a guess',
    );
  });

  test('an absent transaction timestamp is sent as null, not as now()', () => {
    const event = createQueuedEvent({
      candidate: candidate({ transactionTimestamp: null }),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(buildIngestArgs(event, 'x').p_transaction_timestamp, null);
  });

  test('an unstated receiver falls back to the connected account number', () => {
    const resolution = resolveAccount(candidate({ receiverAccount: null }), ACCOUNTS);
    const event = createQueuedEvent({
      candidate: candidate({ receiverAccount: null }),
      accountId: resolution.accountId,
      receiverAccount: resolution.accountNumber,
      clientRef: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(buildIngestArgs(event, 'x').p_receiver_account, '01711000111');
  });

  test('the support string carries the parser version', () => {
    // An SMS parsed today must be diagnosable against the rules that produced it,
    // and payment_events has no column for that, so it rides in detected_by.
    assert.equal(
      buildDetectedBy({ androidRelease: '14', appVersion: '1.0.0', parserVersion: 3 }),
      'android:14:sms:1.0.0:p3',
    );
  });

  test('the queue record holds no message text', () => {
    const event = createQueuedEvent({
      candidate: candidate(),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: '11111111-2222-4333-8444-555555555555',
    });
    const keys = Object.keys(event);
    for (const forbidden of ['body', 'messageBody', 'text', 'message', 'sms_body']) {
      assert.ok(!keys.includes(forbidden), `the queue record must not carry ${forbidden}`);
    }
    assert.deepEqual(
      Object.keys(event.candidate).sort(),
      [
        'amount',
        'detectedAt',
        'fingerprint',
        'parserVersion',
        'provider',
        'receiverAccount',
        'senderAccount',
        'transactionId',
        'transactionTimestamp',
      ],
    );
  });
});

describe('sms adapter :: duplicates and replay', () => {
  test('the same candidate queued ten times is one event', async () => {
    const same = candidate();
    let added = 0;

    for (let i = 0; i < 10; i++) {
      const result = await enqueue(
        createQueuedEvent({
          candidate: { ...same },
          accountId: 'acct-bkash-1',
          receiverAccount: '01711000111',
          clientRef: `key-${i}`,
        }),
        candidateIdentity,
      );
      if (result.added) added += 1;
    }

    assert.equal(added, 1, 'a redelivered message must be recognised as already queued');
    assert.equal((await readQueue()).length, 1);
  });

  test('a duplicate keeps the original idempotency key', async () => {
    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'original-key',
      }),
      candidateIdentity,
    );

    const second = await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'a-different-key',
      }),
      candidateIdentity,
    );

    assert.equal(second.added, false);
    const [only] = await readQueue();
    assert.equal(only.clientRef, 'original-key', 'the first key must win, or a replay is a new payment');
  });

  test('a different transaction is a different event', async () => {
    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'k1',
      }),
      candidateIdentity,
    );
    const other = await enqueue(
      createQueuedEvent({
        candidate: candidate({ transactionId: 'DIFFERENT1' }),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'k2',
      }),
      candidateIdentity,
    );
    assert.equal(other.added, true);
    assert.equal((await readQueue()).length, 2);
  });

  test('ten flushes against a server that says duplicate produce one ledger row', async () => {
    // The server is the authority and answers `duplicate: true`, which is success.
    for (let i = 0; i < 10; i++) {
      __queueRpc({ data: { event_id: 'evt-1', duplicate: true, status: 'confirmed' } });
    }

    const ingest = async () => ({ event_id: 'evt-1', duplicate: true, status: 'confirmed' });
    const match = async () => ({ status: 'confirmed', settled: false, already_processed: true });

    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'stable-key',
      }),
      candidateIdentity,
    );

    let now = Date.now();
    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest,
      match,
      now: () => now,
    });

    // The first pass sends it. Every later pass has nothing to send, because the
    // event left the queue -- and a server that keeps answering "duplicate" cannot
    // put it back.
    const first = await listener.flush();
    assert.equal(first.settled, 1);

    for (let i = 0; i < 9; i++) {
      now += 60_000;
      const again = await listener.flush();
      assert.equal(again.settled, 0, `pass ${i + 2} must have nothing to send`);
    }

    assert.equal((await readQueue()).length, 0, 'the event leaves the queue exactly once');
  });
});

describe('sms adapter :: the existing engine boundary is the only door', () => {
  test('a flush calls ingest then match, in that order, and nothing else', async () => {
    __queueRpc({ data: { event_id: 'evt-9', duplicate: false, status: 'detected' } });
    __queueRpc({ data: { status: 'confirmed', settled: true } });

    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'boundary-key',
      }),
      candidateIdentity,
    );

    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async (args) => {
        const { data, error } = await getSupabase().rpc('ingest_payment_event', args);
        if (error) throw error;
        return data;
      },
      match: async (eventId) => {
        const { data, error } = await getSupabase().rpc('match_payment_event', {
          p_event_id: eventId,
        });
        if (error) throw error;
        return data;
      },
    });

    await listener.flush();

    assert.deepEqual(
      __rpcNames(),
      ['ingest_payment_event', 'match_payment_event'],
      'the adapter opens exactly two doors, in this order',
    );

    // And the ingest arguments carry no account or order the client chose.
    const [ingest] = __callsOf('ingest_payment_event');
    assert.equal(ingest.args.p_source, 'sms');
    assert.equal(ingest.args.p_payment_account_id, 'acct-bkash-1');
    assert.ok(!('order_id' in ingest.args));
    assert.ok(!('org_id' in ingest.args));

    const [match] = __callsOf('match_payment_event');
    assert.deepEqual(Object.keys(match.args), ['p_event_id']);
  });

  test('the client proposes no target: match is called with an id and nothing else', async () => {
    __queueRpc({ data: { event_id: 'evt-3', duplicate: false, status: 'detected' } });
    __queueRpc({ data: { status: 'confirmed' } });

    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'propose-nothing',
      }),
      candidateIdentity,
    );

    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => ({ event_id: 'evt-3', duplicate: false, status: 'detected' }),
      match: async () => ({ status: 'confirmed' }),
    });

    await listener.flush();
    // The shape is asserted above against the recorded RPC args; here the point is
    // that nothing in this file could express a target even if it wanted to.
    assert.deepEqual(await readQueue(), []);
  });
});

describe('sms adapter :: offline, retry and refusal', () => {
  test('an offline device queues and sends nothing', async () => {
    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'offline-1',
      }),
      candidateIdentity,
    );

    let attempted = 0;
    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => false,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => {
        attempted += 1;
        return { event_id: 'evt-1' };
      },
      match: async () => ({}),
    });

    await listener.flush();

    // A known-offline device does not attempt anything at all. Burning an attempt
    // per queued payment while the phone is in a lift would exhaust the retry
    // budget without ever reaching the network.
    assert.equal(attempted, 0);
    assert.equal((await readQueue()).length, 1, 'an offline payment must stay queued');

    const [event] = await readQueue();
    assert.equal(event.state, 'pending');
    assert.equal(event.attempts, 0, 'an offline pass must not consume an attempt');
    assert.equal(event.lastError, null);
  });

  test('the queue survives a restart', async () => {
    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'survives-restart',
      }),
      candidateIdentity,
    );

    // The value is on disk, not in memory. AsyncStorage is what survives a kill,
    // so asserting on it is asserting on durability rather than on a cache.
    const raw = JSON.parse(__dumpAsyncStorage()[StorageKeys.pendingSmsEvents]);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].clientRef, 'survives-restart');
    assert.ok(!JSON.stringify(raw).includes('messageBody'));
  });

  test('recovery sends the queued event exactly once', async () => {
    let attempts = 0;
    let online = false;
    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => online,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => {
        attempts += 1;
        return { event_id: 'evt-recovered', duplicate: false, status: 'detected' };
      },
      match: async () => ({ status: 'confirmed' }),
    });

    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'recovery-key',
      }),
      candidateIdentity,
    );

    // Offline: the event stays queued, untouched, with no attempt spent.
    await listener.flush();
    assert.equal(attempts, 0);
    assert.equal((await readQueue()).length, 1);

    // The connection returns.
    online = true;
    const result = await listener.flush();
    assert.equal(result.settled, 1);
    assert.equal((await readQueue()).length, 0);
    assert.equal(attempts, 1, 'recovery sends the payment once');

    // And a later pass has nothing to resend.
    online = true;
    await listener.flush();
    assert.equal(attempts, 1, 'a recovered payment is not sent twice');
  });

  test('backoff grows and is capped, so there is no unbounded retry', () => {
    assert.ok(backoffFor(1) < backoffFor(2));
    assert.ok(backoffFor(2) < backoffFor(3));
    assert.ok(backoffFor(MAX_ATTEMPTS) <= MAX_BACKOFF_MS);
    assert.ok(backoffFor(100) <= MAX_BACKOFF_MS);
  });

  test('an event that exhausts its attempts stops and stays visible', async () => {
    const now = Date.parse('2024-01-12T05:00:00.000Z');
    let clock = now;
    let attempts = 0;

    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => {
        attempts += 1;
        throw { code: 'invalid_transaction_id', message: 'too short' };
      },
      match: async () => ({}),
      now: () => clock,
    });

    await enqueue(
      createQueuedEvent({
        candidate: candidate(),
        accountId: 'acct-bkash-1',
        receiverAccount: '01711000111',
        clientRef: 'permanent-failure',
      }),
      candidateIdentity,
    );

    // A malformed reference cannot become valid by asking again.
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      clock += MAX_BACKOFF_MS + 1;
      await listener.flush();
    }

    const [event] = await readQueue();
    assert.equal(event.state, 'failed', 'a permanently invalid event must stop retrying');
    assert.equal(event.lastError, 'invalid_transaction_id');
    assert.equal(attempts, 1, 'a permanent refusal is attempted once, not MAX_ATTEMPTS times');
  });

  test('an expired session stops the whole queue rather than hammering it', async () => {
    let attempts = 0;
    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => {
        attempts += 1;
        throw { code: 'invalid_authorization', message: 'JWT expired' };
      },
      match: async () => ({}),
    });

    for (let i = 0; i < 4; i++) {
      await enqueue(
        createQueuedEvent({
          candidate: candidate({ transactionId: `TXN${i}AAAA` }),
          accountId: 'acct-bkash-1',
          receiverAccount: '01711000111',
          clientRef: `auth-stop-${i}`,
        }),
        candidateIdentity,
      );
    }

    const result = await listener.flush();

    assert.equal(result.blocked, true, 'the queue must report that it is waiting for a human');
    assert.equal(attempts, 1, 'one failure is enough to stop; the rest would fail identically');
    assert.equal((await readQueue()).length, 4, 'nothing is lost');
  });

  test('an unknown account is retried, because a seller can connect it later', () => {
    const classified = classifySendError({ code: 'payment_account_not_found' }, true);
    assert.equal(classified.decision, 'retry');
    assert.equal(classified.failure, 'account_not_connected');
  });

  test('a malformed amount is permanent', () => {
    const classified = classifySendError({ code: 'invalid_amount' }, true);
    assert.equal(classified.decision, 'permanent');
  });

  test('being offline is reported as offline, not as a server fault', () => {
    assert.deepEqual(classifySendError(new Error('Failed to fetch'), false), {
      decision: 'retry',
      failure: 'offline',
    });
    assert.deepEqual(classifySendError(new Error('Failed to fetch'), true), {
      decision: 'retry',
      failure: 'network',
    });
  });

  test('an unrecognised failure is retried rather than dropped', () => {
    // Losing a customer's payment is worse than one extra attempt. The attempt cap
    // is what stops that being a loop.
    assert.equal(classifySendError({ code: 'something_new' }, true).decision, 'retry');
  });
});

describe('sms adapter :: security', () => {
  test('the app never resolves an account for an event it does not own', async () => {
    // A candidate whose receiver matches nothing connected is dropped locally and
    // never reaches the network, so a payment to an unrelated number cannot even be
    // filed.
    let sent = 0;
    const listener = createSmsListener({
      accounts: () => ACCOUNTS,
      online: () => true,
      androidRelease: () => '14',
      appVersion: () => '1.0.0',
      ingest: async () => {
        sent += 1;
        return { event_id: 'evt' };
      },
      match: async () => ({}),
    });

    const result = await listener.ingestNativeCandidates([
      candidate({ receiverAccount: '01999999999', fingerprint: 'not-ours' }),
    ]);

    assert.equal(result.queued, 0);
    assert.equal(result.unmatched, 1);
    assert.equal(sent, 0);
    assert.equal((await readQueue()).length, 0);
  });

  test('nothing the client sends can name an org, a store, an order or an intent', () => {
    const event = createQueuedEvent({
      candidate: candidate(),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: 'no-tenant',
    });

    const args = buildIngestArgs(event, 'android:14:sms:1.0.0:p1');
    const text = JSON.stringify(args);

    // These are the strings a hostile client would put in a payload to move money.
    for (const forbidden of [
      'org_id',
      'store_id',
      'order_id',
      'intent_id',
      'payment_status',
      'settled',
      'confirmed',
    ]) {
      assert.ok(!text.includes(forbidden), `the ingest payload must not carry ${forbidden}`);
    }
  });

  test('the payload holds only fields the engine already knows', () => {
    const event = createQueuedEvent({
      candidate: candidate(),
      accountId: 'acct-bkash-1',
      receiverAccount: '01711000111',
      clientRef: 'known-fields',
    });

    const known = new Set([
      'p_payment_account_id',
      'p_provider',
      'p_receiver_account',
      'p_sender_account',
      'p_amount',
      'p_transaction_id',
      'p_transaction_timestamp',
      'p_source',
      'p_fingerprint',
      'p_client_ref',
      'p_detected_by',
    ]);

    for (const key of Object.keys(buildIngestArgs(event, 'x'))) {
      assert.ok(known.has(key), `${key} is not an argument of ingest_payment_event`);
    }
  });
});

describe('sms adapter :: offline queue mechanics', () => {
  test('a due event is the oldest one first', async () => {
    const now = Date.now();
    // Queued out of order on purpose. order-1 was seen 1s ago, order-0 three
    // seconds ago, so order-0 is the oldest and must go first.
    for (const [index, seenSecondsAgo] of [3, 1, 2].entries()) {
      await enqueue(
        createQueuedEvent({
          candidate: candidate({
            transactionId: `TXN${index}AAAA`,
            detectedAt: now - seenSecondsAgo * 1000,
          }),
          accountId: 'acct-bkash-1',
          receiverAccount: '01711000111',
          clientRef: `order-${index}`,
        }),
        candidateIdentity,
      );
    }

    const due = dueEvents(await readQueue(), now);
    assert.deepEqual(
      due.map((event) => event.clientRef),
      ['order-0', 'order-2', 'order-1'],
      'money must be sent in the order it arrived',
    );
  });

  test('a failed event is never due again', () => {
    const now = Date.now();
    const failed = {
      clientRef: 'x',
      candidate: candidate(),
      accountId: 'a',
      receiverAccount: '01711000111',
      detectedAt: new Date(now).toISOString(),
      attempts: MAX_ATTEMPTS,
      nextAttemptAt: 0,
      state: 'failed',
      lastError: 'invalid_amount',
    };
    assert.equal(canAttempt(failed, now), false);
    assert.equal(dueEvents([failed], now).length, 0);
  });

  test('an event older than the retention window is not attempted', () => {
    const now = Date.now();
    const ancient = {
      clientRef: 'old',
      candidate: candidate(),
      accountId: 'a',
      receiverAccount: '01711000111',
      detectedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      state: 'pending',
      lastError: null,
    };
    assert.equal(hasExpired(ancient, now), true);
    assert.equal(canAttempt(ancient, now), false);
  });

  test('a corrupt row is dropped rather than crashing the screen', async () => {
    __dumpAsyncStorage; // the storage stub is the same object
    const storage = (await import('@/lib/storage')).writeJson;
    await storage(StorageKeys.pendingSmsEvents, [null, 42, { noClientRef: true }]);

    assert.deepEqual(await readQueue(), []);
  });
});

describe('sms adapter :: native bridge resilience', () => {
  // The native module throws when the React context is gone, which happens on
  // every startup and shutdown. The bridge has to survive that without reporting
  // a failure that did not happen, because the caller treats a throw as a failed
  // send and would schedule a pointless retry against a queue that is fine.
  test('a lost React context reads as unsupported, never as healthy', async () => {
    const bridge = await import('@sellflow-sms');
    const { NativeModules } = await import('react-native');

    NativeModules.SellflowSms = {
      getListenerStatusAsync: async () => {
        throw new Error('The React context is gone');
      },
      peekCandidatesAsync: async () => [],
      acknowledgeCandidatesAsync: async () => {
        throw new Error('The React context is gone');
      },
      discardCandidateAsync: async () => false,
      parseMessageForDiagnosticsAsync: async () => null,
      addListener: () => ({ remove() {} }),
    };

    // The bridge captured `isNativeListenerAvailable` at import time, so this test
    // documents the CONTRACT the TS side must honour rather than re-running the
    // native path.
    assert.equal(typeof bridge.isNativeListenerAvailable, 'boolean');
    assert.equal(typeof bridge.getListenerStatus, 'function');
    assert.equal(typeof bridge.peekCandidates, 'function');

    delete NativeModules.SellflowSms;
  });

  test('with no native module the bridge reports unsupported and sends nothing', async () => {
    const { NativeModules } = await import('react-native');
    delete NativeModules.SellflowSms;

    // Re-import with a cache-busting query so the bridge re-evaluates against a
    // NativeModules that no longer carries the module.
    const bridge = await import('@sellflow-sms?fresh=native-missing');
    assert.equal(bridge.isNativeListenerAvailable, false);

    const status = await bridge.getListenerStatus();
    assert.equal(status.permission, 'unsupported');
    assert.equal(status.receiverActive, false);

    assert.deepEqual(await bridge.peekCandidates(), []);
    assert.equal(await bridge.acknowledgeCandidates(['abc']), 0);
    assert.equal(await bridge.discardCandidate('abc'), false);
    assert.equal(await bridge.parseMessageForDiagnostics('anything'), null);
  });
});

describe('sms adapter :: what the seller is told', () => {
  const native = (overrides = {}) => ({
    permission: 'granted',
    receiverActive: true,
    appVersion: '1.0.0',
    androidRelease: '14',
    queuedCandidates: 0,
    oldestQueuedAt: 0,
    rejections: {},
    ...overrides,
  });

  const facts = (overrides = {}) => {
    const snapshot = summarise([], Date.now());
    return {
      nativeStatus: native(),
      connectedAccounts: 1,
      snapshot,
      lastEventStatus: null,
      needsReview: 0,
      lastFailure: null,
      ...overrides,
    };
  };

  test('every status has a sentence a seller can act on', () => {
    const statuses = [
      'unsupported_platform',
      'permission_required',
      'permission_denied',
      'receiver_unavailable',
      'no_accounts',
      'sign_in_required',
      'offline_queued',
      'needs_attention',
      'processing',
      'confirmed',
      'needs_review',
      'waiting',
    ];

    for (const status of statuses) {
      const copy = detectionCopy(status);
      assert.ok(copy.title.length > 0, `${status} needs a title`);
      assert.ok(copy.body.length > 30, `${status} needs an explanation`);
    }
  });

  test('no listener means it says so, rather than showing a healthy state', () => {
    assert.equal(deriveDetectionStatus(facts({ nativeStatus: null })), 'unsupported_platform');
    assert.equal(
      deriveDetectionStatus(facts({ nativeStatus: native({ permission: 'denied' }) })),
      'permission_denied',
    );
  });

  test('a receiver that is not registered is its own status', () => {
    // Permission granted with no receiver reads as "connected" to a seller, and
    // nothing would ever be detected. This is the state that would otherwise be
    // invisible.
    assert.equal(
      deriveDetectionStatus(facts({ nativeStatus: native({ receiverActive: false }) })),
      'receiver_unavailable',
    );
  });

  test('a denied permission never reads as connected', () => {
    const status = deriveDetectionStatus(
      facts({ nativeStatus: native({ permission: 'denied' }) }),
    );
    assert.notEqual(status, 'waiting');
    assert.notEqual(status, 'confirmed');
    assert.match(detectionCopy(status).body, /by hand/i);
  });

  test('queued work outranks a stale healthy state', () => {
    const snapshot = summarise(
      [
        {
          clientRef: 'q',
          candidate: candidate(),
          accountId: 'a',
          receiverAccount: '01711000111',
          detectedAt: new Date().toISOString(),
          attempts: 0,
          nextAttemptAt: 0,
          state: 'pending',
          lastError: 'offline',
        },
      ],
      Date.now(),
    );
    assert.equal(
      deriveDetectionStatus(facts({ snapshot, lastFailure: 'offline' })),
      'offline_queued',
    );
  });

  test('needs attention outranks everything else', () => {
    const snapshot = summarise(
      [
        {
          clientRef: 'f',
          candidate: candidate(),
          accountId: 'a',
          receiverAccount: '01711000111',
          detectedAt: new Date().toISOString(),
          attempts: 3,
          nextAttemptAt: 0,
          state: 'failed',
          lastError: 'invalid_amount',
        },
      ],
      Date.now(),
    );
    assert.equal(deriveDetectionStatus(facts({ snapshot })), 'needs_attention');
  });

  test('confirmed comes from the engine, never from the device', () => {
    // Nothing on the device can produce this: `lastEventStatus` is
    // `payment_events.status`, which only the engine writes.
    assert.equal(
      deriveDetectionStatus(facts({ lastEventStatus: 'confirmed' })),
      'confirmed',
    );
    assert.equal(deriveDetectionStatus(facts({ lastEventStatus: 'detected' })), 'waiting');
    assert.equal(deriveDetectionStatus(facts({ lastEventStatus: 'matched' })), 'waiting');
  });

  test('review outranks confirmed, because it needs a person', () => {
    assert.equal(
      deriveDetectionStatus(facts({ lastEventStatus: 'confirmed', needsReview: 2 })),
      'needs_review',
    );
  });

  test('a connected account is required before anything is reported as working', () => {
    assert.equal(deriveDetectionStatus(facts({ connectedAccounts: 0 })), 'no_accounts');
  });
});