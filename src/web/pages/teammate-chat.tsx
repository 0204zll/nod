import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Message, MessageHistoryPage } from '../../shared/contracts';
import { api } from '../lib/api';
import { ChatTop, TeammateEmpty } from '../components/teammates';
import type { Teammate } from '../lib/teammates';
import { Chat } from './chat';

export function TeammateChat({
  teammate,
  teammates,
  ownerId,
  state,
  streams,
  connected,
  refresh,
  visible,
  panelOpen,
  onTogglePanel,
  onNavigate,
  onRead,
  onFeedback,
}: {
  teammate: Teammate;
  teammates: Teammate[];
  ownerId: string;
  state: AppState;
  streams: Record<string, string>;
  connected?: boolean;
  refresh(): Promise<void>;
  visible: boolean;
  panelOpen: boolean;
  onTogglePanel(): void;
  onNavigate(path: string): void;
  onRead(chatId: string, at: string): void;
  onFeedback?(): void;
}) {
  const [page, setPage] = useState<MessageHistoryPage | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const request = useRef(0);
  const version = `${state.messages.at(-1)?.id ?? ''}:${state.turns.map((turn) => `${turn.id}${turn.status}`).join()}:${teammate.updatedAt}:${teammate.chatOnly?.count ?? 0}:${teammate.status}:${teammate.lastMessage?.text ?? ''}`;
  useEffect(() => {
    const current = ++request.current;
    void api<MessageHistoryPage>(`/api/teammates/${teammate.id}/messages`)
      .then((next) => {
        if (request.current === current) setPage(next);
      })
      .catch(() => {});
  }, [teammate.id, version]);
  const latest = page?.messages.at(-1)?.createdAt;
  useEffect(() => {
    if (visible && latest) onRead(teammate.id, latest);
  }, [visible, latest, teammate.id]);
  useEffect(() => {
    if (!visible) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || panelOpen) return;
      const busy = [
        ...document.querySelectorAll(
          '[role="dialog"],[role="menu"],.teammate-chat-route .composer-reply',
        ),
      ].some((element) => element.getClientRects().length);
      if (busy) return;
      const editor = document.querySelector('.teammate-chat-route .composer-editor');
      if (editor?.textContent?.trim()) return;
      onNavigate('/');
    };
    window.addEventListener('keydown', leave, true);
    return () => window.removeEventListener('keydown', leave, true);
  }, [visible, panelOpen, onNavigate]);
  const scoped = useMemo<AppState>(
    () => ({
      ...state,
      messages: page?.messages ?? ([] as Message[]),
      hasEarlierMessages: page?.hasMore ?? false,
      hiddenMessageCount: 0,
      hiddenMessageIds: [],
      chatRecovery: undefined,
      planningTasks: false,
      activity: state.activity
        ?.filter((item) => item.taskId === teammate.id)
        .map(({ background: _background, ...item }) => ({ ...item, taskId: null })),
    }),
    [state, page, teammate.id],
  );
  const turnIds = new Set(
    (state.activity ?? []).filter((item) => item.taskId === teammate.id).map((item) => item.turnId),
  );
  const chatStreams = Object.fromEntries(
    Object.entries(streams).filter(([id]) =>
      [...turnIds].some((turnId) => id === `turn:${turnId}` || id.includes(turnId)),
    ),
  );
  return (
    <div className="teammate-chat-route chat-surface">
      <ChatTop
        teammate={teammate}
        panelOpen={panelOpen}
        onTogglePanel={onTogglePanel}
        toolsRef={setTools}
      />
      {page && (
        <Chat
          key={teammate.id}
          chat={teammate}
          teammates={teammates}
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
          empty={<TeammateEmpty teammate={teammate} />}
        />
      )}
    </div>
  );
}
