import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrivateObjectStore } from '../ports/object-storage.ts';
import type { CaptureAnalytics } from './analytics.ts';
import { createMemoryService, type MemoryService } from './memory.ts';

const findInput = z.object({ query: z.string(), area: z.string().optional() }).strict();
const readInput = z.object({ path: z.string(), memory: z.string().optional() }).strict();

export function createMemories(options: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  store: PrivateObjectStore;
  analytics?: CaptureAnalytics;
}) {
  const nod = createMemoryService(options);
  const bots = new Map<string, MemoryService>();

  function of(bot?: string | null) {
    if (!bot) return nod;
    let memory = bots.get(bot);
    if (!memory)
      bots.set(bot, (memory = createMemoryService({ ...options, bot: { id: bot, owner: nod } })));
    return memory;
  }

  async function everyone(reader?: string | null) {
    const { rows } = await options.pool.query<{ id: string; name: string }>(
      'SELECT id,name FROM bots WHERE owner_id=$1 AND archived_at IS NULL ORDER BY created_at,id',
      [options.ownerId],
    );
    return [{ id: 'nod', name: 'Nod' }, ...rows]
      .map((item) => ({ ...item, own: item.id === (reader ?? 'nod') }))
      .toSorted((a, b) => Number(b.own) - Number(a.own));
  }

  const label = (memory: { name: string; own: boolean }): { memory?: string } =>
    memory.own ? {} : { memory: memory.name };

  return {
    nod,
    of,
    async chatOf(turnId?: string | null) {
      if (!turnId) return null;
      const { rows } = await options.pool.query<{ bot_id: string | null }>(
        'SELECT bot_id FROM turns WHERE id=$1 AND owner_id=$2',
        [turnId, options.ownerId],
      );
      return rows[0]?.bot_id ?? null;
    },
    async list() {
      return (await everyone()).map(({ id, name }) => ({ id, name }));
    },
    async views(reader?: string | null) {
      return Promise.all(
        (await everyone(reader)).map(async (memory) => ({
          label: label(memory),
          view: await of(memory.id === 'nod' ? null : memory.id).view(),
        })),
      );
    },
    async context(reader?: string | null) {
      if (!reader) return nod.context();
      const [own, main] = await Promise.all([of(reader).context(), nod.index()]);
      return main ? `${own}\nNod's memory, read only:\n${main}` : own;
    },
    async find(raw: unknown, reader?: string | null) {
      findInput.parse(raw);
      const found = [];
      for (const memory of await everyone(reader))
        found.push(
          ...(await of(memory.id === 'nod' ? null : memory.id).find(raw)).map((note) => ({
            ...note,
            ...label(memory),
          })),
        );
      return found;
    },
    async read(raw: unknown, reader?: string | null) {
      const { path, memory } = readInput.parse(raw);
      const owner = (await everyone(reader)).find((item) =>
        memory
          ? item.id === memory || item.name.toLowerCase() === memory.trim().toLowerCase()
          : item.own,
      );
      if (!owner) throw new Error(`No current bot is called ${JSON.stringify(memory)}.`);
      return {
        ...(await of(owner.id === 'nod' ? null : owner.id).read({ path })),
        ...label(owner),
      };
    },
    async remove(bot: string) {
      await of(bot).remove();
      bots.delete(bot);
    },
  };
}

export type Memories = ReturnType<typeof createMemories>;
