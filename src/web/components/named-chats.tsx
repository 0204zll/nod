import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Activity, Task } from '../../shared/contracts';
import { taskLabels } from '../../shared/task-status';
import { LiveLine } from './live-line';
import { api, errorMessage } from '../lib/api';
import { chatPath, chatState, draftChatPath, type NamedChat } from '../lib/named-chats';
import { ChevronRight, Ellipsis, Plus } from './icons';
import { ActionMenu, ActionMenuItem } from './action-menu';

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

export const mainChatSubtitle = 'Briefings, reminders and messenger messages land here.';
export const sideChatSubtitle = 'Side chat. Same Nod, same memory and apps.';

export async function changeChat(id: string, body: object) {
  await api(`/api/chats/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ChatMenu({
  chat,
  trigger,
  onChanged,
  onRename,
  onDetails,
  onArchived,
  onError,
}: {
  chat: NamedChat;
  trigger: ReactNode;
  onChanged(): void;
  onRename(): void;
  onDetails?(): void;
  onArchived?(): void;
  onError(message: string): void;
}) {
  const active = chat.status === 'working' || chat.status === 'queued';
  const run = (work: Promise<unknown>) =>
    void work.then(onChanged).catch((cause) => onError(errorMessage(cause)));
  return (
    <ActionMenu label={`${chat.name} options`} trigger={trigger as React.ReactElement}>
      {(close) => (
        <>
          {onDetails && (
            <ActionMenuItem
              onClick={() => {
                close();
                onDetails();
              }}
            >
              Details
            </ActionMenuItem>
          )}
          <ActionMenuItem
            onClick={() => {
              close();
              onRename();
            }}
          >
            Rename
          </ActionMenuItem>
          <ActionMenuItem
            onClick={() => {
              close();
              run(changeChat(chat.id, { pinned: !chat.pinned }));
            }}
          >
            {chat.pinned ? 'Don’t keep' : 'Keep'}
          </ActionMenuItem>
          {active && (
            <ActionMenuItem
              onClick={() => {
                close();
                run(api(`/api/tasks/${chat.id}/stop`, { method: 'POST' }));
              }}
            >
              Stop
            </ActionMenuItem>
          )}
          <ActionMenuItem
            onClick={() => {
              close();
              const archiving = !chat.archivedAt;
              void changeChat(chat.id, { archived: archiving })
                .then(() => {
                  onChanged();
                  if (archiving) onArchived?.();
                })
                .catch((cause) => onError(errorMessage(cause)));
            }}
          >
            {chat.archivedAt ? 'Restore' : 'Archive'}
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );
}

function ChatMarker({ chat }: { chat: Task }) {
  const state = chatState(chat);
  if (state === 'working')
    return (
      <span className="chat-marker chat-marker-working">
        <span className="sr-only">working</span>
      </span>
    );
  if (state === 'needs')
    return (
      <span className="chat-marker chat-marker-needs">
        <span aria-hidden="true">?</span>
        <span className="sr-only">needs you</span>
      </span>
    );
  return null;
}

export function ChatList({
  chats,
  activeId,
  mainActive,
  mainWorking,
  mainUnread,
  draftActive = false,
  unread,
  earlier = [],
  onNavigate,
  onChanged,
}: {
  chats: NamedChat[];
  earlier?: NamedChat[];
  activeId?: string;
  mainActive: boolean;
  mainWorking: boolean;
  mainUnread: boolean;
  draftActive?: boolean;
  unread(chat: Task): boolean;
  onNavigate(path: string): void;
  onChanged(): void;
}) {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [showEarlier, setShowEarlier] = useState(false);
  const [error, setError] = useState('');
  const ids = chats.map((chat) => chat.id).join();
  useEffect(() => {
    const next = new Set(chats.map((chat) => chat.id));
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
  const row = (chat: NamedChat, old = false) => {
    const isUnread = !old && unread(chat);
    const state = old ? undefined : chatState(chat);
    const label = [
      chat.name,
      state === 'working' ? 'working' : state === 'needs' ? 'needs you' : null,
      isUnread ? 'new messages' : null,
    ]
      .filter(Boolean)
      .join(', ');
    return (
      <li key={chat.id} className={fresh.has(chat.id) ? 'chat-row-fresh' : undefined}>
        <a
          href={chatPath(chat.id)}
          className={[
            'panel-row chat-row',
            chat.id === activeId && 'panel-row-active',
            isUnread && 'chat-row-unread',
            old && 'chat-row-earlier',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={label}
          aria-current={chat.id === activeId ? 'page' : undefined}
          onClick={link(chatPath(chat.id))}
        >
          <span className="chat-row-name">{chat.name}</span>
          {!old && <ChatMarker chat={chat} />}
        </a>
        {!old && (
          <ChatMenu
            chat={chat}
            onChanged={onChanged}
            onError={setError}
            onRename={() => {
              onNavigate(chatPath(chat.id));
              window.setTimeout(
                () => window.dispatchEvent(new CustomEvent('nod:rename-chat', { detail: chat.id })),
                60,
              );
            }}
            trigger={
              <button type="button" className="chat-row-more" aria-label={`${chat.name} options`}>
                <Ellipsis size={16} aria-hidden="true" />
              </button>
            }
          />
        )}
      </li>
    );
  };
  return (
    <section className="chat-list" aria-label="Chats">
      <ul className="panel-rows">
        <li>
          <a
            href="/"
            className={[
              'panel-row chat-row',
              mainActive && 'panel-row-active',
              mainUnread && 'chat-row-unread',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-current={mainActive ? 'page' : undefined}
            onClick={link('/')}
          >
            <span className="chat-row-name">Main chat</span>
            {mainWorking && (
              <span className="chat-marker chat-marker-working">
                <span className="sr-only">working</span>
              </span>
            )}
          </a>
        </li>
        {chats.map((chat) => row(chat))}
        {draftActive && (
          <li className="chat-row-fresh">
            <a
              href={draftChatPath}
              className="panel-row chat-row panel-row-active"
              aria-current="page"
            >
              <span className="chat-row-name">New chat</span>
            </a>
          </li>
        )}
        <li>
          <a href={draftChatPath} className="panel-row panel-row-new" onClick={link(draftChatPath)}>
            <Plus size={16} aria-hidden="true" />
            <span>New chat</span>
          </a>
        </li>
        {earlier.length > 0 && (
          <li>
            <button
              type="button"
              className="panel-row chat-list-earlier"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((value) => !value)}
            >
              <ChevronRight size={14} aria-hidden="true" />
              Earlier
            </button>
          </li>
        )}
        {showEarlier && earlier.map((chat) => row(chat, true))}
      </ul>
      {error && (
        <p className="chat-list-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ChatLink({
  chat,
  continued,
  onOpen,
}: {
  chat: NamedChat;
  continued?: boolean;
  onOpen(path: string): void;
}) {
  return (
    <a
      href={chatPath(chat.id)}
      className="chat-link"
      onClick={(event) => {
        if (!plain(event)) return;
        event.preventDefault();
        onOpen(chatPath(chat.id));
      }}
    >
      {continued ? `Continued in ${chat.name}` : `Open ${chat.name}`}
      <ChatMarker chat={chat} />
    </a>
  );
}

export function ChatStatus({
  chat,
  live,
  request,
}: {
  chat: NamedChat;
  live?: Activity;
  request: string;
}) {
  const state = chatState(chat);
  if (state !== 'working' && state !== 'needs') return null;
  const title = chat.title.trim() === request.trim() ? '' : chat.title;
  return (
    <section className="chat-status" data-state={state} aria-label={title || chat.name}>
      <div className="chat-status-head">
        {title && <p className="chat-status-title">{title}</p>}
        <span className="chat-status-pill">{taskLabels[chat.status]}</span>
      </div>
      <div className="chat-status-now">
        {state === 'working' ? <LiveLine item={live} /> : 'Waiting for your answer below.'}
      </div>
    </section>
  );
}

export function ContinueLink({
  messageId,
  onOpen,
}: {
  messageId: string;
  onOpen(path: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="chat-link"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void api<Task>('/api/chats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: messageId }),
          })
            .then((chat) => onOpen(chatPath(chat.id)))
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setBusy(false));
        }}
      >
        Continue in a side chat
      </button>
      {error && (
        <p className="chat-link-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function CarriedNote({ messageId, onOpen }: { messageId: string; onOpen(): void }) {
  return (
    <p className="chat-carried">
      Carried over from Main chat: your request and Nod’s answer.{' '}
      <a
        href="/"
        onClick={(event) => {
          if (!plain(event)) return;
          event.preventDefault();
          onOpen();
          window.setTimeout(
            () =>
              window.dispatchEvent(new CustomEvent('nod:focus-message', { detail: { messageId } })),
            120,
          );
        }}
      >
        Show
      </a>
    </p>
  );
}

export function FromMainLink({ messageId, onOpen }: { messageId: string; onOpen(): void }) {
  return (
    <a
      href="/"
      className="chat-from-main"
      onClick={(event) => {
        if (!plain(event)) return;
        event.preventDefault();
        onOpen();
        window.setTimeout(
          () =>
            window.dispatchEvent(new CustomEvent('nod:focus-message', { detail: { messageId } })),
          120,
        );
      }}
    >
      From Main chat
    </a>
  );
}

export function ChatHeader({
  chat,
  main = false,
  onChanged,
  onDetails,
  onLeave,
  toolsRef,
}: {
  chat?: NamedChat;
  main?: boolean;
  onDetails?(): void;
  onLeave?(): void;
  toolsRef?(element: HTMLDivElement | null): void;
  onChanged?(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chat?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setName(chat?.name ?? '');
  }, [chat?.name, editing]);
  useEffect(() => {
    if (!chat) return;
    const rename = (event: Event) => {
      if ((event as CustomEvent<string>).detail === chat.id) setEditing(true);
    };
    window.addEventListener('nod:rename-chat', rename);
    return () => window.removeEventListener('nod:rename-chat', rename);
  }, [chat?.id]);
  async function save() {
    const next = name.trim();
    if (!chat || !next || next === chat.name) return setEditing(false);
    setBusy(true);
    setError('');
    try {
      await changeChat(chat.id, { name: next });
      setEditing(false);
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <header className="chat-header">
      <div className="chat-header-copy">
        {main ? (
          <h1>Main chat</h1>
        ) : !chat ? (
          <h1>New chat</h1>
        ) : editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={24}
              aria-label="Chat name"
              disabled={busy}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                setEditing(false);
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
        <p role={error ? 'alert' : undefined}>
          {error || (main ? mainChatSubtitle : sideChatSubtitle)}
        </p>
      </div>
      <div className="chat-header-tools" ref={toolsRef} />
      {chat && (
        <ChatMenu
          chat={chat}
          onChanged={() => onChanged?.()}
          onArchived={onLeave}
          onError={setError}
          onRename={() => setEditing(true)}
          onDetails={onDetails}
          trigger={
            <button
              type="button"
              className="chat-header-action"
              aria-label={`${chat.name} options`}
            >
              <Ellipsis size={18} aria-hidden="true" />
            </button>
          }
        />
      )}
    </header>
  );
}
