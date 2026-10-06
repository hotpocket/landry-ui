import 'package:flutter/material.dart';

import 'sso_auth.dart';

/// Full-screen access gate shown INSTEAD of the app whenever auth is enabled
/// and the user isn't (yet) a signed-in member. One look per [SsoStatus]:
/// signed out ("Sign in with Google"), [SsoStatus.checking] (a spinner),
/// [SsoStatus.denied] (the broker refused the account: "by invitation only",
/// and a way to try another account), and [SsoStatus.error] (the sentence,
/// and "Try again"). Signed in shows the spinner: the app replaces it.
class SsoGateScreen extends StatelessWidget {
  const SsoGateScreen({
    super.key,
    required this.title,
    required this.tagline,
    required this.deniedMessage,
    required this.status,
    required this.onSignIn,
    this.onSignOut,
    this.message,
    this.backgroundColor = const Color(0xFFE5E7EB),
    this.textColor = const Color(0xFF1F2937),
    this.fontFamily,
  });

  /// The site's name.
  final String title;

  /// One line under the title for a signed-out visitor.
  final String tagline;

  /// Shown under "By invitation only": how to get invited.
  final String deniedMessage;

  /// Usually `auth.state.value.status`.
  final SsoStatus status;

  /// Shown for [SsoStatus.error] (`auth.state.value.message`).
  final String? message;

  /// "Sign in with Google" and "Try again": usually `auth.signIn`.
  final VoidCallback onSignIn;

  /// "Use a different account" when denied: usually `auth.signOut`, which
  /// leaves through the broker's logout so Google asks again.
  final VoidCallback? onSignOut;

  final Color backgroundColor;
  final Color textColor;
  final String? fontFamily;

  @override
  Widget build(BuildContext context) {
    final denied = status == SsoStatus.denied;
    final small = TextStyle(fontFamily: fontFamily, fontSize: 13, color: Colors.black54);
    return Scaffold(
      backgroundColor: backgroundColor,
      body: Center(
        child: Card(
          elevation: 0,
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: Theme.of(context).dividerColor),
          ),
          child: Padding(
            padding: const EdgeInsets.all(48),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontFamily: fontFamily,
                    fontSize: 24,
                    fontWeight: FontWeight.w700,
                    color: textColor,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  denied ? 'By invitation only' : tagline,
                  style: TextStyle(
                    fontFamily: fontFamily,
                    fontSize: 15,
                    color: textColor,
                  ),
                ),
                const SizedBox(height: 24),
                switch (status) {
                  SsoStatus.signedOut => FilledButton(
                      onPressed: onSignIn,
                      child: const Text('Sign in with Google'),
                    ),
                  SsoStatus.denied => Column(mainAxisSize: MainAxisSize.min, children: [
                      Text(deniedMessage, textAlign: TextAlign.center, style: small),
                      if (onSignOut != null) ...[
                        const SizedBox(height: 16),
                        TextButton(
                          onPressed: onSignOut,
                          child: const Text('Use a different account'),
                        ),
                      ],
                    ]),
                  SsoStatus.error => Column(mainAxisSize: MainAxisSize.min, children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 320),
                        child: Text(message ?? 'Sign-in failed.',
                            textAlign: TextAlign.center, style: small),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(onPressed: onSignIn, child: const Text('Try again')),
                    ]),
                  SsoStatus.checking || SsoStatus.signedIn => Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        const CircularProgressIndicator(),
                        const SizedBox(height: 12),
                        Text('Checking access…', style: small),
                      ]),
                    ),
                },
              ],
            ),
          ),
        ),
      ),
    );
  }
}
