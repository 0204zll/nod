import * as Popover from '@radix-ui/react-popover';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
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
  teammateInstructionsLimit,
  teammateMarks,
  type MemoryMode,
  type TeammateAvatar as Avatar,
  type TeammateChannel,
} from '../../shared/teammates';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import type { ChannelSettings } from '../lib/secondary-pages';
import { teammateLine, teammatePath, teammateState, type Teammate } from '../lib/teammates';
import { ActionMenu, ActionMenuItem, ActionMenuSurface, focusActionMenuItem } from './action-menu';
import { ChevronDown, LockKeyhole, MessageSquare, Plus, Settings, Trash2, X } from './icons';
import { InlineName } from './inline-name';
import { NodModel, TeammateModel } from './model-choices';
import { Tabs } from './tabs';
import { NodAvatar, TeammateAvatar } from './teammate-avatar';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Notice } from './ui';

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

type ToastValue = { text: string; kind: 'success' | 'error' };

export function toast(text: string, kind: ToastValue['kind'] = 'success') {
  window.dispatchEvent(new CustomEvent<ToastValue>('nod:toast', { detail: { text, kind } }));
}

export const toastError = (cause: unknown) => toast(errorMessage(cause), 'error');

export function Toasts() {
  const [value, setValue] = useState<ToastValue>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      const next = (event as CustomEvent<ToastValue>).detail;
      setValue(next);
      setOpen(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOpen(false), next.kind === 'error' ? 6000 : 2600);
    };
    window.addEventListener('nod:toast', show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('nod:toast', show);
    };
  }, []);
  return value ? (
    <div
      className="teammate-toast"
      data-open={open || undefined}
      inert={!open || undefined}
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget && event.propertyName === 'opacity')
          setValue(undefined);
      }}
    >
      <Notice kind={value.kind} onDismiss={() => setOpen(false)}>
        {value.text}
      </Notice>
    </div>
  ) : null;
}

const teammatesChanged = () => window.dispatchEvent(new Event('nod:teammates-changed'));

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

function RemoveTeammate({
  teammate,
  open,
  onOpenChange,
  onRemoved,
}: {
  teammate: Teammate;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRemoved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  const goes = [
    'Its chat',
    teammate.teammate.memory === 'shared' ? '' : ' and its own notes',
    ' go with it.',
    teammate.teammate.channels.length ? ' Its channels go back to Nod.' : '',
  ].join('');
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent className="teammate-remove-dialog">
        <DialogTitle>Remove {teammate.name}?</DialogTitle>
        <DialogDescription>{goes}</DialogDescription>
        {error && <Notice>{error}</Notice>}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void api(`/api/teammates/${teammate.id}`, { method: 'DELETE' })
                .then(() => {
                  teammatesChanged();
                  onOpenChange(false);
                  toast(`Removed ${teammate.name}`);
                  onRemoved();
                })
                .catch((cause) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Removing…' : `Remove ${teammate.name}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RowMarker({ teammate, unread }: { teammate: Teammate; unread: boolean }) {
  const state = teammateState(teammate);
  if (state === 'needs' && teammate.teammate.job)
    return <span className="teammate-dot teammate-dot-needs" aria-hidden="true" />;
  if (unread) return <span className="teammate-dot" aria-hidden="true" />;
  if (state === 'working')
    return <span className="teammate-dot teammate-dot-working" aria-hidden="true" />;
  return null;
}

function RowMenu({
  teammate,
  point,
  anchor,
  onClose,
  onOpen,
  onSettings,
  onRemove,
}: {
  teammate: Teammate;
  point: { x: number; y: number };
  anchor: HTMLElement;
  onClose(): void;
  onOpen(): void;
  onSettings(): void;
  onRemove(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    setPosition({
      left: Math.min(point.x, window.innerWidth - element.offsetWidth - 8),
      top: Math.min(point.y, window.innerHeight - element.offsetHeight - 8),
    });
    focusActionMenuItem(element.querySelector<HTMLElement>('[role="menuitem"]'));
  }, [point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      onClose();
      if (event.key === 'Escape') anchor.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, anchor]);
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return createPortal(
    <ActionMenuSurface
      ref={menu}
      className="action-menu-compact teammate-row-menu"
      aria-label={`${teammate.name} options`}
      style={position}
    >
      <ActionMenuItem onClick={run(onOpen)}>
        <MessageSquare size={16} aria-hidden="true" />
        Open chat
      </ActionMenuItem>
      <ActionMenuItem onClick={run(onSettings)}>
        <Settings size={16} aria-hidden="true" />
        Settings
      </ActionMenuItem>
      <ActionMenuItem destructive onClick={run(onRemove)}>
        <Trash2 size={16} aria-hidden="true" />
        Remove
      </ActionMenuItem>
    </ActionMenuSurface>,
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
  const [menu, setMenu] = useState<{
    teammate: Teammate;
    point: { x: number; y: number };
    anchor: HTMLElement;
  }>();
  const [removing, setRemoving] = useState<Teammate>();
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
      toastError(cause);
    } finally {
      setCreating(false);
    }
  }
  return (
    <nav className="teammate-nav" aria-label="Chats">
      <a
        href="/"
        className="teammate-item teammate-brand"
        aria-current={mainActive ? 'page' : undefined}
        aria-label={['Chat with Nod', nodWorking ? 'working' : null, nodUnread ? 'unread' : null]
          .filter(Boolean)
          .join(', ')}
        onClick={link('/')}
      >
        <NodAvatar />
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
          <Button
            variant="ghost"
            size="icon"
            title="New teammate"
            aria-label="New teammate"
            tooltipSide="right"
            disabled={creating}
            onClick={() => void add()}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </div>
        {teammates.length > 0 && (
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
                    aria-haspopup="menu"
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
                      setMenu({
                        teammate,
                        point: { x: event.clientX, y: event.clientY },
                        anchor: event.currentTarget,
                      });
                    }}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                        return;
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      setMenu({
                        teammate,
                        point: { x: box.left + 24, y: box.bottom },
                        anchor: event.currentTarget as HTMLElement,
                      });
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
        )}
      </div>
      <div className="teammate-foot">
        <button
          type="button"
          className="teammate-item"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={onSettings}
        >
          <span className="teammate-icon" aria-hidden="true">
            <Settings size={18} />
          </span>
          <span className="teammate-name">Settings</span>
        </button>
      </div>
      {menu && (
        <RowMenu
          teammate={menu.teammate}
          point={menu.point}
          anchor={menu.anchor}
          onClose={() => setMenu(undefined)}
          onOpen={() => onNavigate(teammatePath(menu.teammate.id))}
          onSettings={() => onOpenPanel(menu.teammate.id)}
          onRemove={() => setRemoving(menu.teammate)}
        />
      )}
      {removing && (
        <RemoveTeammate
          teammate={removing}
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          onRemoved={() => {
            if (removing.id === activeId) onNavigate('/');
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
  return (
    <header className="chat-top">
      <h1 className="chat-pill-wrap">
        <button
          type="button"
          className="chat-pill"
          aria-expanded={panelOpen}
          aria-controls="teammate-panel"
          aria-label={`${teammate?.name ?? 'Nod'} settings`}
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

const hueWords: Array<[RegExp, (typeof teammateHues)[number]]> = [
  [/pink|rose|red|coral|magenta/i, 'pink'],
  [/purple|violet|lilac|lavender|indigo/i, 'lilac'],
  [/green|mint|sage|forest|olive|teal/i, 'green'],
  [/yellow|orange|amber|gold|sun|warm|peach/i, 'amber'],
  [/blue|sky|ocean|sea|navy|cyan/i, 'sky'],
  [/gr[ae]y|silver|mono|black|white|neutral/i, 'gray'],
];
const gradients: Record<(typeof teammateHues)[number], [string, string]> = {
  pink: ['#ff91ac', '#87003c'],
  lilac: ['#b9a7ff', '#4b2bb3'],
  green: ['#8fd3a7', '#1d6b3f'],
  amber: ['#ffd27a', '#9a5b00'],
  sky: ['#9ad2ff', '#0b5394'],
  gray: ['#d6d6d6', '#464646'],
};

function generatedAvatar(name: string, description: string, fallback: Avatar['hue']) {
  const hue = hueWords.find(([pattern]) => pattern.test(description))?.[1] ?? fallback;
  const seed = [...description].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
  const [from, to] = gradients[hue];
  const glyph = [...name.trim()][0]?.toUpperCase() ?? '?';
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const radians = ((seed % 360) * Math.PI) / 180;
  const gradient = context.createLinearGradient(
    128 - Math.cos(radians) * 128,
    128 - Math.sin(radians) * 128,
    128 + Math.cos(radians) * 128,
    128 + Math.sin(radians) * 128,
  );
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  for (let index = 0; index < 3; index++) {
    const x = ((seed >>> (index * 5)) % 200) + 28;
    const y = ((seed >>> (index * 7 + 3)) % 200) + 28;
    context.fillStyle = `rgba(255,255,255,${0.08 + index * 0.04})`;
    context.beginPath();
    context.arc(x, y, 40 + ((seed >>> index) % 50), 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = 'rgba(255,255,255,0.94)';
  context.font = '600 112px Geist, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(glyph, 128, 136);
  return { hue, image: canvas.toDataURL('image/webp', 0.9) };
}

const avatarTabs = [
  { value: 'avatar', label: 'Avatar' },
  { value: 'generate', label: 'Generate' },
  { value: 'upload', label: 'Upload' },
] as const;

function AvatarPicker({ teammate }: { teammate: Teammate }) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof avatarTabs)[number]['value']>('avatar');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const avatar = teammate.teammate.avatar;
  const save = (next: Avatar, done?: string) => {
    setBusy(true);
    void changeTeammate(teammate.id, { avatar: next })
      .then(() => done && toast(done))
      .catch(toastError)
      .finally(() => setBusy(false));
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="avatar-button" aria-label="Change avatar">
        <TeammateAvatar name={teammate.name} avatar={avatar} size="lg" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="menu avatar-menu"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Change avatar"
        >
          <Tabs
            id={id}
            panelId={`${id}-panel`}
            label="Avatar source"
            size="compact"
            items={avatarTabs}
            value={tab}
            onValueChange={setTab}
          />
          <div id={`${id}-panel`} role="tabpanel" className="avatar-panel">
            {tab === 'avatar' ? (
              <>
                <div className="avatar-pick" role="group" aria-label="Shape">
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
                <div className="avatar-swatches" role="group" aria-label="Color">
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
                className="avatar-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = description.trim();
                  if (value)
                    save(generatedAvatar(teammate.name, value, avatar.hue), 'Avatar generated');
                }}
              >
                <textarea
                  className="input"
                  rows={2}
                  value={description}
                  aria-label="Colors"
                  placeholder="Calm blue, a warm sunset…"
                  onChange={(event) => setDescription(event.target.value)}
                />
                <Button size="sm" type="submit" disabled={busy || !description.trim()}>
                  Generate
                </Button>
              </form>
            ) : (
              <div className="avatar-form">
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    event.target.value = '';
                    if (!chosen) return;
                    void resizedImage(chosen)
                      .then((image) => save({ hue: avatar.hue, image }, 'Avatar updated'))
                      .catch(toastError);
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => file.current?.click()}
                >
                  Choose image…
                </Button>
                <span className="field-hint">PNG, JPG or WebP. Square works best.</span>
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
    void changeTeammate(teammate.id, { instructions: next }).catch(toastError);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Field label="Instructions" hint="They guide its work and never approve an action.">
      <textarea
        className="input"
        rows={3}
        value={value}
        placeholder="What should it always or never do?"
        maxLength={teammateInstructionsLimit}
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
    </Field>
  );
}

function MenuValue({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button {...props} variant="ghost" size="sm" className="teammate-setting-value">
      <span>{children}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </Button>
  );
}

function MemoryMenu({ teammate }: { teammate: Teammate }) {
  const mode = teammate.teammate.memory;
  const choose = (value: MemoryMode) =>
    value !== mode && void changeTeammate(teammate.id, { memory: value }).catch(toastError);
  return (
    <ActionMenu
      label={`Memory: ${memoryLabels[mode].title}`}
      trigger={<MenuValue>{memoryLabels[mode].title.split(',')[0]}</MenuValue>}
      contentClassName="teammate-setting-menu"
    >
      {(close) =>
        memoryModes.map((value) => (
          <ActionMenuItem
            key={value}
            checked={mode === value}
            onClick={() => {
              close();
              choose(value);
            }}
          >
            <span>
              {memoryLabels[value].title}
              <small>{memoryLabels[value].detail}</small>
            </span>
          </ActionMenuItem>
        ))
      }
    </ActionMenu>
  );
}

function ChannelMenu({ teammate, others }: { teammate: Teammate; others: Teammate[] }) {
  const settings = usePageData<ChannelSettings>('/api/channel-settings');
  const connected = new Set(
    settings.data?.channels.filter((item) => item.enabled).map((item) => item.provider) ?? [],
  );
  const assigned = teammate.teammate.channels;
  const toggle = (channel: TeammateChannel) => {
    const on = assigned.includes(channel);
    void changeTeammate(teammate.id, {
      channels: on ? assigned.filter((item) => item !== channel) : [...assigned, channel],
    })
      .then(() =>
        toast(
          on
            ? `${channelLabels[channel]} goes to Nod again`
            : `${channelLabels[channel]} messages now go to ${teammate.name}`,
        ),
      )
      .catch(toastError);
  };
  return (
    <ActionMenu
      label={`Channels: ${assigned.map((channel) => channelLabels[channel]).join(', ') || 'None'}`}
      trigger={
        <MenuValue>
          {assigned.map((channel) => channelLabels[channel]).join(', ') || 'None'}
        </MenuValue>
      }
      contentClassName="teammate-setting-menu"
    >
      {(close) =>
        teammateChannels.map((channel) => {
          const on = assigned.includes(channel);
          const holder = others.find((item) => item.teammate.channels.includes(channel));
          const ready = on || connected.has(channel);
          return (
            <ActionMenuItem
              key={channel}
              checked={on}
              aria-disabled={!ready}
              onClick={() => {
                close();
                toggle(channel);
              }}
            >
              <span>
                {channelLabels[channel]}
                <small>
                  {on
                    ? `Comes to ${teammate.name}`
                    : !ready
                      ? 'Not connected'
                      : `Now with ${holder?.name ?? 'Nod'}`}
                </small>
              </span>
            </ActionMenuItem>
          );
        })
      }
    </ActionMenu>
  );
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="account-preference-row teammate-setting">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function TeammatePanel({
  teammate,
  teammates,
  onClose,
  onRemoved,
}: {
  teammate?: Teammate;
  teammates: Teammate[];
  onClose(): void;
  onRemoved(): void;
}) {
  const [removing, setRemoving] = useState(false);
  useEffect(() => setRemoving(false), [teammate?.id]);
  return (
    <aside
      id="teammate-panel"
      className="teammate-panel"
      aria-label={teammate ? `${teammate.name} settings` : 'Nod settings'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
    >
      <div className="panel-head">
        <Button
          variant="ghost"
          size="icon"
          className="panel-close"
          title="Close"
          aria-label="Close settings"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </Button>
        <div className="panel-identity">
          {teammate ? <AvatarPicker teammate={teammate} /> : <NodAvatar size="lg" />}
          <div className="panel-identity-text">
            <div className="panel-name">
              {teammate ? (
                <InlineName
                  value={teammate.name}
                  label="name"
                  save={async (name) => {
                    await changeTeammate(teammate.id, { name });
                  }}
                />
              ) : (
                'Nod'
              )}
            </div>
            <p>{teammate ? teammate.teammate.job || 'Setting up' : 'Your main assistant'}</p>
          </div>
        </div>
      </div>
      <div className="panel-body">
        {teammate ? (
          <>
            <div className="teammate-settings">
              <Setting label="Model">
                <TeammateModel teammate={teammate} />
              </Setting>
              <Setting label="Memory">
                <MemoryMenu teammate={teammate} />
              </Setting>
              <Setting label="Channels">
                <ChannelMenu
                  teammate={teammate}
                  others={teammates.filter((item) => item.id !== teammate.id)}
                />
              </Setting>
            </div>
            <InstructionsField key={teammate.id} teammate={teammate} />
            <button type="button" className="teammate-remove" onClick={() => setRemoving(true)}>
              Remove {teammate.name}
            </button>
            <RemoveTeammate
              teammate={teammate}
              open={removing}
              onOpenChange={setRemoving}
              onRemoved={onRemoved}
            />
          </>
        ) : (
          <>
            <div className="teammate-settings">
              <Setting label="Model">
                <NodModel />
              </Setting>
              <Setting label="Apps">
                <span className="teammate-setting-text">All connected apps</span>
              </Setting>
              <Setting label="Memory">
                <span className="teammate-setting-text">Yours</span>
              </Setting>
            </div>
            <p className="panel-note field-hint">
              <LockKeyhole size={14} aria-hidden="true" />
              <span>
                Nod holds your Vault, approvals and settings, and every teammate’s actions go
                through its trust check.
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
        {teammate.teammate.job
          ? `Hi, I’m ${teammate.name}. What can I take off your plate?`
          : 'Getting ready…'}
      </p>
    </div>
  );
}
