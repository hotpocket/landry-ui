import 'storage_stub.dart' if (dart.library.js_interop) 'storage_web.dart' as impl;

/// Where the ID token is remembered across reloads.
abstract interface class SsoStorage {
  String? get(String key);
  void set(String key, String value);
  void remove(String key);
}

/// Browser localStorage, guarded: Safari with "Block All Cookies" throws
/// SecurityError from the localStorage GETTER itself, so every touch sits
/// inside a try. Unavailable = nothing remembered, never a crash. Off the web
/// (tests) it remembers nothing.
class SafeLocalStorage implements SsoStorage {
  const SafeLocalStorage();

  @override
  String? get(String key) {
    try {
      return impl.read(key);
    } on Object {
      return null;
    }
  }

  @override
  void set(String key, String value) {
    try {
      impl.write(key, value);
    } on Object {
      // Unavailable: the value lives in memory for this session only.
    }
  }

  @override
  void remove(String key) {
    try {
      impl.delete(key);
    } on Object {
      // Unavailable: nothing was stored.
    }
  }
}
