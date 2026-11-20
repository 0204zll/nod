import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { presentationSchema, presentationText } from '../shared/presentation.ts';
import type { OwnerInstructions } from './owner-instructions.ts';
import { withdrawnSql } from './turn-chain.ts';

type Database = Pick<Pool, 'query'>;
type Source = {
  message_id: string;
  owner_id: string;
  thread_id: string;
  turn_id: string;
  task_id: string | null;
  input_at: Date;
  source_ids: string[];
  context_ids: string[];
  inherited_ids: string[];
  state: 'pending' | 'relevant' | 'clear';
  revision: string | null;
  policy_revision: string | null;
};
type Message = {
  id: string;
  thread_id: string;
  role: string;
  text: string;
  created_at: Date;
  presentation: unknown;
  task_ids: string[];
  hidden_at: Date | null;
  approval_answer: boolean | null;
  withdrawn: boolean;
};

export async function initializeChatDraftInstructions(database: Database) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS chat_draft_instructions (
      message_id uuid PRIMARY KEY, owner_id text NOT NULL,
      thread_id uuid NOT NULL REFERENCES threads(id), turn_id uuid NOT NULL REFERENCES turns(id),
      task_id uuid, input_at timestamptz NOT NULL, source_ids uuid[] NOT NULL,
      context_ids uuid[] NOT NULL DEFAULT '{}', inherited_ids uuid[] NOT NULL DEFAULT '{}',
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','relevant','clear')),
      revision text, policy_revision text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_draft_instructions_owner ON chat_draft_instructions(owner_id,input_at,message_id);
    CREATE TABLE IF NOT EXISTS draft_artifact_sources (
      artifact_id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL,
      turn_id uuid NOT NULL, sha256 text NOT NULL, size integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS draft_artifact_sources_digest ON draft_artifact_sources(owner_id,sha256);
    INSERT INTO chat_draft_instructions(message_id,owner_id,thread_id,turn_id,task_id,input_at,source_ids)
      SELECT DISTINCT ON (u.message_id) u.message_id,u.owner_id,u.thread_id,u.id,
        (to_jsonb(u)->>'task_id')::uuid,COALESCE(m.created_at,u.created_at),ARRAY[u.message_id]
      FROM turns u LEFT JOIN messages m ON m.id=u.message_id AND m.owner_id=u.owner_id
      WHERE u.message_id IS NOT NULL AND (u.source='user' OR (u.source IN ('task','resume')
        AND (m.role='user' OR m.id IS NULL))) AND m.approval_answer IS NULL
      ORDER BY u.message_id,u.created_at DESC,u.id DESC
      ON CONFLICT(message_id) DO NOTHING;
  `);
}

export async function pendingChatDraftInstructions(
  database: Database,
  ownerId: string,
  turn: { turnId: string; threadId: string },
  messageIds: string[],
  taskId: string | null,
) {
  if (!messageIds.length) return;
  await database.query(
    `INSERT INTO chat_draft_instructions(message_id,owner_id,thread_id,turn_id,task_id,input_at,source_ids)
     SELECT m.id,$1,$2,$3,$5,m.created_at,ARRAY[m.id] FROM messages m
     WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.id=ANY($4::uuid[]) AND m.role='user'
       AND m.approval_answer IS NULL AND m.hidden_at IS NULL AND NOT ${withdrawnSql('m')}
     ON CONFLICT(message_id) DO NOTHING`,
    [ownerId, turn.threadId, turn.turnId, messageIds, taskId],
  );
}

async function load(database: Database, ownerId: string, lock: boolean, extraIds: string[] = []) {
  const sources = (
    await database.query<Source>(
      `SELECT * FROM chat_draft_instructions WHERE owner_id=$1
       ORDER BY input_at,message_id${lock ? ' FOR SHARE' : ''}`,
      [ownerId],
    )
  ).rows;
  const ids = [
    ...new Set([
      ...extraIds,
      ...sources.flatMap((source) => [...source.source_ids, ...source.context_ids]),
    ]),
  ];
  const messages = ids.length
    ? (
        await database.query<Message>(
          `SELECT m.id,m.thread_id,m.role,m.text,m.created_at,m.presentation,m.hidden_at,m.approval_answer,
             ${withdrawnSql('m')} AS withdrawn,
             ARRAY(SELECT DISTINCT to_jsonb(u)->>'task_id' FROM turns u
               WHERE u.owner_id=$1 AND (u.id=m.turn_id OR u.message_id=m.id)
                 AND to_jsonb(u)->>'task_id' IS NOT NULL
               ORDER BY to_jsonb(u)->>'task_id') AS task_ids
           FROM messages m WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[])
           ORDER BY m.created_at,m.id${lock ? ' FOR SHARE OF m' : ''}`,
          [ownerId, ids],
        )
      ).rows
    : [];
  const tasks = (
    await database.query<{ id: string; created_at: Date; title: string }>(
      'SELECT id,created_at,title FROM tasks WHERE owner_id=$1',
      [ownerId],
    )
  ).rows;
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const bySource = new Map(sources.map((source) => [source.message_id, source]));
  const snapshot = (source: Source) => {
    const task = source.task_id ? byTask.get(source.task_id) : undefined;
    const eligible = (message: Message) =>
      message.thread_id === source.thread_id &&
      (source.task_id
        ? message.task_ids.includes(source.task_id) ||
          (!message.task_ids.length && Boolean(task && message.created_at <= task.created_at))
        : !message.task_ids.length);
    const selected = (ids: string[], role: string) =>
      ids
        .map((id) => byMessage.get(id))
        .filter((message): message is Message =>
          Boolean(message && message.role === role && eligible(message)),
        )
        .sort(
          (a, b) =>
            a.created_at.getTime() - b.created_at.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
    const allOwners = selected(source.source_ids, 'user');
    const allContext = selected(source.context_ids, 'assistant');
    const visible = (message: Message) =>
      !message.withdrawn && message.hidden_at === null && message.approval_answer === null;
    const owners = allOwners.filter(visible);
    const context = allContext.filter(visible);
    const inherited = source.inherited_ids.map((id) => {
      const parent = bySource.get(id);
      return (
        parent && {
          id,
          state: parent.state,
          revision: parent.revision,
          sources: parent.source_ids,
          context: parent.context_ids,
          inherited: parent.inherited_ids,
        }
      );
    });
    const intact =
      allOwners.length === source.source_ids.length &&
      allContext.length === source.context_ids.length &&
      inherited.every(Boolean);
    const complete =
      intact && owners.length === allOwners.length && context.length === allContext.length;
    const localWords = (messages: Message[]) =>
      messages.map(({ withdrawn, ...message }) => message);
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          messageId: source.message_id,
          threadId: source.thread_id,
          taskId: source.task_id,
          inputAt: source.input_at,
          sourceIds: source.source_ids,
          contextIds: source.context_ids,
          inheritedIds: source.inherited_ids,
          policyRevision: source.policy_revision,
          owners: localWords(allOwners),
          context: localWords(allContext),
          inherited,
        }),
      )
      .digest('hex');
    return { owners, context, inherited, complete, intact, revision };
  };
  return { sources, messages, tasks, snapshot };
}

export async function prepareChatDraftCapture(
  database: Database,
  ownerId: string,
  messageId: string,
  evidence: OwnerInstructions,
  policyRevision = '1',
) {
  const current = await load(
    database,
    ownerId,
    false,
    evidence.messages.flatMap((message) => [
      ...(message.id ? [message.id] : []),
      ...(message.replyTo ? [message.replyTo.id] : []),
    ]),
  );
  const source = current.sources.find((candidate) => candidate.message_id === messageId);
  if (!source || source.state !== 'pending' || source.revision !== null) return;
  const ids = [
    ...new Set([
      ...source.source_ids,
      ...evidence.messages.flatMap((message) => (message.id ? [message.id] : [])),
      ...current.sources
        .filter((candidate) => candidate.turn_id === source.turn_id)
        .flatMap((candidate) => candidate.source_ids),
    ]),
  ];
  const inherited = current.sources.filter(
    (candidate) => candidate.state === 'relevant' && ids.includes(candidate.message_id),
  );
  source.source_ids = [
    ...new Set([...ids, ...inherited.flatMap((candidate) => candidate.source_ids)]),
  ];
  source.context_ids = [
    ...new Set([
      ...evidence.messages.flatMap((message) => (message.replyTo ? [message.replyTo.id] : [])),
      ...current.sources
        .filter((candidate) => candidate.turn_id === source.turn_id)
        .flatMap((candidate) => candidate.context_ids),
      ...inherited.flatMap((candidate) => candidate.context_ids),
    ]),
  ];
  source.inherited_ids = inherited.map((candidate) => candidate.message_id);
  source.policy_revision = policyRevision;
  const captured = current.snapshot(source);
  await database.query(
    `UPDATE chat_draft_instructions SET source_ids=$3,context_ids=$4,inherited_ids=$5,revision=$6,policy_revision=$7
     WHERE owner_id=$1 AND message_id=$2 AND revision IS NULL AND state='pending'`,
    [
      ownerId,
      messageId,
      source.source_ids,
      source.context_ids,
      source.inherited_ids,
      captured.revision,
      policyRevision,
    ],
  );
  return {
    messageId,
    revision: captured.revision,
    complete: captured.complete,
    input: {
      purpose: 'message_condition_capture',
      newMessages: captured.owners
        .filter((message) => message.id === messageId)
        .map((message) => ({
          at: message.created_at.toISOString(),
          text: message.text,
          canAuthorize: false,
        })),
      userMessages: captured.owners.map((message) => ({
        at: message.created_at.toISOString(),
        text: message.text,
        canAuthorize: false,
      })),
      assistantContext: captured.context.map((message) => {
        const visual = presentationSchema.safeParse(message.presentation);
        return [message.text, visual.success ? presentationText(visual.data) : '']
          .filter(Boolean)
          .join('\n\n');
      }),
      inheritedConditions: inherited.map((candidate) => {
        const prior = current.snapshot(candidate);
        return {
          messages: prior.owners.map((message) => ({
            at: message.created_at.toISOString(),
            text: message.text,
            canAuthorize: false,
          })),
          unavailable: !prior.complete || prior.revision !== candidate.revision,
        };
      }),
    },
  };
}

export async function pendingChatDraftMessageIds(
  database: Database,
  ownerId: string,
  turnId: string,
  messageIds: string[],
) {
  return (
    await database.query<{ message_id: string }>(
      `SELECT message_id FROM chat_draft_instructions WHERE owner_id=$1 AND state='pending'
     AND revision IS NULL AND (turn_id=$2 OR message_id=ANY($3::uuid[]))
     ORDER BY input_at,message_id`,
      [ownerId, turnId, messageIds],
    )
  ).rows.map((row) => row.message_id);
}

export async function chatDraftInstructionBindings(
  database: Database,
  ownerId: string,
  messageIds: string[],
) {
  const current = await load(database, ownerId, false);
  const ids = new Set(messageIds);
  for (let changed = true; changed;) {
    changed = false;
    for (const source of current.sources) {
      if (!ids.has(source.message_id)) continue;
      for (const id of [...source.source_ids, ...source.inherited_ids]) {
        if (ids.has(id)) continue;
        ids.add(id);
        changed = true;
      }
    }
  }
  return current.sources
    .filter((source) => ids.has(source.message_id))
    .map((source) => {
      const snapshot = current.snapshot(source);
      return {
        id: source.message_id,
        turnId: source.turn_id,
        state: source.state,
        revision: snapshot.revision,
        sourceIds: source.source_ids,
        contextIds: source.context_ids,
        messages: snapshot.owners.map((message) => ({
          at: message.created_at.toISOString(),
          text: message.text,
          canAuthorize: false as const,
        })),
        unavailable:
          !snapshot.complete || snapshot.revision !== source.revision || source.state === 'pending',
      };
    });
}

export async function finishChatDraftCapture(
  database: Database,
  ownerId: string,
  capture: { messageId: string; revision: string },
  state: 'relevant' | 'clear',
) {
  const current = await load(database, ownerId, true);
  const source = current.sources.find((candidate) => candidate.message_id === capture.messageId);
  if (!source || source.state !== 'pending' || source.revision !== capture.revision) return;
  const snapshot = current.snapshot(source);
  if (!snapshot.complete || snapshot.revision !== capture.revision) return;
  await database.query(
    `UPDATE chat_draft_instructions SET state=$3 WHERE owner_id=$1 AND message_id=$2
     AND state='pending' AND revision=$4`,
    [ownerId, capture.messageId, state, capture.revision],
  );
}

export async function retainedChatDraftInstructions(
  database: Database,
  ownerId: string,
  threadId: string,
  taskId: string | null,
  lock = false,
  policyRevision = '1',
  forcedIds: string[] = [],
) {
  const current = await load(database, ownerId, lock);
  const task = current.tasks.find((candidate) => candidate.id === taskId);
  return current.sources.flatMap((source) => {
    const forced = forcedIds.includes(source.message_id);
    const outsideTask =
      taskId && source.task_id !== taskId && (!task || source.input_at > task.created_at);
    if (outsideTask && !forced) return [];
    const snapshot = current.snapshot(source);
    const verified =
      snapshot.complete &&
      source.revision === snapshot.revision &&
      source.policy_revision === policyRevision;
    if (
      source.state === 'clear' &&
      !forced &&
      snapshot.intact &&
      source.revision === snapshot.revision &&
      source.policy_revision === policyRevision
    )
      return [];
    const inScope =
      !outsideTask &&
      source.thread_id === threadId &&
      (source.task_id === taskId || (taskId !== null && source.task_id === null));
    if (!inScope && !forced) return [];
    return [
      {
        sourceRevision: createHash('sha256')
          .update(
            JSON.stringify({
              source,
              live: snapshot.revision,
              complete: snapshot.complete,
              inScope,
              forced,
              policyRevision,
            }),
          )
          .digest('hex'),
        kind: 'chat' as const,
        draftId: null,
        connectionId: null,
        target: inScope
          ? {}
          : { scope: source.thread_id === threadId ? 'other_task' : 'other_conversation' },
        messages: inScope
          ? snapshot.owners.map((message) => ({
              at: message.created_at.toISOString(),
              text: message.text,
              canAuthorize: false as const,
            }))
          : [],
        unavailable: !inScope || !verified || source.state === 'pending',
      },
    ];
  });
}

export async function linkedDraftSources(
  database: Database,
  ownerId: string,
  turn: { turnId: string; threadId: string },
  args: Record<string, unknown> = {},
) {
  const digests = new Set<string>();
  const artifactIds = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(
        /\/api\/artifacts\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/gi,
      ))
        artifactIds.add(match[1]!.toLowerCase());
    } else if (value && typeof value === 'object') {
      if (
        'workspaceFile' in value &&
        'sha256' in value &&
        typeof value.sha256 === 'string' &&
        /^[a-f\d]{64}$/i.test(value.sha256)
      )
        digests.add(value.sha256.toLowerCase());
      Object.values(value).forEach(visit);
    }
  };
  visit(args);
  const linked = (
    await database.query<{ message_id: string | null; turn_id: string; proved: boolean }>(
      `WITH RECURSIVE latest AS (
       SELECT m.id,m.created_at,m.reply_to_message_id,u.channel,to_jsonb(u)->>'task_id' AS task_id
       FROM messages m JOIN turns u ON u.owner_id=m.owner_id AND (u.message_id=m.id OR u.id=m.turn_id
         OR m.id IN (SELECT s.message_id FROM chat_draft_instructions s WHERE s.turn_id=u.id AND s.owner_id=u.owner_id))
       WHERE u.id=$2 AND u.owner_id=$1 AND u.thread_id=$4 AND m.thread_id=$4 AND m.role='user'
       ORDER BY m.created_at DESC,m.id DESC LIMIT 1),
     anchor AS (
       SELECT a.turn_id,COALESCE(a.id=(SELECT reply_to_message_id FROM latest)
         OR ($3::text IS NOT NULL AND a.text=$3),false) AS proved FROM messages a WHERE a.owner_id=$1 AND a.role='assistant'
         AND (a.id=(SELECT reply_to_message_id FROM latest) OR ($3::text IS NOT NULL AND a.text=$3)
           OR a.id=(SELECT b.id FROM messages b JOIN turns p ON p.id=b.turn_id AND p.owner_id=b.owner_id,latest
             WHERE latest.reply_to_message_id IS NULL AND b.owner_id=$1 AND b.thread_id=$4 AND b.role='assistant'
               AND b.hidden_at IS NULL AND NOT ${withdrawnSql('b')} AND (b.text<>'' OR b.presentation IS NOT NULL)
               AND (b.created_at,b.id)<(latest.created_at,latest.id) AND p.channel=latest.channel
               AND to_jsonb(p)->>'task_id' IS NOT DISTINCT FROM latest.task_id
             ORDER BY b.created_at DESC,b.id DESC LIMIT 1))
         AND a.turn_id IS NOT NULL
       UNION SELECT p.turn_id,true FROM draft_artifact_sources p WHERE p.owner_id=$1
         AND (p.artifact_id=ANY($5::uuid[]) OR p.sha256=ANY($6::text[]))),
     chain AS (
       SELECT u.id,u.message_id,u.parent_turn_id,a.proved FROM turns u JOIN anchor a ON a.turn_id=u.id
       WHERE u.owner_id=$1
       UNION SELECT u.id,u.message_id,u.parent_turn_id,c.proved FROM turns u JOIN chain c ON u.id=c.parent_turn_id
       WHERE u.owner_id=$1)
     SELECT d.message_id,d.turn_id,EXISTS (SELECT 1 FROM chain c WHERE c.proved AND (c.id=d.turn_id OR c.message_id=d.message_id)) AS proved
       FROM chat_draft_instructions d WHERE d.owner_id=$1 AND (
       d.turn_id IN (SELECT id FROM chain) OR d.message_id IN (SELECT message_id FROM chain))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=d.message_id AND m.owner_id=$1
         AND (m.role<>'user' OR m.approval_answer IS NOT NULL))
     UNION SELECT c.message_id,c.id,c.proved FROM chain c LEFT JOIN messages m ON m.id=c.message_id AND m.owner_id=$1
       WHERE c.message_id IS NOT NULL AND (m.id IS NULL OR (m.role='user' AND m.approval_answer IS NULL))
     UNION SELECT NULL::uuid,c.id,c.proved FROM chain c`,
      [
        ownerId,
        turn.turnId,
        typeof args.body === 'string' && args.body.trim() ? args.body : null,
        turn.threadId,
        [...artifactIds],
        [...digests],
      ],
    )
  ).rows;
  const messageIds = linked.flatMap((row) => (row.message_id ? [row.message_id] : []));
  const turnIds = linked.map((row) => row.turn_id);
  const provedTurnIds = linked.filter((row) => row.proved).map((row) => row.turn_id);
  if (typeof args.draft_id === 'string') {
    const drafts = await database.query<{ source_ids: string[]; turn_id: string }>(
      `SELECT source_ids,turn_id FROM draft_instructions WHERE owner_id=$1 AND draft_id=$2
       AND ($3::text IS NULL OR connection_id::text=$3::text)`,
      [ownerId, args.draft_id, typeof args.connectionId === 'string' ? args.connectionId : null],
    );
    messageIds.push(...drafts.rows.flatMap((draft) => draft.source_ids));
    turnIds.push(...drafts.rows.map((draft) => draft.turn_id));
    provedTurnIds.push(...drafts.rows.map((draft) => draft.turn_id));
  }
  return {
    messageIds: [...new Set(messageIds)],
    turnIds: [...new Set(turnIds)],
    provedTurnIds: [...new Set(provedTurnIds)],
  };
}

export async function linkedChatDraftMessageIds(...args: Parameters<typeof linkedDraftSources>) {
  return (await linkedDraftSources(...args)).messageIds;
}
