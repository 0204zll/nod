import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/prepared_repository.dart';
import '../../core/api_transport.dart';
import '../../core/prepared.dart';
import '../../design_system/design_system.dart';
import '../tasks/task_text.dart';

class NodPreparedPage extends StatefulWidget {
  const NodPreparedPage({required this.transport, this.issueId, super.key});
  final NodApiTransport transport;
  final String? issueId;

  @override
  State<NodPreparedPage> createState() => _NodPreparedPageState();
}

class _NodPreparedPageState extends State<NodPreparedPage>
    with WidgetsBindingObserver {
  late final _repository = NodPreparedRepository(widget.transport);
  NodPreparedWork? _work;
  List<NodPreparedFinding>? _findings;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _work = null;
      _error = null;
    });
    try {
      if (widget.issueId case final String id) {
        final work = await _repository.load(id);
        if (mounted) setState(() => _work = work);
      } else {
        final findings = await _repository.recentFindings();
        if (mounted) setState(() => _findings = findings);
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _work = null;
          _findings = null;
          _error = 'This prepared work is unavailable. Its source may have been removed or replaced, or the connection may be unavailable.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openSource(NodPreparedSource source) async {
    if (_loading || source.externalUri == null) return;
    setState(() => _loading = true);
    try {
      final work = await _repository.load(widget.issueId!);
      final current = work.sources.where(
        (item) =>
            item.sourceId == source.sourceId &&
            item.id == source.id &&
            item.version == source.version &&
            item.url == source.url,
      );
      if (!mounted) return;
      setState(() => _work = work);
      if (current.isEmpty) throw StateError('Source changed');
      final opened = await launchUrl(
        current.first.externalUri!,
        mode: LaunchMode.externalApplication,
      );
      if (!opened) throw StateError('Could not open source');
    } catch (_) {
      if (mounted) {
        setState(() {
          _work = null;
          _error = 'This source could not be opened. Refresh to check whether the saved result is still available.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final work = _work;
    final theme = Theme.of(context);
    final colors = context.nodColors;
    final secondary = theme.textTheme.bodyMedium?.copyWith(
      color: colors.textSecondary,
    );
    return Scaffold(
      appBar: NodPageBar(
        title: widget.issueId == null ? 'Prepared' : 'Prepared work',
        busy: _loading,
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: NodPageBody(
        onRefresh: _load,
        children: [
          if (_error != null) ...[
            NodNotice(_error!, tone: NodTone.error),
            const SizedBox(height: NodSpacing.md),
          ],
          if (widget.issueId == null) ...[
            Text(
              'Findings from recent chat. Older findings remain available through their original messages.',
              style: secondary,
            ),
            const SizedBox(height: NodSpacing.md),
            if (_findings?.isEmpty == true)
              const NodEmptyState(
                icon: Icons.drafts_outlined,
                title: 'No prepared findings in recent chat',
                message: 'When Nod prepares work for you, its finding appears here with the saved result.',
              ),
            if (_findings?.isNotEmpty == true)
              NodGroup(
                children: [
                  for (final finding in _findings!)
                    ListTile(
                      title: Text(
                        _findingTitle(finding.text),
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push<void>(
                        MaterialPageRoute(
                          builder: (_) => NodPreparedPage(
                            transport: widget.transport,
                            issueId: finding.id,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
          ],
          if (work != null) ...[
            Text(work.title, style: theme.textTheme.headlineSmall),
            const SizedBox(height: NodSpacing.xs),
            Text(
              'Last updated ${nodTimestamp(context, work.updatedAt)}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.mutedForeground,
              ),
            ),
            if (work.state == 'resolved') ...[
              const SizedBox(height: NodSpacing.md),
              const NodNotice(
                'This matter is resolved.',
                tone: NodTone.success,
              ),
            ],
            if (work.state == 'dismissed') ...[
              const SizedBox(height: NodSpacing.md),
              const NodNotice('You dismissed this matter.'),
            ],
            const SizedBox(height: NodSpacing.md),
            TaskText(text: work.draft, transport: widget.transport),
            if (work.unknowns.isNotEmpty) ...[
              const SizedBox(height: NodSpacing.lg),
              Text('Needs checking', style: theme.textTheme.titleMedium),
              const SizedBox(height: NodSpacing.xs),
              for (final unknown in work.unknowns) SelectableText('• $unknown'),
            ],
            const SizedBox(height: NodSpacing.lg),
            Text('Sources', style: theme.textTheme.titleMedium),
            const SizedBox(height: NodSpacing.xs),
            if (work.sources.isNotEmpty)
              NodGroup(
                children: [
                  for (final source in work.sources)
                    ListTile(
                      title: Text(source.label),
                      subtitle: Text(
                        'Checked ${nodTimestamp(context, source.checkedAt)}',
                      ),
                      trailing: source.externalUri == null
                          ? null
                          : const Icon(Icons.open_in_new, size: 20),
                      onTap: _loading || source.externalUri == null
                          ? null
                          : () => _openSource(source),
                    ),
                ],
              ),
          ],
        ],
      ),
    );
  }
}

String _findingTitle(String text) {
  final title = text
      .replaceAll(RegExp(r'\s*\[[^\]]*\]\(/prepared/[^)]*\)'), '')
      .trim();
  return title.isEmpty ? text : title;
}
