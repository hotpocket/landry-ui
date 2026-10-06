import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sso_gate/sso_gate.dart';

const button = Text('SIGN-IN-BUTTON');

Widget gate({bool denied = false, bool checking = false}) => MaterialApp(
      home: SsoGateScreen(
        title: 'Graph',
        tagline: 'Who knows whom.',
        deniedMessage: 'Ask Brandon for an invite.',
        denied: denied,
        checking: checking,
        signInButton: button,
      ),
    );

class FakeApi implements AllowlistApi {
  FakeApi([List<String>? emails]) : emails = emails ?? [];
  List<String> emails;
  Object? failWith;
  Completer<void>? hold;
  final calls = <String>[];

  Future<List<String>> _answer() async {
    if (hold != null) await hold!.future;
    if (failWith != null) throw failWith!;
    return [...emails]..sort();
  }

  @override
  Future<List<String>> getAllowlist() {
    calls.add('get');
    return _answer();
  }

  @override
  Future<List<String>> addAllowedEmail(String email) {
    calls.add('add $email');
    emails.add(email.toLowerCase());
    return _answer();
  }

  @override
  Future<List<String>> removeAllowedEmail(String email) {
    calls.add('remove $email');
    emails.remove(email);
    return _answer();
  }
}

Future<void> openDialog(WidgetTester tester, AllowlistApi api) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => TextButton(
        onPressed: () => AllowlistDialog.show(context, api),
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  group('SsoGateScreen', () {
    testWidgets('signed out: the site, its tagline and the sign-in button', (tester) async {
      await tester.pumpWidget(gate());
      expect(find.text('Graph'), findsOneWidget);
      expect(find.text('Who knows whom.'), findsOneWidget);
      expect(find.text('SIGN-IN-BUTTON'), findsOneWidget);
      expect(find.text('By invitation only'), findsNothing);
    });

    testWidgets('not on the allow-list: by invitation only, no button', (tester) async {
      await tester.pumpWidget(gate(denied: true));
      expect(find.text('By invitation only'), findsOneWidget);
      expect(find.text('Ask Brandon for an invite.'), findsOneWidget);
      expect(find.text('Who knows whom.'), findsNothing);
      expect(find.text('SIGN-IN-BUTTON'), findsNothing);
    });

    testWidgets('waiting on the server: a spinner, never the button', (tester) async {
      await tester.pumpWidget(gate(checking: true));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Checking access…'), findsOneWidget);
      expect(find.text('SIGN-IN-BUTTON'), findsNothing);
    });
  });

  group('AllowlistDialog', () {
    testWidgets('lists who is invited', (tester) async {
      await openDialog(tester, FakeApi(['b@x.com', 'a@x.com']));
      expect(find.text('Manage access'), findsOneWidget);
      expect(find.text('a@x.com'), findsOneWidget);
      expect(find.text('b@x.com'), findsOneWidget);
    });

    testWidgets('says so when no one is invited', (tester) async {
      await openDialog(tester, FakeApi());
      expect(find.text('No one has been invited yet.'), findsOneWidget);
    });

    testWidgets('adds a trimmed email and clears the field', (tester) async {
      final api = FakeApi();
      await openDialog(tester, api);
      await tester.enterText(find.byType(TextField), '  new@x.com ');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('add new@x.com'));
      expect(find.text('new@x.com'), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
    });

    testWidgets('Enter in the field adds too; an empty field adds nothing', (tester) async {
      final api = FakeApi();
      await openDialog(tester, api);
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(api.calls, ['get']);
      await tester.enterText(find.byType(TextField), 'k@x.com');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(api.calls, contains('add k@x.com'));
    });

    testWidgets('removes an email', (tester) async {
      final api = FakeApi(['a@x.com', 'b@x.com']);
      await openDialog(tester, api);
      await tester.tap(find.byTooltip('Remove').first);
      await tester.pumpAndSettle();
      expect(api.calls, contains('remove a@x.com'));
      expect(find.text('a@x.com'), findsNothing);
      expect(find.text('b@x.com'), findsOneWidget);
    });

    testWidgets('a failure is shown and the list stays', (tester) async {
      final api = FakeApi(['a@x.com']);
      await openDialog(tester, api);
      api.failWith = Exception('403 admin only');
      await tester.enterText(find.byType(TextField), 'n@x.com');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(find.textContaining('403 admin only'), findsOneWidget);
      expect(find.text('a@x.com'), findsOneWidget);
    });

    testWidgets('while a change is in flight the controls are disabled', (tester) async {
      final api = FakeApi(['a@x.com']);
      await openDialog(tester, api);
      api.hold = Completer<void>();
      await tester.enterText(find.byType(TextField), 'n@x.com');
      await tester.tap(find.text('Add'));
      await tester.pump();
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      api.hold!.complete();
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
    });

    testWidgets('Close dismisses it', (tester) async {
      await openDialog(tester, FakeApi());
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.text('Manage access'), findsNothing);
    });
  });
}
