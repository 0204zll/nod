import type { PoolClient } from 'pg';
import { inChatSql, withdrawnSql } from './turn-chain.ts';
import { teammateName, teammateNameLimit } from '../shared/teammates.ts';

type Queryable = Pick<PoolClient, 'query'>;

export const teammateResultLimit = 300;

export const teammateColumnsSql = `
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name text;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS request_started_at timestamptz;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS avatar jsonb;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS job text NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS memory text NOT NULL DEFAULT 'shared';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT '{}';
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_teammate_name ON tasks(owner_id,lower(name))
    WHERE name IS NOT NULL AND archived_at IS NULL;
`;

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validName(value: string) {
  const name = teammateName(value);
  if (!name) throw failure(`A teammate's name needs 1 to ${teammateNameLimit} characters.`);
  return name;
}

export async function teammates(client: Queryable, ownerId: string) {
  return (
    await client.query<{ id: string; name: string; job: string; channels: string[] }>(
      `SELECT t.id,t.name,t.job,t.channels FROM tasks t
       WHERE t.owner_id=$1 AND t.name IS NOT NULL AND t.archived_at IS NULL
       ORDER BY t.created_at,t.id`,
      [ownerId],
    )
  ).rows;
}

const sameName = (name: string) => {
  const wanted = name.toLowerCase();
  return (teammate: { name: string }) => teammate.name.toLowerCase() === wanted;
};

export async function freeTeammateName(client: Queryable, ownerId: string, base: string) {
  const taken = await teammates(client, ownerId);
  for (let count = 1; ; count++) {
    const name = count === 1 ? base : `${base} ${count}`;
    if (!taken.some(sameName(name))) return name;
  }
}

export async function assertNameFree(
  client: Queryable,
  ownerId: string,
  name: string,
  except?: string,
) {
  const taken = (await teammates(client, ownerId)).find(
    (teammate) => teammate.id !== except && sameName(name)(teammate),
  );
  if (taken)
    throw Object.assign(failure(`${taken.name} is already a teammate. Pick another name.`, 409), {
      code: 'teammate_name_in_use',
    });
}

export async function latestChatMessages(client: Queryable, ownerId: string, chatId: string) {
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
       FROM messages m WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND m.text<>''
         AND ${inChatSql('m', '$2::uuid')} AND NOT (m.role='user' AND ${withdrawnSql('m')})
       ORDER BY m.created_at DESC,m.id DESC LIMIT 12
     ) latest ORDER BY created_at,id`,
    [ownerId, chatId],
  );
  return {
    messages: rows.map((row) => ({
      id: row.id,
      from: row.role === 'user' ? 'owner' : 'teammate',
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
       NULLIF(CASE WHEN length(t.result)<=${teammateResultLimit} THEN btrim(t.result) END,''),
       (SELECT CASE WHEN length(p.text)>${teammateResultLimit} THEN left(p.text,${teammateResultLimit - 1})||'…' ELSE p.text END
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

export interface ChatRequest {
  title: string;
  doneWhen: string;
  brief: string;
  now?: string;
  steps?: string[];
  waitingFor?: unknown[];
  nextCheck?: string | null;
}

export function ownerChatRequest(text: string, name: string): ChatRequest {
  const line = text.replace(/\s+/gu, ' ').trim();
  return {
    title: [...line].slice(0, 160).join('') || name,
    doneWhen: 'This request is answered in the chat.',
    brief: `The owner wrote this request in their chat with ${name}.`,
  };
}

export async function restartChatRequest(
  client: Queryable,
  ownerId: string,
  chatId: string,
  request: ChatRequest,
) {
  await client.query(
    `UPDATE tasks SET title=$3,done_when=$4,brief=$5,now_text=$6,steps=$7,step_index=0,
       waiting_for=$8,next_check=$9,result='',request_started_at=now(),updated_at=now()
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
