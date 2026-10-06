import 'package:web/web.dart' as web;

import 'browser.dart';

class WindowBrowser implements SsoBrowser {
  @override
  Uri get url => Uri.parse(web.window.location.href);

  @override
  void replaceUrl(String url) => web.window.history.replaceState(null, '', url);

  @override
  void navigate(String url) => web.window.location.assign(url);
}
