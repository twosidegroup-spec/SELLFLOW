/// App passcode: a second lock in front of the account password.
///
/// WHAT THIS PROTECTS, STATED PLAINLY
///
/// A borrowed or unattended unlocked phone. It is one of two factors, not the only
/// one: unlocking still requires a live Supabase session, and the account password
/// remains the real credential.
///
/// The record lives only in the platform keystore (Android hardware-backed), is
/// salted, and is keyed by user id so two accounts on one device cannot read or
/// overwrite each other's passcode.
///
/// WHAT IT DELIBERATELY DOES NOT DO
///
/// Make a 4- or 6-digit passcode unguessable offline. It cannot be: the search
/// space is tiny by definition, and no iteration count changes that. A KDF here
/// would buy a lockout delay, not security, so this is a single salted SHA-512 and
/// says so rather than implying a strength it does not have.
library;

import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _keyPrefix = 'sellflow.passcode.';
const _maxAttempts = 5;

/// Cooldown after the last permitted attempt.
///
/// Short on purpose. The threat is someone guessing at an unlocked phone, and a
/// short cooldown stops a five-digit brute force exactly as well as a long one —
/// the attacker waits either way. A long cooldown would punish the far likelier
/// case, a seller who mis-remembers their own code while holding live orders.
const _lockoutMs = Duration(seconds: 30);

/// The two lengths a seller may choose.
const passcodeLengths = <int>[4, 6];

const defaultPasscodeLength = 4;

/// Record version. v2 added `length`, which is what makes a 6-digit code enterable.
const _recordVersion = 2;

class PasscodeRecord {
  const PasscodeRecord({
    required this.version,
    required this.salt,
    required this.hash,
    required this.length,
    required this.updatedAt,
  });

  final int version;
  final String salt;
  final String hash;

  /// How many digits this code has. Absent on legacy records — see [readPasscodeLength].
  final int? length;
  final DateTime updatedAt;

  Map<String, dynamic> toJson() => {
    'version': version,
    'salt': salt,
    'hash': hash,
    'length': length,
    'updatedAt': updatedAt.toIso8601String(),
  };

  static PasscodeRecord? fromJson(Map<String, dynamic> json) {
    final version = json['version'];
    final salt = json['salt'];
    final hash = json['hash'];
    if (version is! int || salt is! String || hash is! String) return null;
    final rawLength = json['length'];
    return PasscodeRecord(
      version: version,
      salt: salt,
      hash: hash,
      length: rawLength is int && rawLength > 0 ? rawLength : null,
      updatedAt:
          DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// Outcome of a verification attempt.
class PasscodeCheck {
  const PasscodeCheck({
    required this.pass,
    required this.ok,
    required this.lockedOut,
    required this.remaining,
    required this.message,
  });

  /// Attempts consumed so far, 0-5.
  final int pass;
  final bool ok;
  final bool lockedOut;

  /// Attempts left before a cooldown.
  final int remaining;
  final String message;
}

class PasscodeValidation {
  const PasscodeValidation(this.ok, this.message);

  final bool ok;
  final String message;
}

/// Keystore access. Injectable so tests never touch platform channels.
abstract class SecureStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

class FlutterSecureStore implements SecureStore {
  FlutterSecureStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// In-memory store, for tests.
class InMemorySecureStore implements SecureStore {
  final Map<String, String> _values = {};

  Map<String, String> get snapshot => Map.unmodifiable(_values);

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

/// Encodes passcodes for debug output without revealing them.
///
/// Present because a test that asserts "these two codes are not equal" reads much
/// better than one comparing 64-character hashes, and a printed hash is still a
/// derived secret.
String debugFingerprint(String passcode) =>
    sha256.convert(utf8.encode(passcode)).toString().substring(0, 8);

class PasscodeService {
  PasscodeService(this._store);

  final SecureStore _store;

  /// Random hex salt, from the platform CSPRNG.
  static final _rng = Random.secure();

  static String _newSalt() {
    final bytes = List<int>.generate(16, (_) => _rng.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  String _key(String userId) =>
      '$_keyPrefix${userId.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}';

  /// Salted SHA-512. The `:` separator stops a passcode being read off the salt.
  static String _derive(String passcode, String saltHex) =>
      sha512.convert(utf8.encode('$saltHex:$passcode')).toString();

  /// Length-safe, content-safe comparison.
  ///
  /// Not constant-time against an attacker who can measure this Dart code, but it
  /// avoids the early `return` on the first differing character that a plain `==`
  /// gives, and the passcode is not a remote-observable secret.
  static bool _constantTimeEquals(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }

  /// Whether a length is one a seller may pick.
  static bool isPasscodeLength(int value) => passcodeLengths.contains(value);

  /// Validates the shape rules the UI enforces, in one place.
  ///
  /// [lengths] defaults to accepting any 4-8 digit value, which is what legacy
  /// records predate. Registration and setup pass [passcodeLengths] so only 4 or 6
  /// can be chosen.
  static PasscodeValidation validatePasscode(
    String passcode, {
    List<int> lengths = const [4, 5, 6, 7, 8],
  }) {
    if (passcode.isEmpty || !RegExp(r'^\d+$').hasMatch(passcode)) {
      return const PasscodeValidation(false, 'Digits only.');
    }
    if (!lengths.contains(passcode.length)) {
      final wanted = lengths.length == 1
          ? '${lengths.first} digits'
          : '${lengths.join(' or ')} digits';
      return PasscodeValidation(false, 'Use exactly $wanted.');
    }
    if (RegExp(r'^(\d)\1+$').hasMatch(passcode)) {
      return const PasscodeValidation(false, 'Do not repeat one digit.');
    }
    if (_isSequential(passcode)) {
      return const PasscodeValidation(false, 'Do not use a simple sequence.');
    }
    return const PasscodeValidation(true, '');
  }

  /// Rejects 1234, 4321 and their forward/reverse runs.
  static bool _isSequential(String passcode) {
    final digits = passcode.split('').map(int.parse).toList();
    if (digits.length < 3) return false;
    var ascending = true;
    var descending = true;
    for (var i = 1; i < digits.length; i++) {
      if (digits[i] != digits[i - 1] + 1) ascending = false;
      if (digits[i] != digits[i - 1] - 1) descending = false;
    }
    return ascending || descending;
  }

  Future<bool> hasPasscode(String? userId) async {
    if (userId == null || userId.isEmpty) return false;
    try {
      return await _store.read(_key(userId)) != null;
    } catch (_) {
      // An unreadable keystore must not lock a seller out of their own account.
      return false;
    }
  }

  Future<void> setPasscode(
    String userId,
    String passcode, {
    List<int> lengths = passcodeLengths,
  }) async {
    final check = validatePasscode(passcode, lengths: lengths);
    if (!check.ok) throw ArgumentError(check.message);

    final salt = _newSalt();
    final record = PasscodeRecord(
      version: _recordVersion,
      salt: salt,
      hash: _derive(passcode, salt),
      length: passcode.length,
      updatedAt: DateTime.now(),
    );
    await _store.write(_key(userId), jsonEncode(record.toJson()));
    await _store.write('${_key(userId)}.failed', '0');
  }

  /// How many digits this account's code has, or null.
  ///
  /// Null means either no passcode, or a record written before `length` existed.
  /// The second case matters: assuming 4 was the bug that made 6-digit codes
  /// impossible to enter — the keypad auto-submitted at four digits and the rest
  /// were swallowed, burning one of five attempts each time. Callers get `null`
  /// and must fall back to an explicit Continue key instead of guessing.
  Future<int?> readPasscodeLength(String? userId) async {
    if (userId == null || userId.isEmpty) return null;
    try {
      final raw = await _store.read(_key(userId));
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final length = decoded['length'];
      return length is int && length > 0 ? length : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> clearPasscode(String userId) async {
    try {
      await _store.delete(_key(userId));
      await _store.delete('${_key(userId)}.failed');
      // The cooldown marker goes too. Leaving it would mean the NEXT passcode is
      // born already locked out until a stale timestamp expires.
      await _store.delete('${_key(userId)}.lockedUntil');
    } catch (_) {
      // Nothing to clear.
    }
  }

  Future<int> _readAttempts(String userId) async {
    try {
      final raw = await _store.read('${_key(userId)}.failed');
      final parsed = int.tryParse(raw ?? '0') ?? 0;
      return parsed < 0 ? 0 : parsed;
    } catch (_) {
      return 0;
    }
  }

  Future<void> _writeAttempts(String userId, int value) async {
    try {
      await _store.write('${_key(userId)}.failed', '$value');
    } catch (_) {
      // A failed counter write only weakens throttling; it must not block unlock.
    }
  }

  /// Verifies a passcode.
  ///
  /// Failures are counted. After [_maxAttempts] the entry is LOCKED FOR A COOLDOWN
  /// — it is not wiped.
  ///
  /// WHY NOT WIPED
  ///
  /// The previous behaviour deleted the record on the fifth wrong guess. That is a
  /// lockout that grants access: whoever holds the phone simply continues into the
  /// app, and the only thing lost is the seller's own protection. A rate limiter
  /// whose fifth action is "let them in" is worse than none, because it looks like
  /// protection.
  ///
  /// WHY A COOLDOWN AND NOT A PERMANENT LOCK
  ///
  /// A seller who forgets their own code must not be permanently locked out of a
  /// business holding live orders. So the entry refuses for [_lockoutMs] and then
  /// reopens. Escape is always the account password.
  Future<PasscodeCheck> verifyPasscode(String userId, String passcode) async {
    String? raw;
    try {
      raw = await _store.read(_key(userId));
    } catch (_) {
      return const PasscodeCheck(
        pass: 0,
        ok: false,
        lockedOut: false,
        remaining: 0,
        message: 'Passcode unavailable.',
      );
    }

    if (raw == null) {
      // No passcode set, so there is nothing to enforce.
      return const PasscodeCheck(
        pass: 0,
        ok: true,
        lockedOut: false,
        remaining: _maxAttempts,
        message: '',
      );
    }

    var attempts = await _readAttempts(userId);
    if (attempts >= _maxAttempts) {
      final waitMs = await _lockoutRemainingMs(userId);
      if (waitMs > 0) {
        // The password is named on EVERY locked-out response, not just the first.
        // A seller mid-cooldown who has forgotten their code is exactly the person
        // who needs to see the way out.
        final seconds = (waitMs / 1000).ceil();
        return PasscodeCheck(
          pass: _maxAttempts,
          ok: false,
          lockedOut: true,
          remaining: 0,
          message:
              'Too many attempts. Try again in ${seconds}s, '
              'or sign in with your account password.',
        );
      }
      // Cooldown expired: reset and judge this attempt on its own merits rather
      // than stranding the seller at a permanent refusal.
      attempts = 0;
      await _writeAttempts(userId, 0);
    }

    PasscodeRecord record;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) throw const FormatException();
      final parsed = PasscodeRecord.fromJson(decoded);
      if (parsed == null) throw const FormatException();
      record = parsed;
    } catch (_) {
      // Corrupt record: treat as absent rather than locking the user out forever.
      await clearPasscode(userId);
      return const PasscodeCheck(
        pass: 0,
        ok: true,
        lockedOut: false,
        remaining: _maxAttempts,
        message: '',
      );
    }

    final candidate = _derive(passcode, record.salt);
    if (_constantTimeEquals(candidate, record.hash)) {
      await _writeAttempts(userId, 0);
      await _safeWrite('${_key(userId)}.lockedUntil', '');
      return const PasscodeCheck(
        pass: 0,
        ok: true,
        lockedOut: false,
        remaining: _maxAttempts,
        message: '',
      );
    }

    final next = attempts + 1;
    await _writeAttempts(userId, next);

    if (next >= _maxAttempts) {
      // Start the cooldown. The record is left intact on purpose.
      final until = DateTime.now().add(_lockoutMs).millisecondsSinceEpoch;
      await _safeWrite('${_key(userId)}.lockedUntil', '$until');
      return PasscodeCheck(
        pass: next,
        ok: false,
        lockedOut: true,
        remaining: 0,
        message:
            'Too many attempts. Try again in ${(_lockoutMs.inSeconds)}s, '
            'or sign in with your account password.',
      );
    }

    final left = _maxAttempts - next;
    return PasscodeCheck(
      pass: next,
      ok: false,
      lockedOut: false,
      remaining: left,
      message: 'Incorrect passcode. $left attempt${left == 1 ? '' : 's'} left.',
    );
  }

  /// Milliseconds until the entry reopens. 0 when not locked.
  Future<int> _lockoutRemainingMs(String userId) async {
    final raw = await _safeRead('${_key(userId)}.lockedUntil');
    final until = int.tryParse(raw ?? '') ?? 0;
    if (until <= 0) return 0;
    final remaining = until - DateTime.now().millisecondsSinceEpoch;
    if (remaining > 0) return remaining;
    await _safeWrite('${_key(userId)}.lockedUntil', '');
    return 0;
  }

  /// Keystore read that never throws. A failure here must not leave the seller
  /// staring at a permanently blank keypad.
  Future<String?> _safeRead(String key) async {
    try {
      return await _store.read(key);
    } catch (_) {
      return null;
    }
  }

  Future<void> _safeWrite(String key, String value) async {
    try {
      await _store.write(key, value);
    } catch (_) {
      // Losing the throttle degrades to "no lockout", never to a broken keypad.
    }
  }

  static const passcodeAttempts = _maxAttempts;
  static const passcodeLockoutMs = _lockoutMs;
}
