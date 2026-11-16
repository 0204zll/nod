import 'package:flutter/material.dart';

import 'nod_app_shell.dart';
import 'nod_tokens.dart';

enum NodTone { neutral, info, success, warning, error }

({Color soft, Color strong}) _tone(BuildContext context, NodTone tone) {
  final colors = context.nodColors;
  final scheme = Theme.of(context).colorScheme;
  return switch (tone) {
    NodTone.neutral => (
      soft: colors.surfaceInset,
      strong: colors.textSecondary,
    ),
    NodTone.info => (soft: colors.infoSoft, strong: colors.info),
    NodTone.success => (soft: colors.successSoft, strong: colors.success),
    NodTone.warning => (soft: colors.warningSoft, strong: colors.warning),
    NodTone.error => (
      soft: scheme.errorContainer,
      strong: scheme.onErrorContainer,
    ),
  };
}

String nodDateTime(BuildContext context, DateTime date) {
  final local = date.toLocal();
  final material = MaterialLocalizations.of(context);
  return '${material.formatMediumDate(local)} · ${material.formatTimeOfDay(TimeOfDay.fromDateTime(local), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
}

String nodTimestamp(BuildContext context, String value) {
  final date = DateTime.tryParse(value);
  return date == null ? value : nodDateTime(context, date);
}

class NodProgressLine extends StatelessWidget implements PreferredSizeWidget {
  const NodProgressLine({super.key, required this.active});

  final bool active;

  @override
  Size get preferredSize => const Size.fromHeight(2);

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 2,
    child: active ? const LinearProgressIndicator(minHeight: 2) : null,
  );
}

class NodPageBar extends StatelessWidget implements PreferredSizeWidget {
  const NodPageBar({
    super.key,
    required this.title,
    this.actions = const [],
    this.busy = false,
  });

  final String title;
  final List<Widget> actions;
  final bool busy;

  @override
  Size get preferredSize => const Size.fromHeight(NodSizes.appBar + 2);

  @override
  Widget build(BuildContext context) {
    final shell = NodShellScope.maybeOf(context);
    final back = shell?.onBack;
    final docked = shell != null && back == null;
    return AppBar(
      automaticallyImplyLeading: shell == null,
      leading: back == null
          ? null
          : IconButton(
              key: const Key('back-to-chat'),
              tooltip: 'Back to chat',
              icon: const BackButtonIcon(),
              onPressed: back,
            ),
      titleSpacing: docked ? NodSpacing.lg : null,
      title: Text(title),
      actions: [
        ...actions,
        const SizedBox(width: NodSpacing.xxs),
      ],
      bottom: NodProgressLine(active: busy),
      shape: docked
          ? Border(bottom: BorderSide(color: context.nodColors.border))
          : null,
    );
  }
}

class NodPageBody extends StatelessWidget {
  const NodPageBody({
    super.key,
    required this.children,
    this.onRefresh,
    this.listKey,
    this.spacing = 0,
  });

  final List<Widget> children;
  final Future<void> Function()? onRefresh;
  final Key? listKey;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    final list = LayoutBuilder(
      builder: (context, constraints) {
        final gutter = constraints.maxWidth < NodBreakpoints.compact
            ? NodSpacing.md
            : NodSpacing.lg;
        return ListView(
          key: listKey,
          physics: const AlwaysScrollableScrollPhysics(),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: EdgeInsets.fromLTRB(gutter, gutter, gutter, NodSpacing.xl),
          children: [
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: NodSizes.page),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  spacing: spacing,
                  children: children,
                ),
              ),
            ),
          ],
        );
      },
    );
    return onRefresh == null
        ? list
        : RefreshIndicator(onRefresh: onRefresh!, child: list);
  }
}

class NodGroup extends StatelessWidget {
  const NodGroup({super.key, this.title, this.footer, required this.children});

  final String? title;
  final String? footer;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NodSpacing.md,
              0,
              NodSpacing.md,
              NodSpacing.xs,
            ),
            child: Semantics(
              header: true,
              child: Text(
                title!,
                style: text.titleSmall?.copyWith(color: colors.textSecondary),
              ),
            ),
          ),
        Material(
          clipBehavior: Clip.antiAlias,
          color: colors.surfaceOverlay,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(NodRadii.card),
            side: BorderSide(color: colors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < children.length; index++) ...[
                if (index > 0)
                  Divider(
                    height: 1,
                    indent: NodSpacing.md,
                    color: Theme.of(context).colorScheme.outlineVariant,
                  ),
                children[index],
              ],
            ],
          ),
        ),
        if (footer != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NodSpacing.md,
              NodSpacing.xs,
              NodSpacing.md,
              0,
            ),
            child: Text(
              footer!,
              style: text.bodySmall?.copyWith(color: colors.mutedForeground),
            ),
          ),
      ],
    );
  }
}

class NodNotice extends StatelessWidget {
  const NodNotice(
    this.message, {
    super.key,
    this.title,
    this.tone = NodTone.neutral,
  });

  final String message;
  final String? title;
  final NodTone tone;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final (:soft, :strong) = _tone(context, tone);
    return Semantics(
      container: true,
      liveRegion: tone == NodTone.error || tone == NodTone.success,
      child: Container(
        padding: const EdgeInsets.all(NodSpacing.md),
        decoration: BoxDecoration(
          color: tone == NodTone.neutral
              ? context.nodColors.surfaceSubtle
              : soft,
          borderRadius: BorderRadius.circular(NodRadii.card),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              switch (tone) {
                NodTone.error => Icons.error_outline_rounded,
                NodTone.warning => Icons.warning_amber_rounded,
                NodTone.success => Icons.check_circle_outline_rounded,
                _ => Icons.info_outline_rounded,
              },
              size: 20,
              color: strong,
            ),
            const SizedBox(width: NodSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title != null) ...[
                    Text(
                      title!,
                      style: text.titleSmall?.copyWith(color: strong),
                    ),
                    const SizedBox(height: NodSpacing.xxs),
                  ],
                  Text(
                    message,
                    style: text.bodyMedium?.copyWith(color: strong),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class NodStatusLabel extends StatelessWidget {
  const NodStatusLabel(this.label, {super.key, this.tone = NodTone.neutral});

  final String label;
  final NodTone tone;

  @override
  Widget build(BuildContext context) {
    final (:soft, :strong) = _tone(context, tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: soft,
        borderRadius: BorderRadius.circular(NodRadii.control),
      ),
      child: Text(
        label,
        softWrap: false,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(color: strong, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class NodEmptyState extends StatelessWidget {
  const NodEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: NodSpacing.lg,
        vertical: NodSpacing.xl,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceSubtle,
        borderRadius: BorderRadius.circular(NodRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 32, color: colors.textSecondary),
          const SizedBox(height: NodSpacing.md),
          Text(title, style: text.titleMedium),
          const SizedBox(height: NodSpacing.xs),
          Text(
            message,
            style: text.bodyMedium?.copyWith(color: colors.textSecondary),
          ),
        ],
      ),
    );
  }
}
