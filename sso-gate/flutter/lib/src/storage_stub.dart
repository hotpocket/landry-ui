// Off the web (VM tests, tools): an in-memory stand-in per area.
final _areas = [<String, String>{}, <String, String>{}];

String? read(bool session, String key) => _areas[session ? 1 : 0][key];
void write(bool session, String key, String value) => _areas[session ? 1 : 0][key] = value;
void delete(bool session, String key) => _areas[session ? 1 : 0].remove(key);
