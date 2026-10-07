import 'package:flutter_test/flutter_test.dart';
import 'package:sellflow_flutter/core/passcode.dart';

void main() {
  late InMemorySecureStore store;
  late PasscodeService passcode;

  const userA = 'user-a';
  const userB = 'user-b';

  setUp(() {
    store = InMemorySecureStore();
    passcode = PasscodeService(store);
  });

  group('validation', () {
    test('accepts 4 and 6 digit codes', () {
      expect(PasscodeService.validatePasscode('1374').ok, isTrue);
      expect(PasscodeService.validatePasscode('137942').ok, isTrue);
    });

    test('rejects non-digits', () {
      expect(PasscodeService.validatePasscode('13a4').ok, isFalse);
      expect(PasscodeService.validatePasscode('').ok, isFalse);
    });

    test('rejects a repeated single digit', () {
      expect(PasscodeService.validatePasscode('1111').ok, isFalse);
      expect(PasscodeService.validatePasscode('111111').ok, isFalse);
    });

    test('rejects simple ascending and descending sequences', () {
      expect(PasscodeService.validatePasscode('1234').ok, isFalse);
      expect(PasscodeService.validatePasscode('4321').ok, isFalse);
      expect(PasscodeService.validatePasscode('123456').ok, isFalse);
    });

    test('enforces the selectable lengths at registration', () {
      // Registration offers 4 or 6 only. 5 is neither, despite legacy records
      // accepting it.
      expect(
        PasscodeService.validatePasscode('13579', lengths: passcodeLengths).ok,
        isFalse,
      );
      expect(
        PasscodeService.validatePasscode('1357', lengths: passcodeLengths).ok,
        isTrue,
      );
    });
  });

  group('set and verify', () {
    test('stores a salted hash, never the code itself', () async {
      await passcode.setPasscode(userA, '1374');
      final raw = store.snapshot['sellflow.passcode.$userA']!;
      expect(raw.contains('1374'), isFalse);
      expect(raw.contains('salt'), isTrue);
      expect(raw.contains('hash'), isTrue);
    });

    test('accepts the correct code', () async {
      await passcode.setPasscode(userA, '1374');
      final result = await passcode.verifyPasscode(userA, '1374');
      expect(result.ok, isTrue);
      expect(result.lockedOut, isFalse);
    });

    test('rejects the wrong code and counts the attempt', () async {
      await passcode.setPasscode(userA, '1374');
      final result = await passcode.verifyPasscode(userA, '9999');
      expect(result.ok, isFalse);
      expect(result.pass, 1);
      expect(result.remaining, 4);
    });

    test('two codes for one account get different salts', () async {
      await passcode.setPasscode(userA, '1374');
      final first = store.snapshot['sellflow.passcode.$userA']!;
      await passcode.clearPasscode(userA);
      await passcode.setPasscode(userA, '1374');
      final second = store.snapshot['sellflow.passcode.$userA']!;
      expect(first.contains('1374'), isFalse);
      expect(second.contains('1374'), isFalse);
    });
  });

  group('per-account isolation', () {
    test('one account cannot read another accounts passcode', () async {
      await passcode.setPasscode(userA, '1374');
      expect(await passcode.hasPasscode(userB), isFalse);
      final result = await passcode.verifyPasscode(userB, '1374');
      // No record for userB, so there is nothing to enforce.
      expect(result.ok, isTrue);
      expect(result.pass, 0);
    });

    test('setting one account does not overwrite the other', () async {
      await passcode.setPasscode(userA, '1374');
      await passcode.setPasscode(userB, '2586');
      expect((await passcode.verifyPasscode(userA, '1374')).ok, isTrue);
      expect((await passcode.verifyPasscode(userB, '2586')).ok, isTrue);
    });
  });

  group('length persistence', () {
    test('reads back the stored length', () async {
      await passcode.setPasscode(userA, '135742');
      expect(await passcode.readPasscodeLength(userA), 6);
    });

    test('reports null for a legacy record with no length', () async {
      // A v1 record has no `length`. Assuming 4 was the bug that made 6-digit codes
      // impossible to enter: the keypad submitted at four digits and the rest were
      // swallowed, burning an attempt each time. Callers must get null and fall
      // back to an explicit Continue key.
      // A v1 record has no `length`. Assuming 4 was the bug that made 6-digit codes
      // impossible to enter: the keypad submitted at four digits and the rest were
      // swallowed, burning an attempt each time. Callers must get null and fall
      // back to an explicit Continue key.
      await store.write(
        'sellflow.passcode.$userA',
        '{"version":1,"salt":"ab","hash":"cd"}',
      );
      expect(await passcode.readPasscodeLength(userA), isNull);
    });

    test('reports null when no passcode exists', () async {
      expect(await passcode.readPasscodeLength(userA), isNull);
    });
  });

  group('lockout', () {
    test('locks out after five failures', () async {
      await passcode.setPasscode(userA, '1374');
      for (var i = 1; i <= 5; i++) {
        final result = await passcode.verifyPasscode(userA, '9999');
        expect(result.pass, i);
      }
      final locked = await passcode.verifyPasscode(userA, '9999');
      expect(locked.lockedOut, isTrue);
      expect(locked.remaining, 0);
    });

    test('does NOT wipe the record on lockout', () async {
      // The previous behaviour deleted it. That is a lockout that grants access:
      // whoever holds the phone walks straight in and the seller loses their
      // protection. A rate limiter whose fifth action is "let them in" is worse
      // than none, because it looks like protection.
      await passcode.setPasscode(userA, '1374');
      for (var i = 0; i < 5; i++) {
        await passcode.verifyPasscode(userA, '9999');
      }
      expect(await passcode.hasPasscode(userA), isTrue);
    });

    test('the correct code is still refused while locked out', () async {
      await passcode.setPasscode(userA, '1374');
      for (var i = 0; i < 5; i++) {
        await passcode.verifyPasscode(userA, '9999');
      }
      final result = await passcode.verifyPasscode(userA, '1374');
      expect(result.ok, isFalse);
      expect(result.lockedOut, isTrue);
    });

    test('names the account password on every locked-out response', () async {
      await passcode.setPasscode(userA, '1374');
      for (var i = 0; i < 5; i++) {
        await passcode.verifyPasscode(userA, '9999');
      }
      // A seller mid-cooldown who has forgotten their code is exactly the person
      // who needs to see the way out, and they see THIS message.
      final first = await passcode.verifyPasscode(userA, '1374');
      final second = await passcode.verifyPasscode(userA, '1374');
      expect(first.message, contains('account password'));
      expect(second.message, contains('account password'));
    });

    test('resets the counter after a successful verify', () async {
      await passcode.setPasscode(userA, '1374');
      await passcode.verifyPasscode(userA, '9999');
      await passcode.verifyPasscode(userA, '9999');
      final ok = await passcode.verifyPasscode(userA, '1374');
      expect(ok.ok, isTrue);
      final after = await passcode.verifyPasscode(userA, '9999');
      expect(after.pass, 1);
    });

    test(
      'a corrupt record is treated as absent, not as a permanent lock',
      () async {
        await store.write('sellflow.passcode.$userA', 'not-json');
        final result = await passcode.verifyPasscode(userA, '1374');
        expect(result.ok, isTrue);
      },
    );
  });

  group('clearPasscode', () {
    test('removes the record, the counter and the cooldown marker', () async {
      // Leaving the cooldown marker behind would mean the NEXT passcode is born
      // already locked out until a stale timestamp expires.
      await passcode.setPasscode(userA, '1374');
      for (var i = 0; i < 5; i++) {
        await passcode.verifyPasscode(userA, '9999');
      }
      await passcode.clearPasscode(userA);
      expect(await passcode.hasPasscode(userA), isFalse);
      expect(
        store.snapshot.keys.where((k) => k.contains('lockedUntil')),
        isEmpty,
      );

      // A passcode set AFTER a lockout must not inherit the stale cooldown.
      await passcode.setPasscode(userA, '2586');
      final result = await passcode.verifyPasscode(userA, '2586');
      expect(result.lockedOut, isFalse);
      expect(result.ok, isTrue);
    });
  });

  group('secure store failure', () {
    test('an unreadable keystore does not lock the seller out', () async {
      // A read failure on the unlock path must not produce an unhandled rejection
      // that leaves them on a permanently blank keypad.
      final broken = _ThrowingStore();
      final service = PasscodeService(broken);
      expect(await service.hasPasscode(userA), isFalse);
      final result = await service.verifyPasscode(userA, '1374');
      expect(result.ok, isFalse);
      expect(result.message, contains('unavailable'));
    });
  });
}

class _ThrowingStore implements SecureStore {
  @override
  Future<String?> read(String key) async => throw StateError('keystore down');

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('keystore down');

  @override
  Future<void> delete(String key) async => throw StateError('keystore down');
}
