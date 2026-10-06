import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Safari with "Block All Cookies" throws SecurityError from the
/// localStorage/sessionStorage GETTER — naming it is enough. The class: every
/// evaluation of a storage global outside lib/src/storage_web.dart, whose
/// only caller (SafeLocalStorage) wraps each call in try.
void main() {
  test('browser storage is only touched inside storage_web.dart', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart') || f.path.endsWith('storage_web.dart')) continue;
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final code = lines[i].split('//').first;
        if (RegExp(r'\b(localStorage|sessionStorage|indexedDB|caches)\b').hasMatch(code)) {
          offenders.add('${f.path}:${i + 1}');
        }
      }
    }
    expect(offenders, isEmpty);
  });

  test('every storage_web.dart call is wrapped in try by SafeLocalStorage', () {
    final src = File('lib/src/storage.dart').readAsStringSync();
    for (final call in ['impl.read(', 'impl.write(', 'impl.delete(']) {
      final at = src.indexOf(call);
      expect(at, isNonNegative, reason: call);
      final before = src.substring(0, at);
      expect(before.lastIndexOf('try {'), greaterThan(before.lastIndexOf('}')), reason: '$call outside try');
    }
  });
}
