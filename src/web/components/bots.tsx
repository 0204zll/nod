import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Activity } from '../../shared/contracts';
import { botInstructionsLimit, botJobLimit, botEmojis, botNameLimit } from '../../shared/bots';
import { api, errorMessage } from '../lib/api';
import { botActivity, botLine, botPath, type Bot } from '../lib/bots';
import { LockKeyhole, Plus, Settings, X } from './icons';
import { NodModelName, BotModel } from './model-choices';
import { NodAvatar, BotAvatar } from './bot-avatar';

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

export function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nod:toast', { detail: text }));
}

export function Toasts() {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      setText((event as CustomEvent<string>).detail);
      setOpen(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOpen(false), 2400);
    };
    window.addEventListener('nod:toast', show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('nod:toast', show);
    };
  }, []);
  return text ? (
    <div
      className="bot-toast"
      role="status"
      data-open={open || undefined}
      onTransitionEnd={(event) => {
        if (!open && event.propertyName === 'opacity') setText('');
      }}
    >
      {text}
    </div>
  ) : null;
}

const botsChanged = () => window.dispatchEvent(new Event('nod:bots-changed'));

async function changeBot(id: string, body: object) {
  const result = await api<Bot>(`/api/bots/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  botsChanged();
  return result;
}

export async function createBot() {
  const created = await api<Bot>('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  botsChanged();
  return created;
}

async function removeBot(id: string) {
  await api(`/api/bots/${id}`, { method: 'DELETE' });
  botsChanged();
}

function RowMarker({ bot, unread }: { bot: Bot; unread: boolean }) {
  if (bot.status === 'needs_you')
    return <span className="bot-dot bot-dot-needs" aria-label="Needs you" />;
  if (unread) return <span className="bot-dot" aria-label="Unread" />;
  if (bot.status === 'working')
    return <span className="bot-dot bot-dot-working" aria-label="Working" />;
  return null;
}

function ContextMenu({
  bot,
  point,
  onClose,
  onOpen,
  onRemoved,
}: {
  bot: Bot;
  point: { x: number; y: number };
  onClose(): void;
  onOpen(): void;
  onRemoved(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    setPosition({
      x: Math.min(point.x, window.innerWidth - element.offsetWidth - 8),
      y: Math.min(point.y, window.innerHeight - element.offsetHeight - 8),
    });
    element.querySelector<HTMLButtonElement>('button')?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="bot-context"
      role="menu"
      aria-label={`${bot.name} options`}
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onOpen();
        }}
      >
        Open chat
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onClose();
          void removeBot(bot.id)
            .then(() => {
              toast(`Removed ${bot.name}`);
              onRemoved();
            })
            .catch((cause) => toast(errorMessage(cause)));
        }}
      >
        Remove {bot.name}
      </button>
    </div>,
    document.body,
  );
}

export function BotNav({
  bots,
  activity,
  activeId,
  mainActive,
  nodLine,
  nodUnread,
  nodWorking,
  settingsActive,
  unread,
  onNavigate,
  onSettings,
  onOpenPanel,
}: {
  bots: Bot[];
  activity?: Activity[];
  activeId?: string;
  mainActive: boolean;
  nodLine: string;
  nodUnread: boolean;
  nodWorking: boolean;
  settingsActive: boolean;
  unread(bot: Bot): boolean;
  onNavigate(path: string): void;
  onSettings(): void;
  onOpenPanel(id: string): void;
}) {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ bot: Bot; point: { x: number; y: number } }>();
  const [creating, setCreating] = useState(false);
  const ids = bots.map((bot) => bot.id).join();
  useEffect(() => {
    const next = new Set(bots.map((bot) => bot.id));
    if (known.current) {
      const added = [...next].filter((id) => !known.current!.has(id));
      if (added.length) {
        setFresh(new Set(added));
        const timer = window.setTimeout(() => setFresh(new Set()), 1800);
        known.current = next;
        return () => window.clearTimeout(timer);
      }
    }
    known.current = next;
  }, [ids]);
  const link = (path: string) => (event: MouseEvent) => {
    if (!plain(event)) return;
    event.preventDefault();
    onNavigate(path);
  };
  async function add() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createBot();
      onOpenPanel(created.id);
    } catch (cause) {
      toast(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }
  const openMenu = (bot: Bot, point: { x: number; y: number }) => setMenu({ bot, point });
  return (
    <nav className="bot-nav" aria-label="Chats">
      <a
        href="/"
        className="bot-brand"
        aria-current={mainActive ? 'page' : undefined}
        aria-label={['Chat with Nod', nodWorking ? 'working' : null, nodUnread ? 'unread' : null]
          .filter(Boolean)
          .join(', ')}
        onClick={link('/')}
      >
        <span className="bot-brand-mark" aria-hidden="true">
          <span />
        </span>
        <span className="bot-meta">
          <span className="bot-name">Nod</span>
          <span className={`bot-sub${nodUnread ? ' bot-sub-unread' : ''}`}>
            {nodWorking ? 'Working…' : nodLine || 'Ask me anything'}
          </span>
        </span>
        {nodUnread ? (
          <span className="bot-dot" aria-hidden="true" />
        ) : nodWorking ? (
          <span className="bot-dot bot-dot-working" aria-hidden="true" />
        ) : null}
      </a>
      <div className="bot-section">
        <div className="bot-head">
          <span>Bots</span>
          <button
            type="button"
            className="bot-icon-button"
            aria-label="New bot"
            disabled={creating}
            onClick={() => void add()}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {bots.length ? (
          <ul className="bot-list">
            {bots.map((bot) => {
              const active = bot.id === activeId;
              const isUnread = !active && unread(bot);
              const live = botActivity(activity, bot.id);
              return (
                <li key={bot.id} className={fresh.has(bot.id) ? 'bot-fresh' : ''}>
                  <a
                    href={botPath(bot.id)}
                    className="bot-item"
                    aria-current={active ? 'page' : undefined}
                    aria-label={[
                      bot.name,
                      bot.status === 'needs_you'
                        ? 'needs you'
                        : bot.status === 'working'
                          ? 'working'
                          : null,
                      isUnread ? 'unread' : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    onClick={link(botPath(bot.id))}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openMenu(bot, { x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                        return;
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      openMenu(bot, { x: box.left + 24, y: box.bottom });
                    }}
                  >
                    <BotAvatar name={bot.name} avatar={bot.avatar} />
                    <span className="bot-meta">
                      <span className="bot-name">{bot.name}</span>
                      <span className={`bot-sub${isUnread ? ' bot-sub-unread' : ''}`}>
                        {botLine(
                          bot,
                          bot.status === 'working' && !(live?.step ?? live?.title),
                          live,
                        )}
                      </span>
                    </span>
                    <RowMarker bot={bot} unread={isUnread} />
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="bot-empty">
            No bots yet.{' '}
            <button type="button" onClick={() => void add()}>
              Add one
            </button>
          </p>
        )}
      </div>
      <div className="bot-foot">
        <button
          type="button"
          className="bot-foot-item"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={onSettings}
        >
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
      {menu && (
        <ContextMenu
          bot={menu.bot}
          point={menu.point}
          onClose={() => setMenu(undefined)}
          onOpen={() => onNavigate(botPath(menu.bot.id))}
          onRemoved={() => {
            if (menu.bot.id === activeId) onNavigate('/');
          }}
        />
      )}
    </nav>
  );
}

export function ChatTop({
  bot,
  panelOpen,
  onTogglePanel,
  toolsRef,
}: {
  bot?: Bot;
  panelOpen: boolean;
  onTogglePanel(): void;
  toolsRef?(element: HTMLDivElement | null): void;
}) {
  const summary = bot ? bot.job || 'No job yet' : 'Your main assistant';
  return (
    <header className="chat-top">
      <h1 className="chat-pill-wrap">
        <button
          type="button"
          className="chat-pill"
          aria-expanded={panelOpen}
          aria-controls="bot-panel"
          title={summary}
          onClick={onTogglePanel}
        >
          {bot ? (
            <BotAvatar name={bot.name} avatar={bot.avatar} size="sm" />
          ) : (
            <NodAvatar size="sm" />
          )}
          <span className="chat-pill-name">{bot?.name ?? 'Nod'}</span>
        </button>
      </h1>
      <div className="chat-top-tools" ref={toolsRef} />
    </header>
  );
}

async function uploadAvatar(dataUrl: string) {
  const blob = await (await fetch(dataUrl)).blob();
  const body = new FormData();
  body.append(
    'file',
    new File([blob], `avatar.${blob.type.split('/')[1] ?? 'webp'}`, { type: blob.type }),
  );
  return (await api<{ url: string }>('/api/uploads', { method: 'POST', body })).url;
}

function resizedImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
      return reject(new Error('Choose a PNG, JPG or WebP image.'));
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d')!;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      const webp = canvas.toDataURL('image/webp', 0.86);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be read.'));
    };
    image.src = url;
  });
}

const generatedColors: Array<[string, string]> = [
  ['#ff91ac', '#87003c'],
  ['#b9a7ff', '#4b2bb3'],
  ['#8fd3a7', '#1d6b3f'],
  ['#ffd27a', '#9a5b00'],
  ['#9ad2ff', '#0b5394'],
  ['#e6c7a5', '#7a4a21'],
];

function generatedAvatar(name: string, description: string) {
  const seed = [...description].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
  const [from, to] = generatedColors[seed % generatedColors.length]!;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = 'rgba(255,255,255,0.92)';
  context.font = '700 104px Geist, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillText([...name.trim()][0]?.toUpperCase() ?? '?', 128, 164);
  return canvas.toDataURL('image/webp', 0.92);
}

function AvatarMenu({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const [tab, setTab] = useState<'avatar' | 'generate' | 'upload'>('avatar');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const avatar = bot.avatar;
  const save = (next: string, done?: string) => {
    setBusy(true);
    void changeBot(bot.id, { avatar: next })
      .then(() => done && toast(done))
      .catch((cause) => toast(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="avatar-menu" role="dialog" aria-label="Change avatar">
      <div className="avatar-tabs" role="tablist">
        {(
          [
            ['avatar', 'Avatar'],
            ['generate', 'Generate'],
            ['upload', 'Upload'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'avatar' ? (
        <div className="avatar-pick">
          {(['', ...botEmojis] as const).map((emoji) => (
            <button
              key={emoji || 'initial'}
              type="button"
              aria-pressed={avatar === emoji}
              aria-label={emoji || 'First letter'}
              disabled={busy}
              onClick={() => save(emoji)}
            >
              <BotAvatar name={bot.name} avatar={emoji} />
            </button>
          ))}
        </div>
      ) : tab === 'generate' ? (
        <form
          className="avatar-generate"
          onSubmit={(event) => {
            event.preventDefault();
            const value = description.trim();
            if (!value) return toast('Describe the avatar first');
            void uploadAvatar(generatedAvatar(bot.name, value))
              .then((url) => save(url, 'Avatar generated'))
              .catch((cause) => toast(errorMessage(cause)));
          }}
        >
          <textarea
            className="bot-input"
            rows={2}
            value={description}
            placeholder="Describe the avatar, e.g. a friendly robot in pastel colors"
            onChange={(event) => setDescription(event.target.value)}
          />
          <button type="submit" className="bot-button" disabled={busy}>
            Generate
          </button>
        </form>
      ) : (
        <div className="avatar-upload">
          <label>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void resizedImage(file)
                  .then(uploadAvatar)
                  .then((url) => save(url, 'Avatar updated'))
                  .catch((cause) => toast(errorMessage(cause)));
              }}
            />
            <span className="bot-button">Choose image…</span>
          </label>
          <span className="avatar-hint">PNG or JPG, square works best.</span>
        </div>
      )}
      <button type="button" className="sr-only" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function NameField({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(bot.name);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(bot.name);
  }, [bot.name]);
  function commit() {
    editing.current = false;
    const next = value.replace(/\s+/g, ' ').trim();
    if (next === bot.name) return setValue(bot.name);
    if (!next) {
      toast('Give the bot a name.');
      return setValue(bot.name);
    }
    void changeBot(bot.id, { name: next }).catch((cause) => {
      toast(errorMessage(cause));
      setValue(bot.name);
    });
  }
  return (
    <input
      className="bot-name-input"
      value={value}
      maxLength={botNameLimit}
      aria-label="Name"
      onFocus={() => (editing.current = true)}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.stopPropagation();
          setValue(bot.name);
          editing.current = false;
          requestAnimationFrame(() => event.currentTarget?.blur());
        }
      }}
    />
  );
}

function ProfileField({ bot, field }: { bot: Bot; field: 'job' | 'instructions' }) {
  const [value, setValue] = useState(bot[field]);
  const saved = useRef(bot[field]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setValue(bot[field]);
      saved.current = bot[field];
    }
  }, [bot[field]]);
  function save(next: string) {
    clearTimeout(timer.current);
    if (next.trim() === saved.current.trim()) return;
    saved.current = next;
    void changeBot(bot.id, { [field]: next }).catch((cause) => toast(errorMessage(cause)));
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const props = {
    className: 'bot-input',
    value,
    onFocus: () => (focused.current = true),
    onChange: (event: { target: { value: string } }) => {
      const next = event.target.value;
      setValue(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save(next), 700);
    },
    onBlur: () => {
      focused.current = false;
      save(value);
    },
  };
  return field === 'job' ? (
    <input
      {...props}
      aria-label="Job"
      placeholder="What should it do for you?"
      maxLength={botJobLimit}
    />
  ) : (
    <textarea
      {...props}
      rows={3}
      aria-label="Instructions"
      placeholder="What should it always or never do?"
      maxLength={botInstructionsLimit}
    />
  );
}

export function BotPanel({ bot, onClose }: { bot?: Bot; onClose(): void }) {
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRoot = useRef<HTMLSpanElement>(null);
  useEffect(() => setAvatarOpen(false), [bot?.id]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (avatarOpen) return setAvatarOpen(false);
      onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [avatarOpen, onClose]);
  useEffect(() => {
    if (!avatarOpen) return;
    const outside = (event: PointerEvent) => {
      if (!avatarRoot.current?.contains(event.target as Node)) setAvatarOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [avatarOpen]);
  const close = (
    <button type="button" className="bot-icon-button" aria-label="Close settings" onClick={onClose}>
      <X size={16} aria-hidden="true" />
    </button>
  );
  return (
    <aside
      id="bot-panel"
      className="bot-panel"
      aria-label={bot ? `${bot.name} settings` : 'Nod settings'}
    >
      <div className="panel-head">
        <div className="panel-head-top">{close}</div>
        <div className="panel-identity">
          {bot ? (
            <span className="avatar-wrap" ref={avatarRoot}>
              <button
                type="button"
                className="avatar-button"
                aria-expanded={avatarOpen}
                aria-label="Change avatar"
                onClick={() => setAvatarOpen((value) => !value)}
              >
                <BotAvatar name={bot.name} avatar={bot.avatar} size="lg" />
              </button>
              {avatarOpen && <AvatarMenu bot={bot} onClose={() => setAvatarOpen(false)} />}
            </span>
          ) : (
            <NodAvatar size="lg" />
          )}
          <div className="panel-identity-text">
            {bot ? (
              <NameField bot={bot} />
            ) : (
              <>
                <h2>Nod</h2>
                <p>Your main assistant</p>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="panel-body">
        {bot ? (
          <>
            <div className="panel-rows">
              <div className="panel-row">
                <label className="panel-row-head panel-row-still">
                  <span>Model</span>
                  <BotModel bot={bot} onError={toast} />
                </label>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Memory</span>
                  <span className="panel-row-value">Shared with Nod</span>
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Job</span>
                </div>
                <div className="panel-row-body">
                  <ProfileField bot={bot} field="job" />
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Instructions</span>
                </div>
                <div className="panel-row-body">
                  <ProfileField bot={bot} field="instructions" />
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="panel-rows">
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Model</span>
                  <span className="panel-row-value">
                    <NodModelName />
                  </span>
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Apps</span>
                  <span className="panel-row-value">All connected apps</span>
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Memory</span>
                  <span className="panel-row-value">Yours</span>
                </div>
              </div>
            </div>
            <p className="panel-note">
              <LockKeyhole size={14} aria-hidden="true" />
              <span>
                Nod can’t be renamed or removed. It holds your Vault, approvals and settings, and
                every bot’s actions go through its trust check.
              </span>
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

export function BotEmpty({ bot }: { bot: Bot }): ReactNode {
  return (
    <div className="bot-empty-chat">
      <BotAvatar name={bot.name} avatar={bot.avatar} size="lg" />
      <p>Hi, I’m {bot.name}. What can I take off your plate?</p>
      {bot.job && <p className="bot-empty-job">{bot.job}</p>}
    </div>
  );
}
