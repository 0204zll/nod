import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/settings_repository.dart';
import '../../core/api_transport.dart';
import '../../core/settings.dart';
import '../../design_system/design_system.dart';
import '../settings/settings_widgets.dart';

class NodNotificationSettingsPage extends StatefulWidget {
  const NodNotificationSettingsPage({super.key, required this.transport});
  final NodApiTransport transport;
  @override
  State<NodNotificationSettingsPage> createState() =>
      _NodNotificationSettingsPageState();
}

class _NodNotificationSettingsPageState
    extends State<NodNotificationSettingsPage>
    with WidgetsBindingObserver {
  late final repository = NodSettingsRepository(widget.transport);
  final section = GlobalKey<SettingsSectionState>();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(section.currentState?.reload());
    }
  }

  Future<void> edit(
    SettingsSectionState state,
    Map<String, Object?> data,
    String field,
    String title,
    String help, {
    int? limit,
  }) async {
    if (await editSettings(
      context,
      SettingsEditPage(
        title: title,
        fields: {field: data[field] as String? ?? ''},
        labels: {field: title},
        limits: {field: ?limit},
        multiline: {if (field == 'notificationRule') field},
        help: help,
        save: (values) async {
          final value = values[field]!.trim();
          if ((field == 'quietStart' || field == 'quietEnd') &&
              !RegExp(r'^([01]\d|2[0-3]):[0-5]\d$').hasMatch(value)) {
            throw const FormatException();
          }
          await repository.savePreferences({
            field: field == 'timeZone' && value.isEmpty ? null : value,
          });
        },
      ),
    )) {
      await state.reload();
    }
  }

  @override
  Widget build(BuildContext context) => SettingsSection(
    key: section,
    title: 'Notifications & preparation',
    load: repository.preferences,
    builder: (context, data, state) => NodPageBody(
      children: [
        const NodNotice(
          'This client has no remote push delivery or system permission request. These settings control the paired server, not phone notification permission. Opening the app does not enable alerts or authorize actions.',
          title: 'Phone alerts are not available yet',
        ),
        const SizedBox(height: NodSpacing.lg),
        NodGroup(
          title: 'Preparation',
          children: [
            SwitchListTile(
              title: const Text('Pause preparation'),
              subtitle: const Text(
                'Stops background preparation, Gmail inbox polling, and planned checks of tasks Nod started. Tasks and schedules you started keep running.',
              ),
              value: data['proactivePaused'] == true,
              onChanged: (value) => state.change(
                () => repository.savePreferences({'proactivePaused': value}),
              ),
            ),
            ListTile(
              title: const Text('Notification rule'),
              subtitle: Text(
                (data['notificationRule'] as String?)?.isNotEmpty == true
                    ? data['notificationRule'] as String
                    : 'No standing instruction',
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => edit(
                state,
                data,
                'notificationRule',
                'Notification rule',
                'Nod reads connected apps even without a rule. This is your standing instruction for background work. Outside actions still pass Trust; a rule never authorizes Nod’s own settings. Never enter secrets here.',
                limit: 4000,
              ),
            ),
          ],
        ),
        const SizedBox(height: NodSpacing.lg),
        NodGroup(
          title: 'Quiet hours',
          children: [
            SwitchListTile(
              title: const Text('Quiet hours'),
              subtitle: const Text(
                'Nudges wait until quiet hours end, except high-impact findings with strong evidence and an earlier deadline. Equal start and end times mean no quiet interval.',
              ),
              value: data['quietHoursEnabled'] == true,
              onChanged: (value) => state.change(
                () => repository.savePreferences({'quietHoursEnabled': value}),
              ),
            ),
            for (final entry in {
              'quietStart': 'From',
              'quietEnd': 'Until',
            }.entries)
              ListTile(
                title: Text(entry.value),
                subtitle: Text(settingsText(data, entry.key)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => edit(
                  state,
                  data,
                  entry.key,
                  entry.value,
                  'Use 24-hour HH:mm. Times use the server preference time zone shown below.',
                ),
              ),
            ListTile(
              title: const Text('Time zone'),
              subtitle: Text(
                data['timeZone'] as String? ??
                    'Automatic (server fallback: UTC)',
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => edit(
                state,
                data,
                'timeZone',
                'Time zone',
                'Use an IANA time zone such as Europe/London. Empty uses the server fallback, UTC, not the phone clock.',
              ),
            ),
          ],
        ),
        const SizedBox(height: NodSpacing.lg),
        const NodGroup(
          children: [
            ListTile(
              title: Text('Snooze one finding'),
              subtitle: Text(
                'Reply to its nudge in chat, for example “Remind me tonight”. Snooze belongs to that finding, not a global phone timer. Silence is not dismissal.',
              ),
            ),
          ],
        ),
      ],
    ),
  );
}
