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
import type { Task } from '../../shared/contracts';
import {
  channelLabels,
  memoryLabels,
  memoryModes,
  teammateChannels,
  teammateHues,
  teammateMarks,
  teammateNameLimit,
  type MemoryMode,
  type TeammateAvatar as Avatar,
  type TeammateChannel,
} from '../../shared/teammates';
import { api, errorMessage } from '../lib/api';
import {
  mentionParts,
  teammateLine,
  teammatePath,
  teammateState,
  type Teammate,
} from '../lib/teammates';
import { ChevronRight, LockKeyhole, Plus, Settings, X } from './icons';
import { NodModelName, TeammateModel } from './model-choices';
import { NodAvatar, TeammateAvatar } from './teammate-avatar';

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
      className="teammate-toast"
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

export const teammatesChanged = () => window.dispatchEvent(new Event('nod:teammates-changed'));

export async function changeTeammate(id: string, body: object) {
  const result = await api<Task>(`/api/teammates/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  teammatesChanged();
  return result;
}

export async function createTeammate() {
  const created = await api<Task>('/api/teammates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  teammatesChanged();
  return created;
}

export async function removeTeammate(id: string) {
  await api(`/api/teammates/${id}`, { method: 'DELETE' });
  teammatesChanged();
}

function RowMarker({ teammate, unread }: { teammate: Teammate; unread: boolean }) {
  const state = teammateState(teammate);
  if (state === 'needs' && teammate.teammate.job)
    return <span className="teammate-dot teammate-dot-needs" aria-label="Needs you" />;
  if (unread) return <span className="teammate-dot" aria-label="Unread" />;
  if (state === 'working')
    return <span className="teammate-dot teammate-dot-working" aria-label="Working" />;
  return null;
}

function ContextMenu({
  teammate,
  point,
  onClose,
  onOpen,
  onRemoved,
}: {
  teammate: Teammate;
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
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="teammate-context"
      role="menu"
      aria-label={`${teammate.name} options`}
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
          void removeTeammate(teammate.id)
            .then(() => {
              toast(`Removed ${teammate.name}`);
              onRemoved();
            })
            .catch((cause) => toast(errorMessage(cause)));
        }}
      >
        Remove {teammate.name}
      </button>
    </div>,
    document.body,
  );
}

export function TeammateNav({
  teammates,
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
  teammates: Teammate[];
  activeId?: string;
  mainActive: boolean;
  nodLine: string;
  nodUnread: boolean;
  nodWorking: boolean;
  settingsActive: boolean;
  unread(teammate: Teammate): boolean;
  onNavigate(path: string): void;
  onSettings(): void;
  onOpenPanel(id: string): void;
}) {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ teammate: Teammate; point: { x: number; y: number } }>();
  const [creating, setCreating] = useState(false);
  const ids = teammates.map((teammate) => teammate.id).join();
  useEffect(() => {
    const next = new Set(teammates.map((teammate) => teammate.id));
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
      const created = await createTeammate();
      onNavigate(teammatePath(created.id));
    } catch (cause) {
      toast(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }
  const openMenu = (teammate: Teammate, point: { x: number; y: number }) =>
    setMenu({ teammate, point });
  return (
    <nav className="teammate-nav" aria-label="Chats">
      <a
        href="/"
        className="teammate-brand"
        aria-current={mainActive ? 'page' : undefined}
        aria-label={['Chat with Nod', nodWorking ? 'working' : null, nodUnread ? 'unread' : null]
          .filter(Boolean)
          .join(', ')}
        onClick={link('/')}
      >
        <span className="teammate-brand-mark" aria-hidden="true">
          <span />
        </span>
        <span className="teammate-meta">
          <span className="teammate-name">Nod</span>
          <span className={`teammate-sub${nodUnread ? ' teammate-sub-unread' : ''}`}>
            {nodWorking ? 'Working…' : nodLine || 'Ask me anything'}
          </span>
        </span>
        {nodUnread ? (
          <span className="teammate-dot" aria-hidden="true" />
        ) : nodWorking ? (
          <span className="teammate-dot teammate-dot-working" aria-hidden="true" />
        ) : null}
      </a>
      <div className="teammate-section">
        <div className="teammate-head">
          <span>Teammates</span>
          <button
            type="button"
            className="teammate-icon-button"
            aria-label="New teammate"
            disabled={creating}
            onClick={() => void add()}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {teammates.length ? (
          <ul className="teammate-list">
            {teammates.map((teammate) => {
              const active = teammate.id === activeId;
              const isUnread = !active && unread(teammate);
              const state = teammateState(teammate);
              return (
                <li key={teammate.id} className={fresh.has(teammate.id) ? 'teammate-fresh' : ''}>
                  <a
                    href={teammatePath(teammate.id)}
                    className="teammate-item"
                    aria-current={active ? 'page' : undefined}
                    aria-label={[
                      teammate.name,
                      state === 'needs' ? 'needs you' : state === 'working' ? 'working' : null,
                      isUnread ? 'unread' : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    onClick={link(teammatePath(teammate.id))}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openMenu(teammate, { x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                        return;
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      openMenu(teammate, { x: box.left + 24, y: box.bottom });
                    }}
                  >
                    <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} />
                    <span className="teammate-meta">
                      <span className="teammate-name">{teammate.name}</span>
                      <span className={`teammate-sub${isUnread ? ' teammate-sub-unread' : ''}`}>
                        {teammateLine(teammate, state === 'working' && !teammate.now)}
                      </span>
                    </span>
                    <RowMarker teammate={teammate} unread={isUnread} />
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="teammate-empty">
            No teammates yet.{' '}
            <button type="button" onClick={() => void add()}>
              Add one
            </button>
          </p>
        )}
      </div>
      <div className="teammate-foot">
        <button
          type="button"
          className="teammate-foot-item"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={onSettings}
        >
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
      {menu && (
        <ContextMenu
          teammate={menu.teammate}
          point={menu.point}
          onClose={() => setMenu(undefined)}
          onOpen={() => onNavigate(teammatePath(menu.teammate.id))}
          onRemoved={() => {
            if (menu.teammate.id === activeId) onNavigate('/');
          }}
        />
      )}
    </nav>
  );
}

export function ChatTop({
  teammate,
  panelOpen,
  onTogglePanel,
  toolsRef,
}: {
  teammate?: Teammate;
  panelOpen: boolean;
  onTogglePanel(): void;
  toolsRef?(element: HTMLDivElement | null): void;
}) {
  const summary = teammate
    ? [
        teammate.teammate.job || 'Setting up',
        teammate.teammate.channels.map((c) => channelLabels[c]).join(', '),
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Your main assistant';
  return (
    <header className="chat-top">
      <h1 className="chat-pill-wrap">
        <button
          type="button"
          className="chat-pill"
          aria-expanded={panelOpen}
          aria-controls="teammate-panel"
          title={summary}
          onClick={onTogglePanel}
        >
          {teammate ? (
            <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="sm" />
          ) : (
            <NodAvatar size="sm" />
          )}
          <span className="chat-pill-name">{teammate?.name ?? 'Nod'}</span>
        </button>
      </h1>
      <div className="chat-top-tools" ref={toolsRef} />
    </header>
  );
}

export function HandoffNote({
  teammate,
  title,
  onOpen,
}: {
  teammate: Teammate;
  title: string;
  onOpen(path: string): void;
}) {
  return (
    <div className="handoff-row">
      <div className="handoff">
        <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="sm" />
        <span>
          Handed to <b>{teammate.name}</b>: {title}
        </span>
        <a
          href={teammatePath(teammate.id)}
          onClick={(event) => {
            if (!plain(event)) return;
            event.preventDefault();
            onOpen(teammatePath(teammate.id));
          }}
        >
          Open
        </a>
      </div>
    </div>
  );
}

const memoryShort = (mode: MemoryMode) => memoryLabels[mode].title.split(',')[0]!;

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

function AvatarMenu({ teammate, onClose }: { teammate: Teammate; onClose(): void }) {
  const [tab, setTab] = useState<'avatar' | 'generate' | 'upload'>('avatar');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const avatar = teammate.teammate.avatar;
  const save = (next: Avatar, done?: string) => {
    setBusy(true);
    void changeTeammate(teammate.id, { avatar: next })
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
        <>
          <div className="avatar-label">Shape</div>
          <div className="avatar-pick">
            {teammateMarks.map((mark) => (
              <button
                key={mark || 'initial'}
                type="button"
                aria-pressed={!avatar.image && (avatar.mark ?? '') === mark}
                aria-label={mark || 'First letter'}
                disabled={busy}
                onClick={() => save({ hue: avatar.hue, mark })}
              >
                <TeammateAvatar name={teammate.name} avatar={{ hue: avatar.hue, mark }} />
              </button>
            ))}
          </div>
          <div className="avatar-label">Color</div>
          <div className="avatar-swatches">
            {teammateHues.map((hue) => (
              <button
                key={hue}
                type="button"
                className={`h-${hue}`}
                aria-pressed={avatar.hue === hue}
                aria-label={hue}
                disabled={busy}
                onClick={() =>
                  save(
                    avatar.image
                      ? { hue, image: avatar.image }
                      : { hue, ...(avatar.mark !== undefined ? { mark: avatar.mark } : {}) },
                  )
                }
              />
            ))}
          </div>
        </>
      ) : tab === 'generate' ? (
        <form
          className="avatar-generate"
          onSubmit={(event) => {
            event.preventDefault();
            const value = description.trim();
            if (!value) return toast('Describe the avatar first');
            save(
              { hue: avatar.hue, image: generatedAvatar(teammate.name, value) },
              'Avatar generated',
            );
          }}
        >
          <textarea
            className="teammate-input"
            rows={2}
            value={description}
            placeholder="Describe the avatar, e.g. a friendly robot in pastel colors"
            onChange={(event) => setDescription(event.target.value)}
          />
          <button type="submit" className="teammate-button" disabled={busy}>
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
                  .then((image) => save({ hue: avatar.hue, image }, 'Avatar updated'))
                  .catch((cause) => toast(errorMessage(cause)));
              }}
            />
            <span className="teammate-button">Choose image…</span>
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

function NameField({ teammate }: { teammate: Teammate }) {
  const [value, setValue] = useState(teammate.name);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(teammate.name);
  }, [teammate.name]);
  function commit() {
    editing.current = false;
    const next = value.replace(/\s+/g, ' ').trim();
    if (next === teammate.name) return setValue(teammate.name);
    if (!next) {
      toast('Give the teammate a name.');
      return setValue(teammate.name);
    }
    void changeTeammate(teammate.id, { name: next }).catch((cause) => {
      toast(errorMessage(cause));
      setValue(teammate.name);
    });
  }
  return (
    <input
      className="teammate-name-input"
      value={value}
      maxLength={teammateNameLimit}
      aria-label="Name"
      onFocus={() => (editing.current = true)}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.stopPropagation();
          setValue(teammate.name);
          editing.current = false;
          requestAnimationFrame(() => event.currentTarget?.blur());
        }
      }}
    />
  );
}

function InstructionsField({ teammate }: { teammate: Teammate }) {
  const [value, setValue] = useState(teammate.teammate.instructions);
  const saved = useRef(teammate.teammate.instructions);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setValue(teammate.teammate.instructions);
      saved.current = teammate.teammate.instructions;
    }
  }, [teammate.teammate.instructions]);
  function save(next: string) {
    clearTimeout(timer.current);
    if (next.trim() === saved.current.trim()) return;
    saved.current = next;
    void changeTeammate(teammate.id, { instructions: next }).catch((cause) =>
      toast(errorMessage(cause)),
    );
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <textarea
      className="teammate-input"
      rows={3}
      value={value}
      aria-label="Instructions"
      placeholder="What should it always or never do?"
      maxLength={2000}
      onFocus={() => (focused.current = true)}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => save(next), 700);
      }}
      onBlur={() => {
        focused.current = false;
        save(value);
      }}
    />
  );
}

function Channels({ teammate }: { teammate: Teammate }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const assigned = teammate.teammate.channels;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const set = (channels: TeammateChannel[], done: string) =>
    void changeTeammate(teammate.id, { channels })
      .then(() => toast(done))
      .catch((cause) => toast(errorMessage(cause)));
  const available = teammateChannels.filter((channel) => !assigned.includes(channel));
  return (
    <span className="channel-wrap" ref={root}>
      {assigned.map((channel) => (
        <span key={channel} className="channel-chip">
          {channelLabels[channel]}
          <button
            type="button"
            aria-label={`Remove ${channelLabels[channel]}`}
            onClick={() =>
              set(
                assigned.filter((item) => item !== channel),
                `${channelLabels[channel]} goes to Nod again`,
              )
            }
          >
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <span className="channel-add">
          <button
            type="button"
            className="teammate-icon-button"
            aria-label="Add a channel"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          {open && (
            <span className="channel-menu" role="menu">
              {available.map((channel) => (
                <button
                  key={channel}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    set(
                      [...assigned, channel],
                      `${channelLabels[channel]} messages now go to ${teammate.name}`,
                    );
                  }}
                >
                  {channelLabels[channel]}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function MemoryRow({ teammate }: { teammate: Teammate }) {
  const [open, setOpen] = useState(false);
  const mode = teammate.teammate.memory;
  return (
    <div className={`panel-row${open ? ' panel-row-open' : ''}`}>
      <button
        type="button"
        className="panel-row-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Memory</span>
        <span className="panel-row-value">{memoryShort(mode)}</span>
        <ChevronRight size={14} className="panel-row-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="panel-row-body">
          <div className="panel-options" role="radiogroup" aria-label="Memory">
            {memoryModes.map((value) => (
              <label key={value} className="panel-option">
                <input
                  type="radio"
                  name={`memory-${teammate.id}`}
                  value={value}
                  checked={mode === value}
                  onChange={() =>
                    void changeTeammate(teammate.id, { memory: value }).catch((cause) =>
                      toast(errorMessage(cause)),
                    )
                  }
                />
                <div>
                  <b>{memoryLabels[value].title}</b>
                  <span>{memoryLabels[value].detail}</span>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TeammatePanel({ teammate, onClose }: { teammate?: Teammate; onClose(): void }) {
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRoot = useRef<HTMLSpanElement>(null);
  useEffect(() => setAvatarOpen(false), [teammate?.id]);
  useEffect(() => {
    if (!avatarOpen) return;
    const outside = (event: PointerEvent) => {
      if (!avatarRoot.current?.contains(event.target as Node)) setAvatarOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [avatarOpen]);
  const close = (
    <button
      type="button"
      className="teammate-icon-button"
      aria-label="Close settings"
      onClick={onClose}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
  return (
    <aside
      id="teammate-panel"
      className="teammate-panel"
      aria-label={teammate ? `${teammate.name} settings` : 'Nod settings'}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (avatarOpen) {
          event.stopPropagation();
          return setAvatarOpen(false);
        }
        onClose();
      }}
    >
      <div className="panel-head">
        <div className="panel-head-top">{close}</div>
        <div className="panel-identity">
          {teammate ? (
            <span className="avatar-wrap" ref={avatarRoot}>
              <button
                type="button"
                className="avatar-button"
                aria-expanded={avatarOpen}
                aria-label="Change avatar"
                onClick={() => setAvatarOpen((value) => !value)}
              >
                <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="lg" />
              </button>
              {avatarOpen && (
                <AvatarMenu teammate={teammate} onClose={() => setAvatarOpen(false)} />
              )}
            </span>
          ) : (
            <NodAvatar size="lg" />
          )}
          <div className="panel-identity-text">
            {teammate ? (
              <NameField teammate={teammate} />
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
        {teammate ? (
          <>
            <div className="panel-rows">
              <div className="panel-row">
                <label className="panel-row-head panel-row-still">
                  <span>Model</span>
                  <TeammateModel teammate={teammate} onError={toast} />
                </label>
              </div>
              <MemoryRow teammate={teammate} />
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Instructions</span>
                </div>
                <div className="panel-row-body">
                  <InstructionsField teammate={teammate} />
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Channels</span>
                  <Channels teammate={teammate} />
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
                every teammate’s actions go through its trust check.
              </span>
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

export function TeammateEmpty({ teammate }: { teammate: Teammate }): ReactNode {
  return (
    <div className="teammate-empty-chat">
      <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="lg" />
      <p>
        Hi, I’m {teammate.name}.
        {teammate.teammate.job
          ? ` I handle ${teammate.teammate.job.charAt(0).toLowerCase()}${teammate.teammate.job.slice(1)}.`
          : ''}{' '}
        What can I take off your plate?
      </p>
    </div>
  );
}
