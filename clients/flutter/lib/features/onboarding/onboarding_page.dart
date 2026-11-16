import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/onboarding_repository.dart';
import '../../api/settings_repository.dart';
import '../../core/api_transport.dart';
import '../../core/onboarding.dart';
import '../../core/settings.dart';
import '../../design_system/design_system.dart';
import '../connections/connections_page.dart';
import '../settings/model_settings_page.dart';
import '../settings/settings_widgets.dart';

class NodMobileOnboarding extends StatefulWidget {
  const NodMobileOnboarding({
    super.key,
    required this.transport,
    required this.onComplete,
  });
  final NodApiTransport transport;
  final VoidCallback onComplete;
  @override
  State<NodMobileOnboarding> createState() => _NodMobileOnboardingState();
}

class _NodMobileOnboardingState extends State<NodMobileOnboarding>
    with WidgetsBindingObserver {
  late final repository = NodOnboardingRepository(widget.transport);
  late final settings = NodSettingsRepository(widget.transport);
  final roleText = TextEditingController();
  final jobsText = TextEditingController();
  final email = TextEditingController();
  final roles = <String>{};
  final jobs = <String>{};
  String? scope;
  String? whoFor;
  String? size;
  Map<String, Object?>? session;
  String? owner;
  int step = 0;
  bool busy = false;
  bool loading = true;
  bool consent = false;
  bool subscribed = false;
  bool ready = false;
  bool preparationFailed = false;
  bool profileFailed = false;
  String? error;
  Future<void>? preparation;

  bool get business =>
      roles.any(const ['owner', 'freelance', 'agency'].contains);
  bool get usage => settingsMap(session!['settings'])['usageData'] == true;
  bool capability(String name) =>
      settingsMap(session!['capabilities'])[name] == true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(reload());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    roleText.dispose();
    jobsText.dispose();
    email.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !busy) unawaited(reload());
  }

  Future<void> reload() async {
    try {
      final current = await repository.session();
      final currentOwner = settingsText(settingsMap(current['user']), 'id');
      final modelReady = nodOnboardingModelReady(await settings.models());
      if (!mounted) return;
      if (owner != null && owner != currentOwner) {
        roleText.clear();
        jobsText.clear();
        email.clear();
        roles.clear();
        jobs.clear();
        scope = whoFor = size = null;
        step = 0;
        consent = subscribed = false;
        preparation = null;
      }
      setState(() {
        owner = currentOwner;
        session = current;
        ready = modelReady;
        loading = false;
        error = null;
      });
      if (settingsMap(current['settings'])['onboardingCompleted'] == true) {
        widget.onComplete();
      }
    } catch (cause) {
      if (mounted) {
        setState(() {
          loading = false;
          error = settingsError(cause);
        });
      }
    }
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final current = await repository.session();
      if (settingsText(settingsMap(current['user']), 'id') != owner) {
        await reload();
        return;
      }
      session = current;
      await action();
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> prepare() async {
    try {
      await repository.prepare();
      preparationFailed = false;
    } catch (_) {
      preparationFailed = true;
    }
  }

  void next() {
    if (!mounted) return;
    setState(() {
      step++;
      error = null;
    });
  }

  Future<void> afterProfile({required bool save}) async {
    if (save) {
      profileFailed = true;
      await repository.saveProfile({
        if (scope != null) 'scope': scope,
        'roles': roles.toList(),
        if (roleText.text.trim().isNotEmpty) 'roleText': roleText.text.trim(),
        if (business && whoFor != null) 'whoFor': whoFor,
        if (scope != 'personal' && size != null) 'companySize': size,
        'jobs': jobs.toList(),
        if (jobsText.text.trim().isNotEmpty) 'jobsText': jobsText.text.trim(),
      });
      profileFailed = false;
    }
    unawaited(repository.discoverIdeas().catchError((_) {}));
    ready = nodOnboardingModelReady(await settings.models());
    next();
    if (ready) next();
  }

  Future<void> finish({bool skipEmail = false}) async {
    if (!skipEmail &&
        !subscribed &&
        capability('updatesEmail') &&
        usage &&
        email.text.trim().isNotEmpty) {
      if (!consent) throw const FormatException();
      await repository.subscribe(email.text, consent: consent);
      subscribed = true;
    }
    if (preparation == null || preparationFailed) preparation = prepare();
    await preparation;
    if (preparationFailed) throw const FormatException();
    ready = nodOnboardingModelReady(await settings.models());
    if (!ready) {
      if (mounted) setState(() => step = 3);
      return;
    }
    await repository.complete();
    if (mounted) widget.onComplete();
  }

  Future<void> open(Widget page) async {
    await Navigator.of(context)
        .push<void>(MaterialPageRoute(builder: (_) => page));
    if (mounted) await reload();
  }

  Widget button(
    String label,
    Future<void> Function() action, {
    bool primary = true,
  }) => primary
      ? FilledButton(
          onPressed: busy ? null : () => run(action),
          child: Text(label),
        )
      : OutlinedButton(
          onPressed: busy ? null : () => run(action),
          child: Text(label),
        );

  Widget heading(String text) => Semantics(
    header: true,
    child: Text(text, style: Theme.of(context).textTheme.headlineSmall),
  );

  Widget note(String text) => Text(
    text,
    style: Theme.of(context).textTheme.bodyLarge
        ?.copyWith(color: context.nodColors.textSecondary),
  );

  Widget choices(
    String title,
    Map<String, String> options,
    String? value,
    ValueChanged<String?> change,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: NodSpacing.xxs),
      Wrap(
        spacing: 8,
        children: [
          for (final option in options.entries)
            ChoiceChip(
              label: Text(option.value),
              selected: value == option.key,
              onSelected: (selected) =>
                  setState(() => change(selected ? option.key : null)),
            ),
        ],
      ),
    ],
  );

  Widget multiple(
    String title,
    Map<String, String> options,
    Set<String> values,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: NodSpacing.xxs),
      Wrap(
        spacing: 8,
        children: [
          for (final option in options.entries)
            FilterChip(
              label: Text(option.value),
              selected: values.contains(option.key),
              onSelected: (selected) => setState(() {
                selected ? values.add(option.key) : values.remove(option.key);
              }),
            ),
        ],
      ),
    ],
  );

  List<Widget> content() => switch (step) {
    0 => [
      heading('Welcome to Nod'),
      note(
        'Your assistant runs on your paired server. It checks connected apps in the background with your model, which counts as model usage. It asks before actions your words do not cover. Never enter passwords, codes, cards or API keys in chat.',
      ),
      CheckboxListTile(
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        title: const Text('Share usage data'),
        subtitle: const Text(
          'Basic usage and fixed About you choices, never your messages or screen recordings.',
        ),
        value: usage,
        onChanged: (value) => run(() async {
          session = await settings.saveAccount({'usageData': value});
        }),
      ),
      button('Get started', () async {
        preparation ??= prepare();
        next();
      }),
    ],
    1 => [
      heading('Connect email (optional)'),
      note(
        'Connect Gmail or Outlook to help Nod suggest useful first tasks. Google or Microsoft may ask you to allow Composio. You can connect other apps here too.',
      ),
      button(
        'Connect apps',
        () => open(NodConnectionsPage(transport: widget.transport)),
        primary: false,
      ),
      button('Continue', () async => next()),
      TextButton(
        onPressed: busy ? null : next,
        child: const Text('Skip for now'),
      ),
    ],
    2 => [
      heading('About you (optional)'),
      note(
        'Answers become one memory note when memory is on. Do not include secrets.${usage ? ' Fixed choices are also shared with the Nod team and saved on this installation’s usage profile. Your typed answers are not analytics.' : ''}',
      ),
      choices('Where would you like help?', nodProfileScopes, scope, (value) {
        scope = value;
        if (value != 'personal') roles.removeAll(['student', 'not_working']);
        if (value == 'personal') size = null;
      }),
      multiple('What do you do?', {
        for (final entry in nodProfileRoles.entries)
          if (scope == 'personal' ||
              !['student', 'not_working'].contains(entry.key))
            entry.key: entry.value,
      }, roles),
      TextField(
        controller: roleText,
        maxLength: 200,
        decoration: const InputDecoration(
          labelText: 'Something else about your role',
        ),
      ),
      if (business)
        choices(
          'Who is the help for?',
          nodProfileWhoFor,
          whoFor,
          (value) => whoFor = value,
        ),
      if (scope != 'personal')
        choices('Company size', nodProfileSizes, size, (value) => size = value),
      multiple('What would you like off your plate?', nodProfileJobs, jobs),
      TextField(
        controller: jobsText,
        maxLength: 200,
        decoration: const InputDecoration(
          labelText: 'Something else to take off your plate',
        ),
      ),
      button('Save and continue', () => afterProfile(save: true)),
      TextButton(
        onPressed: busy ? null : () => run(() => afterProfile(save: false)),
        child: Text(
          profileFailed ? 'Continue without retrying' : 'Skip for now',
        ),
      ),
    ],
    3 => [
      heading('Connect a model'),
      note(
        'Choose the provider your paired server will use. Keys go directly to its private configuration, never chat.',
      ),
      button(
        'Models',
        () => open(NodModelSettingsPage(repository: settings)),
        primary: false,
      ),
      button('Check and continue', () async {
        ready = nodOnboardingModelReady(await settings.models());
        if (!ready) throw const FormatException();
        next();
      }),
    ],
    4 => [
      heading('Help improve Nod'),
      if (capability('traces')) ...[
        note(
          'Conversation traces include your messages and what Nod reads and does. Recognized personal details are removed first. Traces are pseudonymised, not anonymous, kept 14 days and never used to train AI.',
        ),
        button('Share traces', () async {
          await settings.saveAccount({'traces': true});
          next();
        }),
        button('Not now', () async {
          await settings.saveAccount({'traces': false});
          next();
        }, primary: false),
      ] else ...[
        note('Conversation traces are not available on this server.'),
        button('Continue', () async => next()),
      ],
      Text(
        usage
            ? 'Basic usage sharing is on. Change it in Settings → Privacy & data.'
            : 'Basic usage sharing is off.',
        style: Theme.of(context).textTheme.bodyMedium
            ?.copyWith(color: context.nodColors.mutedForeground),
      ),
    ],
    _ => [
      heading('Join us (optional)'),
      if (capability('updatesEmail') && usage) ...[
        TextField(
          controller: email,
          maxLength: 254,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: 'Email address for updates',
          ),
        ),
        CheckboxListTile(
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: consent,
          onChanged: busy
              ? null
              : (value) => setState(() => consent = value ?? false),
          title: const Text(
            'I agree that n8n GmbH links my email to my Nod usage data and emails me about Nod and other n8n products.',
          ),
          subtitle: const Text(
            'Withdraw via the unsubscribe link in every email or privacy@n8n.io. Submitting sends no email immediately.',
          ),
        ),
      ],
      Wrap(
        alignment: WrapAlignment.center,
        children: [
          for (final link in {
            'Discord': 'https://discord.gg/n8n',
            'Forum': 'https://community.n8n.io/c/n8n-labs/48',
          }.entries)
            TextButton.icon(
              onPressed: () => launchUrl(
                Uri.parse(link.value),
                mode: LaunchMode.externalApplication,
              ),
              icon: const Icon(Icons.open_in_new, size: 18),
              label: Text(link.key),
            ),
        ],
      ),
      button('Start chatting', finish),
      TextButton(
        onPressed: busy ? null : () => run(() => finish(skipEmail: true)),
        child: const Text('Continue without email'),
      ),
    ],
  };

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      titleSpacing: step > 0 && !busy ? null : NodSpacing.md,
      title: const Text('Set up Nod'),
      leading: step > 0 && !busy
          ? BackButton(
              onPressed: () => setState(() {
                step -= step == 4 && ready ? 2 : 1;
              }),
            )
          : null,
      bottom: NodProgressLine(active: busy),
    ),
    body: SafeArea(
      child: loading
          ? const Center(child: CircularProgressIndicator())
          : NodPageBody(
              spacing: NodSpacing.md,
              children: [
                if (error != null) NodNotice(error!, tone: NodTone.error),
                if (session == null)
                  button('Try again', reload)
                else
                  AbsorbPointer(
                    absorbing: busy,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      spacing: NodSpacing.md,
                      children: [
                        ...content(),
                        Wrap(
                          alignment: WrapAlignment.center,
                          children: [
                            TextButton(
                              onPressed: () => launchUrl(
                                Uri.parse('https://n8n.io/legal/privacy/'),
                                mode: LaunchMode.externalApplication,
                              ),
                              child: const Text('Privacy policy'),
                            ),
                            TextButton(
                              onPressed: () => launchUrl(
                                Uri.parse(
                                  'https://n8n.io/legal/nod-terms-of-use/',
                                ),
                                mode: LaunchMode.externalApplication,
                              ),
                              child: const Text('Terms of use'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    ),
  );
}
