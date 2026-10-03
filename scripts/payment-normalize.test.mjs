/**
 * BD phone normalisation, client side.
 *
 * The SQL function this mirrors shipped a real bug: `+8801712...` came out as
 * `0801712...`, so every payment reported with a +880 sender or receiver would
 * have failed to match its order. These expectations are hand-written from the
 * intended behaviour rather than copied from the implementation, so the test
 * fails on drift instead of agreeing with whatever the code happens to do.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const N = await import('../src/features/payments/normalize.ts');

describe('normalizeBdNumber', () => {
  test('every accepted form of one number collapses to the same value', () => {
    const canonical = '01822000111';

    assert.equal(N.normalizeBdNumber('01822000111'), canonical, 'already local');
    assert.equal(N.normalizeBdNumber('+8801822000111'), canonical, 'plus 880');
    assert.equal(N.normalizeBdNumber('8801822000111'), canonical, '880 prefix');
    assert.equal(N.normalizeBdNumber('1822000111'), canonical, 'bare national');
  });

  test('a +880 number becomes a 10-digit local number, not an 11-digit one', () => {
    // The exact regression: substring(x from 2) is a character offset, not a
    // capture group, and produced a leading zero plus the country code.
    const result = N.normalizeBdNumber('+8801712345678');

    assert.equal(result, '01712345678');
    assert.equal(result.length, 11, 'a BD mobile number is 11 digits');
    assert.ok(result.startsWith('01'), 'must start with 0, not 0 + country code');
  });

  test('spaces and dashes are tolerated', () => {
    assert.equal(N.normalizeBdNumber('018 2200 0111'), '01822000111');
    assert.equal(N.normalizeBdNumber('018-2200-0111'), '01822000111');
    assert.equal(N.normalizeBdNumber('+880 18 2200 0111'), '01822000111');
  });

  test('surrounding whitespace is ignored', () => {
    assert.equal(N.normalizeBdNumber('  01822000111  '), '01822000111');
  });

  test('non-mobile input is reduced to digits, never coerced into a matchable one', () => {
    // Landlines and junk must not be turned into something that could match an
    // account number by accident.
    assert.equal(N.normalizeBdNumber('not-a-number'), '');
    assert.equal(N.normalizeBdNumber('+1 202 555 0143'), '12025550143');
    assert.equal(N.normalizeBdNumber('08012345678'), '08012345678', 'not a mobile prefix');
  });

  test('every operator prefix 13-19 is accepted', () => {
    for (const third of ['3', '4', '5', '6', '7', '8', '9']) {
      const local = `01${third}12345678`;
      assert.equal(N.normalizeBdNumber(local), local, `${local} is already canonical`);
      assert.equal(N.normalizeBdNumber(`+88${local}`), local, `+88${local}`);
      assert.equal(N.isBdMobileNumber(local), true, `${local} is valid`);
    }
  });

  test('empty and whitespace-only input does not throw', () => {
    assert.equal(N.normalizeBdNumber(''), '');
    assert.equal(N.normalizeBdNumber('   '), '');
    assert.equal(N.isBdMobileNumber(''), false);
  });
});

describe('isBdMobileNumber', () => {
  test('accepts any accepted spelling of a real mobile number', () => {
    for (const input of [
      '01822000111',
      '+8801822000111',
      '8801822000111',
      '1822000111',
      '018 2200 0111',
    ]) {
      assert.equal(N.isBdMobileNumber(input), true, `${input} should be valid`);
    }
  });

  test('rejects too short, too long and non-mobile input', () => {
    for (const input of ['0171234567', '017123456789', '01212345678', '01112345678', 'abc']) {
      assert.equal(N.isBdMobileNumber(input), false, `${input} should be rejected`);
    }
  });
});

describe('isCanonical', () => {
  test('detects when retyping would visibly change the number', () => {
    // Drives the "Saved as 017…" preview, so it must be true only when the
    // canonical form actually differs from what was typed.
    assert.equal(N.isCanonical('01822000111'), true, 'already canonical');
    assert.equal(N.isCanonical('+8801822000111'), false, 'would be rewritten');
    assert.equal(N.isCanonical('8801822000111'), false, 'would be rewritten');
    assert.equal(N.isCanonical('1822000111'), false, 'would be rewritten');
    assert.equal(N.isCanonical('nonsense'), false, 'not a number at all');
  });
});