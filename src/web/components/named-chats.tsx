import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Task } from '../../shared/contracts';
import { taskLabels } from '../../shared/task-status';
import { api, errorMessage } from '../lib/api';
import {
  chatDot,
  chatHue,
  chatLine,
  chatPath,
  type ChatDot,
  type NamedChat,
} from '../lib/named-chats';
import { Tooltip } from './tooltip';
import { ActionMenu, ActionMenuItem } from './action-menu';

const dotLabels: Record<NonNullable<ChatDot>, string> = {
  needs: 'Needs you',
  failed: 'Failed',
  unread: 'New messages',
  working: 'Working',
};

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

export function ChatTile({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`chat-tile chat-tile-${size}`}
      style={{ '--chat-hue': chatHue(name) } as React.CSSProperties}
      aria-hidden="true"
    >
      {[...name][0]?.toUpperCase()}
    </span>
  );
}

export function ChatDotMark({ dot }: { dot: ChatDot }) {
  if (!dot) return null;
  return <span className={`chat-dot chat-dot-${dot}`} role="img" aria-label={dotLabels[dot]} />;
}

export function ChatList({
  chats,
  activeId,
  unread,
  drafts,
  earlier = [],
  onNavigate,
  onCreated,
}: {
  chats: NamedChat[];
  earlier?: NamedChat[];
  activeId?: string;
  unread(chat: Task): boolean;
  drafts: Record<string, string>;
  onNavigate(path: string): void;
  onCreated(chat: Task): void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('nod:new-chat', open);
    return () => window.removeEventListener('nod:new-chat', open);
  }, []);
  async function create() {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    setCreateError('');
    try {
      const chat = await api<Task>('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setCreating(false);
      setNewName('');
      onCreated(chat);
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(chats.map((chat) => chat.id));
    if (known.current) {
      const added = [...ids].filter((id) => !known.current!.has(id));
      if (added.length) {
        setFresh(new Set(added));
        const timer = window.setTimeout(() => setFresh(new Set()), 1600);
        known.current = ids;
        return () => window.clearTimeout(timer);
      }
    }
    known.current = ids;
  }, [chats.map((chat) => chat.id).join()]);
  const [showEarlier, setShowEarlier] = useState(false);
  const row = (chat: NamedChat, old = false) => {
    const draft = old ? undefined : drafts[chat.id];
    const dot = old ? undefined : chatDot(chat, unread(chat));
    return (
      <li key={chat.id} className={fresh.has(chat.id) ? 'chat-row-fresh' : undefined}>
        <a
          href={chatPath(chat.id)}
          className={`chat-row ${chat.id === activeId ? 'chat-row-active' : ''} ${old ? 'chat-row-earlier' : ''}`}
          aria-current={chat.id === activeId ? 'page' : undefined}
          title={`${chat.name}: ${chatLine(chat)}`}
          onClick={(event) => {
            if (!plain(event)) return;
            event.preventDefault();
            onNavigate(chatPath(chat.id));
          }}
        >
          <ChatTile name={chat.name} />
          <span className="chat-row-copy">
            <strong>{chat.name}</strong>
            <small>
              {draft ? (
                <>
                  <em>Draft</em> {draft}
                </>
              ) : chat.archivedAt ? (
                'Archived'
              ) : (
                chatLine(chat) || (chat.chatOnly?.count ? '' : 'New chat')
              )}
            </small>
          </span>
          <ChatDotMark dot={dot} />
        </a>
      </li>
    );
  };
  return (
    <section className="chat-list" aria-label="Chats">
      <ul>
        {chats.map((chat) => row(chat))}
        <li>
          {creating ? (
            <form
              className="chat-new-form"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <input
                autoFocus
                value={newName}
                maxLength={24}
                placeholder="Name"
                aria-label="New chat name"
                aria-invalid={Boolean(createError)}
                disabled={saving}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setCreateError('');
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.stopPropagation();
                  setCreating(false);
                  setNewName('');
                  setCreateError('');
                }}
              />
              {createError && <p role="alert">{createError}</p>}
            </form>
          ) : (
            <button
              type="button"
              className="chat-row chat-row-new"
              onClick={() => setCreating(true)}
            >
              <span className="chat-tile chat-tile-new" aria-hidden="true">
                +
              </span>
              <span className="chat-row-copy">
                <strong>New chat</strong>
              </span>
            </button>
          )}
        </li>
        {earlier.length > 0 && (
          <li>
            <button
              type="button"
              className="chat-list-earlier"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((value) => !value)}
            >
              Earlier
              <span>{earlier.length}</span>
            </button>
          </li>
        )}
        {showEarlier && earlier.map((chat) => row(chat, true))}
      </ul>
    </section>
  );
}

export function ChatCard({
  chat,
  unread,
  onOpen,
}: {
  chat: NamedChat;
  unread: boolean;
  onOpen(path: string): void;
}) {
  return (
    <a
      href={chatPath(chat.id)}
      className="chat-card"
      onClick={(event) => {
        if (!plain(event)) return;
        event.preventDefault();
        onOpen(chatPath(chat.id));
      }}
    >
      <ChatTile name={chat.name} size="lg" />
      <span className="chat-card-copy">
        <strong>{chat.name}</strong>
        <small>{chatLine(chat)}</small>
      </span>
      <span className={`chat-card-state chat-card-state-${chat.status}`}>
        {unread ? `New in ${chat.name}` : taskLabels[chat.status]}
      </span>
    </a>
  );
}

export function ChatHeader({
  chat,
  onBack,
  onChanged,
  onLeave,
  onDetails,
  toolsRef,
}: {
  chat: NamedChat;
  onDetails(): void;
  toolsRef?(element: HTMLDivElement | null): void;
  onBack(): void;
  onChanged(): void;
  onLeave(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chat.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setName(chat.name);
  }, [chat.name, editing]);
  async function change(body: object, leave = false) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setEditing(false);
      onChanged();
      if (leave) onLeave();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const active = chat.status === 'working' || chat.status === 'queued';
  return (
    <header className="chat-header">
      <button type="button" className="chat-header-back" aria-label="Back to Nod" onClick={onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14 6-6 6 6 6" />
        </svg>
      </button>
      <ChatTile name={chat.name} size="lg" />
      <div className="chat-header-copy">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== chat.name) void change({ name: name.trim() });
              else setEditing(false);
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={24}
              aria-label="Chat name"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(false);
              }}
            />
          </form>
        ) : (
          <h1>
            <button type="button" onClick={() => setEditing(true)} title="Rename">
              {chat.name}
            </button>
          </h1>
        )}
        <p>{error || chatLine(chat)}</p>
      </div>
      {chat.pinned && (
        <svg className="chat-header-pin" viewBox="0 0 24 24" role="img" aria-label="Pinned">
          <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Zm3 9v7" />
        </svg>
      )}
      <span className={`chat-card-state chat-card-state-${chat.status}`}>
        {chat.status === 'done' || chat.status === 'cancelled' ? '' : taskLabels[chat.status]}
      </span>
      <div className="chat-header-tools" ref={toolsRef} />
      <ActionMenu
        label={`${chat.name} options`}
        trigger={
          <button type="button" className="chat-header-action" aria-label={`${chat.name} options`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
            </svg>
          </button>
        }
      >
        {(close) => (
          <>
            <ActionMenuItem
              onClick={() => {
                close();
                onDetails();
              }}
            >
              Details
            </ActionMenuItem>
            <ActionMenuItem
              onClick={() => {
                close();
                setEditing(true);
              }}
            >
              Rename
            </ActionMenuItem>
            <ActionMenuItem
              disabled={busy}
              onClick={() => {
                close();
                void change({ pinned: !chat.pinned });
              }}
            >
              {chat.pinned ? 'Unpin' : 'Pin'}
            </ActionMenuItem>
            {active && (
              <ActionMenuItem
                disabled={busy}
                onClick={() => {
                  close();
                  void api(`/api/tasks/${chat.id}/stop`, { method: 'POST' })
                    .then(onChanged)
                    .catch((cause) => setError(errorMessage(cause)));
                }}
              >
                Stop
              </ActionMenuItem>
            )}
            <ActionMenuItem
              disabled={busy}
              onClick={() => {
                close();
                void change({ archived: !chat.archivedAt }, !chat.archivedAt);
              }}
            >
              {chat.archivedAt ? 'Restore' : 'Archive'}
            </ActionMenuItem>
          </>
        )}
      </ActionMenu>
    </header>
  );
}
