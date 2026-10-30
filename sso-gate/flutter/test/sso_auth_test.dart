import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sso_gate/sso_gate.dart';
import 'package:sso_gate/src/storage.dart' show RawStorage;

/// SsoAuth driven the way a page drives it: construct, init on load, read
/// state. A port of ../test/js.test.ts. The browser is a small fake: a URL,
/// two storages (which can be made to THROW, as iOS Safari "Block All
/// Cookies" does), and an http client that plays the broker.

String b64(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
String jwt(Map<String, Object?> claims) => '${b64({'alg': 'RS256'})}.${b64(claims)}.sig';

/// The test clock; tests move it to expire tokens.
DateTime clock = DateTime.now();
int now() => clock.millisecondsSinceEpoch ~/ 1000;
String access([Map<String, Object?> extra = const {}]) => jwt({
      'email': 'ann@x.com',
      'landry_site': 'graph',
      'landry_role': 'user',
      'exp': now() + 3600,
      ...extra,
    });

class MemStorage implements RawStorage {
  final m = <String, String>{};
  @override
  String? getItem(String key) => m[key];
  @override
  void setItem(String key, String value) => m[key] = value;
  @override
  void removeItem(String key) => m.remove(key);
}

/// Safari "Block All Cookies": naming the storage throws, so every call does.
class HostileStorage implements RawStorage {
  @override
  String? getItem(String key) => throw StateError('SecurityError');
  @override
  void setItem(String key, String value) => throw StateError('SecurityError');
  @override
  void removeItem(String key) => throw StateError('SecurityError');
}

/// Readable, but every write is refused (a full quota).
class WriteRefusingStorage extends MemStorage {
  @override
  void setItem(String key, String value) => throw StateError('QuotaExceededError');
}

class FakeBrowser implements SsoBrowser {
  FakeBrowser(String url) : url = Uri.parse(url);
  @override
  Uri url;
  String? navigated;
  @override
  void replaceUrl(String to) => url = url.resolve(to);
  @override
  void navigate(String to) => navigated = to;
}

class Call {
  Call(this.request, this.body);
  final http.Request request;
  final Map<String, String> body;
  String get url => request.url.toString();
}

typedef Answer = Future<http.Response> Function();

class Browser {
  Browser(String url,
      {bool blocked = false, Browser? shared, String clientId = 'cid', bool defaults = false, RawStorage? sessionRaw})
      : local = shared?.local ?? MemStorage(),
        session = shared?.session ?? MemStorage(),
        browser = FakeBrowser(url) {
    auth = SsoAuth(
      site: 'graph',
      clientId: clientId,
      hostedDomain: defaults ? null : 'https://auth.landry.bot/',
      apiUrl: defaults ? null : 'https://api.auth.landry.bot',
      local: SafeLocalStorage(raw: blocked ? HostileStorage() : local),
      session: SafeSessionStorage(raw: blocked ? HostileStorage() : (sessionRaw ?? session)),
      browser: browser,
      client: MockClient(_handle),
      clock: () => clock,
    );
  }

  final MemStorage local;
  final MemStorage session;
  final FakeBrowser browser;
  late final SsoAuth auth;
  final calls = <Call>[];
  final seen = <SsoStatus>[];

  Answer token = () async => http.Response(
      jsonEncode({'access_token': access(), 'id_token': jwt({}), 'refresh_token': 'r1', 'expires_in': 3600}), 200);
  Answer revoke = () async => http.Response('', 200);

  /// Anything else on the API: 200 echoing the Authorization header.
  Future<http.Response> Function(http.Request) api =
      (r) async => http.Response(jsonEncode({'ok': true, 'auth': r.headers['authorization']}), 200);

  Future<http.Response> _handle(http.Request r) async {
    final form = r.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ?? false;
    calls.add(Call(r, form ? Uri.splitQueryString(r.body) : const {}));
    if (r.url.path.endsWith('/oauth2/token')) return token();
    if (r.url.path.endsWith('/oauth2/revoke')) return revoke();
    return api(r);
  }

  void listen() => auth.state.addListener(() => seen.add(auth.state.value.status));

  void storeTokens(String accessToken, [String refresh = 'r0']) =>
      local.m['landry.graph.auth'] = jsonEncode({'access': accessToken, 'refresh': refresh});

  List<Call> tokenCalls() => calls.where((c) => c.url.endsWith('/oauth2/token')).toList();
}

String s256(String verifier) =>
    base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');

void main() {
  setUp(() => clock = DateTime.now());

  test('before init the status is checking', () {
    expect(Browser('https://graph.landry.bot/').auth.state.value.status, SsoStatus.checking);
  });

  test('a first visit is signed out; signIn goes to the broker with PKCE and Google preselected', () async {
    final b = Browser('https://graph.landry.bot/some/page?x=1');
    expect((await b.auth.init()).status, SsoStatus.signedOut);
    await b.auth.signIn();
    final u = Uri.parse(b.browser.navigated!);
    expect('${u.origin}${u.path}', 'https://auth.landry.bot/oauth2/authorize');
    final q = u.queryParameters;
    expect(q['client_id'], 'cid');
    expect(q['response_type'], 'code');
    expect(q['scope'], 'openid email profile');
    expect(q['identity_provider'], 'Google');
    expect(q['code_challenge_method'], 'S256');
    expect(q['redirect_uri'], 'https://graph.landry.bot/');
    expect(q['state'], isNotEmpty);

    final pending = jsonDecode(b.session.m['landry.graph.auth.pkce']!) as Map<String, dynamic>;
    expect(pending['state'], q['state']);
    expect(pending['next'], '/some/page?x=1');
    expect(pending['verifier'], hasLength(64));
    expect(pending['verifier'], matches(RegExp(r'^[A-Za-z0-9_-]+$')));
    expect(q['code_challenge'], s256(pending['verifier'] as String));
    expect(b.calls, isEmpty);
  });

  test('coming back with a code: exchanged with the verifier, URL cleaned, back on the page they left', () async {
    final first = Browser('https://graph.landry.bot/some/page?x=1');
    await first.auth.init();
    await first.auth.signIn();
    final sent = Uri.parse(first.browser.navigated!);
    final verifier = (jsonDecode(first.session.m['landry.graph.auth.pkce']!) as Map)['verifier'];

    final back = Browser('https://graph.landry.bot/?code=abc&state=${sent.queryParameters['state']}', shared: first);
    final s = await back.auth.init();
    expect(s.status, SsoStatus.signedIn);
    expect(s.user, const SsoUser(email: 'ann@x.com', role: 'user', site: 'graph'));
    expect(s.user!.isAdmin, isFalse);

    final ex = back.tokenCalls().single;
    expect(ex.url, 'https://auth.landry.bot/oauth2/token');
    expect(ex.request.method, 'POST');
    expect(ex.body, {
      'grant_type': 'authorization_code',
      'client_id': 'cid',
      'code': 'abc',
      'redirect_uri': 'https://graph.landry.bot/',
      'code_verifier': verifier,
    });
    expect(back.browser.url.toString(), 'https://graph.landry.bot/some/page?x=1');
    expect(jsonDecode(back.local.m['landry.graph.auth']!), {'access': isA<String>(), 'refresh': 'r1'});
    expect(back.session.m, isEmpty, reason: 'the PKCE record is used once');
  });

  test('a code with a state we did not issue is refused and never exchanged', () async {
    final first = Browser('https://graph.landry.bot/');
    await first.auth.signIn();
    final b = Browser('https://graph.landry.bot/?code=abc&state=forged', shared: first);
    final s = await b.auth.init();
    expect(s.status, SsoStatus.error);
    expect(s.message, isNotEmpty);
    expect(b.calls, isEmpty);
    expect(b.browser.url.query, isEmpty);
  });

  test('a code with no sign-in pending in this tab is refused and never exchanged', () async {
    final b = Browser('https://graph.landry.bot/?code=abc&state=s');
    final s = await b.auth.init();
    expect(s.status, SsoStatus.error);
    expect(s.message, contains('expired'));
    expect(b.calls, isEmpty);
    expect(b.browser.url.query, isEmpty);
  });

  test('the token endpoint refusing the code is an error, not a crash', () async {
    final first = Browser('https://graph.landry.bot/');
    await first.auth.signIn();
    final state = Uri.parse(first.browser.navigated!).queryParameters['state'];
    final b = Browser('https://graph.landry.bot/?code=abc&state=$state', shared: first);
    b.token = () async => http.Response(jsonEncode({'error': 'invalid_grant'}), 400);
    final s = await b.auth.init();
    expect(s.status, SsoStatus.error);
    expect(s.message, 'Sign-in failed. Please try again.');
    expect(b.local.m, isEmpty);
  });

  test('the broker refusing (not on the allow-list) is "denied", not an error', () async {
    final b = Browser(
        'https://graph.landry.bot/?error_description=PreTokenGeneration+failed+with+error+not_allowed.&error=invalid_request');
    b.listen();
    final s = await b.auth.init();
    expect(s.status, SsoStatus.denied);
    expect(b.browser.url.query, isEmpty);
    expect(b.seen, [SsoStatus.denied]);
  });

  test('any other broker error is an error carrying its description', () async {
    final b = Browser('https://graph.landry.bot/?error=access_denied&error_description=User+cancelled');
    final s = await b.auth.init();
    expect(s.status, SsoStatus.error);
    expect(s.message, 'Sign-in failed: User cancelled');
    expect(b.browser.url.query, isEmpty);
  });

  test('a returning visitor with an unexpired token is signed in with no network', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'landry_role': 'admin'}));
    final s = await b.auth.init();
    expect(s.status, SsoStatus.signedIn);
    expect(s.user!.isAdmin, isTrue);
    expect(b.calls, isEmpty);
  });

  test('a returning visitor is signed in from the stored session; an expired access token is refreshed', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'exp': now() - 5}));
    b.token = () async => http.Response(jsonEncode({'access_token': access()}), 200);
    final s = await b.auth.init();
    expect(s.status, SsoStatus.signedIn);
    final r = b.tokenCalls().single;
    expect(r.body, {'grant_type': 'refresh_token', 'refresh_token': 'r0', 'client_id': 'cid'});
    expect((jsonDecode(b.local.m['landry.graph.auth']!) as Map)['refresh'], 'r0',
        reason: 'no new refresh token in the answer keeps the old one');
  });

  test('an access token inside its last minute counts as expired', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'exp': now() + 30}));
    await b.auth.init();
    expect(b.tokenCalls(), hasLength(1));
  });

  test('refresh refused (removed from the site, or revoked) signs out and tells listeners', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'exp': now() - 5}));
    b.token = () async => http.Response(jsonEncode({'error': 'invalid_grant'}), 400);
    b.listen();
    expect((await b.auth.init()).status, SsoStatus.signedOut);
    expect(b.local.m['landry.graph.auth'], isNull);
    expect(b.seen, [SsoStatus.signedOut]);
  });

  test('refresh unreachable at load is an error that keeps the session, and tells listeners', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'exp': now() - 5}));
    b.token = () async => throw http.ClientException('offline');
    b.listen();
    final s = await b.auth.init();
    expect(s.status, SsoStatus.error);
    expect(s.message, contains('connection'));
    expect(b.local.m['landry.graph.auth'], isNotNull);
    expect(b.seen, [SsoStatus.error]);
  });

  test('refresh refused mid-session signs out and tells listeners', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access());
    await b.auth.init();
    b.listen();
    clock = clock.add(const Duration(hours: 2));
    b.token = () async => http.Response(jsonEncode({'error': 'invalid_grant'}), 400);
    expect(await b.auth.accessToken(), isNull);
    expect(b.seen, [SsoStatus.signedOut]);
    expect(b.local.m, isEmpty);
  });

  test('concurrent token requests share one refresh, and nobody gets an empty token meanwhile', () async {
    final b = Browser('https://graph.landry.bot/');
    final old = access();
    b.storeTokens(old);
    await b.auth.init();
    clock = clock.add(const Duration(hours: 2));
    final hold = Completer<void>();
    final fresh = access();
    b.token = () async {
      await hold.future;
      return http.Response(jsonEncode({'access_token': fresh, 'refresh_token': 'r2'}), 200);
    };
    final pending = Future.wait([b.auth.accessToken(), b.auth.accessToken(), b.auth.accessToken()]);
    await pumpEventQueue();
    // Mid-refresh: the session is still there, not blanked.
    expect(b.auth.state.value.status, SsoStatus.signedIn);
    expect(b.auth.state.value.user, isNotNull);
    expect((jsonDecode(b.local.m['landry.graph.auth']!) as Map)['access'], old);
    hold.complete();
    final tokens = await pending;
    expect(b.tokenCalls(), hasLength(1));
    expect(tokens, [fresh, fresh, fresh]);
  });

  test('send adds the bearer token', () async {
    final b = Browser('https://graph.landry.bot/');
    final a = access();
    b.storeTokens(a);
    await b.auth.init();
    final res = await b.auth.send(() => http.Request('GET', Uri.parse('https://graph.landry.bot/api/thing')));
    expect((jsonDecode(res.body) as Map)['auth'], 'Bearer $a');
  });

  test('send signed out goes without a header', () async {
    final b = Browser('https://graph.landry.bot/');
    await b.auth.init();
    final res = await b.auth.send(() => http.Request('GET', Uri.parse('https://graph.landry.bot/api/thing')));
    expect((jsonDecode(res.body) as Map)['auth'], isNull);
  });

  test('send: a 401 refreshes once and retries with the new token; a second 401 is returned', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access());
    await b.auth.init();
    final fresh = access({'n': 2});
    b.token = () async => http.Response(jsonEncode({'access_token': fresh}), 200);
    final auths = <String?>[];
    b.api = (r) async {
      auths.add(r.headers['authorization']);
      return http.Response('{}', auths.length == 1 ? 401 : 200);
    };
    final res = await b.auth.send(() => http.Request('GET', Uri.parse('https://graph.landry.bot/api/thing')));
    expect(res.statusCode, 200);
    expect(auths.last, 'Bearer $fresh');
    expect(auths, hasLength(2));

    b.api = (r) async {
      auths.add(r.headers['authorization']);
      return http.Response('{}', 401);
    };
    expect((await b.auth.send(() => http.Request('GET', Uri.parse('https://x/')))).statusCode, 401);
    expect(auths, hasLength(4), reason: 'one retry, not a loop');
  });

  test('members API talks to the broker for this site', () async {
    final b = Browser('https://graph.landry.bot/');
    final a = access({'landry_role': 'admin'});
    b.storeTokens(a);
    await b.auth.init();
    b.api = (r) async => switch (r.method) {
          'GET' => http.Response(jsonEncode({'members': []}), 200),
          'POST' => http.Response('{}', 201),
          'PATCH' => http.Response('{}', 200),
          _ => http.Response('', 204),
        };
    await b.auth.members.list();
    await b.auth.members.add('New@x.com', role: 'admin');
    await b.auth.members.setRole('a b@x.com', 'user');
    await b.auth.members.remove('a b@x.com');
    final api = b.calls.where((c) => c.url.contains('api.auth')).toList();
    expect(api.map((c) => '${c.request.method} ${c.url}'), [
      'GET https://api.auth.landry.bot/sites/graph/members',
      'POST https://api.auth.landry.bot/sites/graph/members',
      'PATCH https://api.auth.landry.bot/sites/graph/members/a%20b%40x.com',
      'DELETE https://api.auth.landry.bot/sites/graph/members/a%20b%40x.com',
    ]);
    expect(api.every((c) => c.request.headers['authorization'] == 'Bearer $a'), isTrue);
    expect(jsonDecode(api[1].request.body), {'email': 'New@x.com', 'role': 'admin'});
    expect(jsonDecode(api[2].request.body), {'role': 'user'});
  });

  test('members list is parsed; refusals carry the broker\'s message and status', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access({'landry_role': 'admin'}));
    await b.auth.init();
    b.api = (r) async => r.method == 'GET'
        ? http.Response(
            jsonEncode({
              'members': [
                {'email': 'boss@x.com', 'role': 'admin', 'global': true},
                {'email': 'ann@x.com', 'role': 'user', 'global': false, 'addedBy': 'boss@x.com', 'addedAt': '2026-10-01T00:00:00.000Z'},
              ]
            }),
            200)
        : http.Response(jsonEncode({'error': 'already a member'}), 409);
    final members = await b.auth.members.list();
    expect(members.first.global, isTrue);
    expect(members.last.email, 'ann@x.com');
    expect(members.last.role, 'user');
    expect(members.last.global, isFalse);
    expect(members.last.addedBy, 'boss@x.com');
    expect(members.last.addedAt, '2026-10-01T00:00:00.000Z');
    await expectLater(
        b.auth.members.add('ann@x.com'),
        throwsA(isA<MembersException>()
            .having((e) => e.status, 'status', 409)
            .having((e) => e.message, 'message', 'already a member')));
    b.api = (r) async => http.Response('not json', 403);
    await expectLater(
        b.auth.members.list(),
        throwsA(isA<MembersException>()
            .having((e) => e.status, 'status', 403)
            .having((e) => e.message, 'message', 'HTTP 403')));
  });

  test('signOut forgets tokens, revokes the refresh token, and leaves through the broker logout', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access());
    await b.auth.init();
    b.listen();
    await b.auth.signOut();
    expect(b.local.m['landry.graph.auth'], isNull);
    expect(b.seen, [SsoStatus.signedOut]);
    final rv = b.calls.singleWhere((c) => c.url.endsWith('/oauth2/revoke'));
    expect(rv.url, 'https://auth.landry.bot/oauth2/revoke');
    expect(rv.body, {'token': 'r0', 'client_id': 'cid'});
    final u = Uri.parse(b.browser.navigated!);
    expect('${u.origin}${u.path}', 'https://auth.landry.bot/logout');
    expect(u.queryParameters, {'client_id': 'cid', 'logout_uri': 'https://graph.landry.bot/'});
    expect(await b.auth.accessToken(), isNull);
  });

  test('signOut is signed out locally before the revoke answers, and survives it failing', () async {
    final b = Browser('https://graph.landry.bot/');
    b.storeTokens(access());
    await b.auth.init();
    final hold = Completer<void>();
    b.revoke = () async {
      await hold.future;
      throw http.ClientException('offline');
    };
    final out = b.auth.signOut();
    await pumpEventQueue();
    expect(b.auth.state.value.status, SsoStatus.signedOut);
    expect(b.local.m, isEmpty);
    expect(await b.auth.accessToken(), isNull);
    hold.complete();
    await out;
    expect(b.browser.navigated, contains('/logout'));
  });

  test('Block All Cookies: storage throws, init still answers with a sentence, nothing throws', () async {
    final b = Browser('https://graph.landry.bot/', blocked: true);
    final s = await b.auth.init();
    expect(s.status, SsoStatus.signedOut);
    expect(b.auth.storageBlocked, isTrue);
    // Leaving would strand the PKCE verifier in memory: the return could only fail.
    await b.auth.signIn();
    expect(b.browser.navigated, isNull);
    expect(b.auth.state.value.status, SsoStatus.error);
    expect(b.auth.state.value.message, matches(RegExp('cookies', caseSensitive: false)));
    final back = Browser('https://graph.landry.bot/?code=abc&state=s', blocked: true);
    final r = await back.auth.init();
    expect(r.status, SsoStatus.error);
    expect(r.message, matches(RegExp('cookies', caseSensitive: false)));
    expect(back.calls, isEmpty);
  });

  test('sessionStorage that reads but refuses writes: sign-in stays put and says why', () async {
    final b = Browser('https://graph.landry.bot/', sessionRaw: WriteRefusingStorage());
    await b.auth.init();
    await b.auth.signIn();
    expect(b.browser.navigated, isNull);
    expect(b.auth.state.value.status, SsoStatus.error);
  });

  test('working storage is not reported blocked', () {
    expect(Browser('https://graph.landry.bot/').auth.storageBlocked, isFalse);
  });

  test('no client id: disabled, signed out, and nothing touches the network', () async {
    final b = Browser('https://graph.landry.bot/?code=abc&state=s', clientId: '');
    b.storeTokens(access());
    expect(b.auth.enabled, isFalse);
    expect(b.auth.state.value.status, SsoStatus.signedOut);
    expect((await b.auth.init()).status, SsoStatus.signedOut);
    await b.auth.signIn();
    await b.auth.signOut();
    expect(await b.auth.accessToken(), isNull);
    expect(b.calls, isEmpty);
    expect(b.browser.navigated, isNull);
  });

  test('hosted domain and API default to the landry.bot broker', () async {
    final b = Browser('https://graph.landry.bot/', defaults: true);
    b.storeTokens(access());
    await b.auth.init();
    b.api = (r) async => http.Response(jsonEncode({'members': []}), 200);
    await b.auth.members.list();
    expect(b.calls.single.url, 'https://api.auth.landry.bot/sites/graph/members');
    await b.auth.signOut();
    expect(b.browser.navigated, startsWith('https://auth.landry.bot/logout?'));
  });
}
