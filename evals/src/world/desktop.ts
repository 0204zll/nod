import type { DesktopControl, DesktopRequest } from '../../../src/ports/desktop.ts';

export interface DesktopElement {
  role: string;
  name?: string;
  value?: string;
  secure?: boolean;
  press?: () => void;
  children?: DesktopElement[];
}

export interface DesktopWindow {
  id: string;
  title: string;
  root: DesktopElement;
}

export interface DesktopApp {
  bundle: string;
  name: string;
  running: boolean;
  windows: DesktopWindow[];
  menu?: Record<string, Record<string, () => void>>;
}

export interface DesktopStep {
  op: string;
  bundle?: string;
  target?: string;
  text?: string;
}

export type FakeDesktop = DesktopControl & {
  apps: DesktopApp[];
  steps: DesktopStep[];
  app(bundle: string): DesktopApp;
};

const textRoles = new Set(['textfield', 'textarea']);

export function createDesktop(apps: DesktopApp[]): FakeDesktop {
  const steps: DesktopStep[] = [];
  const pids = new Map(apps.map((app, index) => [app.bundle, 500 + index]));
  const refs = new Map<string, { app: DesktopApp; element: DesktopElement }>();
  let snapshots = 0;
  const info = (app: DesktopApp) => ({
    pid: pids.get(app.bundle),
    bundle: app.bundle,
    name: app.name,
    windows: app.windows.map((window) => ({ id: window.id, title: window.title })),
  });
  const byName = (name: unknown) => apps.find((app) => app.running && app.name === name);

  function tree(app: DesktopApp, element: DesktopElement, id: string, counter: { next: number }) {
    const node: Record<string, unknown> = { role: element.role };
    if (element.name) node.name = element.name;
    if (element.secure) node.states = ['secure'];
    else if (element.value !== undefined) node.value = element.value;
    if (element.press || textRoles.has(element.role)) {
      const ref = `@${id}:e${counter.next++}`;
      refs.set(ref, { app, element });
      node.ref_id = ref;
    }
    if (element.children?.length)
      node.children = element.children.map((child) => tree(app, child, id, counter));
    return node;
  }

  function menuBar(app: DesktopApp): DesktopElement {
    return {
      role: 'menu',
      children: [
        {
          role: 'menuitem',
          name: 'Apple',
          children: [
            {
              role: 'menuitem',
              name: 'Restart…',
              press: () => steps.push({ op: 'press', target: 'Restart…' }),
            },
          ],
        },
        {
          role: 'menuitem',
          name: app.name,
          children: [
            {
              role: 'menuitem',
              name: 'Services',
              press: () => steps.push({ op: 'press', target: 'Services' }),
            },
          ],
        },
        ...Object.entries(app.menu ?? {}).map(([menu, items]) => ({
          role: 'menuitem',
          name: menu,
          children: Object.entries(items).map(([item, run]) => ({
            role: 'menuitem',
            name: item,
            press: run,
          })),
        })),
      ],
    };
  }

  function find(request: DesktopRequest) {
    const entry = refs.get(String(request.ref ?? ''));
    if (!entry) throw new Error('STALE_REF: That ref is not current. Take a new snapshot.');
    return entry;
  }

  async function request(request: DesktopRequest): Promise<Record<string, unknown>> {
    switch (request.op) {
      case 'permissions':
      case 'request':
        return {
          platform: 'darwin',
          accessibility: 'granted',
          screen: 'granted',
          surfaces: ['window', 'menubar'],
        };
      case 'apps':
        return { apps: apps.filter((item) => item.running).map(info) };
      case 'locate': {
        const found = apps.find((item) => item.bundle === request.bundle);
        if (!found) throw new Error('No app with that bundle ID is installed.');
        return { bundle: found.bundle, name: found.name };
      }
      case 'open': {
        const found = apps.find((item) => item.bundle === request.bundle);
        if (!found) throw new Error('No app with that bundle ID is installed.');
        found.running = true;
        steps.push({ op: 'open', bundle: found.bundle });
        return { pid: pids.get(found.bundle), name: found.name };
      }
      case 'snapshot': {
        const id = `sfake${String(++snapshots).padStart(4, '0')}`;
        if (request.ref) {
          const { app, element } = find(request);
          return { tree: tree(app, element, id, { next: 1 }) };
        }
        const app = byName(request.app);
        if (!app) throw new Error(`${String(request.app)} is not running.`);
        if (request.menu) return { tree: tree(app, menuBar(app), id, { next: 1 }) };
        const window = request.window
          ? app.windows.find((item) => item.id === request.window)
          : app.windows[0];
        if (!window) throw new Error('AMBIGUOUS_TARGET: name a window.');
        return { tree: tree(app, window.root, id, { next: 1 }) };
      }
      case 'screenshot':
        throw new Error('Screenshots are not available in this evaluation; use snapshot.');
      case 'press': {
        const { app, element } = find(request);
        if (!element.press)
          throw new Error('ACTION_NOT_SUPPORTED: that element cannot be pressed.');
        steps.push({ op: 'press', bundle: app.bundle, target: element.name });
        element.press();
        return { disposition: { delivery: 'delivered_verified' } };
      }
      case 'focus':
        find(request);
        return { disposition: { delivery: 'delivered_verified' } };
      case 'set_value':
      case 'type': {
        const { app, element } = find(request);
        if (!textRoles.has(element.role))
          throw new Error('ACTION_NOT_SUPPORTED: not a text field.');
        element.value =
          request.op === 'type'
            ? `${element.value ?? ''}${String(request.text ?? '')}`
            : String(request.text ?? '');
        steps.push({
          op: request.op,
          bundle: app.bundle,
          target: element.name,
          text: element.value,
        });
        return { disposition: { delivery: 'delivered_verified' } };
      }
      case 'select':
        find(request);
        return { disposition: { delivery: 'delivered_verified' } };
      case 'key': {
        const app = byName(request.app);
        steps.push({ op: 'key', bundle: app?.bundle, text: String(request.keys) });
        if (app && /^cmd\+n$/i.test(String(request.keys))) app.menu?.File?.New?.();
        return { disposition: { delivery: 'delivered_unverified' } };
      }
    }
    throw new Error(`Unknown computer use step ${request.op}.`);
  }

  return {
    apps,
    steps,
    app: (bundle) => apps.find((item) => item.bundle === bundle)!,
    request: async (input) => request(input),
  };
}

export function textEdit(): DesktopApp {
  const app: DesktopApp = {
    bundle: 'com.apple.TextEdit',
    name: 'TextEdit',
    running: false,
    windows: [],
  };
  let count = 0;
  const document = () => {
    count += 1;
    const title = count === 1 ? 'Untitled' : `Untitled ${count}`;
    app.windows.unshift({
      id: `w-textedit-${count}`,
      title,
      root: { role: 'window', name: title, children: [{ role: 'textfield', value: '' }] },
    });
  };
  app.menu = { File: { New: document, Save: () => {} }, Format: { Bold: () => {} } };
  return app;
}

export function mail(draft: { to: string; subject: string; quoted: string }) {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const to: DesktopElement = { role: 'textfield', name: 'To', value: draft.to };
  const subject: DesktopElement = { role: 'textfield', name: 'Subject', value: draft.subject };
  const body: DesktopElement = {
    role: 'textarea',
    name: 'Message body',
    value: `\n\n${draft.quoted}`,
  };
  const app: DesktopApp = {
    bundle: 'com.apple.mail',
    name: 'Mail',
    running: true,
    windows: [
      {
        id: 'w-mail-1',
        title: draft.subject,
        root: {
          role: 'window',
          name: draft.subject,
          children: [
            {
              role: 'button',
              name: 'Send',
              press: () => {
                sent.push({
                  to: to.value ?? '',
                  subject: subject.value ?? '',
                  body: body.value ?? '',
                });
                app.windows.shift();
              },
            },
            to,
            subject,
            body,
          ],
        },
      },
    ],
  };
  return { app, sent, body };
}

export function terminal(): DesktopApp {
  return {
    bundle: 'com.apple.Terminal',
    name: 'Terminal',
    running: true,
    windows: [
      {
        id: 'w-terminal-1',
        title: 'zsh',
        root: { role: 'window', name: 'zsh', children: [{ role: 'textarea', value: '$ ' }] },
      },
    ],
  };
}

export function chrome(): DesktopApp {
  return {
    bundle: 'com.google.Chrome',
    name: 'Google Chrome',
    running: true,
    windows: [
      {
        id: 'w-chrome-1',
        title: 'Inbox',
        root: {
          role: 'window',
          name: 'Inbox',
          children: [{ role: 'button', name: 'Compose', press: () => {} }],
        },
      },
    ],
  };
}

export function slackApp(person: string) {
  const sent: string[] = [];
  const message: DesktopElement = { role: 'textfield', name: `Message to ${person}`, value: '' };
  const app: DesktopApp = {
    bundle: 'com.tinyspeck.slackmacgap',
    name: 'Slack',
    running: true,
    windows: [
      {
        id: 'w-slack-1',
        title: `${person} (DM) - Rivera Design - Slack`,
        root: {
          role: 'window',
          name: `${person} (DM) - Rivera Design - Slack`,
          children: [
            message,
            {
              role: 'button',
              name: 'Send now',
              press: () => {
                if (message.value) sent.push(message.value);
                message.value = '';
              },
            },
          ],
        },
      },
    ],
  };
  return { app, sent };
}
