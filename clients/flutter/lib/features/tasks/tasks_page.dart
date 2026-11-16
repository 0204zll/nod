import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/tasks_repository.dart';
import '../../core/api_transport.dart';
import '../../core/nod_errors.dart';
import '../../core/nod_repository.dart';
import '../../core/tasks.dart';
import '../../design_system/design_system.dart';
import 'task_schedule_form.dart';
import 'task_text.dart';

String _failure(Object error) => error is NodException
    ? error.message
    : 'Could not load this work. Try again.';

NodTone _tone(NodTask task) => switch (task.status) {
  'needs_you' => NodTone.warning,
  'working' || 'queued' => NodTone.info,
  'done' => NodTone.success,
  'failed' => NodTone.error,
  _ => NodTone.neutral,
};

class NodTasksPage extends StatefulWidget {
  const NodTasksPage({required this.transport, this.onShowMessage, super.key});
  final NodApiTransport transport;
  final ValueChanged<String>? onShowMessage;

  @override
  State<NodTasksPage> createState() => _NodTasksPageState();
}

class _NodTasksPageState extends State<NodTasksPage>
    with WidgetsBindingObserver {
  late final _repository = NodTasksRepository(widget.transport);
  List<NodTask>? _tasks;
  String? _error;
  bool _loading = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (WidgetsBinding.instance.lifecycleState == null ||
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        unawaited(_load());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    if (_loading) return;
    _loading = true;
    try {
      final tasks = await _repository.loadTasks();
      if (mounted) {
        setState(() {
          _tasks = tasks;
          _error = null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _failure(error));
    } finally {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: const NodPageBar(title: 'Tasks'),
    body: NodPageBody(
      onRefresh: _load,
      spacing: NodSpacing.sm,
      children: [
        if (_error != null) ...[
          NodNotice(_error!, tone: NodTone.error),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: _load,
              child: const Text('Try again'),
            ),
          ),
        ],
        if (_tasks == null && _error == null) const LinearProgressIndicator(),
        if (_tasks?.isEmpty == true)
          const NodEmptyState(
            icon: Icons.task_outlined,
            title: 'No saved tasks',
            message: 'Substantial work, an outside wait, or work you ask Nod to track becomes a saved task and appears here.',
          ),
        for (final task in _tasks ?? <NodTask>[])
          Card(
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: NodSpacing.md,
                vertical: NodSpacing.xs,
              ),
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  NodStatusLabel(task.statusLabel, tone: _tone(task)),
                  const SizedBox(height: NodSpacing.xs),
                  Text(
                    task.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ],
              ),
              subtitle: task.now.isEmpty
                  ? null
                  : Padding(
                      padding: const EdgeInsets.only(top: NodSpacing.xxs),
                      child: Text(
                        task.now,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () async {
                await Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) => NodTaskPage(
                      transport: widget.transport,
                      taskId: task.id,
                      onShowMessage: widget.onShowMessage,
                    ),
                  ),
                );
                await _load();
              },
            ),
          ),
      ],
    ),
  );
}

class NodTaskPage extends StatefulWidget {
  const NodTaskPage({
    required this.transport,
    required this.taskId,
    this.onShowMessage,
    super.key,
  });
  final NodApiTransport transport;
  final String taskId;
  final ValueChanged<String>? onShowMessage;

  @override
  State<NodTaskPage> createState() => _NodTaskPageState();
}

class _NodTaskPageState extends State<NodTaskPage> with WidgetsBindingObserver {
  late final _repository = NodTasksRepository(widget.transport);
  NodTaskDetail? _detail;
  String? _error;
  bool _busy = false;
  bool _unconfirmed = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (WidgetsBinding.instance.lifecycleState == null ||
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        unawaited(_load());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    if (_busy) return;
    _busy = true;
    try {
      final detail = await _repository.loadTask(widget.taskId);
      if (mounted) {
        setState(() {
          _detail = detail;
          _error = null;
          _unconfirmed = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _detail = null;
          _error = _failure(error);
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _mutate(Future<void> Function() action) async {
    if (_busy || _unconfirmed) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted) {
        setState(() {
          _unconfirmed = true;
          _error =
              '${_failure(error)} The change was not confirmed. Refresh before doing more; it will not be retried automatically.';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!_unconfirmed) await _load();
  }

  Future<void> _rename(NodTask task) async {
    var draft = task.title;
    final title = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename task'),
        content: TextFormField(
          initialValue: task.title,
          onChanged: (value) => draft = value,
          maxLength: 160,
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (draft.trim().isNotEmpty) {
                Navigator.pop(context, draft);
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (title != null && mounted) {
      await _mutate(() => _repository.rename(task.id, title));
    }
  }

  Future<void> _reply() async {
    if (_busy || _unconfirmed) return;
    setState(() => _busy = true);
    try {
      final context = await _repository.prepareReply(widget.taskId);
      if (!mounted) return;
      await showDialog<void>(
        context: this.context,
        builder: (_) => _TaskReply(repository: _repository, context: context),
      );
    } catch (error) {
      if (mounted) setState(() => _error = _failure(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final task = _detail?.task;
    final disabled = _busy || _unconfirmed;
    final theme = Theme.of(context);
    final colors = context.nodColors;
    final meta = theme.textTheme.bodyMedium?.copyWith(
      color: colors.textSecondary,
    );
    return Scaffold(
      appBar: AppBar(
        title: Text(task?.title ?? 'Task'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
        bottom: NodProgressLine(active: _busy),
      ),
      body: NodPageBody(
        children: [
          if (_error != null) ...[
            NodNotice(_error!, tone: NodTone.error),
            const SizedBox(height: NodSpacing.md),
          ],
          if (task != null) ...[
            Align(
              alignment: Alignment.centerLeft,
              child: NodStatusLabel(task.statusLabel, tone: _tone(task)),
            ),
            if (task.now.isNotEmpty) ...[
              const SizedBox(height: NodSpacing.sm),
              SelectableText(task.now, style: theme.textTheme.titleMedium),
            ],
            if (task.question != null) ...[
              const SizedBox(height: NodSpacing.md),
              Container(
                padding: const EdgeInsets.all(NodSpacing.md),
                decoration: BoxDecoration(
                  color: colors.surfaceSubtle,
                  borderRadius: BorderRadius.circular(NodRadii.card),
                ),
                child: SelectableText(
                  task.question!,
                  style: theme.textTheme.bodyLarge,
                ),
              ),
            ],
            if (task.result.isNotEmpty) ...[
              const SizedBox(height: NodSpacing.md),
              TaskText(text: task.result, transport: widget.transport),
            ],
            if (task.steps.isNotEmpty) const SizedBox(height: NodSpacing.sm),
            for (var i = 0; i < task.steps.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: NodSpacing.xxs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      task.status == 'done' || i < task.stepIndex
                          ? Icons.check_circle_outline
                          : Icons.radio_button_unchecked,
                      size: 20,
                      color: task.status == 'done' || i < task.stepIndex
                          ? colors.success
                          : colors.mutedForeground,
                    ),
                    const SizedBox(width: NodSpacing.sm),
                    Expanded(child: Text(task.steps[i])),
                  ],
                ),
              ),
            const SizedBox(height: NodSpacing.md),
            if (task.doneWhen.isNotEmpty)
              Text('Done when: ${task.doneWhen}', style: meta),
            for (final wait in task.waitingFor)
              Text('Waiting on: ${wait.who} · ${wait.via}', style: meta),
            if (task.nextCheck != null)
              Text(
                'Next check: ${nodTimestamp(context, task.nextCheck!)}',
                style: meta,
              ),
            if (task.updateQueued && !task.closed)
              Text('Owner update queued', style: meta),
            const SizedBox(height: NodSpacing.lg),
            Wrap(
              spacing: NodSpacing.xs,
              runSpacing: NodSpacing.xs,
              children: [
                if (task.replyTarget != null)
                  FilledButton(
                    onPressed: disabled ? null : _reply,
                    child: Text(
                      task.closed ? 'Continue task' : 'Reply to task',
                    ),
                  ),
                if (task.status == 'done')
                  OutlinedButton(
                    onPressed: disabled
                        ? null
                        : () => Navigator.of(context).push<void>(
                            MaterialPageRoute(
                              builder: (_) => NodTaskSchedulePage(
                                transport: widget.transport,
                                taskId: task.id,
                              ),
                            ),
                          ),
                    child: const Text('Schedule task'),
                  ),
                if (task.replyTarget != null && widget.onShowMessage != null)
                  OutlinedButton(
                    onPressed: () => widget.onShowMessage!(task.replyTarget!),
                    child: Text(
                      task.browserHandoff
                          ? 'Open browser in chat'
                          : 'Show in chat',
                    ),
                  ),
                TextButton(
                  onPressed: disabled ? null : () => _rename(task),
                  child: const Text('Rename'),
                ),
                if (!task.closed)
                  TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: theme.colorScheme.error,
                    ),
                    onPressed: disabled
                        ? null
                        : () => _mutate(() => _repository.stop(task.id)),
                    child: const Text('Stop this task'),
                  ),
              ],
            ),
            if (task.browserHandoff && widget.onShowMessage == null) ...[
              const SizedBox(height: NodSpacing.md),
              const NodNotice(
                'Open this task’s question in chat to use its private browser controls.',
              ),
            ],
            const SizedBox(height: NodSpacing.md),
            const Divider(height: 1),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('Activity'),
              children: [
                if (_detail!.events.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: NodSpacing.md),
                    child: Text('No activity recorded yet.', style: meta),
                  ),
                for (final event in _detail!.events)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: event.type == 'tool_failed'
                        ? Icon(
                            Icons.error_outline,
                            color: theme.colorScheme.error,
                          )
                        : null,
                    title: SelectableText(
                      '${event.helper ? 'Helper · ' : ''}${event.summary}',
                      style: theme.textTheme.bodyMedium,
                    ),
                    subtitle: event.site == null ? null : Text(event.site!),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _TaskReply extends StatefulWidget {
  const _TaskReply({required this.repository, required this.context});
  final NodTasksRepository repository;
  final NodTaskReplyContext context;
  @override
  State<_TaskReply> createState() => _TaskReplyState();
}

class _TaskReplyState extends State<_TaskReply> {
  final _text = TextEditingController();
  late final _clientId = newNodClientMessageId();
  bool _sent = false;
  String? _error;

  Future<void> _send() async {
    if (_sent || _text.text.trim().isEmpty) return;
    setState(() => _sent = true);
    try {
      await widget.repository.reply(
        widget.context,
        _text.text,
        clientMessageId: _clientId,
      );
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) {
        setState(
          () => _error =
              '${_failure(error)} Check the conversation before sending again. This reply will not be retried.',
        );
      }
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('Reply to ${widget.context.task.title}'),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: NodSpacing.md,
          children: [
            if (widget.context.task.question != null)
              Text(
                widget.context.task.question!,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            TextField(
              controller: _text,
              enabled: !_sent,
              minLines: 3,
              maxLines: 6,
              decoration: const InputDecoration(
                labelText: 'Your reply',
                helperText: 'Use private entry in chat for passwords, codes, and card details.',
              ),
            ),
            if (_error != null) NodNotice(_error!, tone: NodTone.error),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Close'),
      ),
      FilledButton(
        onPressed: _sent ? null : _send,
        child: const Text('Send reply'),
      ),
    ],
  );
}
