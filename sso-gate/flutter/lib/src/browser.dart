import 'browser_stub.dart' if (dart.library.js_interop) 'browser_web.dart' as impl;

/// The page's address bar, as sign-in needs it. In the browser this is
/// window.location / history; tests stand in a fake.
abstract interface class SsoBrowser {
  /// The real window (off the web: a fixed localhost page that goes nowhere).
  factory SsoBrowser.window() => impl.WindowBrowser();

  /// The current address.
  Uri get url;

  /// Rewrites the address without loading anything (history.replaceState):
  /// drops ?code=… after sign-in so a reload cannot replay it.
  void replaceUrl(String url);

  /// Leaves the page for [url] (location.assign).
  void navigate(String url);
}
