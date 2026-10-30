import 'package:web/web.dart' as web;

// Callers wrap every one of these in try: naming localStorage or
// sessionStorage can throw (iOS Safari "Block All Cookies").
web.Storage _area(bool session) => session ? web.window.sessionStorage : web.window.localStorage;

String? read(bool session, String key) => _area(session).getItem(key);
void write(bool session, String key, String value) => _area(session).setItem(key, value);
void delete(bool session, String key) => _area(session).removeItem(key);
