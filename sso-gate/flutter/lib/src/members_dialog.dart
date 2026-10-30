import 'package:flutter/material.dart';

import 'members.dart';

/// The shared "manage users" UI (the twin of ../js mountMembersAdmin): who
/// may use this site and as what, with add, role toggle and remove. Reloads
/// from the broker after every change, so two admins see each other's edits.
/// Global admins and the viewer ([myEmail]) are listed but not editable.
class MembersDialog extends StatefulWidget {
  const MembersDialog({super.key, required this.api, this.myEmail});

  final MembersApi api;

  /// The signed-in admin: their own row has no controls.
  final String? myEmail;

  static Future<void> show(BuildContext context, MembersApi api, {String? myEmail}) => showDialog<void>(
      context: context, builder: (_) => MembersDialog(api: api, myEmail: myEmail));

  @override
  State<MembersDialog> createState() => _MembersDialogState();
}

class _MembersDialogState extends State<MembersDialog> {
  final _email = TextEditingController();
  String _role = 'user';
  List<Member>? _members;
  String? _status;
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

  /// [afterChange]: a failed reload keeps the change's own message.
  Future<void> _load({bool afterChange = false}) async {
    try {
      final members = await widget.api.list();
      if (mounted) setState(() => _members = members);
    } on Exception catch (e) {
      if (!mounted || afterChange) return;
      setState(() => _status = _statusOf(e) == 403
          ? 'Only a site admin can manage users.'
          : 'Could not load users: ${_messageOf(e)}');
    }
  }

  /// Runs one change, says how it went, then reloads either way.
  Future<bool> _act(Future<void> Function() change, String done) async {
    setState(() {
      _busy = true;
      _status = 'Saving…';
    });
    var ok = false;
    String said;
    try {
      await change();
      ok = true;
      said = done;
    } on Exception catch (e) {
      said = switch (_statusOf(e)) {
        409 => 'Already done: ${_messageOf(e)}',
        403 => 'Only a site admin can do that.',
        _ => 'Failed: ${_messageOf(e)}',
      };
    }
    if (!mounted) return ok;
    setState(() => _status = said);
    await _load(afterChange: true);
    if (mounted) setState(() => _busy = false);
    return ok;
  }

  Future<void> _add() async {
    final email = _email.text.trim();
    if (email.isEmpty || _busy) return;
    if (await _act(() => widget.api.add(email, role: _role), 'Added $email') && mounted) {
      _email.clear();
    }
  }

  static int? _statusOf(Exception e) => e is MembersException ? e.status : null;
  static String _messageOf(Exception e) => e is MembersException ? e.message : '$e';

  bool _editable(Member m) =>
      !m.global && m.email.toLowerCase() != widget.myEmail?.toLowerCase();

  Widget _row(Member m) {
    final other = m.role == 'admin' ? 'user' : 'admin';
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      title: Text(m.email),
      subtitle: Text(m.global ? 'admin (all sites)' : m.role),
      trailing: !_editable(m)
          ? null
          : Row(mainAxisSize: MainAxisSize.min, children: [
              TextButton(
                onPressed: _busy ? null : () => _act(() => widget.api.setRole(m.email, other), 'Updated ${m.email}'),
                child: Text('Make $other'),
              ),
              IconButton(
                icon: const Icon(Icons.delete_outline, size: 20),
                tooltip: 'Remove',
                onPressed: _busy ? null : () => _act(() => widget.api.remove(m.email), 'Removed ${m.email}'),
              ),
            ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Manage users'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Google accounts allowed into this site. Changes apply at their '
              'next sign-in or token refresh — no redeploy.',
              style: TextStyle(fontSize: 13, color: Colors.black54),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _email,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    hintText: 'name@gmail.com',
                    isDense: true,
                  ),
                  onSubmitted: (_) => _add(),
                ),
              ),
              const SizedBox(width: 8),
              DropdownButton<String>(
                value: _role,
                items: const [
                  DropdownMenuItem(value: 'user', child: Text('user')),
                  DropdownMenuItem(value: 'admin', child: Text('admin')),
                ],
                onChanged: _busy ? null : (r) => setState(() => _role = r ?? 'user'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _busy ? null : _add,
                child: const Text('Add'),
              ),
            ]),
            if (_status != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_status!, style: const TextStyle(fontSize: 12, color: Colors.black87)),
              ),
            const SizedBox(height: 8),
            Flexible(
              child: _members == null
                  ? Padding(
                      padding: const EdgeInsets.all(16),
                      child: Center(child: _status == null ? const CircularProgressIndicator() : null),
                    )
                  : _members!.isEmpty
                      ? const Padding(
                          padding: EdgeInsets.all(16),
                          child: Text('No one has been invited yet.'),
                        )
                      : ListView(
                          shrinkWrap: true,
                          children: [for (final m in _members!) _row(m)],
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
