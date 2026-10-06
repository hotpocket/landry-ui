import 'browser.dart';

class WindowBrowser implements SsoBrowser {
  @override
  Uri url = Uri.parse('http://localhost/');

  @override
  void replaceUrl(String url) => this.url = this.url.resolve(url);

  @override
  void navigate(String url) {}
}
