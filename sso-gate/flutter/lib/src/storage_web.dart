import 'package:web/web.dart' as web;

// Callers wrap every one of these in try: naming localStorage can throw.
String? read(String key) => web.window.localStorage.getItem(key);
void write(String key, String value) => web.window.localStorage.setItem(key, value);
void delete(String key) => web.window.localStorage.removeItem(key);
