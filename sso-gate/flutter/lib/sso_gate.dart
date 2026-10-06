/// Google sign-in gate + Admin allow-list UI for a Flutter web site whose API
/// runs sso-gate/server. See ../README.md.
library;

export 'src/allowlist_dialog.dart' show AllowlistApi, AllowlistDialog;
export 'src/gate_screen.dart' show SsoGateScreen;
export 'src/google_button.dart' show GoogleSignInButton;
export 'src/sso_auth.dart' show SsoAuth, SsoProfile;
export 'src/storage.dart' show SsoStorage, SafeLocalStorage;
