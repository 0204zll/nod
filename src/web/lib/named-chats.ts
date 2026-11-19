import type { Task } from '../../shared/contracts';

export type NamedChat = Task & { name: string };

export const isNamedChat = (task: Task): task is NamedChat => Boolean(task.name);
export const chatPath = (id: string) => `/chat/${id}`;
export const chatIdOf = (path: string) =>
  /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path)?.[1];

export function chatHue(name: string) {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

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
        a.createdAt.localeCompare(b.createdAt),
    );
}

export type ChatDot = 'needs' | 'failed' | 'unread' | 'working' | undefined;

export function chatDot(chat: Task, unread: boolean): ChatDot {
  if (chat.status === 'needs_you') return 'needs';
  if (chat.status === 'failed') return 'failed';
  if (unread) return 'unread';
  if (chat.status === 'working' || chat.status === 'queued') return 'working';
  return undefined;
}

const plainLine = (value: string) =>
  value
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function chatLine(chat: Task) {
  if (chat.status === 'needs_you') return plainLine(chat.question ?? '') || 'Needs you';
  if (chat.status === 'working' || chat.status === 'queued')
    return plainLine(chat.now) || chat.title;
  return chat.title === chat.name ? '' : chat.title;
}

export function earlierChats(tasks: Task[] | undefined, shown: NamedChat[]) {
  const visible = new Set(shown.map((chat) => chat.id));
  return (tasks ?? [])
    .filter(isNamedChat)
    .filter((chat) => !visible.has(chat.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
