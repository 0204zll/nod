import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../api/private_requests_repository.dart';
import '../../core/api_transport.dart';
import '../../core/private_requests.dart';
import '../../design_system/design_system.dart';
import 'private_browser.dart';

class NodPrivateRequestsPage extends StatefulWidget {
  const NodPrivateRequestsPage({
    super.key,
    required this.transport,
    this.initialRequest,
  });

  final NodApiTransport transport;
  final NodPrivateRequestRef? initialRequest;

  @override
  State<NodPrivateRequestsPage> createState() => _NodPrivateRequestsPageState();
}

class _NodPrivateRequestsPageState extends State<NodPrivateRequestsPage>
    with WidgetsBindingObserver {
  late final NodPrivateRequestsRepository _repository;
  List<NodPrivateRequestRef>? _requests;
  String? _error;
  Timer? _timer;
  bool _refreshing = false;
  bool _active = true;

  @override
  void initState() {
    super.initState();
    _repository = NodPrivateRequestsRepository(widget.transport);
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
    _refresh();
    final initial = widget.initialRequest;
    if (initial != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _open(initial));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (_active) _refresh();
  }

  Future<void> _refresh() async {
    if (_refreshing || !_active) return;
    _refreshing = true;
    try {
      final requests = await _repository.list();
      if (mounted) {
        setState(() {
          _requests = requests;
          _error = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Private requests could not be refreshed.');
      }
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _open(NodPrivateRequestRef ref) async {
    if (!mounted || !ref.isValid) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => ref.kind == NodPrivateRequestKind.browser
            ? NodPrivateBrowser(repository: _repository, turnId: ref.id)
            : NodPrivateEntry(repository: _repository, request: ref),
      ),
    );
    await _refresh();
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: NodPageBar(
      title: 'Private requests',
      actions: [
        IconButton(
          onPressed: _refresh,
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh requests',
        ),
      ],
    ),
    body: NodPageBody(
      children: [
        Text(
          'Passwords, verification codes, and payment approvals go directly to your Nod server, never through chat.',
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: context.nodColors.textSecondary),
        ),
        const SizedBox(height: NodSpacing.md),
        if (_error != null) ...[
          NodNotice(_error!, tone: NodTone.error),
          const SizedBox(height: NodSpacing.md),
        ],
        if (_requests == null && _error == null)
          const LinearProgressIndicator(),
        if (_requests?.isEmpty == true)
          const NodEmptyState(
            icon: Icons.lock_outline,
            title: 'No private requests in this conversation',
            message: 'When a task needs a sign-in, a verification code, or a payment approval, its request opens here.',
          ),
        if (_requests?.isNotEmpty == true)
          NodGroup(
            children: [
              for (final ref in _requests!)
                ListTile(
                  leading: Icon(
                    ref.kind == NodPrivateRequestKind.browser
                        ? Icons.web
                        : Icons.lock_outline,
                  ),
                  title: Text(ref.title),
                  subtitle: const Text(
                    'Open to check the current request and website',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(ref),
                ),
            ],
          ),
      ],
    ),
  );
}

class NodPrivateEntry extends StatefulWidget {
  const NodPrivateEntry({
    super.key,
    required this.repository,
    required this.request,
  });

  final NodPrivateRequestsRepository repository;
  final NodPrivateRequestRef request;

  @override
  State<NodPrivateEntry> createState() => _NodPrivateEntryState();
}

class _NodPrivateEntryState extends State<NodPrivateEntry>
    with WidgetsBindingObserver {
  late NodPrivateRequestRef _ref;
  NodPrivateDetails? _details;
  final _username = TextEditingController();
  final _secret = TextEditingController();
  final _form = GlobalKey<FormState>();
  Timer? _timer;
  bool _busy = false;
  bool _reading = false;
  bool _active = true;
  bool _newLogin = false;
  bool _retrying = false;
  String? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _ref = widget.request;
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
    _refresh();
  }

  void _clear() {
    _username.clear();
    _secret.clear();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (!_active) {
      _clear();
      _generation++;
    } else {
      _refresh();
    }
    if (mounted) setState(() {});
  }

  Future<void> _refresh() async {
    if (_busy || _reading || !_active) return;
    _reading = true;
    final generation = _generation;
    try {
      final details = await widget.repository.read(_ref);
      final next = await widget.repository.next(details, afterRetry: _retrying);
      if (!mounted || generation != _generation) return;
      if (next != null) {
        _clear();
        setState(() {
          _ref = next;
          _details = null;
          _newLogin = false;
          _retrying = false;
          _error = null;
          _generation++;
        });
      } else {
        if (_details == null && details.data['username'] is String) {
          _username.text = details.data['username']! as String;
        }
        if (!details.pending) _clear();
        setState(() {
          _details = details;
          _error = null;
        });
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        _clear();
        setState(() {
          _details = null;
          _error = 'This private request is unavailable. Return to the conversation to check the task.';
        });
      }
    } finally {
      _reading = false;
    }
    if (mounted && _details == null && _error == null && _active) {
      await _refresh();
    }
  }

  Future<void> _submit(
    Map<String, Object?> values, {
    String suffix = '',
  }) async {
    final details = _details;
    if (_busy || details == null || !_active) {
      values.clear();
      return;
    }
    _generation++;
    _clear();
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final next = await widget.repository.submit(
        details,
        values,
        suffix: suffix,
      );
      if (!mounted) return;
      if (next != null) {
        setState(() {
          _ref = next;
          _details = null;
          _newLogin = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'The result was not confirmed. Check the task before another attempt.',
        );
      }
    } finally {
      values.clear();
      if (mounted) setState(() => _busy = false);
    }
    await _refresh();
  }

  Future<void> _freshStep() async {
    if (_busy || _retrying) return;
    setState(() {
      _busy = true;
      _retrying = true;
    });
    try {
      await widget.repository.requestFreshStep(_ref);
    } catch (_) {
      if (mounted) {
        setState(() {
          _retrying = false;
          _error = 'A fresh sign-in step could not be requested. Check the task in your conversation.';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _refresh();
  }

  Future<void> _managed() async {
    final details = _details;
    if (details == null || _busy) return;
    final manager = privateObject(details.data['passwordManager']);
    var accountName = manager['account'] as String? ?? '';
    final account = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('${manager['name']} account on the Nod server'),
        content: TextFormField(
          initialValue: accountName,
          onChanged: (value) => accountName = value,
          decoration: const InputDecoration(labelText: 'Account name'),
          maxLength: 200,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, accountName.trim()),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    if (!mounted || account == null || account.isEmpty || !_active) return;
    setState(() => _busy = true);
    List<Map<String, Object?>>? logins;
    try {
      logins = await widget.repository.managedLogins(details, account);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'The server could not open the password manager. Check approval on the computer running Nod.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted || !_active || logins == null) return;
    final entries = logins;
    final selected = await showModalBottomSheet<String>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(title: Text('Choose a login for ${details.origin}')),
            if (entries.isEmpty)
              const ListTile(title: Text('No matching logins.')),
            for (final login in entries)
              ListTile(
                title: Text(login['title']! as String),
                subtitle: Text(login['username']! as String),
                onTap: () =>
                    Navigator.pop(sheetContext, login['id']! as String),
              ),
          ],
        ),
      ),
    );
    if (!mounted ||
        !_active ||
        selected == null ||
        _ref.id != details.ref.id ||
        _details?.origin != details.origin) {
      return;
    }
    await _submit({
      'account': account,
      'id': selected,
    }, suffix: '/password-manager/use');
  }

  void _submitForm() {
    if (!(_form.currentState?.validate() ?? false)) return;
    final details = _details!;
    final values = <String, Object?>{};
    if (details.payment || details.kind == 'otp') {
      values['code'] = _secret.text;
    } else {
      values['username'] = _username.text;
      if (details.kind == 'password') values['password'] = _secret.text;
    }
    _submit(values);
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _clear();
    _username.dispose();
    _secret.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final details = _details;
    final attempted = widget.repository.wasSubmitted(_ref);
    final enabled = _active && !_busy && details?.pending == true && !attempted;
    final chooseSaved =
        details != null &&
        details.savedEntries.isNotEmpty &&
        !_newLogin &&
        details.kind != 'otp';
    final theme = Theme.of(context);
    final colors = context.nodColors;
    return Scaffold(
      appBar: AppBar(
        title: Text(_ref.title),
        bottom: NodProgressLine(
          active: details == null && _error == null || _busy,
        ),
      ),
      body: NodPageBody(
        spacing: NodSpacing.md,
        children: [
          if (_error != null) NodNotice(_error!, tone: NodTone.error),
          if (details != null) ...[
            Text(details.origin, style: theme.textTheme.titleLarge),
            if (!_active)
              const NodNotice('Return to the app to check this request.'),
            if (!details.pending || attempted)
              NodNotice(
                _status(details, attempted),
                tone: switch (details.status) {
                  'filled' || 'submitted' => NodTone.success,
                  'expired' || 'uncertain' => NodTone.warning,
                  _ => NodTone.neutral,
                },
              ),
            if (_retrying)
              const NodNotice(
                'Waiting for a fresh sign-in step from the same task.',
              ),
            if (!details.payment &&
                !_busy &&
                !_retrying &&
                _active &&
                ['uncertain', 'expired'].contains(details.status))
              OutlinedButton(
                onPressed: _freshStep,
                child: const Text('Request a fresh sign-in step'),
              ),
            if (enabled && details.data['passwordManager'] != null)
              OutlinedButton(
                onPressed: _managed,
                child: Text(
                  'Use ${privateObject(details.data['passwordManager'])['name']} on the Nod server',
                ),
              ),
            if (enabled) ...[
              if (details.payment)
                NodNotice(
                  'Card details go to ${(details.data['destinations'] as List? ?? []).join(' and ')}.',
                  title:
                      '${details.data['amount']} at ${details.origin} with ${details.data['card']}',
                ),
              if (details.kind == 'method')
                for (final method in details.methods)
                  OutlinedButton(
                    onPressed: () =>
                        _submit({'methodId': method['id']}, suffix: '/method'),
                    child: Text(method['label']! as String),
                  )
              else if (chooseSaved) ...[
                for (final entry in details.savedEntries)
                  OutlinedButton(
                    onPressed: () =>
                        _submit({'entryId': entry['id']}, suffix: '/saved'),
                    child: Text('${entry['label']} · ${entry['username']}'),
                  ),
                TextButton(
                  onPressed: () => setState(() => _newLogin = true),
                  child: const Text('Use another login'),
                ),
              ] else
                Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    spacing: NodSpacing.xs,
                    children: [
                      if (!details.payment && details.kind != 'otp')
                        TextFormField(
                          controller: _username,
                          decoration: InputDecoration(
                            labelText: details.fieldLabel(
                              'identifier',
                              'Username or email',
                            ),
                          ),
                          autocorrect: false,
                          enableSuggestions: false,
                          maxLength: 320,
                          validator: (value) => value == null || value.isEmpty
                              ? 'Enter your username or email.'
                              : null,
                        ),
                      if (details.payment ||
                          details.kind == 'otp' ||
                          details.kind == 'password')
                        TextFormField(
                          controller: _secret,
                          obscureText: true,
                          enableSuggestions: false,
                          autocorrect: false,
                          keyboardType: details.payment
                              ? TextInputType.number
                              : TextInputType.visiblePassword,
                          inputFormatters: details.payment
                              ? [FilteringTextInputFormatter.digitsOnly]
                              : null,
                          maxLength: details.payment
                              ? 4
                              : details.kind == 'otp'
                              ? 100
                              : 8192,
                          decoration: InputDecoration(
                            labelText: details.payment
                                ? 'Security code'
                                : details.fieldLabel(
                                    details.kind == 'otp' ? 'otp' : 'password',
                                    details.kind == 'otp'
                                        ? 'Verification code'
                                        : 'Password',
                                  ),
                          ),
                          validator: (value) => details.payment
                              ? RegExp(r'^\d{3,4}$').hasMatch(value ?? '')
                                    ? null
                                    : 'Enter the card security code.'
                              : value == null || value.isEmpty
                              ? 'Enter the requested value.'
                              : null,
                          onFieldSubmitted: (_) => _submitForm(),
                        ),
                      FilledButton(
                        onPressed: _submitForm,
                        child: Text(
                          details.payment
                              ? 'Pay ${details.data['amount']}'
                              : details.kind == 'otp'
                              ? 'Continue'
                              : 'Save and continue',
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ],
          const Divider(height: NodSpacing.md),
          Text(
            'Closing clears unsent values. It does not cancel an entry already submitted. Use Stop on the owning task to stop its work.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.mutedForeground,
            ),
          ),
          TextButton(
            onPressed: () {
              _clear();
              Navigator.of(context).pop();
            },
            child: const Text('Back to conversation'),
          ),
        ],
      ),
    );
  }

  String _status(
    NodPrivateDetails details,
    bool attempted,
  ) => switch (details.status) {
    'filled' => 'Details submitted. Nod will continue the same task.',
    'submitted' =>
      'Card submitted, not a payment confirmation. Nod will check the order.',
    'entering' => 'Private entry is in progress. Do not submit again.',
    'expired' => 'This request is expired or replaced. Return to the conversation for the latest step.',
    'uncertain' =>
      'The result is unknown. Ask Nod to check before another attempt.',
    _ =>
      attempted
          ? 'Submission attempted. Check the task before another attempt.'
          : 'This request is unavailable.',
  };
}
