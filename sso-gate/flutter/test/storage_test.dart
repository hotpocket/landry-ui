import 'package:flutter_test/flutter_test.dart';
import 'package:sso_gate/sso_gate.dart';
import 'package:sso_gate/src/storage.dart' show RawStorage;

class MemStorage implements RawStorage {
  final m = <String, String>{};
  @override
  String? getItem(String key) => m[key];
  @override
  void setItem(String key, String value) => m[key] = value;
  @override
  void removeItem(String key) => m.remove(key);
}

/// Safari "Block All Cookies": naming the storage throws.
class HostileStorage implements RawStorage {
  @override
  String? getItem(String key) => throw StateError('SecurityError');
  @override
  void setItem(String key, String value) => throw StateError('SecurityError');
  @override
  void removeItem(String key) => throw StateError('SecurityError');
}

/// Readable, but full (quota) or read-only.
class FullStorage extends MemStorage {
  @override
  void setItem(String key, String value) => throw StateError('QuotaExceededError');
}

void main() {
  for (final make in [(RawStorage r) => SafeLocalStorage(raw: r), (RawStorage r) => SafeSessionStorage(raw: r)]) {
    test('working storage: not blocked, values land in the browser', () {
      final raw = MemStorage();
      final s = make(raw);
      expect(s.blocked, isFalse);
      s.set('k', 'v');
      expect(raw.m, {'k': 'v'});
      expect(s.get('k'), 'v');
      s.remove('k');
      expect(s.get('k'), isNull);
    });

    test('storage that throws on every touch is blocked, never throws, remembers in memory', () {
      final s = make(HostileStorage());
      expect(s.blocked, isTrue);
      expect(s.get('k'), isNull);
      s.set('k', 'v');
      expect(s.get('k'), 'v');
      s.remove('k');
      expect(s.get('k'), isNull);
    });

    test('a write that throws falls back to memory', () {
      final s = make(FullStorage());
      expect(s.blocked, isFalse);
      s.set('k', 'v');
      expect(s.get('k'), 'v', reason: 'kept in memory for this page');
      s.remove('k');
      expect(s.get('k'), isNull);
    });
  }
}
