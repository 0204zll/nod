import { createContext } from 'react';
import type { Activity } from '../../shared/contracts';
import type { Bot } from '../../shared/bots';

export type { Bot };

export const botPath = (id: string) => `/bot/${id}`;
export const botIdOf = (path: string) =>
  /^\/bot\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path)?.[1];

const cursorKey = (ownerId: string) => `nod.bot-cursors.${ownerId}`;

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

export function chatUnread(bot: Bot, cursors: Record<string, string>) {
  const latest = bot.latestReply?.at;
  return Boolean(latest && (!cursors[bot.id] || cursors[bot.id] < latest));
}

export function botActivity(activity: Activity[] | undefined, id: string) {
  return activity?.find((item) => item.botId === id);
}

export function botLine(bot: Bot, writing: boolean, live?: Activity) {
  if (writing) return 'Writing…';
  if (bot.status === 'needs_you' && bot.question) return `Needs you: ${bot.question}`;
  const now = live?.step ?? live?.title;
  if (bot.status === 'working' && now) return now;
  const last = bot.lastMessage;
  if (!last) return bot.job || 'No messages yet';
  return last.from === 'owner' ? `You: ${last.text}` : last.text;
}

export const ChatBot = createContext<string | undefined>(undefined);

export function focusMessage(messageId: string, botId?: string) {
  window.dispatchEvent(
    new CustomEvent('nod:focus-message', { detail: { messageId, ...(botId ? { botId } : {}) } }),
  );
}
