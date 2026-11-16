import 'package:flutter/material.dart';

import '../../core/nod_errors.dart';
import '../../design_system/design_system.dart';

String settingsError(Object error) => error is NodException
    ? error.message
    : 'The change could not be completed. Review the details and try again.';

Future<bool> confirmSettings(
  BuildContext context,
  String title,
  String detail,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Continue'),
          ),
        ],
      ),
    ) ??
    false;

class SettingsSection extends StatefulWidget {
  const SettingsSection({
    super.key,
    required this.title,
    required this.load,
    required this.builder,
  });
  final String title;
  final Future<Map<String, Object?>> Function() load;
  final Widget Function(
    BuildContext,
    Map<String, Object?>,
    SettingsSectionState,
  )
  builder;
  @override
  State<SettingsSection> createState() => SettingsSectionState();
}

class SettingsSectionState extends State<SettingsSection> {
  Map<String, Object?>? data;
  String? error;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() => run(() async {
    final next = await widget.load();
    if (mounted) setState(() => data = next);
  });
  Future<bool> run(Future<void> Function() action) async {
    if (busy) return false;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
      return true;
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
      return false;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> change(Future<Object?> Function() action) => run(() async {
    await action();
    final next = await widget.load();
    if (mounted) setState(() => data = next);
  });
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: NodPageBar(
      title: widget.title,
      busy: busy,
      actions: [
        IconButton(
          onPressed: busy ? null : reload,
          icon: const Icon(Icons.refresh),
          tooltip: 'Reload',
        ),
      ],
    ),
    body: Column(
      children: [
        if (error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NodSpacing.md,
              NodSpacing.md,
              NodSpacing.md,
              0,
            ),
            child: NodNotice(error!, tone: NodTone.error),
          ),
        Expanded(
          child: data == null
              ? Center(
                  child: busy
                      ? null
                      : OutlinedButton(
                          onPressed: reload,
                          child: const Text('Try again'),
                        ),
                )
              : AbsorbPointer(
                  absorbing: busy,
                  child: widget.builder(context, data!, this),
                ),
        ),
      ],
    ),
  );
}

class SettingsEditPage extends StatefulWidget {
  const SettingsEditPage({
    super.key,
    required this.title,
    required this.fields,
    required this.save,
    this.secretFields = const {},
    this.limits = const {},
    this.multiline = const {},
    this.labels = const {},
    this.help,
  });
  final String title;
  final Map<String, String> fields;
  final Set<String> secretFields;
  final Set<String> multiline;
  final Map<String, int> limits;
  final Map<String, String> labels;
  final String? help;
  final Future<void> Function(Map<String, String>) save;
  @override
  State<SettingsEditPage> createState() => _SettingsEditPageState();
}

class _SettingsEditPageState extends State<SettingsEditPage> {
  late final fields = {
    for (final entry in widget.fields.entries)
      entry.key: TextEditingController(text: entry.value),
  };
  bool busy = false;
  String? error;
  bool get dirty => fields.entries.any(
    (entry) => entry.value.text != widget.fields[entry.key],
  );
  @override
  void dispose() {
    for (final controller in fields.values) {
      controller.clear();
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> save() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.save({
        for (final entry in fields.entries) entry.key: entry.value.text,
      });
      if (mounted) Navigator.pop(context, true);
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy && !dirty,
    onPopInvokedWithResult: (didPop, result) async {
      if (didPop || busy) return;
      if (await confirmSettings(
            context,
            'Discard changes?',
            'Your unsaved changes will be lost.',
          ) &&
          context.mounted) {
        Navigator.pop(context);
      }
    },
    child: Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: NodPageBody(
        children: [
          if (widget.help != null) ...[
            Text(
              widget.help!,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: context.nodColors.textSecondary),
            ),
            const SizedBox(height: NodSpacing.lg),
          ],
          for (final entry in fields.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: NodSpacing.md),
              child: TextField(
                controller: entry.value,
                enabled: !busy,
                obscureText: widget.secretFields.contains(entry.key),
                autocorrect: !widget.secretFields.contains(entry.key),
                enableSuggestions: !widget.secretFields.contains(entry.key),
                enableIMEPersonalizedLearning: !widget.secretFields.contains(
                  entry.key,
                ),
                minLines: widget.multiline.contains(entry.key) ? 4 : 1,
                maxLines: widget.multiline.contains(entry.key) ? 10 : 1,
                maxLength: widget.limits[entry.key],
                decoration: InputDecoration(
                  labelText: widget.labels[entry.key] ?? entry.key,
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
          if (error != null) ...[
            NodNotice(error!, tone: NodTone.error),
            const SizedBox(height: NodSpacing.md),
          ],
          FilledButton(
            onPressed: busy ? null : save,
            child: Text(busy ? 'Saving' : 'Save'),
          ),
        ],
      ),
    ),
  );
}

Future<bool> editSettings(BuildContext context, SettingsEditPage page) async =>
    await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => page),
    ) ??
    false;
