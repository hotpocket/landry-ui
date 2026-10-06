import 'dart:async';
import 'dart:convert';

import 'package:google_sign_in/google_sign_in.dart';

import 'storage.dart';

/// The signed-in Google identity, for display.
class SsoProfile {
  final String? name;
  final String? email;
  final String? photoUrl;
  const SsoProfile({this.name, this.email, this.photoUrl});
}

/// Google SSO via google_sign_in v7 (GIS). The API client sends [idToken] as
/// `Authorization: Bearer <idToken>`; sso-gate/server verifies it.
///
/// No [clientId] = disabled: the site runs signed out (local dev, where the
/// server bypasses auth too).
///
/// Silent sign-in has two layers:
/// 1. The last ID token is remembered in [storage]; on load, an unexpired
///    token signs the user straight in (page reloads within the ~1h token
///    lifetime need no GIS round-trip at all).
/// 2. Otherwise GIS One Tap (`attemptLightweightAuthentication`, FedCM with
///    auto_select) is prompted; its credential arrives asynchronously via
///    [GoogleSignIn.authenticationEvents]. The rendered button remains the
///    fallback when One Tap is cooled down or blocked.
class SsoAuth {
  SsoAuth({
    required String clientId,
    required String storageKey,
    SsoStorage storage = const SafeLocalStorage(),
    this.refreshPollInterval = const Duration(milliseconds: 250),
  })  : _clientId = clientId,
        _storageKey = storageKey,
        _storage = storage;

  final String _clientId;
  final String _storageKey;
  final SsoStorage _storage;

  /// How often [refreshIdToken] looks for One Tap's answer (40 looks).
  final Duration refreshPollInterval;

  bool get enabled => _clientId.isNotEmpty;
  bool _initialized = false;
  StreamSubscription<GoogleSignInAuthenticationEvent>? _subscription;

  /// The current Google ID token (JWT), or null when signed out.
  String? _idToken;
  String? get idToken => _idToken;

  Future<void> init({
    required void Function(SsoProfile?) onProfileChanged,
  }) async {
    if (!enabled || _initialized) return;
    _initialized = true;
    try {
      final signIn = GoogleSignIn.instance;
      await signIn.initialize(clientId: _clientId);
      _subscription = signIn.authenticationEvents.listen((event) {
        switch (event) {
          case GoogleSignInAuthenticationEventSignIn():
            final user = event.user;
            _adoptToken(user.authentication.idToken);
            onProfileChanged(SsoProfile(
              name: user.displayName,
              email: user.email,
              photoUrl: user.photoUrl,
            ));
          case GoogleSignInAuthenticationEventSignOut():
            _adoptToken(null);
            onProfileChanged(null);
        }
      }, onError: (Object _) {
        // A failed authentication (GIS error, FedCM refusal) arrives here as
        // a stream error. Nothing changes: the user stays as they were and
        // the rendered button remains.
      });

      // Layer 1: an unexpired cached token signs the user in immediately —
      // no GIS UI, no click. The profile comes from the token's own claims.
      final cached = _readCachedToken();
      if (cached != null) {
        final claims = _decodeClaims(cached)!;
        _idToken = cached;
        onProfileChanged(SsoProfile(
          name: claims['name'] as String?,
          email: claims['email'] as String?,
          photoUrl: claims['picture'] as String?,
        ));
        return;
      }

      // Layer 2: One Tap auto prompt; result (if any) arrives via the
      // authenticationEvents stream above. No UI if it silently fails.
      // A failure surfaces as an async error, beyond this try: absorb it.
      unawaited(Future.sync(() => signIn.attemptLightweightAuthentication())
          .then<void>((_) {}, onError: (Object _) {}));
    } on Exception {
      // GIS blocked (browser settings / missing origin config) — stay
      // signed out.
    }
  }

  /// Re-acquires a fresh Google ID token silently (tokens expire ~hourly).
  /// Called by the API client when a request comes back 401. Returns the new
  /// token, or null if re-auth fails (the user must sign in again).
  ///
  /// On web `attemptLightweightAuthentication` never returns the account
  /// directly — One Tap credentials arrive via the event stream — so after
  /// prompting we wait briefly for the listener to pick up the new token.
  Future<String?> refreshIdToken() async {
    if (!enabled) return null;
    final stale = _idToken;
    _idToken = null;
    try {
      final future = GoogleSignIn.instance.attemptLightweightAuthentication();
      final account = future == null ? null : await future;
      if (account != null) {
        _adoptToken(account.authentication.idToken);
        return _idToken;
      }
      // Web path: poll for the event-stream listener to deliver the token.
      for (var i = 0; i < 40 && _idToken == null; i++) {
        await Future<void>.delayed(refreshPollInterval);
      }
      if (_idToken == null || _idToken == stale) {
        _adoptToken(null);
      }
    } on Object {
      // GIS/FedCM failures surface as raw JS interop Errors, not Exceptions
      // ("NetworkError: Error retrieving a token"). Catch everything — a
      // failed silent re-auth must degrade to signed-out, never crash the
      // caller's request path.
      _adoptToken(null);
    }
    return _idToken;
  }

  Future<void> signOut() async {
    if (!enabled) return;
    _adoptToken(null);
    await GoogleSignIn.instance.signOut();
  }

  void dispose() {
    _subscription?.cancel();
  }

  /// Sets the in-memory token and mirrors it to storage so page reloads
  /// within the token's lifetime stay signed in.
  void _adoptToken(String? token) {
    _idToken = token;
    try {
      if (token == null) {
        _storage.remove(_storageKey);
      } else {
        _storage.set(_storageKey, token);
      }
    } on Object {
      // Storage unavailable (privacy mode) — in-memory auth still works.
    }
  }

  /// Cached token, or null when absent, malformed, or within 60s of expiry.
  String? _readCachedToken() {
    try {
      final token = _storage.get(_storageKey);
      if (token == null || token.isEmpty) return null;
      final claims = _decodeClaims(token);
      final exp = claims?['exp'];
      if (exp is! num) return null;
      final expiresAt = DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000);
      if (expiresAt.isBefore(DateTime.now().add(const Duration(seconds: 60)))) {
        _storage.remove(_storageKey);
        return null;
      }
      return token;
    } on Object {
      return null;
    }
  }

  static Map<String, dynamic>? _decodeClaims(String jwt) {
    final parts = jwt.split('.');
    if (parts.length != 3) return null;
    try {
      final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
      return jsonDecode(payload) as Map<String, dynamic>;
    } on Object {
      return null;
    }
  }
}
