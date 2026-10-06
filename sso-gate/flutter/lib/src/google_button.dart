import 'package:flutter/widgets.dart';

import 'google_button_stub.dart' if (dart.library.js_interop) 'google_button_web.dart' as impl;

/// Google's own rendered sign-in button. On web the GIS SDK requires it — a
/// custom button cannot trigger authentication. Empty off the web (tests).
class GoogleSignInButton extends StatelessWidget {
  const GoogleSignInButton({super.key});

  @override
  Widget build(BuildContext context) => impl.renderButton();
}
