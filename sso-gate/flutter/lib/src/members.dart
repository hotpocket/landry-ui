import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'sso_auth.dart';

/// Someone allowed into the site. A [global] admin is an admin of every
/// landry.bot site: shown, never editable from one site.
@immutable
class Member {
  const Member({required this.email, required this.role, this.global = false, this.addedBy, this.addedAt});

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        email: j['email'] as String,
        role: j['role'] as String? ?? 'user',
        global: j['global'] == true,
        addedBy: j['addedBy'] as String?,
        addedAt: j['addedAt'] as String?,
      );

  final String email;

  /// `admin` or `user`.
  final String role;
  final bool global;
  final String? addedBy;

  /// ISO 8601, as the broker wrote it.
  final String? addedAt;
}

/// The broker refused: [status] 403 = not a site admin, 409 = already so,
/// 404 = no such member. [message] is the broker's `error`.
class MembersException implements Exception {
  const MembersException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// Who may use this site, as a site admin manages it. Throws
/// [MembersException] when the broker refuses.
abstract interface class MembersApi {
  Future<List<Member>> list();
  Future<void> add(String email, {String role = 'user'});
  Future<void> setRole(String email, String role);
  Future<void> remove(String email);
}

/// [MembersApi] against the broker: `<apiUrl>/sites/<site>/members`, with the
/// signed-in user's bearer token.
class BrokerMembersApi implements MembersApi {
  BrokerMembersApi(this._auth);

  final SsoAuth _auth;

  Future<Map<String, dynamic>> _call(String method, String path, [Map<String, String>? body]) async {
    final url = Uri.parse(
        '${_auth.apiUrl}/sites/${Uri.encodeComponent(_auth.site)}/members$path');
    final res = await _auth.send(() {
      final r = http.Request(method, url);
      if (body != null) {
        r.headers['Content-Type'] = 'application/json';
        r.body = jsonEncode(body);
      }
      return r;
    });
    Map<String, dynamic> out;
    try {
      out = res.statusCode == 204 ? const {} : jsonDecode(res.body) as Map<String, dynamic>;
    } on Object {
      out = const {};
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw MembersException(res.statusCode, '${out['error'] ?? 'HTTP ${res.statusCode}'}');
    }
    return out;
  }

  @override
  Future<List<Member>> list() async {
    final out = await _call('GET', '');
    return [
      for (final m in (out['members'] as List? ?? const []))
        Member.fromJson(m as Map<String, dynamic>),
    ];
  }

  @override
  Future<void> add(String email, {String role = 'user'}) =>
      _call('POST', '', {'email': email, 'role': role});

  @override
  Future<void> setRole(String email, String role) =>
      _call('PATCH', '/${Uri.encodeComponent(email)}', {'role': role});

  @override
  Future<void> remove(String email) => _call('DELETE', '/${Uri.encodeComponent(email)}');
}
