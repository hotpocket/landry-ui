import 'package:flutter/foundation.dart';

import 'storage_stub.dart' if (dart.library.js_interop) 'storage_web.dart' as impl;

/// Where the session (tokens) and the pending sign-in (PKCE) are kept.
/// Never throws.
abstract interface class SsoStorage {
  /// True when the browser refused storage (the probe threw): values then
  /// live in memory for this page only.
  bool get blocked;
  String? get(String key);
  void set(String key, String value);
  void remove(String key);
}

/// A browser Storage as it really is: any call may throw. Tests stand in a
/// hostile one; in the browser it is never constructed.
@visibleForTesting
abstract interface class RawStorage {
  String? getItem(String key);
  void setItem(String key, String value);
  void removeItem(String key);
}

/// Browser storage, guarded: Safari with "Block All Cookies" throws
/// SecurityError from the localStorage/sessionStorage GETTER itself, so every
/// touch sits inside a try. A probe at construction sets [blocked]; a refused
/// or failed write keeps the value in memory instead. Never a crash.
abstract class _SafeStorage implements SsoStorage {
  _SafeStorage(this._session, this._raw) {
    try {
      _raw == null ? impl.read(_session, '__probe__') : _raw.getItem('__probe__');
    } on Object {
      _blocked = true;
    }
  }

  final bool _session;
  final RawStorage? _raw;
  final _memory = <String, String>{};

  bool _blocked = false;
  @override
  bool get blocked => _blocked;

  @override
  String? get(String key) {
    if (_blocked || _memory.containsKey(key)) return _memory[key];
    try {
      return _raw == null ? impl.read(_session, key) : _raw.getItem(key);
    } on Object {
      return null;
    }
  }

  @override
  void set(String key, String value) {
    if (_blocked) {
      _memory[key] = value;
      return;
    }
    try {
      _raw == null ? impl.write(_session, key, value) : _raw.setItem(key, value);
      _memory.remove(key);
    } on Object {
      _memory[key] = value;
    }
  }

  @override
  void remove(String key) {
    _memory.remove(key);
    if (_blocked) return;
    try {
      _raw == null ? impl.delete(_session, key) : _raw.removeItem(key);
    } on Object {
      // Unavailable: nothing was stored there.
    }
  }
}

/// window.localStorage, guarded. Holds the session across reloads.
class SafeLocalStorage extends _SafeStorage {
  SafeLocalStorage({@visibleForTesting RawStorage? raw}) : super(false, raw);
}

/// window.sessionStorage, guarded. Holds the pending sign-in for this tab.
class SafeSessionStorage extends _SafeStorage {
  SafeSessionStorage({@visibleForTesting RawStorage? raw}) : super(true, raw);
}
