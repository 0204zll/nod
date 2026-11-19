import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Artifact, Message, MessageHistoryPage, Task } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { ChatHeader } from '../components/named-chats';
import { Composer } from '../components/composer';
import { Notice } from '../components/ui';
import type { NamedChat as Named } from '../lib/named-chats';
import { Chat } from './chat';
import { TaskCard } from './tasks';

export type FirstChatMessage = { id: string; text: string; attachments: Artifact[] };

export function NamedChat({
  chat,
  ownerId,
  state,
  streams,
  connected,
  refresh,
  visible,
  onNavigate,
  onRead,
  onFeedback,
  firstMessage,
  onFirstMessageSent,
}: {
  firstMessage?: FirstChatMessage;
  onFirstMessageSent?(id: string): void;
  chat: Named;
  ownerId: string;
  state: AppState;
  streams: Record<string, string>;
  connected?: boolean;
  refresh(): Promise<void>;
  visible: boolean;
  onNavigate(path: string): void;
  onRead(chatId: string, at: string): void;
  onFeedback?(): void;
}) {
  const [page, setPage] = useState<MessageHistoryPage | null>(null);
  const [details, setDetails] = useState(false);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const request = useRef(0);
  const version = `${state.messages.at(-1)?.id ?? ''}:${state.turns.map((turn) => `${turn.id}${turn.status}`).join()}:${chat.updatedAt}:${chat.chatOnly?.count ?? 0}:${chat.status}`;
  useEffect(() => {
    const current = ++request.current;
    void api<MessageHistoryPage>(`/api/chats/${chat.id}/messages`)
      .then((next) => {
        if (request.current === current) setPage(next);
      })
      .catch(() => {});
  }, [chat.id, version]);
  const latest = page?.messages.at(-1)?.createdAt;
  useEffect(() => {
    if (visible && latest) onRead(chat.id, latest);
  }, [visible, latest, chat.id]);
  useEffect(() => {
    if (!visible) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const busy = [
        ...document.querySelectorAll(
          '[role="dialog"],[role="menu"],.chat-header-copy input,.named-chat-route .composer-reply',
        ),
      ].some((element) => element.getClientRects().length);
      if (busy) return;
      const editor = document.querySelector('.named-chat-route .composer-editor');
      if (editor?.textContent?.trim()) return;
      onNavigate('/');
    };
    window.addEventListener('keydown', leave, true);
    return () => window.removeEventListener('keydown', leave, true);
  }, [visible, onNavigate]);
  const scoped = useMemo<AppState>(
    () => ({
      ...state,
      messages: page?.messages ?? ([] as Message[]),
      hasEarlierMessages: page?.hasMore ?? false,
      hiddenMessageCount: 0,
      hiddenMessageIds: [],
      chatRecovery: undefined,
      planningTasks: false,
      activity: state.activity?.filter((item) => item.taskId === chat.id),
    }),
    [state, page, chat.id],
  );
  const turnIds = new Set(
    (state.activity ?? []).filter((item) => item.taskId === chat.id).map((item) => item.turnId),
  );
  const chatStreams = Object.fromEntries(
    Object.entries(streams).filter(([id]) =>
      [...turnIds].some((turnId) => id === `turn:${turnId}` || id.includes(turnId)),
    ),
  );
  return (
    <div className="named-chat-route">
      <ChatHeader
        chat={chat}
        onBack={() => onNavigate('/')}
        onChanged={() => void refresh()}
        onLeave={() => onNavigate('/')}
        onDetails={() => setDetails((value) => !value)}
        toolsRef={setTools}
      />
      {details && (
        <div className="chat-details">
          <TaskCard
            task={chat}
            live={state.activity?.find((item) => item.taskId === chat.id)}
            defaultExpanded
          />
        </div>
      )}
      {page && (
        <Chat
          key={chat.id}
          chat={chat}
          ownerId={ownerId}
          state={scoped}
          streams={chatStreams}
          connected={connected}
          refresh={refresh}
          visible={visible}
          toolbarActions={tools}
          readUnavailable
          onFeedback={onFeedback}
          onOpenChat={onNavigate}
          requestedMessage={firstMessage && { ...firstMessage, source: 'composer' }}
          onRequestHandled={onFirstMessageSent}
        />
      )}
    </div>
  );
}

export function DraftChat({
  ownerId,
  threadId,
  ready,
  refresh,
  onNavigate,
  onCreated,
}: {
  ownerId: string;
  threadId: string;
  ready: boolean;
  refresh(): Promise<void>;
  onNavigate(path: string): void;
  onCreated(chat: Task, first: FirstChatMessage): void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"],[role="menu"]')) return;
      if (document.querySelector('.draft-chat .composer-editor')?.textContent?.trim()) return;
      onNavigate('/');
    };
    window.addEventListener('keydown', leave, true);
    return () => window.removeEventListener('keydown', leave, true);
  }, [onNavigate]);
  return (
    <div className="named-chat-route">
      <ChatHeader onBack={() => onNavigate('/')} onChanged={() => {}} />
      <div className="draft-chat">
        {error && <Notice kind="error">{error}</Notice>}
        <Composer
          name="a new chat"
          placeholder="What’s this chat about?"
          draftKey={`nod.chat-draft.${ownerId}.${threadId}.new`}
          ready={ready}
          text={text}
          setText={setText}
          replyTo={null}
          clearReply={() => {}}
          onSend={async (value, attachments, recording) => {
            setError('');
            if (recording) {
              setError('Type the first message of a new chat. Voice messages work once it starts.');
              return { sent: false, restoreText: true, restoreRecording: true };
            }
            try {
              const chat = await api<Task>('/api/chats', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
              });
              await refresh();
              onCreated(chat, { id: crypto.randomUUID(), text: value, attachments });
              return { sent: true };
            } catch (cause) {
              setError(errorMessage(cause));
              return { sent: false, restoreText: true };
            }
          }}
        />
      </div>
    </div>
  );
}
