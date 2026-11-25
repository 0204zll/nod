import { z } from 'zod';
import type { ModelSelection } from './models';

export const botEmojis = ['🧾', '🔭', '🍳', '🗓️', '✈️', '🏡', '🎓', '💪', '🧩'] as const;
export const botNameLimit = 24;
export const botJobLimit = 80;
export const botInstructionsLimit = 2000;
export const newBotName = 'New bot';
const uploaded =
  /^\/api\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const botAvatarSchema = z.union([z.enum(['', ...botEmojis]), z.string().regex(uploaded)]);
export const avatarUpload = (avatar: string) => uploaded.exec(avatar)?.[1];

export type BotAvatar = z.infer<typeof botAvatarSchema>;
export type BotStatus = 'idle' | 'working' | 'needs_you' | 'failed';

export interface Bot {
  id: string;
  name: string;
  job: string;
  instructions: string;
  avatar: BotAvatar;
  model: ModelSelection;
  createdAt: string;
  status: BotStatus;
  question: string | null;
  lastMessage: { from: 'owner' | 'bot'; text: string } | null;
  latestReply: { id: string; at: string } | null;
}

export function botName(value: string) {
  const name = value.replace(/\s+/gu, ' ').trim();
  return name && name.length <= botNameLimit ? name : null;
}
