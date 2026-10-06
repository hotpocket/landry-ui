import 'package:flutter/material.dart';

/// The Admin's calls against sso-gate/server's /allowlist routes. Each answers
/// the updated allow-list. A site's API client implements this.
abstract interface class AllowlistApi {
  Future<List<String>> getAllowlist();
  Future<List<String>> addAllowedEmail(String email);
  Future<List<String>> removeAllowedEmail(String email);
}

/// Admin-only management of the sign-in allow-list (who can use the site).
/// Changes take effect on the next sign-in check, no redeploy needed.
class AllowlistDialog extends StatefulWidget {
  const AllowlistDialog({super.key, required this.api});

  final AllowlistApi api;

  static Future<void> show(BuildContext context, AllowlistApi api) =>
      showDialog<void>(context: context, builder: (_) => AllowlistDialog(api: api));

  @override
  State<AllowlistDialog> createState() => _AllowlistDialogState();
}

class _AllowlistDialogState extends State<AllowlistDialog> {
  final _email = TextEditingController();
  List<String>? _emails;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final emails = await widget.api.getAllowlist();
      if (mounted) setState(() => _emails = emails);
    } on Exception catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _run(Future<List<String>> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final emails = await action();
      if (mounted) {
        setState(() {
          _emails = emails;
          _busy = false;
          _email.clear();
        });
      }
    } on Exception catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.toString();
        });
      }
    }
  }

  Future<void> _add() async {
    final email = _email.text.trim();
    if (email.isEmpty) return;
    await _run(() => widget.api.addAllowedEmail(email));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Manage access'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Google accounts allowed to sign in. Changes apply on their '
              'next request — no redeploy.',
              style: TextStyle(fontSize: 13, color: Colors.black54),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _email,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    hintText: 'friend@gmail.com',
                    isDense: true,
                  ),
                  onSubmitted: (_) => _add(),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _busy ? null : _add,
                child: const Text('Add'),
              ),
            ]),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
              ),
            const SizedBox(height: 8),
            Flexible(
              child: _emails == null
                  ? const Padding(
                      padding: EdgeInsets.all(16),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  : _emails!.isEmpty
                      ? const Padding(
                          padding: EdgeInsets.all(16),
                          child: Text('No one has been invited yet.'),
                        )
                      : ListView(
                          shrinkWrap: true,
                          children: [
                            for (final email in _emails!)
                              ListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text(email),
                                trailing: IconButton(
                                  icon: const Icon(Icons.delete_outline, size: 20),
                                  tooltip: 'Remove',
                                  onPressed: _busy
                                      ? null
                                      : () => _run(() => widget.api.removeAllowedEmail(email)),
                                ),
                              ),
                          ],
                        ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close'),
        ),
      ],
    );
  }
}
