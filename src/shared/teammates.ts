import { z } from 'zod';

export const teammateHues = ['pink', 'lilac', 'green', 'amber', 'sky', 'gray'] as const;
export const teammateMarks = ['', '🧾', '🔭', '🍳', '🗓️', '✈️', '🏡', '🎓', '💪', '🧩'] as const;
export const memoryModes = ['shared', 'read', 'own'] as const;
export const teammateChannels = ['telegram', 'whatsapp'] as const;
export const teammateNameLimit = 24;
export const teammateJobLimit = 80;
export const teammateInstructionsLimit = 2000;
const teammateImageLimit = 160_000;

export type MemoryMode = (typeof memoryModes)[number];
export type TeammateChannel = (typeof teammateChannels)[number];

const teammateImage = z
  .string()
  .max(teammateImageLimit)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/);

export const teammateAvatarSchema = z
  .object({
    hue: z.enum(teammateHues),
    mark: z.enum(teammateMarks).optional(),
    image: teammateImage.optional(),
  })
  .strict();

export type TeammateAvatar = z.infer<typeof teammateAvatarSchema>;

export interface TeammateProfile {
  avatar: TeammateAvatar;
  job: string;
  instructions: string;
  memory: MemoryMode;
  channels: TeammateChannel[];
}

export const memoryLabels: Record<MemoryMode, { title: string; detail: string }> = {
  shared: {
    title: 'Shares Nod’s memory',
    detail:
      'Reads and adds to the same memory as Nod. Good for helpers that work on your everyday life.',
  },
  read: {
    title: 'Reads Nod’s memory, keeps its own notes',
    detail: 'Knows what Nod knows about you. What it learns stays with this teammate.',
  },
  own: {
    title: 'Own memory only',
    detail: 'Starts fresh and never sees Nod’s memory. Good for teammates you share with others.',
  },
};

export const channelLabels: Record<TeammateChannel, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

export function teammateName(value: string) {
  const name = value.replace(/\s+/gu, ' ').trim();
  return name && name.length <= teammateNameLimit ? name : null;
}
