import type { Message, Task } from '../../shared/contracts';
import type { TeammateProfile } from '../../shared/teammates';

export type Teammate = Task & { name: string; teammate: TeammateProfile };
export type ChatMessage = Message & { inMain?: true };

export const isTeammate = (task: Task): task is Teammate =>
  Boolean(task.name && task.teammate && !task.archivedAt);
export const teammatePath = (id: string) => `/chat/${id}`;
export const teammateIdOf = (path: string) =>
  /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path)?.[1];

const cursorKey = (ownerId: string) => `nod.teammate-cursors.${ownerId}`;

export function readChatCursors(ownerId: string): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(cursorKey(ownerId)) ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeChatCursor(ownerId: string, chatId: string, at: string) {
  const cursors = readChatCursors(ownerId);
  if (cursors[chatId] && cursors[chatId] >= at) return cursors;
  const next = { ...cursors, [chatId]: at };
  try {
    window.localStorage.setItem(cursorKey(ownerId), JSON.stringify(next));
  } catch {}
  return next;
}

export function chatUnread(teammate: Task, cursors: Record<string, string>) {
  const latest = teammate.chatOnly?.latestAt;
  return Boolean(latest && (!cursors[teammate.id] || cursors[teammate.id] < latest));
}

export function teammatesOf(tasks: Task[] | undefined) {
  return (tasks ?? [])
    .filter(isTeammate)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export type TeammateState = 'working' | 'needs' | 'failed' | undefined;

export function teammateState(teammate: Task): TeammateState {
  if (teammate.status === 'needs_you') return 'needs';
  if (teammate.status === 'failed') return 'failed';
  if (teammate.status === 'working' || teammate.status === 'queued') return 'working';
  return undefined;
}

export function teammateLine(teammate: Teammate, writing: boolean) {
  if (writing) return 'Writing…';
  const state = teammateState(teammate);
  if (state === 'needs' && teammate.question && teammate.teammate.job)
    return `Needs you: ${teammate.question}`;
  if (state === 'working' && teammate.now) return teammate.now;
  const last = teammate.lastMessage;
  if (!last) return teammate.teammate.job || 'No messages yet';
  return last.from === 'owner' ? `You: ${last.text}` : last.text;
}

export function mentionParts(text: string, names: string[]) {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length || !text.includes('@')) return [text];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`@(${sorted.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const parts: Array<string | { mention: string }> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > 0 && /[\p{L}\p{N}]/u.test(text[at - 1]!)) continue;
    if (at > last) parts.push(text.slice(last, at));
    const name = sorted.find((item) => item.toLowerCase() === match[1]!.toLowerCase())!;
    parts.push({ mention: name });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
