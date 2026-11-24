import type { PoolClient } from 'pg';
import { inChatSql, withdrawnSql } from './turn-chain.ts';

type Queryable = Pick<PoolClient, 'query'>;

export const chatNameLimit = 24;
export const chatResultLimit = 300;

export const chatColumnsSql = `
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name text;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name_auto boolean NOT NULL DEFAULT false;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS request_started_at timestamptz;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS continued_from uuid REFERENCES messages(id);
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

export async function namedChats(client: Queryable, ownerId: string, threadId: string) {
  return (
    await client.query<{ id: string; name: string }>(
      `SELECT t.id,t.name FROM tasks t JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
       WHERE t.owner_id=$1 AND u.thread_id=$2 AND t.name IS NOT NULL AND t.archived_at IS NULL
       ORDER BY t.updated_at DESC,t.id`,
      [ownerId, threadId],
    )
  ).rows;
}

const sameName = (name: string) => {
  const wanted = name.toLowerCase();
  return (chat: { name: string }) => chat.name.toLowerCase() === wanted;
};

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
  return freeName(await namedChats(client, ownerId, threadId), base);
}

function freeName(chats: Array<{ name: string }>, base: string) {
  for (let count = 1; ; count++) {
    const name = count === 1 ? base : `${base} ${count}`;
    if (!chats.some(sameName(name))) return name;
  }
}

function nameTaken(chat: { id: string; name: string }, hint: boolean) {
  return Object.assign(
    failure(
      `A chat named ${chat.name} already exists.${hint ? ` Send this work to it with chat "${chat.id}".` : ''}`,
      409,
    ),
    { code: 'chat_name_in_use', chatId: chat.id },
  );
}

export async function assertChatNameFree(
  client: Queryable,
  ownerId: string,
  threadId: string,
  name: string,
  except?: string,
) {
  const taken = (await namedChats(client, ownerId, threadId)).find(
    (chat) => chat.id !== except && sameName(name)(chat),
  );
  if (taken) throw nameTaken(taken, false);
}

export async function nameAutoChat(
  client: Queryable,
  ownerId: string,
  threadId: string,
  chatId: string,
  value: string,
) {
  const name = chatName(value);
  await assertChatNameFree(client, ownerId, threadId, name, chatId);
  const { rowCount } = await client.query(
    'UPDATE tasks SET name=$3,name_auto=false WHERE id=$1 AND owner_id=$2 AND name_auto',
    [chatId, ownerId, name],
  );
  if (!rowCount) throw failure('This chat already has its name. Only the owner renames it.');
}

export async function assertNewChat(
  client: Queryable,
  ownerId: string,
  threadId: string,
  name: string,
  reason?: string,
) {
  const chats = await namedChats(client, ownerId, threadId);
  const taken = chats.find(sameName(name));
  if (taken) throw nameTaken(taken, true);
  if (chats.length && !reason)
    throw failure(
      `These chats already exist: ${chats
        .slice(0, 12)
        .map((chat) => `${chat.name} (chat "${chat.id}")`)
        .join(
          ', ',
        )}. When this work belongs to the subject of one of them, give it this request with chat and no name, or with reply while it works. Start a new chat only for a different subject, and then pass newBecause with the reason none of them covers it.`,
    );
}

export async function latestChatMessages(
  client: Queryable,
  ownerId: string,
  threadId: string,
  chatId: string,
) {
  const { rows } = await client.query<{
    id: string;
    role: string;
    text: string;
    shortened: boolean;
    created_at: Date;
    total: number;
  }>(
    `SELECT * FROM (
       SELECT m.id,m.role,left(m.text,2000) AS text,length(m.text)>2000 AS shortened,m.created_at,
         count(*) OVER ()::int AS total
       FROM messages m WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.hidden_at IS NULL AND m.text<>''
         AND ${inChatSql('m', '$3::uuid')} AND NOT (m.role='user' AND ${withdrawnSql('m')})
       ORDER BY m.created_at DESC,m.id DESC LIMIT 12
     ) latest ORDER BY created_at,id`,
    [ownerId, threadId, chatId],
  );
  return {
    messages: rows.map((row) => ({
      id: row.id,
      from: row.role === 'user' ? 'owner' : 'nod',
      text: row.text,
      ...(row.shortened ? { shortened: true } : {}),
      at: row.created_at.toISOString(),
    })),
    earlierMessages: Math.max(0, (rows[0]?.total ?? 0) - rows.length),
  };
}

export async function chatOnlyPlacement(client: Queryable, ownerId: string, turnId: string) {
  const taskId = (
    await client.query<{ task_id: string | null }>(
      "SELECT to_jsonb(u)->>'task_id' AS task_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.channel='web'",
      [turnId, ownerId],
    )
  ).rows[0]?.task_id;
  if (!taskId) return null;
  return (
    (
      await client.query<{ id: string }>(
        'SELECT id FROM tasks WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL',
        [taskId, ownerId],
      )
    ).rows[0]?.id ?? null
  );
}

export async function reportChat(
  client: Queryable,
  ownerId: string,
  turn: { threadId: string; turnId: string },
  failure?: string,
) {
  if (!(await chatOnlyPlacement(client, ownerId, turn.turnId))) return;
  await client.query(
    `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,reply_to_message_id,chat_report)
     SELECT gen_random_uuid(),u.owner_id,'assistant',line.text,u.thread_id,u.id,s.id,true
     FROM turns u JOIN tasks t ON t.id=u.task_id AND t.owner_id=u.owner_id
     JOIN messages s ON s.id=t.source_message_id AND s.owner_id=t.owner_id AND s.thread_id=u.thread_id
     CROSS JOIN LATERAL (SELECT COALESCE($4::text,
       NULLIF(CASE WHEN length(t.result)<=${chatResultLimit} THEN btrim(t.result) END,''),
       (SELECT CASE WHEN length(p.text)>${chatResultLimit} THEN left(p.text,${chatResultLimit - 1})||'…' ELSE p.text END
        FROM (SELECT split_part(btrim(m.text),E'\\n\\n',1) AS text FROM messages m
          WHERE m.owner_id=u.owner_id AND m.turn_id=u.id AND m.role='assistant' AND m.text<>'' AND m.hidden_at IS NULL
          ORDER BY m.created_at DESC,m.id DESC LIMIT 1) p)) AS text) line
     WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
       AND ($4::text IS NOT NULL OR (t.state='done' AND t.closed_at>=u.created_at)) AND line.text<>''
       AND NOT s.chat_only AND s.hidden_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.owner_id=u.owner_id AND r.turn_id=u.id AND r.chat_report)`,
    [turn.turnId, ownerId, turn.threadId, failure ?? null],
  );
}

export async function reviveChat(
  client: Queryable,
  ownerId: string,
  threadId: string,
  chatId: string,
) {
  const chat = (
    await client.query<{ name: string }>(
      'SELECT name FROM tasks WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL AND archived_at IS NOT NULL',
      [chatId, ownerId],
    )
  ).rows[0];
  if (!chat) return;
  await client.query('UPDATE tasks SET archived_at=NULL,name=$3 WHERE id=$1 AND owner_id=$2', [
    chatId,
    ownerId,
    freeName(await namedChats(client, ownerId, threadId), chat.name),
  ]);
}

export interface ChatRequest {
  title: string;
  doneWhen: string;
  brief: string;
  now?: string;
  steps?: string[];
  waitingFor?: unknown[];
  nextCheck?: string | null;
  pinned?: boolean;
}

export function ownerChatRequest(text: string, name: string): ChatRequest {
  const line = text.replace(/\s+/gu, ' ').trim();
  return {
    title: [...line].slice(0, 160).join('') || name,
    doneWhen: 'This request is answered in the chat.',
    brief: `The owner wrote this request in their ${name} chat.`,
  };
}

export async function restartChatRequest(
  client: Queryable,
  ownerId: string,
  threadId: string,
  chatId: string,
  request: ChatRequest,
) {
  await reviveChat(client, ownerId, threadId, chatId);
  await client.query(
    `UPDATE tasks SET title=$3,done_when=$4,brief=$5,now_text=$6,steps=$7,step_index=0,
       waiting_for=$8,next_check=$9,result='',pinned=pinned OR $10,request_started_at=now(),updated_at=now()
     WHERE id=$1 AND owner_id=$2 AND name IS NOT NULL`,
    [
      chatId,
      ownerId,
      request.title,
      request.doneWhen,
      request.brief,
      request.now ?? '',
      JSON.stringify(request.steps ?? []),
      JSON.stringify(request.waitingFor ?? []),
      request.nextCheck ?? null,
      request.pinned ?? false,
    ],
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
