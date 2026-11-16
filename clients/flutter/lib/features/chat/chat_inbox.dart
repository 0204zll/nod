import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/core.dart';
import 'chat_models.dart';

class ChatInbox extends ChangeNotifier {
  final _storage = const FlutterSecureStorage();
  final Set<String> _read = {};
  String? _key;
  bool ready = false;
  bool persistent = true;
  Future<void> _writes = Future.value();
  bool _disposed = false;

  Future<void> scope(String identity) async {
    final key = 'nod.inbox.${sha256.convert(utf8.encode(identity))}';
    if (_key == key) return;
    _key = key;
    _read.clear();
    ready = false;
    persistent = true;
    try {
      await _writes;
      if (_key != key || _disposed) return;
      final saved = await _storage.read(key: key);
      if (_key != key || _disposed) return;
      if (saved != null) {
        _read.addAll((jsonDecode(saved) as List).cast<String>());
      }
    } on Object {
      if (_key != key || _disposed) return;
      persistent = false;
    }
    ready = true;
    notifyListeners();
  }

  bool isUnread(ChatMessageItem message) => !_read.contains(message.id);

  void markRead(Iterable<String> ids) {
    if (!ready) return;
    final before = _read.length;
    _read.addAll(ids);
    if (before == _read.length) return;
    final key = _key!;
    final value = jsonEncode(_read.toList());
    _writes = _writes.then((_) async {
      try {
        await _storage.write(key: key, value: value);
      } on Object {
        if (_key == key && !_disposed) {
          persistent = false;
          notifyListeners();
        }
      }
    });
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

List<ChatMessageItem> inboxMessages(Iterable<ChatMessageItem> messages) =>
    messages
        .where(
          (message) =>
              message.role == NodMessageRole.assistant &&
              !message.isPending &&
              !message.isStreaming,
        )
        .toList()
      ..sort((a, b) {
        final time = b.createdAt.compareTo(a.createdAt);
        return time == 0 ? b.id.compareTo(a.id) : time;
      });

class ChatInboxPage extends StatefulWidget {
  const ChatInboxPage({
    required this.inbox,
    required this.messages,
    required this.changes,
    required this.onOpen,
    super.key,
  });

  final ChatInbox inbox;
  final List<ChatMessageItem> Function() messages;
  final Listenable changes;
  final ValueChanged<String> onOpen;

  @override
  State<ChatInboxPage> createState() => _ChatInboxPageState();
}

class _ChatInboxPageState extends State<ChatInboxPage> {
  bool _unreadOnly = true;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.inbox, widget.changes]),
    builder: (context, _) {
      final all = inboxMessages(widget.messages());
      final messages = all
          .where((m) => !_unreadOnly || widget.inbox.isUnread(m))
          .toList();
      final colors = Theme.of(context).colorScheme;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Updates'),
          actions: [
            IconButton(
              tooltip: 'Mark loaded updates as read',
              onPressed: widget.inbox.ready && all.any(widget.inbox.isUnread)
                  ? () => widget.inbox.markRead(all.map((m) => m.id))
                  : null,
              icon: const Icon(Icons.done_all),
            ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SegmentedButton<bool>(
                      segments: const [
                        ButtonSegment(value: true, label: Text('Unread')),
                        ButtonSegment(value: false, label: Text('All')),
                      ],
                      selected: {_unreadOnly},
                      onSelectionChanged: (value) =>
                          setState(() => _unreadOnly = value.single),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Newest first · Updates from loaded conversation history',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    if (!widget.inbox.persistent)
                      const Text(
                        'Read status is available for this session only.',
                      ),
                  ],
                ),
              ),
              Expanded(
                child: !widget.inbox.ready
                    ? const Center(child: CircularProgressIndicator())
                    : messages.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            _unreadOnly
                                ? 'You’re all caught up.'
                                : 'No updates yet.',
                          ),
                        ),
                      )
                    : ListView.separated(
                        itemCount: messages.length,
                        separatorBuilder: (_, _) =>
                            const Divider(height: 1, indent: 56),
                        itemBuilder: (context, index) {
                          final message = messages[index];
                          final unread = widget.inbox.isUnread(message);
                          final local = message.createdAt.toLocal();
                          final date = MaterialLocalizations.of(context);
                          return ListTile(
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 20,
                              vertical: 12,
                            ),
                            leading: Icon(
                              unread
                                  ? Icons.mark_chat_unread_outlined
                                  : Icons.chat_bubble_outline,
                              color: unread
                                  ? colors.primary
                                  : colors.onSurfaceVariant,
                            ),
                            title: Text(
                              message.text.trim().isEmpty
                                  ? 'Message with attachment'
                                  : message.text,
                              maxLines: 3,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontWeight: unread
                                    ? FontWeight.w600
                                    : FontWeight.normal,
                              ),
                            ),
                            subtitle: Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(
                                '${date.formatMediumDate(local)} · ${date.formatTimeOfDay(TimeOfDay.fromDateTime(local))}',
                              ),
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => widget.onOpen(message.id),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
