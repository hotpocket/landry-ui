import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Safari with "Block All Cookies" throws SecurityError from the
/// localStorage/sessionStorage GETTER — naming it is enough. The class: every
/// evaluation of a storage global outside lib/src/storage_web.dart, whose
/// only caller (SafeStorage in storage.dart) wraps each call in try.
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

  test('storage_web.dart is imported only by storage.dart', () {
    final importers = [
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>())
        if (f.path.endsWith('.dart') && f.readAsStringSync().contains("'storage_web.dart'")) f.path,
    ];
    expect(importers, [endsWith('storage.dart')]);
  });

  test('every storage_web.dart call is wrapped in try by SafeStorage', () {
    final src = File('lib/src/storage.dart').readAsStringSync();
    final calls = RegExp(r'impl\.\w+\(').allMatches(src).toList();
    expect(calls.map((m) => m.group(0)).toSet(), {'impl.read(', 'impl.write(', 'impl.delete('});
    for (final m in calls) {
      final before = src.substring(0, m.start);
      expect(before.lastIndexOf('try {'), greaterThan(before.lastIndexOf('}')),
          reason: '${m.group(0)} at offset ${m.start} outside try');
    }
  });
}
