import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'browser.dart';
import 'members.dart';
import 'storage.dart';

/// Where a page stands with sign-in. [checking] until [SsoAuth.init] answers.
enum SsoStatus { checking, signedOut, signedIn, denied, error }

/// Who is signed in, from the access token's claims. NOT verified: for the
/// UI only. Servers verify the token.
@immutable
class SsoUser {
  const SsoUser({this.email, this.role, this.site});

  final String? email;

  /// `admin` or `user`, for [site].
  final String? role;
  final String? site;

  bool get isAdmin => role == 'admin';

  @override
  bool operator ==(Object other) =>
      other is SsoUser && other.email == email && other.role == role && other.site == site;

  @override
  int get hashCode => Object.hash(email, role, site);

  @override
  String toString() => 'SsoUser($email, $role, $site)';
}

@immutable
class SsoState {
  const SsoState(this.status, {this.user, this.message});

  final SsoStatus status;

  /// Set when [status] is [SsoStatus.signedIn].
  final SsoUser? user;

  /// A sentence for the reader when [status] is [SsoStatus.error].
  final String? message;

  @override
  bool operator ==(Object other) =>
      other is SsoState && other.status == status && other.user == user && other.message == message;

  @override
  int get hashCode => Object.hash(status, user, message);

  @override
  String toString() => 'SsoState($status, $user, $message)';
}

/// The token endpoint said no ([status] 4xx), or answered nonsense.
class _TokenRefused implements Exception {
  _TokenRefused(this.status, this.error);
  final int status;
  final String error;
  @override
  String toString() => 'token endpoint $status: $error';
}

/// landry.bot sign-in via the broker (auth.landry.bot: Cognito with Google).
/// Authorization code + PKCE; the broker refuses anyone not on this site's
/// allow-list before a token exists. The Flutter twin of ../js/landry-auth.js:
/// same flow, same storage keys, same sentences.
///
///   final auth = SsoAuth(site: 'graph', clientId: '…');
///   await auth.init();        // on load; auth.state says where we stand
///   auth.signIn(); auth.signOut(); await auth.accessToken();
///   await auth.send(() => http.Request('GET', uri));  // bearer + one retry
///   auth.members.list() / add / setRole / remove
///
/// Tokens live in localStorage under `landry.<site>.auth` as JSON
/// {access, refresh}; the pending sign-in in sessionStorage under
/// `landry.<site>.auth.pkce` as {verifier, state, next}.
///
/// No [clientId] = disabled: the site runs signed out with no network (local
/// dev, where the API bypasses auth too).
const _cookiesSentence = 'Sign-in needs cookies and site data. Allow them for this site '
    '(Safari: Settings > Safari > Block All Cookies off) and try again.';

class SsoAuth {
  SsoAuth({
    required this.site,
    required this.clientId,
    String? hostedDomain,
    String? apiUrl,
    SsoStorage? local,
    SsoStorage? session,
    SsoBrowser? browser,
    http.Client? client,
    @visibleForTesting DateTime Function()? clock,
  })  : hostedDomain = _trim(hostedDomain ?? 'https://auth.landry.bot'),
        apiUrl = _trim(apiUrl ?? 'https://api.auth.landry.bot'),
        _local = local ?? SafeLocalStorage(),
        _session = session ?? SafeSessionStorage(),
        _browser = browser ?? SsoBrowser.window(),
        _client = client ?? http.Client(),
        _clock = clock ?? DateTime.now {
    _state = ValueNotifier(SsoState(enabled ? SsoStatus.checking : SsoStatus.signedOut));
  }

  /// Refresh this long before the access token expires.
  static const _skew = 60;

  final String site;
  final String clientId;
  final String hostedDomain;
  final String apiUrl;
  final SsoStorage _local;
  final SsoStorage _session;
  final SsoBrowser _browser;
  final http.Client _client;
  final DateTime Function() _clock;
  late final ValueNotifier<SsoState> _state;

  String get _key => 'landry.$site.auth';
  String get _redirectUri => '${_browser.url.origin}/';

  ({String access, String? refresh})? _tokens;
  Future<String?>? _refreshing;

  bool get enabled => clientId.isNotEmpty;

  /// The browser refused storage: sign-in cannot complete here.
  bool get storageBlocked => _local.blocked || _session.blocked;

  /// Notifies on every change of status (and of user or message).
  ValueListenable<SsoState> get state => _state;

  /// The broker's members routes for this site, as the signed-in user.
  late final MembersApi members = BrokerMembersApi(this);

  /// On load: finishes a sign-in coming back from the broker, or resumes the
  /// stored session (refreshing it if needed). Answers the new state.
  Future<SsoState> init() async {
    if (!enabled) return _set(const SsoState(SsoStatus.signedOut));
    final q = _browser.url.queryParameters;
    if (q.containsKey('error') || q.containsKey('error_description')) {
      final desc = q['error_description'] ?? q['error'] ?? '';
      _browser.replaceUrl(_browser.url.path);
      if (desc.contains('not_allowed')) return _set(const SsoState(SsoStatus.denied));
      return _set(SsoState(SsoStatus.error, message: 'Sign-in failed: $desc'));
    }
    if (q.containsKey('code')) return _finishSignIn(q['code']!, q['state']);

    _tokens = _load();
    if (_tokens == null) return _set(const SsoState(SsoStatus.signedOut));
    if (!_expired(_tokens!.access)) return _signedIn();
    try {
      final a = await _refresh();
      return a != null ? _state.value : _set(const SsoState(SsoStatus.signedOut));
    } on Object {
      return _set(const SsoState(SsoStatus.error,
          message: 'Could not reach the sign-in service. Check your connection.'));
    }
  }

  Future<SsoState> _finishSignIn(String code, String? state) async {
    Map<String, dynamic>? pending;
    try {
      pending = jsonDecode(_session.get('$_key.pkce') ?? 'null') as Map<String, dynamic>?;
    } on Object {
      pending = null;
    }
    _session.remove('$_key.pkce');
    if (storageBlocked || pending == null) {
      _browser.replaceUrl(_browser.url.path);
      return _set(SsoState(SsoStatus.error,
          message: storageBlocked
              ? _cookiesSentence
              : 'Sign-in expired. Please try again.'));
    }
    if (pending['state'] != state) {
      _browser.replaceUrl(_browser.url.path);
      return _set(const SsoState(SsoStatus.error,
          message: 'Sign-in did not match this browser tab. Please try again.'));
    }
    // Before the exchange: a reload must not replay the code.
    _browser.replaceUrl(pending['next'] as String? ?? '/');
    try {
      final b = await _tokenCall({
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': _redirectUri,
        'code_verifier': '${pending['verifier']}',
      });
      _save((access: b['access_token'] as String, refresh: b['refresh_token'] as String?));
      return _signedIn();
    } on Object {
      return _set(const SsoState(SsoStatus.error, message: 'Sign-in failed. Please try again.'));
    }
  }

  /// Leaves for the broker's Google sign-in; comes back to this page (or
  /// [next]) via [init].
  Future<void> signIn({String? next}) async {
    if (!enabled) return;
    final verifier = _randomString(48);
    final state = _randomString(16);
    final u = _browser.url;
    final here = '${u.path}${u.hasQuery ? '?${u.query}' : ''}${u.hasFragment ? '#${u.fragment}' : ''}';
    _session.set('$_key.pkce', jsonEncode({'verifier': verifier, 'state': state, 'next': next ?? here}));
    // The verifier must survive the trip to Google and back; held only in
    // memory it dies with this page and the return can only fail.
    final s = _session;
    // (and init() refuses any return while either storage is blocked).
    if (storageBlocked || (s is SsoStorageWrites ? !s.persisted('$_key.pkce') : s.blocked)) {
      _set(const SsoState(SsoStatus.error, message: _cookiesSentence));
      return;
    }
    _browser.navigate(Uri.parse('$hostedDomain/oauth2/authorize').replace(queryParameters: {
      'response_type': 'code',
      'client_id': clientId,
      'redirect_uri': _redirectUri,
      'scope': 'openid email profile',
      'identity_provider': 'Google',
      'state': state,
      'code_challenge_method': 'S256',
      'code_challenge': _b64url(sha256.convert(ascii.encode(verifier)).bytes),
    }).toString());
  }

  /// Signed out here at once (tokens cleared, listeners told), then a
  /// best-effort revoke, then out through the broker's logout.
  Future<void> signOut() async {
    if (!enabled) return;
    final r = _tokens?.refresh;
    _save(null);
    _set(const SsoState(SsoStatus.signedOut));
    if (r != null) {
      try {
        await _client.post(Uri.parse('$hostedDomain/oauth2/revoke'), body: {'token': r, 'client_id': clientId});
      } on Object {
        // Signed out locally regardless.
      }
    }
    _browser.navigate(Uri.parse('$hostedDomain/logout')
        .replace(queryParameters: {'client_id': clientId, 'logout_uri': _redirectUri}).toString());
  }

  /// A current access token (refreshed if near expiry), or null if signed
  /// out. Throws if the sign-in service cannot be reached to refresh.
  Future<String?> accessToken() async {
    final t = _tokens;
    if (t == null) return null;
    if (!_expired(t.access)) return t.access;
    return _refresh();
  }

  /// Sends [request] with the bearer token; on a 401, refreshes once and
  /// sends a fresh [request] again. [request] is called per attempt because
  /// an http request can be sent only once.
  Future<http.Response> send(http.BaseRequest Function() request) async {
    Future<http.Response> once(String? token) async {
      final r = request();
      if (token != null) r.headers['Authorization'] = 'Bearer $token';
      return http.Response.fromStream(await _client.send(r));
    }

    var res = await once(await accessToken());
    if (res.statusCode == 401 && _tokens != null) {
      final t = await _refresh();
      if (t != null) res = await once(t);
    }
    return res;
  }

  void dispose() {
    _state.dispose();
    _client.close();
  }

  /// One refresh at a time; the old token stays readable meanwhile.
  Future<String?> _refresh() {
    final r = _tokens?.refresh;
    if (r == null) return Future.value(null);
    return _refreshing ??= () async {
      try {
        final b = await _tokenCall({'grant_type': 'refresh_token', 'refresh_token': r});
        if (_tokens?.refresh != r) return _tokens?.access; // signed out meanwhile
        _save((access: b['access_token'] as String, refresh: b['refresh_token'] as String? ?? r));
        _signedIn();
        return _tokens!.access;
      } on _TokenRefused catch (e) {
        // A network failure keeps the session; a refusal ends it.
        if (e.status < 400 || e.status >= 500) rethrow;
        _save(null);
        _set(const SsoState(SsoStatus.signedOut));
        return null;
      } finally {
        _refreshing = null;
      }
    }();
  }

  Future<Map<String, dynamic>> _tokenCall(Map<String, String> params) async {
    final res = await _client.post(Uri.parse('$hostedDomain/oauth2/token'), body: {...params, 'client_id': clientId});
    Map<String, dynamic> body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } on Object {
      body = const {};
    }
    final ok = res.statusCode >= 200 && res.statusCode < 300;
    if (!ok || body['access_token'] is! String) {
      throw _TokenRefused(res.statusCode, '${body['error'] ?? 'token endpoint ${res.statusCode}'}');
    }
    return body;
  }

  SsoState _set(SsoState next) {
    _state.value = next; // ValueNotifier: listeners hear only real changes
    return next;
  }

  SsoState _signedIn() {
    final c = _claimsOf(_tokens!.access) ?? const {};
    return _set(SsoState(SsoStatus.signedIn,
        user: SsoUser(
          email: c['email'] as String?,
          role: c['landry_role'] as String?,
          site: c['landry_site'] as String?,
        )));
  }

  ({String access, String? refresh})? _load() {
    try {
      final j = jsonDecode(_local.get(_key) ?? 'null');
      if (j is! Map || j['access'] is! String) return null;
      return (access: j['access'] as String, refresh: j['refresh'] as String?);
    } on Object {
      return null;
    }
  }

  void _save(({String access, String? refresh})? t) {
    _tokens = t;
    if (t == null) {
      _local.remove(_key);
    } else {
      _local.set(_key, jsonEncode({'access': t.access, 'refresh': t.refresh}));
    }
  }

  bool _expired(String access) {
    final exp = _claimsOf(access)?['exp'];
    return exp is! num || exp - _skew <= _clock().millisecondsSinceEpoch / 1000;
  }

  static String _trim(String url) => url.endsWith('/') ? url.substring(0, url.length - 1) : url;

  static final _random = Random.secure();
  static String _randomString(int bytes) => _b64url(List.generate(bytes, (_) => _random.nextInt(256)));
  static String _b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

  /// Claims of a JWT, NOT verified: for the UI only.
  static Map<String, dynamic>? _claimsOf(String jwt) {
    final parts = jwt.split('.');
    if (parts.length != 3) return null;
    try {
      return jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))) as Map<String, dynamic>;
    } on Object {
      return null;
    }
  }
}
