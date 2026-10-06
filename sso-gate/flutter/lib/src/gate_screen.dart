import 'package:flutter/material.dart';

import 'google_button.dart';

/// Full-screen access gate shown INSTEAD of the app whenever auth is enabled
/// and the user isn't (yet) an authorized, signed-in member. Three states:
/// signed out (Google button), signed in and waiting on the server's verdict
/// ([checking]), and signed in but not on the allow-list ([denied]: "by
/// invitation only").
class SsoGateScreen extends StatelessWidget {
  const SsoGateScreen({
    super.key,
    required this.title,
    required this.tagline,
    required this.deniedMessage,
    required this.denied,
    this.checking = false,
    this.backgroundColor = const Color(0xFFE5E7EB),
    this.textColor = const Color(0xFF1F2937),
    this.fontFamily,
    this.signInButton = const GoogleSignInButton(),
  });

  /// The site's name.
  final String title;

  /// One line under the title for a signed-out visitor.
  final String tagline;

  /// Shown under "By invitation only": how to get invited.
  final String deniedMessage;

  /// Signed in, waiting on the server's allow-list verdict.
  final bool checking;

  /// True when the server rejected the signed-in account (403 — not on the
  /// allow-list); false = simply signed out.
  final bool denied;

  final Color backgroundColor;
  final Color textColor;
  final String? fontFamily;

  /// Defaults to Google's rendered button; replaceable for tests.
  final Widget signInButton;

  @override
  Widget build(BuildContext context) {
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
                if (checking)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      const CircularProgressIndicator(),
                      const SizedBox(height: 12),
                      Text('Checking access…',
                          style: TextStyle(
                              fontFamily: fontFamily,
                              fontSize: 13,
                              color: Colors.black54)),
                    ]),
                  )
                else if (denied)
                  Text(
                    deniedMessage,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: fontFamily,
                      fontSize: 13,
                      color: Colors.black54,
                    ),
                  )
                else
                  SizedBox(width: 240, child: Center(child: signInButton)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
