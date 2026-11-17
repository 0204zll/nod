import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { access, chmod, constants, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const answerMs = 30_000;
const ref = /^@[a-z0-9]{6,32}:e\d{1,7}$/;
const windowId = /^[A-Za-z0-9:_-]{1,64}$/;
const appName = /^[^\0\r\n]{1,200}$/;
const keys = /^[a-z0-9+.,\-=/ ]{1,40}$/i;
const needsFocus =
  /focus fallback is denied|no verified focused element|focus could not be confirmed|physical input is disabled|requires --headed|requires focus permission/i;
const pasteRoles = new Set(['scrollarea', 'webarea', 'group', 'document']);
const appSteps = new Set([
  'snapshot',
  'find',
  'screenshot',
  'press',
  'focus',
  'select',
  'set_value',
  'type',
  'key',
]);
const chromiumFrameworks =
  /Electron Framework|Chromium|Chrome Framework|Edge Framework|Brave Browser Framework/i;

function output(file, args) {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout)),
  );
}

export function createComputerHelper({
  binary,
  helper,
  home,
  requestPermission,
  presence,
  ownerIdleSeconds = 1,
  ownerWaitMs = 15_000,
  lingerMs = 2000,
  backgroundLingerMs = 10_000,
}) {
  let queue = Promise.resolve();
  let generation = 0;
  const children = new Set();
  const steps = new AsyncLocalStorage();
  const active = new Map();
  const stopped = () => new Error('STOPPED: Nod stopped, so this step did not run.');
  function alive(started, current) {
    if (
      started !== generation ||
      current?.cancelled ||
      (current?.deadline !== undefined && Date.now() > current.deadline)
    )
      throw stopped();
  }
  function run(args, input) {
    const started = generation;
    const current = steps.getStore();
    const next = queue.then(() => {
      alive(started, current);
      return spawnCommand(args, input, current);
    });
    queue = next.catch(() => {});
    return next;
  }

  function spawnCommand(args, input, current) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        {
          timeout: answerMs,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            AGENT_DESKTOP_HOME: home,
            ...(helper ? { AGENT_DESKTOP_MACOS_HELPER_PATH: helper } : {}),
          },
        },
        (error, stdout) => {
          children.delete(child);
          current?.children.delete(child);
          let envelope;
          try {
            envelope = JSON.parse(stdout);
          } catch {
            return reject(
              new Error(
                error
                  ? `agent-desktop failed: ${error.killed ? 'it did not answer within 30 seconds' : error.message}`
                  : 'agent-desktop returned no result.',
              ),
            );
          }
          if (envelope.ok) return resolve(envelope.data ?? {});
          const failure = envelope.error ?? {};
          reject(
            new Error(`${failure.code ?? 'ERROR'}: ${failure.message ?? 'agent-desktop failed.'}`),
          );
        },
      );
      children.add(child);
      current?.children.add(child);
      child.stdin?.end(input ?? '');
    });
  }

  const check = (value, pattern, what) => {
    if (typeof value !== 'string' || !pattern.test(value))
      throw new Error(`INVALID: Invalid ${what}.`);
    return value;
  };
  const scope = (request) => [
    '--app',
    check(request.app, appName, 'app'),
    ...(request.window ? ['--window-id', check(request.window, windowId, 'window')] : []),
  ];

  async function permissions() {
    const data = await run(['permissions']);
    return {
      accessibility: data.accessibility?.state === 'granted',
      screen: data.screen_recording?.state === 'granted',
    };
  }

  async function screenshot(request) {
    await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
    const path = join(home, 'tmp', `window-${process.pid}-${Date.now()}.png`);
    try {
      await run(['screenshot', ...scope(request), path]);
      return { image: (await readFile(path)).toString('base64') };
    } finally {
      await rm(path, { force: true });
    }
  }

  const chromiumApps = new Map();
  const stale = new Set();
  let session;

  function chromium(pid) {
    if (!chromiumApps.has(pid))
      chromiumApps.set(
        pid,
        output('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).then(async (path) => {
          const bundle = path.trim().match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1];
          if (!bundle) return false;
          const frameworks = await readdir(join(bundle, 'Contents', 'Frameworks')).catch(() => []);
          return frameworks.some((name) => chromiumFrameworks.test(name));
        }),
      );
    return chromiumApps.get(pid);
  }

  async function frontmost() {
    const front = (await output('/usr/bin/lsappinfo', ['front'])).trim();
    if (!front) return undefined;
    const pid = (await output('/usr/bin/lsappinfo', ['info', '-only', 'pid', front])).match(
      /\bpid"?\s*=\s*(\d+)/,
    )?.[1];
    return pid ? Number(pid) : undefined;
  }

  async function windowOf(target) {
    if (!target.window) return undefined;
    const windows = await run(['list-windows', '--app', check(target.app, appName, 'app')]);
    return windows.find((window) => window.id === target.window);
  }

  let followed;
  let following;
  let polling = false;
  function frame(target, bounds, waiting = false) {
    const changed = followed?.waiting !== waiting || followed?.target.window !== target.window;
    followed = { target, bounds: followed && !changed ? followed.bounds : bounds, waiting };
    if (changed) presence.show({ app: target.app, bounds: followed.bounds, waiting });
    following ??= steps.exit(() => setInterval(follow, 300).unref());
  }

  async function follow() {
    const current = followed;
    if (!current || polling) return;
    polling = true;
    try {
      const windows = await run(['list-windows', ...scope({ app: current.target.app })]).catch(
        () => [],
      );
      const bounds = windows.find((item) => item.id === current.target.window)?.bounds;
      if (
        !bounds ||
        followed !== current ||
        JSON.stringify(bounds) === JSON.stringify(current.bounds)
      )
        return;
      current.bounds = bounds;
      presence.show({ app: current.target.app, bounds, waiting: current.waiting });
    } finally {
      polling = false;
    }
  }

  function unframe() {
    followed = undefined;
    clearInterval(following);
    following = undefined;
    presence.hide();
  }

  async function waitForOwner(target, bounds) {
    const until = Date.now() + ownerWaitMs;
    const started = generation;
    const current = steps.getStore();
    const awake = () => {
      try {
        alive(started, current);
      } catch (error) {
        unframe();
        throw error;
      }
    };
    while (presence.idleSeconds() < ownerIdleSeconds) {
      awake();
      if (Date.now() > until) {
        unframe();
        throw new Error(
          `OWNER_ACTIVE: The owner kept using the computer, so Nod didn't bring ${target.app} to the front and sent nothing. Try again when they pause.`,
        );
      }
      frame(target, bounds, true);
      await delay(250);
    }
    awake();
  }

  async function release() {
    const ending = session;
    session = undefined;
    if (!ending) return;
    clearTimeout(ending.timer);
    unframe();
    if (!ending.previous || (await frontmost()) !== ending.pid) return;
    if (ending.previous.pid === presence.ownPid) return presence.focusSelf();
    if (ending.previous.window)
      await run([
        'focus-window',
        '--app',
        ending.previous.app,
        '--window-id',
        ending.previous.window,
      ]).catch(() => {});
  }

  async function focused(target, window, work) {
    if (session?.window !== target.window) {
      await release();
      await waitForOwner(target, window.bounds);
      const [front, windows] = await Promise.all([
        frontmost(),
        run(['list-windows']).catch(() => []),
      ]);
      const back = windows.find((item) => item.pid === front && item.is_focused);
      session = {
        window: target.window,
        pid: window.pid,
        previous: front && { pid: front, app: back?.app_name, window: back?.id },
      };
      frame(target, window.bounds);
      await run(['focus-window', ...scope(target)]);
    } else {
      clearTimeout(session.timer);
      await waitForOwner(target, window.bounds);
      frame(target, window.bounds);
    }
    try {
      return await work();
    } finally {
      if (session) session.timer = setTimeout(() => void release(), lingerMs);
    }
  }

  let backgroundTimer;
  async function shown(request, work) {
    clearTimeout(backgroundTimer);
    if (!followed) presence.show({ app: request.app, background: true });
    try {
      return await work();
    } finally {
      backgroundTimer = setTimeout(() => {
        if (!followed) presence.hide();
      }, backgroundLingerMs);
    }
  }

  async function cancel(step) {
    if (step !== undefined) {
      const current = active.get(step);
      if (!current) return;
      current.cancelled = true;
      for (const child of current.children) child.kill();
      return;
    }
    generation++;
    for (const child of children) child.kill();
    clearTimeout(backgroundTimer);
    if (session) await release();
    else unframe();
  }

  async function act(request, args, input, found = windowOf(request)) {
    const target = { app: request.app, window: request.window };
    const window = await found;
    const inFront = window && (await chromium(window.pid));
    if (!inFront)
      try {
        return await run(args, input);
      } catch (error) {
        if (!window || !needsFocus.test(error.message)) throw error;
      }
    if (inFront) stale.add(target.window);
    return focused(target, window, async () => {
      if (args[0] === 'press') return run([...args, '--headed'], input);
      try {
        return await run(args, input);
      } catch (error) {
        if (!needsFocus.test(error.message)) throw error;
        return run([...args, '--headed'], input);
      }
    });
  }

  async function type(request) {
    const target = { app: request.app, window: request.window };
    const window = await windowOf(target);
    if (window && (pasteRoles.has(request.role) || (await chromium(window.pid))))
      return paste(request, target, window);
    if (pasteRoles.has(request.role))
      throw new Error('ACTION_NOT_SUPPORTED: Nod can type into this area only in its own window.');
    return act(
      request,
      ['type', check(request.ref, ref, 'ref'), '--stdin'],
      String(request.text ?? ''),
      Promise.resolve(window),
    );
  }

  async function paste(request, target, window) {
    stale.add(target.window);
    return focused(target, window, async () => {
      await run(['focus', check(request.ref, ref, 'ref')]);
      const saved = await presence.clipboard.save();
      await presence.clipboard.write(String(request.text ?? ''));
      try {
        return await run(['press', 'cmd+v', ...scope(target), '--headed']);
      } finally {
        await delay(400);
        try {
          await presence.clipboard.restore(saved);
        } catch {
          await Promise.resolve(presence.clipboard.write('')).catch(() => {});
        }
      }
    });
  }

  async function observe(request, work) {
    const target = { app: request.app, window: request.window };
    if (!stale.has(target.window)) return work();
    const window = await windowOf(target);
    if (!window) return work();
    const result = await focused(target, window, work);
    stale.delete(target.window);
    return result;
  }

  const operations = {
    permissions,
    request: async (request) => {
      await requestPermission(request.which === 'screen' ? 'screen' : 'accessibility');
      return permissions();
    },
    apps: async () => {
      const [{ apps }, windows] = await Promise.all([run(['list-apps']), run(['list-windows'])]);
      return {
        apps: apps.map((app) => ({
          pid: app.pid,
          bundle: app.bundle_id ?? app.name,
          name: app.name,
          windows: windows
            .filter((window) => window.pid === app.pid && window.visible !== false)
            .map((window) => ({ id: window.id, title: window.title ?? '' })),
        })),
      };
    },
    locate: async (request) => {
      const bundle = check(request.bundle, /^[A-Za-z0-9.-]{1,200}$/, 'bundle ID');
      const path = (await output('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundle}"`]))
        .split('\n')
        .find((line) => line.endsWith('.app'));
      if (!path) throw new Error('No app with that bundle ID is installed.');
      return { bundle, name: path.split('/').at(-1).slice(0, -4) };
    },
    open: async (request) => {
      const opened = await run(['launch', check(request.bundle, appName, 'app')]);
      return { pid: opened.pid };
    },
    snapshot: (request) =>
      observe(request, async () => {
        const args = request.ref
          ? ['snapshot', '--root', check(request.ref, ref, 'ref')]
          : [
              'snapshot',
              ...scope(request),
              ...(request.menu ? ['--surface', 'menubar'] : []),
              ...(request.skeleton ? ['--skeleton'] : []),
            ];
        const data = await run([...args, '-i', '--compact']);
        return { tree: data.tree };
      }),
    find: (request) =>
      observe(request, () =>
        run([
          'find',
          ...scope(request),
          ...(request.text ? ['--text', check(request.text, appName, 'text')] : []),
          ...(request.role ? ['--role', check(request.role, /^[a-z]{1,40}$/, 'role')] : []),
        ]),
      ),
    screenshot: (request) => observe(request, () => screenshot(request)),
    press: (request) => act(request, ['click', check(request.ref, ref, 'ref')]),
    focus: (request) => act(request, ['focus', check(request.ref, ref, 'ref')]),
    select: (request) =>
      act(request, [
        'select',
        check(request.ref, ref, 'ref'),
        check(request.option, appName, 'option'),
      ]),
    set_value: (request) =>
      act(
        request,
        ['set-value', check(request.ref, ref, 'ref'), '--stdin'],
        String(request.text ?? ''),
      ),
    type,
    key: (request) => act(request, ['press', check(request.keys, keys, 'keys'), ...scope(request)]),
  };

  let ready;
  async function operate(request) {
    await access(binary, constants.X_OK).catch(() => {
      throw new Error(`agent-desktop is missing at ${binary}.`);
    });
    ready ??= mkdir(home, { recursive: true, mode: 0o700 }).then(() => chmod(home, 0o700));
    await ready.catch((error) => {
      ready = undefined;
      throw error;
    });
    const operation = operations[request?.op];
    if (!operation) throw new Error(`Unknown computer use step ${String(request?.op)}.`);
    return appSteps.has(request.op) ? shown(request, () => operation(request)) : operation(request);
  }

  return {
    cancel,
    async request(request) {
      if (request?.op === 'cancel') return cancel(request.step).then(() => ({}));
      const current = {
        cancelled: false,
        children: new Set(),
        deadline: typeof request?.deadline === 'number' ? request.deadline : undefined,
      };
      const step = typeof request?.step === 'string' ? request.step : undefined;
      if (step) active.set(step, current);
      try {
        return await steps.run(current, () => operate(request));
      } finally {
        if (step) active.delete(step);
      }
    },
  };
}
