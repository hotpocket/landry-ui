import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:sso_gate/sso_gate.dart';

/// Google, as the browser plugin presents it: events arrive on a stream,
/// One Tap answers through that stream (web never returns the account).
class FakeGoogle extends GoogleSignInPlatform with MockPlatformInterfaceMixin {
  final events = StreamController<AuthenticationEvent>.broadcast();
  String? initClientId;
  int lightweightAttempts = 0;
  int signOuts = 0;

  /// What the next lightweight attempt does; null = answers nothing directly.
  Future<AuthenticationResults?>? Function()? onLightweight;

  @override
  Future<void> init(InitParameters params) async => initClientId = params.clientId;

  @override
  Stream<AuthenticationEvent>? get authenticationEvents => events.stream;

  @override
  Future<AuthenticationResults?>? attemptLightweightAuthentication(
      AttemptLightweightAuthenticationParameters params) {
    lightweightAttempts++;
    return onLightweight?.call();
  }

  @override
  Future<void> signOut(SignOutParams params) async => signOuts++;

  void signIn(String token, {String email = 'a@example.com'}) => events.add(
        AuthenticationEventSignIn(
          user: GoogleSignInUserData(email: email, id: '1', displayName: 'A Person'),
          authenticationTokens: AuthenticationTokenData(idToken: token),
        ),
      );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class MemoryStorage implements SsoStorage {
  final values = <String, String>{};
  @override
  String? get(String key) => values[key];
  @override
  void set(String key, String value) => values[key] = value;
  @override
  void remove(String key) => values.remove(key);
}

/// Safari "Block All Cookies": every touch throws.
class HostileStorage implements SsoStorage {
  @override
  String? get(String key) => throw StateError('SecurityError');
  @override
  void set(String key, String value) => throw StateError('SecurityError');
  @override
  void remove(String key) => throw StateError('SecurityError');
}

String jwt(Map<String, Object?> claims) =>
    'h.${base64Url.encode(utf8.encode(jsonEncode(claims))).replaceAll('=', '')}.s';

int inSeconds(Duration d) => DateTime.now().add(d).millisecondsSinceEpoch ~/ 1000;

void main() {
  late FakeGoogle google;
  late MemoryStorage storage;

  setUp(() {
    google = FakeGoogle();
    GoogleSignInPlatform.instance = google;
    storage = MemoryStorage();
  });

  SsoAuth auth({String clientId = 'cid'}) => SsoAuth(
        clientId: clientId,
        storageKey: 'site.idToken',
        storage: storage,
        refreshPollInterval: const Duration(milliseconds: 1),
      );

  test('no client id: disabled, and nothing touches Google', () async {
    final a = auth(clientId: '');
    expect(a.enabled, isFalse);
    await a.init(onProfileChanged: (_) => fail('no profile when disabled'));
    expect(google.initClientId, isNull);
    expect(await a.refreshIdToken(), isNull);
    await a.signOut();
    expect(google.signOuts, 0);
  });

  test('an unexpired cached token signs in at once, profile from its claims', () async {
    final token = jwt({
      'exp': inSeconds(const Duration(hours: 1)),
      'name': 'Brandon',
      'email': 'b@example.com',
      'picture': 'https://p/x.png',
    });
    storage.values['site.idToken'] = token;
    SsoProfile? profile;
    final a = auth();
    await a.init(onProfileChanged: (p) => profile = p);
    expect(google.initClientId, 'cid');
    expect(a.idToken, token);
    expect(profile?.email, 'b@example.com');
    expect(profile?.name, 'Brandon');
    expect(profile?.photoUrl, 'https://p/x.png');
    expect(google.lightweightAttempts, 0, reason: 'no One Tap round-trip on reload');
  });

  test('a cached token inside its last minute is dropped and One Tap is tried', () async {
    storage.values['site.idToken'] = jwt({'exp': inSeconds(const Duration(seconds: 30))});
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    await Future<void>.delayed(Duration.zero);
    expect(a.idToken, isNull);
    expect(storage.values, isEmpty);
    expect(google.lightweightAttempts, 1);
  });

  test('a sign-in event adopts and remembers the token; sign-out forgets it', () async {
    final profiles = <SsoProfile?>[];
    final a = auth();
    await a.init(onProfileChanged: profiles.add);
    google.signIn('tok-1', email: 'friend@example.com');
    await pumpEventQueue();
    expect(a.idToken, 'tok-1');
    expect(storage.values['site.idToken'], 'tok-1');
    expect(profiles.single?.email, 'friend@example.com');
    expect(profiles.single?.name, 'A Person');

    google.events.add(AuthenticationEventSignOut());
    await pumpEventQueue();
    expect(a.idToken, isNull);
    expect(storage.values, isEmpty);
    expect(profiles.last, isNull);
  });

  test('refresh picks up a fresh token that One Tap delivers by event', () async {
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    google.signIn('old');
    await pumpEventQueue();
    google.onLightweight = () {
      Timer(const Duration(milliseconds: 5), () => google.signIn('new'));
      return null;
    };
    expect(await a.refreshIdToken(), 'new');
    expect(storage.values['site.idToken'], 'new');
  });

  test('refresh that gets nothing back signs out instead of reusing the stale token', () async {
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    google.signIn('old');
    await pumpEventQueue();
    google.onLightweight = () => null;
    expect(await a.refreshIdToken(), isNull);
    expect(a.idToken, isNull);
    expect(storage.values, isEmpty);
  });

  test('a GIS failure during refresh degrades to signed out, never throws', () async {
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    google.onLightweight = () => throw ArgumentError('NetworkError: Error retrieving a token');
    expect(await a.refreshIdToken(), isNull);
  });

  // An unhandled async error fails a test by itself: these two pass only if
  // the failure is absorbed and the user simply stays signed out.
  test('a failed One Tap at start-up stays signed out, no unhandled error', () async {
    google.onLightweight = () => Future.error(StateError('GIS network failure'));
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    await pumpEventQueue();
    expect(a.idToken, isNull);
  });

  test('an error on the sign-in event stream is absorbed', () async {
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    google.events.add(const AuthenticationEventException(
        GoogleSignInException(code: GoogleSignInExceptionCode.unknownError)));
    await pumpEventQueue();
    expect(a.idToken, isNull);
    google.signIn('after');
    await pumpEventQueue();
    expect(a.idToken, 'after', reason: 'still listening after the error');
  });

  test('sign out forgets the token and tells Google', () async {
    final a = auth();
    await a.init(onProfileChanged: (_) {});
    google.signIn('tok');
    await pumpEventQueue();
    await a.signOut();
    expect(a.idToken, isNull);
    expect(storage.values, isEmpty);
    expect(google.signOuts, 1);
  });

  test('storage that throws on every touch still signs in, in memory', () async {
    final a = SsoAuth(clientId: 'cid', storageKey: 'k', storage: HostileStorage());
    await a.init(onProfileChanged: (_) {});
    google.signIn('tok');
    await pumpEventQueue();
    expect(a.idToken, 'tok');
  });
}
