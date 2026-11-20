import type { Message, Task } from '../../shared/contracts';

export type NamedChat = Task & { name: string; lastReply?: string | null };
export type ChatMessage = Message & { inMain?: true };

export const isNamedChat = (task: Task): task is NamedChat => Boolean(task.name);
export const draftChatPath = '/chat/new';
export const chatPath = (id: string) => `/chat/${id}`;
export const chatIdOf = (path: string) =>
  /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path)?.[1];

const cursorKey = (ownerId: string, threadId: string) =>
  `nod.chat-cursors.${JSON.stringify([ownerId, threadId])}`;

export function readChatCursors(ownerId: string, threadId: string): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(cursorKey(ownerId, threadId)) ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeChatCursor(ownerId: string, threadId: string, chatId: string, at: string) {
  const cursors = readChatCursors(ownerId, threadId);
  if (cursors[chatId] && cursors[chatId] >= at) return cursors;
  const next = { ...cursors, [chatId]: at };
  try {
    window.localStorage.setItem(cursorKey(ownerId, threadId), JSON.stringify(next));
  } catch {}
  return next;
}

export function chatUnread(chat: Task, cursors: Record<string, string>) {
  const latest = chat.chatOnly?.latestAt;
  return Boolean(latest && (!cursors[chat.id] || cursors[chat.id] < latest));
}

const lastActivity = (chat: Task) => chat.chatOnly?.latestAt ?? chat.closedAt ?? chat.updatedAt;

export function sidebarChats(
  tasks: Task[] | undefined,
  cursors: Record<string, string>,
  activeId: string | undefined,
  now = Date.now(),
) {
  const recent = now - 24 * 60 * 60 * 1000;
  return (tasks ?? [])
    .filter(isNamedChat)
    .filter(
      (chat) =>
        chat.id === activeId ||
        (!chat.archivedAt &&
          (chat.pinned ||
            !chat.closedAt ||
            Date.parse(chat.closedAt) > recent ||
            chatUnread(chat, cursors))),
    )
    .sort(
      (a, b) =>
        Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
        lastActivity(b).localeCompare(lastActivity(a)),
    );
}

export function earlierChats(tasks: Task[] | undefined, shown: NamedChat[]) {
  const visible = new Set(shown.map((chat) => chat.id));
  return (tasks ?? [])
    .filter(isNamedChat)
    .filter((chat) => !visible.has(chat.id))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
}

export type ChatState = 'working' | 'needs' | 'failed' | undefined;

export function chatState(chat: Task): ChatState {
  if (chat.status === 'needs_you') return 'needs';
  if (chat.status === 'failed') return 'failed';
  if (chat.status === 'working' || chat.status === 'queued') return 'working';
  return undefined;
}
