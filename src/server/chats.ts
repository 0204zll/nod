import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export type MessageKind = 'plain' | 'decision' | 'notice';

export const chatNameLimit = 24;

export const chatColumnsSql = `
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name text;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reports_to_main boolean NOT NULL DEFAULT true;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS request_started_at timestamptz;
`;

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function chatName(value: string) {
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || name.length > chatNameLimit)
    throw failure(`A chat name needs 1 to ${chatNameLimit} characters.`);
  return name;
}

export async function defaultChatName(
  client: Queryable,
  ownerId: string,
  threadId: string,
  title: string,
) {
  const words = title.replace(/\s+/gu, ' ').trim().split(' ').slice(0, 2).join(' ');
  const base =
    [...(words || 'Chat')]
      .slice(0, chatNameLimit - 3)
      .join('')
      .trim() || 'Chat';
  const taken = new Set(
    (
      await client.query<{ name: string }>(
        `SELECT lower(t.name) AS name FROM tasks t JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE t.owner_id=$1 AND u.thread_id=$2 AND t.name IS NOT NULL AND t.archived_at IS NULL`,
        [ownerId, threadId],
      )
    ).rows.map((row) => row.name),
  );
  for (let count = 1; ; count++) {
    const name = count === 1 ? base : `${base} ${count}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export async function assertChatNameFree(
  client: Queryable,
  ownerId: string,
  threadId: string,
  name: string,
  except?: string,
  hint = false,
) {
  const taken = (
    await client.query<{ id: string; name: string }>(
      `SELECT t.id,t.name FROM tasks t JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
       WHERE t.owner_id=$1 AND u.thread_id=$2 AND t.name IS NOT NULL AND t.archived_at IS NULL
         AND lower(t.name)=lower($3) AND t.id IS DISTINCT FROM $4::uuid LIMIT 1`,
      [ownerId, threadId, name, except ?? null],
    )
  ).rows[0];
  if (taken)
    throw Object.assign(
      failure(
        `A chat named ${taken.name} already exists.${hint ? ` Send this work to it with chat "${taken.id}".` : ''}`,
        409,
      ),
      { code: 'chat_name_in_use', chatId: taken.id },
    );
}

export async function chatOnlyPlacement(
  client: Queryable,
  ownerId: string,
  turnId: string,
  kind: MessageKind,
) {
  if (kind !== 'plain') return false;
  const turn = (
    await client.query<{ task_id: string | null; channel: string }>(
      "SELECT to_jsonb(u)->>'task_id' AS task_id,u.channel FROM turns u WHERE u.id=$1 AND u.owner_id=$2",
      [turnId, ownerId],
    )
  ).rows[0];
  if (!turn?.task_id || turn.channel !== 'web') return false;
  const { rowCount } = await client.query(
    'SELECT 1 FROM tasks WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL AND NOT reports_to_main',
    [turn.task_id, ownerId],
  );
  return Boolean(rowCount);
}

export async function restartChatRequest(
  client: Queryable,
  ownerId: string,
  chatId: string,
  fromChat: boolean,
) {
  await client.query(
    `UPDATE tasks SET reports_to_main=$3,request_started_at=now(),archived_at=NULL
     WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL`,
    [chatId, ownerId, !fromChat],
  );
}

export async function setChatRequestSource(
  client: Queryable,
  ownerId: string,
  chatId: string,
  messageId: string,
) {
  await client.query(
    'UPDATE tasks SET source_message_id=$3 WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL',
    [chatId, ownerId, messageId],
  );
}

export async function noteChatInput(
  client: Queryable,
  ownerId: string,
  chatId: string,
  fromChat: boolean,
) {
  await client.query(
    `UPDATE tasks SET archived_at=NULL,reports_to_main=reports_to_main OR $3
     WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL`,
    [chatId, ownerId, !fromChat],
  );
}

export async function noteSessionInput(client: Queryable, ownerId: string, sessionId: string) {
  const turn = (
    await client.query<{ task_id: string | null }>(
      `SELECT to_jsonb(u)->>'task_id' AS task_id FROM turns u WHERE u.session_id=$1 AND u.owner_id=$2
       ORDER BY u.created_at DESC,u.id DESC LIMIT 1`,
      [sessionId, ownerId],
    )
  ).rows[0];
  if (turn?.task_id) await noteChatInput(client, ownerId, turn.task_id, false);
}
