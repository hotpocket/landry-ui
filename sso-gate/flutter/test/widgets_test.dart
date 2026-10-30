import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sso_gate/sso_gate.dart';

class Taps {
  int signIn = 0;
  int signOut = 0;
}

Widget gate(SsoStatus status, Taps taps, {String? message}) => MaterialApp(
      home: SsoGateScreen(
        title: 'Graph',
        tagline: 'Who knows whom.',
        deniedMessage: 'Ask Brandon for an invite.',
        status: status,
        message: message,
        onSignIn: () => taps.signIn++,
        onSignOut: () => taps.signOut++,
      ),
    );

/// The broker's members routes, in memory: 409 on a duplicate add, 403 when
/// [forbidden], and every call logged.
class FakeMembers implements MembersApi {
  FakeMembers(this.members);
  List<Member> members;
  bool forbidden = false;
  Completer<void>? hold;
  final calls = <String>[];

  Future<void> _gate() async {
    if (hold != null) await hold!.future;
    if (forbidden) throw const MembersException(403, 'admin only');
  }

  @override
  Future<List<Member>> list() async {
    calls.add('list');
    await _gate();
    return [...members];
  }

  @override
  Future<void> add(String email, {String role = 'user'}) async {
    calls.add('add $email $role');
    await _gate();
    if (members.any((m) => m.email == email)) throw const MembersException(409, 'already a member');
    members.add(Member(email: email, role: role));
  }

  @override
  Future<void> setRole(String email, String role) async {
    calls.add('setRole $email $role');
    await _gate();
    members = [for (final m in members) m.email == email ? Member(email: email, role: role) : m];
  }

  @override
  Future<void> remove(String email) async {
    calls.add('remove $email');
    await _gate();
    members.removeWhere((m) => m.email == email);
  }
}

FakeMembers sample() => FakeMembers([
      const Member(email: 'boss@x.com', role: 'admin', global: true),
      const Member(email: 'me@x.com', role: 'admin'),
      const Member(email: 'ann@x.com', role: 'user'),
    ]);

Future<void> openDialog(WidgetTester tester, MembersApi api, {String? myEmail = 'me@x.com'}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => TextButton(
        onPressed: () => MembersDialog.show(context, api, myEmail: myEmail),
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

/// The list row for [email].
Finder row(String email) => find.ancestor(of: find.text(email), matching: find.byType(ListTile));
Finder inRow(String email, Finder f) => find.descendant(of: row(email), matching: f);

void main() {
  group('SsoGateScreen', () {
    testWidgets('signed out: the site, its tagline and a Google button that signs in', (tester) async {
      final taps = Taps();
      await tester.pumpWidget(gate(SsoStatus.signedOut, taps));
      expect(find.text('Graph'), findsOneWidget);
      expect(find.text('Who knows whom.'), findsOneWidget);
      expect(find.text('By invitation only'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in with Google'));
      expect(taps.signIn, 1);
    });

    testWidgets('checking: a spinner, never the button', (tester) async {
      await tester.pumpWidget(gate(SsoStatus.checking, Taps()));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Checking access…'), findsOneWidget);
      expect(find.text('Sign in with Google'), findsNothing);
    });

    testWidgets('denied: by invitation only, and a way out to another account', (tester) async {
      final taps = Taps();
      await tester.pumpWidget(gate(SsoStatus.denied, taps));
      expect(find.text('By invitation only'), findsOneWidget);
      expect(find.text('Ask Brandon for an invite.'), findsOneWidget);
      expect(find.text('Who knows whom.'), findsNothing);
      expect(find.text('Sign in with Google'), findsNothing);
      await tester.tap(find.text('Use a different account'));
      expect(taps.signOut, 1);
      expect(taps.signIn, 0);
    });

    testWidgets('error: the sentence, and Try again signs in', (tester) async {
      final taps = Taps();
      await tester.pumpWidget(gate(SsoStatus.error, taps, message: 'Sign-in needs cookies.'));
      expect(find.text('Sign-in needs cookies.'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      await tester.tap(find.text('Try again'));
      expect(taps.signIn, 1);
    });
  });

  group('MembersDialog', () {
    testWidgets('lists members with their roles; a global admin is labelled and not editable', (tester) async {
      await openDialog(tester, sample());
      expect(find.text('Manage users'), findsOneWidget);
      expect(inRow('ann@x.com', find.text('user')), findsOneWidget);
      expect(inRow('boss@x.com', find.text('admin (all sites)')), findsOneWidget);
      expect(inRow('boss@x.com', find.byTooltip('Remove')), findsNothing);
      expect(inRow('boss@x.com', find.byType(TextButton)), findsNothing);
      expect(inRow('ann@x.com', find.byTooltip('Remove')), findsOneWidget);
      expect(inRow('ann@x.com', find.text('Make admin')), findsOneWidget);
    });

    testWidgets('you cannot edit yourself', (tester) async {
      await openDialog(tester, sample());
      expect(row('me@x.com'), findsOneWidget);
      expect(inRow('me@x.com', find.byTooltip('Remove')), findsNothing);
      expect(inRow('me@x.com', find.text('Make user')), findsNothing);
    });

    testWidgets('adds a trimmed email with the chosen role, clears the field, reloads', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      await tester.enterText(find.byType(TextField), '  new@x.com ');
      await tester.tap(find.byType(DropdownButton<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('admin').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(api.calls, ['list', 'add new@x.com admin', 'list']);
      expect(inRow('new@x.com', find.text('admin')), findsOneWidget);
      expect(find.text('Added new@x.com'), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
    });

    testWidgets('an empty field adds nothing; Enter adds', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(api.calls, ['list']);
      await tester.enterText(find.byType(TextField), 'k@x.com');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(api.calls, contains('add k@x.com user'));
    });

    testWidgets('toggles a role and reloads', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      await tester.tap(inRow('ann@x.com', find.text('Make admin')));
      await tester.pumpAndSettle();
      expect(api.calls, ['list', 'setRole ann@x.com admin', 'list']);
      expect(inRow('ann@x.com', find.text('Make user')), findsOneWidget);
    });

    testWidgets('removes a member and reloads', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      await tester.tap(inRow('ann@x.com', find.byTooltip('Remove')));
      await tester.pumpAndSettle();
      expect(api.calls, ['list', 'remove ann@x.com', 'list']);
      expect(find.text('ann@x.com'), findsNothing);
    });

    testWidgets('a duplicate (409) says so and still reloads', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      await tester.enterText(find.byType(TextField), 'ann@x.com');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(find.text('Already done: already a member'), findsOneWidget);
      expect(api.calls, ['list', 'add ann@x.com user', 'list']);
      expect(row('ann@x.com'), findsOneWidget);
    });

    testWidgets('not a site admin (403) on load', (tester) async {
      await openDialog(tester, sample()..forbidden = true);
      expect(find.text('Only a site admin can manage users.'), findsOneWidget);
    });

    testWidgets('not a site admin (403) on a change', (tester) async {
      final ok = sample();
      await openDialog(tester, ok);
      ok.forbidden = true;
      await tester.enterText(find.byType(TextField), 'n@x.com');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(find.text('Only a site admin can do that.'), findsOneWidget);
    });

    testWidgets('while a change is in flight the controls are disabled', (tester) async {
      final api = sample();
      await openDialog(tester, api);
      api.hold = Completer<void>();
      await tester.enterText(find.byType(TextField), 'n@x.com');
      await tester.tap(find.text('Add'));
      await tester.pump();
      expect(find.text('Saving…'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      api.hold!.complete();
      api.hold = null;
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
    });

    testWidgets('Close dismisses it', (tester) async {
      await openDialog(tester, sample());
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.text('Manage users'), findsNothing);
    });
  });
}
