import type { Activity, Message, Task } from '../../shared/contracts';

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

export const plainLine = (value: string) =>
  value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function firstParagraphMarkdown(value: string, limit = 280) {
  const paragraph = (value.split(/\n\s*\n/).find((part) => part.trim()) ?? '').trim();
  return paragraph.length <= limit && !/^[#>|-]/.test(paragraph)
    ? paragraph
    : firstParagraph(value);
}

export function firstParagraph(value: string, limit = 240) {
  const paragraph = plainLine(value.split(/\n\s*\n/).find((part) => part.trim()) ?? '');
  return paragraph.length > limit ? `${paragraph.slice(0, limit - 1).trimEnd()}…` : paragraph;
}

export function chatLine(chat: Task, live?: Activity) {
  if (chat.status === 'needs_you') return plainLine(chat.question ?? '');
  if (chat.status === 'working' || chat.status === 'queued')
    return plainLine(live?.step ?? '') || plainLine(chat.now) || chat.title;
  const outcome = chat.result.trim() || (chat as NamedChat).lastReply?.trim();
  if (outcome) return firstParagraph(outcome, 120);
  return chat.title === chat.name ? '' : chat.title;
}

export function chatNewsAt(chat: Task, mainMessages: Message[]) {
  const times = mainMessages
    .filter((message) => message.chatId === chat.id && message.id !== chat.messageId)
    .map((message) => message.createdAt);
  if (chat.status === 'needs_you') times.push(chat.updatedAt);
  if (chat.closedAt) times.push(chat.closedAt);
  return times.sort().at(-1);
}

export function relativeTime(at: string, now = Date.now()) {
  const minutes = Math.round((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function elapsed(since: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
