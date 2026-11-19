import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Activity, Task } from '../../shared/contracts';
import { taskLabels } from '../../shared/task-status';
import { api, errorMessage } from '../lib/api';
import {
  chatLine,
  chatPath,
  chatState,
  draftChatPath,
  elapsed,
  firstParagraphMarkdown,
  relativeTime,
  type ChatState,
  type NamedChat,
} from '../lib/named-chats';
import { BrandMark } from './brand';
import { ArrowUpRight, ChevronRight, CornerUpLeft, Ellipsis, Plus } from './icons';
import { ActionMenu, ActionMenuItem } from './action-menu';

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

function useNow(enabled: boolean, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [enabled, every]);
  return now;
}

const spinDelay = () => ({ '--chat-spin-delay': `-${Date.now() % 1400}ms` }) as React.CSSProperties;

export function ChatAvatar({
  name,
  state,
  size = 'md',
  draft = false,
}: {
  name?: string;
  state?: ChatState;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  draft?: boolean;
}) {
  return (
    <span
      className={`chat-avatar chat-avatar-${size}${state ? ` chat-avatar-${state}` : ''}${draft ? ' chat-avatar-draft' : ''}`}
      style={state === 'working' ? spinDelay() : undefined}
      aria-hidden="true"
    >
      {draft ? null : name === undefined ? <BrandMark small /> : [...name][0]?.toUpperCase()}
    </span>
  );
}

const stateLabels: Record<NonNullable<ChatState>, string> = {
  working: 'working',
  needs: 'needs you',
  failed: 'failed',
};

function PinMark() {
  return (
    <svg className="chat-pin" viewBox="0 0 24 24" role="img" aria-label="Pinned">
      <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Zm3 9v7" />
    </svg>
  );
}

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
            {chat.pinned ? 'Unpin' : 'Pin'}
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

export function ChatList({
  chats,
  activeId,
  draftActive = false,
  unread,
  live,
  drafts,
  earlier = [],
  onNavigate,
  onChanged,
}: {
  chats: NamedChat[];
  earlier?: NamedChat[];
  activeId?: string;
  draftActive?: boolean;
  unread(chat: Task): boolean;
  live(chat: Task): Activity | undefined;
  drafts: Record<string, string>;
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
  const anyWorking = chats.some((chat) => chatState(chat) === 'working');
  const now = useNow(true, anyWorking ? 15_000 : 60_000);
  const row = (chat: NamedChat, old = false) => {
    const state = old ? undefined : chatState(chat);
    const isUnread = !old && unread(chat);
    const draft = old ? undefined : drafts[chat.id];
    const line = draft ?? chatLine(chat, live(chat));
    const time = state
      ? ''
      : relativeTime(chat.chatOnly?.latestAt ?? chat.closedAt ?? chat.updatedAt, now);
    const label = [chat.name, state ? stateLabels[state] : null, isUnread ? 'new messages' : null]
      .filter(Boolean)
      .join(', ');
    return (
      <li key={chat.id} className={fresh.has(chat.id) ? 'chat-row-fresh' : undefined}>
        <a
          href={chatPath(chat.id)}
          className={[
            'chat-row',
            chat.id === activeId && 'chat-row-active',
            state === 'needs' && 'chat-row-needs',
            isUnread && 'chat-row-unread',
            old && 'chat-row-earlier',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={label}
          aria-current={chat.id === activeId ? 'page' : undefined}
          onClick={(event) => {
            if (!plain(event)) return;
            event.preventDefault();
            onNavigate(chatPath(chat.id));
          }}
        >
          <ChatAvatar name={chat.name} state={state} />
          <span className="chat-row-name">{chat.name}</span>
          <span className="chat-row-meta">
            {chat.pinned && <PinMark />}
            {time}
          </span>
          <span className={`chat-row-line${state === 'working' && !draft ? ' chat-live' : ''}`}>
            {draft ? (
              <>
                <em>Draft</em> {draft}
              </>
            ) : (
              line
            )}
          </span>
          {isUnread && <span className="chat-row-dot" aria-hidden="true" />}
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
      <ul>
        {draftActive && (
          <li className="chat-row-fresh">
            <a href={draftChatPath} className="chat-row chat-row-active" aria-current="page">
              <ChatAvatar draft />
              <span className="chat-row-name chat-row-name-draft">New chat</span>
            </a>
          </li>
        )}
        {chats.map((chat) => row(chat))}
        {!draftActive && (
          <li>
            <a
              href={draftChatPath}
              className="chat-row chat-row-new"
              onClick={(event) => {
                if (!plain(event)) return;
                event.preventDefault();
                onNavigate(draftChatPath);
              }}
            >
              <span className="chat-avatar chat-avatar-md chat-avatar-add" aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className="chat-row-name">New chat</span>
            </a>
          </li>
        )}
        {earlier.length > 0 && (
          <li>
            <button
              type="button"
              className="chat-list-earlier"
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

export function ChatCard({
  chat,
  live,
  unread,
  showQuestion = true,
  onOpen,
  onReply,
}: {
  chat: NamedChat;
  live?: Activity;
  unread: boolean;
  showQuestion?: boolean;
  onOpen(path: string): void;
  onReply?(): void;
}) {
  const state = chatState(chat);
  const now = useNow(state === 'working');
  const open = (event: MouseEvent) => {
    if (!plain(event)) return;
    event.preventDefault();
    onOpen(chatPath(chat.id));
  };
  const working = state === 'working';
  const finished =
    chat.status === 'done' || chat.status === 'cancelled' || chat.status === 'failed';
  const outcome = finished
    ? firstParagraphMarkdown(chat.result || chat.lastReply || chat.now || '')
    : '';
  const meta = working
    ? live
      ? elapsed(live.since, now)
      : ''
    : state === 'needs'
      ? 'Needs you'
      : finished
        ? taskLabels[chat.status]
        : chat.status === 'waiting' || chat.status === 'scheduled'
          ? taskLabels[chat.status]
          : '';
  return (
    <article
      className={`chat-card${state ? ` chat-card-${state}` : ''}${finished ? ' chat-card-finished' : ''}${unread ? ' chat-card-unread' : ''}`}
      data-chat-card={chat.id}
    >
      <ChatAvatar name={chat.name} state={state} size="lg" />
      <a href={chatPath(chat.id)} className="chat-card-name" onClick={open}>
        {chat.name}
      </a>
      <span className="chat-card-meta">
        {meta}
        {working && <ChevronRight size={14} aria-hidden="true" />}
      </span>
      <span className={`chat-card-line${working ? ' chat-live' : ''}`}>
        {working ? chatLine(chat, live) : chat.title === chat.name ? '' : chat.title}
      </span>
      {state === 'needs' && showQuestion && chat.question && <CardText text={chat.question} />}
      {finished && outcome && <CardText text={outcome} />}
      {(state === 'needs' || finished) && (
        <div className="chat-card-actions">
          {state === 'needs' && onReply && (
            <button type="button" className="chat-button chat-button-primary" onClick={onReply}>
              <CornerUpLeft size={15} aria-hidden="true" />
              Reply
            </button>
          )}
          <a href={chatPath(chat.id)} className="chat-button" onClick={open}>
            Open {chat.name}
            <ChevronRight size={15} aria-hidden="true" />
          </a>
        </div>
      )}
    </article>
  );
}

function CardText({ text }: { text: string }) {
  return (
    <p className="chat-card-body">
      <Markdown allowedElements={['strong', 'em', 'code']} unwrapDisallowed>
        {firstParagraphMarkdown(text, 600)}
      </Markdown>
    </p>
  );
}

export function ChatReceipt({ chat, onOpen }: { chat: NamedChat; onOpen(path: string): void }) {
  return (
    <a
      href={chatPath(chat.id)}
      className="chat-receipt"
      onClick={(event) => {
        if (!plain(event)) return;
        event.preventDefault();
        onOpen(chatPath(chat.id));
      }}
    >
      <ArrowUpRight size={13} aria-hidden="true" />
      <ChatAvatar name={chat.name} state={chatState(chat)} size="xs" />
      {chat.name}
    </a>
  );
}

export function FromNodLink({ messageId, onOpen }: { messageId: string; onOpen(): void }) {
  return (
    <a
      href="/"
      className="chat-from-nod"
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
      <CornerUpLeft size={13} aria-hidden="true" />
      from your chat with
      <ChatAvatar size="xs" />
      Nod
    </a>
  );
}

export function ChatHeader({
  chat,
  onBack,
  onChanged,
  onDetails,
  onLeave,
  toolsRef,
}: {
  chat?: NamedChat;
  onDetails?(): void;
  onLeave?(): void;
  toolsRef?(element: HTMLDivElement | null): void;
  onBack(): void;
  onChanged(): void;
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
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const subtitle = error || (chat && chat.title !== chat.name ? chat.title : '');
  return (
    <header className="chat-header">
      <button type="button" className="chat-header-back" aria-label="Back to Nod" onClick={onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14 6-6 6 6 6" />
        </svg>
      </button>
      <ChatAvatar name={chat?.name} state={chat ? chatState(chat) : undefined} draft={!chat} />
      <div className="chat-header-copy">
        {!chat ? (
          <h1 className="chat-header-draft">New chat</h1>
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
        {subtitle && <p role={error ? 'alert' : undefined}>{subtitle}</p>}
      </div>
      {chat?.pinned && <PinMark />}
      <div className="chat-header-tools" ref={toolsRef} />
      {chat && (
        <ChatMenu
          chat={chat}
          onChanged={onChanged}
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
