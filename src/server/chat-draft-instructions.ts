import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { presentationSchema, presentationText } from '../shared/presentation.ts';
import { ownerMessageContentSql, type OwnerInstructions } from './owner-instructions.ts';
import { withdrawnSql } from './turn-chain.ts';

type Database = Pick<Pool, 'query'>;
export async function draftSourceTurnIds(
  database: Database,
  ownerId: string,
  messageIds: string[],
) {
  if (!messageIds.length) return [];
  return (
    await database.query<{ id: string }>(
      `SELECT u.id FROM turns u WHERE u.owner_id=$1 AND (u.message_id=ANY($2::uuid[])
       OR EXISTS (SELECT 1 FROM messages m WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[]) AND m.turn_id=u.id))
       ORDER BY u.id`,
      [ownerId, [...new Set(messageIds)]],
    )
  ).rows.map(({ id }) => id);
}

export function draftSourceRevision(value: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
          : entry,
      ),
    )
    .digest('hex');
}
export type DraftConditionSource = {
  kind: 'chat' | 'authority';
  id: string;
  state: string;
  revision: string;
  available: boolean;
};
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
  condition_sources: DraftConditionSource[];
};
type AuthoritySource = {
  key: string;
  base_key: string;
  kind: 'schedule' | 'standing' | 'rules';
  authority_scope: string;
  thread_id: string;
  task_id: string | null;
  created_at: Date;
  state: 'pending' | 'relevant' | 'clear';
  policy_revision: string;
  source_ids: string[];
  source_revision: string;
  payload: {
    data: unknown;
    evidence: OwnerInstructions;
    unavailable?: boolean;
    bindings: Array<{ id: string; state: string; revision: string }>;
    conditionSources?: DraftConditionSource[];
    context: Array<{ id?: string; baseKey?: string; unavailable?: boolean }>;
  };
};
type FieldSource = {
  kind: string;
  authority_scope: string;
  payload: { data: unknown };
};

function fieldSource(source: FieldSource) {
  if (
    (source.kind !== 'rules' && source.kind !== 'standing') ||
    source.authority_scope !== source.kind
  )
    return;
  const data = Object(source.payload.data);
  if (
    data.field !== (source.kind === 'rules' ? 'rules' : 'notification_rule') ||
    !Array.isArray(data.versions) ||
    !data.versions.length ||
    !data.versions.every((entry: unknown) => typeof Object(entry).value === 'string')
  )
    return;
  if (
    data.version !== undefined &&
    (!Number.isSafeInteger(data.version) || data.version < 1 || data.versions.length !== 1)
  )
    return;
  return {
    kind: source.kind,
    version: data.version as number | undefined,
    values: data.versions.map((entry: { value: string }) => entry.value) as string[],
  };
}

export function isDraftOwnerFieldSource(source: FieldSource) {
  return Boolean(fieldSource(source));
}

export async function draftOwnerFieldHistoryGaps(
  database: Database,
  ownerId: string,
  sources: FieldSource[],
  through: Partial<Record<'standing' | 'rules', number>> = {},
) {
  const archives = (
    await database.query<{
      kind: 'standing' | 'rules';
      versions: Array<{ value: string }>;
    }>('SELECT kind,versions FROM draft_owner_field_versions WHERE owner_id=$1 ORDER BY kind', [
      ownerId,
    ])
  ).rows;
  return archives.flatMap((archive) => {
    const limit = Math.min(
      through[archive.kind] ?? archive.versions.length,
      archive.versions.length,
    );
    const covered = new Set<number>();
    for (const source of sources) {
      const field = fieldSource(source);
      if (!field || field.kind !== archive.kind) continue;
      if (field.version !== undefined) {
        if (archive.versions[field.version - 1]?.value === field.values[0])
          covered.add(field.version);
      } else if (
        field.values.length <= archive.versions.length &&
        field.values.every((value, index) => archive.versions[index]?.value === value)
      )
        field.values.forEach((_value, index) => covered.add(index + 1));
    }
    const missing = Array.from({ length: limit }, (_value, index) => index + 1).filter(
      (version) => !covered.has(version),
    );
    return missing.length
      ? [
          {
            kind: archive.kind,
            revision: draftSourceRevision({ archive, missing }),
          },
        ]
      : [];
  });
}
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
  owner_authored: boolean;
};

export async function initializeChatDraftInstructions(database: Database) {
  await database.query(`
    DO $backfill$
    BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':chat-draft-backfill-v1',0));
    IF to_regclass('chat_draft_instructions') IS NULL THEN
    CREATE TABLE IF NOT EXISTS chat_draft_instructions (
      message_id uuid PRIMARY KEY, owner_id text NOT NULL,
      thread_id uuid NOT NULL REFERENCES threads(id), turn_id uuid NOT NULL REFERENCES turns(id),
      task_id uuid, input_at timestamptz NOT NULL, source_ids uuid[] NOT NULL,
      context_ids uuid[] NOT NULL DEFAULT '{}', inherited_ids uuid[] NOT NULL DEFAULT '{}',
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','relevant','clear')),
      revision text, policy_revision text, condition_sources jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO chat_draft_instructions(message_id,owner_id,thread_id,turn_id,task_id,input_at,source_ids)
      SELECT DISTINCT ON (u.message_id) u.message_id,u.owner_id,u.thread_id,u.id,
        (to_jsonb(u)->>'task_id')::uuid,COALESCE(m.created_at,u.created_at),ARRAY[u.message_id]
      FROM turns u LEFT JOIN messages m ON m.id=u.message_id AND m.owner_id=u.owner_id
      WHERE u.message_id IS NOT NULL AND (u.source='user' OR (u.source IN ('task','resume')
        AND (m.role='user' OR m.id IS NULL))) AND m.approval_answer IS NULL
        AND (m.id IS NULL OR (m.role='user' AND ${ownerMessageContentSql('m')}))
      ORDER BY u.message_id,u.created_at,u.id
      ON CONFLICT(message_id) DO NOTHING;
    END IF;
    CREATE INDEX IF NOT EXISTS chat_draft_instructions_owner ON chat_draft_instructions(owner_id,input_at,message_id);
    CREATE TABLE IF NOT EXISTS draft_artifact_sources (
      artifact_id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL,
      turn_id uuid NOT NULL, sha256 text NOT NULL, size integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS draft_artifact_sources_digest ON draft_artifact_sources(owner_id,sha256);
    END
    $backfill$;
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
       AND ${ownerMessageContentSql('m')}
     ON CONFLICT(message_id) DO NOTHING`,
    [ownerId, turn.threadId, turn.turnId, messageIds, taskId],
  );
}

export async function eligibleChatDraftInputIds(
  database: Database,
  ownerId: string,
  turn: { turnId: string; threadId: string },
  originIds: string[],
) {
  return (
    await database.query<{ message_id: string }>(
      `WITH RECURSIVE chain AS (
       SELECT id,message_id,parent_turn_id FROM turns WHERE id=$1 AND owner_id=$2
       UNION SELECT u.id,u.message_id,u.parent_turn_id FROM turns u JOIN chain c ON u.id=c.parent_turn_id
         WHERE u.owner_id=$2 AND u.thread_id=$3),
     ids AS (SELECT message_id FROM chain UNION SELECT unnest($4::uuid[]))
     SELECT DISTINCT c.message_id FROM ids c LEFT JOIN messages m ON m.id=c.message_id AND m.owner_id=$2
     WHERE c.message_id IS NOT NULL AND (m.id IS NULL OR (m.role='user' AND m.approval_answer IS NULL AND ${ownerMessageContentSql('m')}))`,
      [turn.turnId, ownerId, turn.threadId, originIds],
    )
  ).rows.map((row) => row.message_id);
}

async function load(database: Database, ownerId: string, lock: boolean, extraIds: string[] = []) {
  const sources = (
    await database.query<Source>(
      `SELECT * FROM chat_draft_instructions WHERE owner_id=$1
       ORDER BY input_at,message_id${lock ? ' FOR SHARE' : ''}`,
      [ownerId],
    )
  ).rows;
  const authorities = (
    await database.query<AuthoritySource>(
      `SELECT * FROM draft_authority_instructions WHERE owner_id=$1 ORDER BY created_at,key${lock ? ' FOR SHARE' : ''}`,
      [ownerId],
    )
  ).rows;
  const ids = [
    ...new Set([
      ...extraIds,
      ...sources.flatMap((source) => [...source.source_ids, ...source.context_ids]),
      ...authorities.flatMap((source) => source.source_ids),
    ]),
  ];
  const messages = ids.length
    ? (
        await database.query<Message>(
          `SELECT m.id,m.thread_id,m.role,m.text,m.created_at,m.presentation,m.hidden_at,m.approval_answer,
             ${withdrawnSql('m')} AS withdrawn,${ownerMessageContentSql('m')} AS owner_authored,
             ARRAY(SELECT accepted.task_id FROM (
               SELECT to_jsonb(u)->>'task_id' AS task_id FROM turns u
               WHERE u.owner_id=$1 AND (u.message_id=m.id OR u.id=m.turn_id)
               ORDER BY CASE WHEN u.message_id=m.id THEN 0 ELSE 1 END,u.created_at,u.id LIMIT 1
             ) accepted WHERE accepted.task_id IS NOT NULL) AS task_ids
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
  const byAuthority = new Map(authorities.map((source) => [source.key, source]));
  const ownerSource = (source: Source) => {
    const own = byMessage.get(source.message_id);
    return !own || (own.role === 'user' && own.approval_answer === null && own.owner_authored);
  };
  const hash = draftSourceRevision;
  const conditionNodes = new Map<
    string,
    { revision: string; available: boolean; conditions: DraftConditionSource[] }
  >();
  const conditionStates = new Map<
    string,
    { revision: string; available: boolean; nodes: Array<{ key: string; revision: string }> }
  >();
  const conditionNode = (ref: Pick<DraftConditionSource, 'kind' | 'id'>) => {
    const key = `${ref.kind}:${ref.id}`;
    const cached = conditionNodes.get(key);
    if (cached) return cached;
    const source = ref.kind === 'chat' ? bySource.get(ref.id) : byAuthority.get(ref.id);
    let available = Boolean(source && source.state === 'relevant');
    const wordIds = source
      ? 'message_id' in source
        ? [...source.source_ids, ...source.context_ids]
        : source.source_ids
      : [];
    const words = [...new Set(wordIds)].sort().map((id) => {
      const word = byMessage.get(id);
      if (!word) {
        available = false;
        return { id, unavailable: true };
      }
      if (word.withdrawn || word.hidden_at !== null) available = false;
      const { withdrawn, ...local } = word;
      return local;
    });
    const result = {
      revision: hash(source ? { key, source, words } : { key, unavailable: true }),
      available,
      conditions: source
        ? 'message_id' in source
          ? source.condition_sources
          : (source.payload.conditionSources ?? [])
        : [],
    };
    conditionNodes.set(key, result);
    return result;
  };
  const conditionState = (ref: Pick<DraftConditionSource, 'kind' | 'id'>) => {
    const cacheKey = `${ref.kind}:${ref.id}`;
    const cached = conditionStates.get(cacheKey);
    if (cached) return cached;
    const visited = new Set<string>();
    const pending = [ref];
    const nodes: Array<{ key: string; revision: string }> = [];
    let available = true;
    while (pending.length) {
      const next = pending.pop()!;
      const key = `${next.kind}:${next.id}`;
      if (visited.has(key)) continue;
      const known = conditionStates.get(key);
      if (known) {
        available &&= known.available;
        for (const node of known.nodes)
          if (!visited.has(node.key)) {
            visited.add(node.key);
            nodes.push(node);
          }
        continue;
      }
      visited.add(key);
      const node = conditionNode(next);
      available &&= node.available;
      nodes.push({ key, revision: node.revision });
      pending.push(...node.conditions);
    }
    const result = {
      revision: hash(nodes.sort((a, b) => a.key.localeCompare(b.key))),
      available,
      nodes,
    };
    conditionStates.set(cacheKey, result);
    return result;
  };
  const condition = (ref: Pick<DraftConditionSource, 'kind' | 'id'>) =>
    conditionState(ref).revision;
  const matches = (refs: DraftConditionSource[]) =>
    refs.every((ref) => {
      const source = ref.kind === 'chat' ? bySource.get(ref.id) : byAuthority.get(ref.id);
      const live = conditionState(ref);
      return (
        ref.available &&
        live.available &&
        source?.state === ref.state &&
        live.revision === ref.revision
      );
    });
  const conditionSourceIds = (refs: Array<Pick<DraftConditionSource, 'kind' | 'id'>>) => {
    const pending = [...refs];
    const visited = new Set<string>();
    const ids = new Set<string>();
    while (pending.length) {
      const ref = pending.pop()!;
      const key = `${ref.kind}:${ref.id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const source = ref.kind === 'chat' ? bySource.get(ref.id) : byAuthority.get(ref.id);
      if (!source) continue;
      for (const id of source.source_ids) ids.add(id);
      if ('message_id' in source) {
        for (const id of source.context_ids) ids.add(id);
        pending.push(
          ...source.condition_sources,
          ...source.inherited_ids.map((id) => ({ kind: 'chat' as const, id })),
        );
      } else
        pending.push(
          ...(source.payload.conditionSources ?? []),
          ...source.payload.bindings.map(({ id }) => ({ kind: 'chat' as const, id })),
        );
    }
    return [...ids];
  };
  const authorityComplete = (source: AuthoritySource) => {
    const rows = source.source_ids.map((id) => byMessage.get(id));
    const words = rows.map(
      (row) =>
        row && {
          id: row.id,
          role: row.role,
          text: row.text,
          created_at: row.created_at,
          hidden_at: row.hidden_at,
          presentation: row.presentation,
          withdrawn: row.withdrawn,
          owner_authored: row.owner_authored,
        },
    );
    return (
      !source.payload.unavailable &&
      !source.payload.evidence.requiresReplacement &&
      rows.every(
        (row) =>
          row &&
          !row.withdrawn &&
          row.hidden_at === null &&
          (row.role !== 'user' || row.owner_authored),
      ) &&
      hash(words) === source.source_revision &&
      matches(source.payload.conditionSources ?? []) &&
      !source.payload.context.some((entry) => entry.unavailable)
    );
  };
  const inheritedRevisions = new Map<string, string>();
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
          Boolean(
            message &&
            message.role === role &&
            eligible(message) &&
            (role !== 'user' || message.owner_authored),
          ),
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
      if (!parent) return undefined;
      let descriptorDigest = inheritedRevisions.get(id);
      if (!descriptorDigest) {
        descriptorDigest = hash({
          id,
          state: parent.state,
          revision: parent.revision,
          sources: parent.source_ids,
          context: parent.context_ids,
          inherited: parent.inherited_ids,
        });
        inheritedRevisions.set(id, descriptorDigest);
      }
      return { id, descriptorDigest };
    });
    const intact =
      allOwners.length === source.source_ids.length &&
      allContext.length === source.context_ids.length &&
      inherited.every(Boolean);
    const complete =
      intact &&
      owners.length === allOwners.length &&
      context.length === allContext.length &&
      matches(source.condition_sources);
    const localWords = (messages: Message[]) =>
      messages.map(({ withdrawn, ...message }) => message);
    const revision = draftSourceRevision({
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
      conditions: source.condition_sources.map((ref) => ({ ...ref, live: condition(ref) })),
    });
    return {
      owners,
      context,
      inherited,
      complete,
      intact,
      revision,
      sourceIds: [
        ...new Set([
          ...source.source_ids,
          ...source.context_ids,
          ...conditionSourceIds([
            ...source.condition_sources,
            ...source.inherited_ids.map((id) => ({ kind: 'chat' as const, id })),
          ]),
        ]),
      ],
    };
  };
  return {
    sources,
    authorities,
    messages,
    tasks,
    snapshot,
    condition,
    conditionState,
    matches,
    authorityComplete,
    ownerSource,
    conditionSourceIds,
  };
}

export async function draftConditionBindingStates(
  database: Database,
  ownerId: string,
  refs: DraftConditionSource[],
) {
  if (!refs.length)
    return new Map<
      string,
      {
        state: Source['state'] | undefined;
        revision: string;
        available: boolean;
        sourceIds: string[];
      }
    >();
  const current = await load(database, ownerId, false);
  return new Map(
    refs.map((ref) => {
      const { revision, available } = current.conditionState(ref);
      return [
        `${ref.kind}:${ref.id}`,
        {
          state: (ref.kind === 'chat'
            ? current.sources.find((source) => source.message_id === ref.id)
            : current.authorities.find((source) => source.key === ref.id)
          )?.state,
          revision,
          available,
          sourceIds: current.conditionSourceIds([ref]),
        },
      ];
    }),
  );
}

export async function captureDraftConditionContext(
  database: Database,
  ownerId: string,
  threadId: string,
  taskId: string | null,
  policyRevision: string,
  omitChatIds: string[] = [],
  omitTurnId?: string,
) {
  const current = await load(database, ownerId, false);
  const task = current.tasks.find((candidate) => candidate.id === taskId);
  const inScope = (source: { thread_id: string; task_id: string | null }, at: Date) =>
    source.thread_id === threadId &&
    (source.task_id === taskId ||
      (taskId !== null && source.task_id === null && Boolean(task && at <= task.created_at)));
  const conditions: DraftConditionSource[] = [];
  const input: Array<{
    kind: 'chat' | 'authority';
    id: string;
    baseKey?: string;
    messages: Array<{ at: string; text: string; canAuthorize: false }>;
    ownerData?: unknown;
    unavailable: boolean;
  }> = [];
  for (const source of current.sources) {
    if (
      !current.ownerSource(source) ||
      omitChatIds.includes(source.message_id) ||
      source.turn_id === omitTurnId ||
      !inScope(source, source.input_at)
    )
      continue;
    const snapshot = current.snapshot(source);
    if (
      source.state === 'clear' &&
      snapshot.intact &&
      current.matches(source.condition_sources) &&
      source.revision === snapshot.revision &&
      source.policy_revision === policyRevision
    )
      continue;
    const unavailable =
      source.state !== 'relevant' ||
      !snapshot.complete ||
      source.revision !== snapshot.revision ||
      source.policy_revision !== policyRevision;
    const ref = {
      kind: 'chat' as const,
      id: source.message_id,
      state: source.state,
      revision: current.condition({ kind: 'chat', id: source.message_id }),
      available: !unavailable,
    };
    conditions.push(ref);
    input.push({
      kind: 'chat',
      id: ref.id,
      messages: snapshot.owners.map((message) => ({
        at: message.created_at.toISOString(),
        text: message.text,
        canAuthorize: false,
      })),
      unavailable,
    });
  }
  for (const source of current.authorities) {
    const scoped = inScope(source, source.created_at);
    if (!scoped && !isDraftOwnerFieldSource(source)) continue;
    const verified = current.authorityComplete(source) && source.policy_revision === policyRevision;
    if (source.state === 'clear' && verified) continue;
    const unavailable = !scoped || source.state !== 'relevant' || !verified;
    const ref = {
      kind: 'authority' as const,
      id: source.key,
      state: source.state,
      revision: current.condition({ kind: 'authority', id: source.key }),
      available: !unavailable,
    };
    conditions.push(ref);
    input.push({
      kind: 'authority',
      id: ref.id,
      baseKey: source.base_key,
      messages: unavailable
        ? []
        : source.payload.evidence.messages.map((message) => ({
            at: message.at,
            text: message.text,
            canAuthorize: false,
          })),
      ...(unavailable ? {} : { ownerData: source.payload.data }),
      unavailable,
    });
  }
  for (const gap of await draftOwnerFieldHistoryGaps(database, ownerId, current.authorities))
    input.push({
      kind: 'authority',
      id: `field-history:${gap.kind}`,
      messages: [],
      unavailable: true,
    });
  return { conditions, input, complete: input.every((entry) => !entry.unavailable) };
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
  const saved = current.sources.find((candidate) => candidate.message_id === messageId);
  if (!saved || !current.ownerSource(saved) || saved.state !== 'pending' || saved.revision !== null)
    return;
  const source = { ...saved };
  const conditionContext = await captureDraftConditionContext(
    database,
    ownerId,
    source.thread_id,
    source.task_id,
    policyRevision,
    [messageId],
  );
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
    (candidate) =>
      candidate.state === 'relevant' &&
      (ids.includes(candidate.message_id) ||
        conditionContext.conditions.some(
          (ref) => ref.kind === 'chat' && ref.id === candidate.message_id,
        )),
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
  source.condition_sources = conditionContext.conditions;
  source.policy_revision = policyRevision;
  const captured = current.snapshot(source);
  const claimed = await database.query(
    `UPDATE chat_draft_instructions SET source_ids=$3,context_ids=$4,inherited_ids=$5,revision=$6,policy_revision=$7,condition_sources=$8
     WHERE owner_id=$1 AND message_id=$2 AND revision IS NULL AND state='pending'`,
    [
      ownerId,
      messageId,
      source.source_ids,
      source.context_ids,
      source.inherited_ids,
      captured.revision,
      policyRevision,
      JSON.stringify(source.condition_sources),
    ],
  );
  if (!claimed.rowCount) return;
  return {
    messageId,
    revision: captured.revision,
    sourceIds: captured.sourceIds,
    complete: captured.complete && conditionContext.complete,
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
      inheritedConditions: [
        ...inherited.map((candidate) => {
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
        ...conditionContext.input.map(({ id, baseKey, ...entry }) => entry),
      ],
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
      `SELECT d.message_id FROM chat_draft_instructions d LEFT JOIN messages m ON m.id=d.message_id AND m.owner_id=d.owner_id WHERE d.owner_id=$1 AND d.state='pending'
     AND d.revision IS NULL AND (d.turn_id=$2 OR d.message_id=ANY($3::uuid[]))
     AND (m.id IS NULL OR (m.role='user' AND m.approval_answer IS NULL AND ${ownerMessageContentSql('m')}))
     ORDER BY d.input_at,d.message_id`,
      [ownerId, turnId, messageIds],
    )
  ).rows.map((row) => row.message_id);
}

export async function chatDraftInstructionBindings(
  database: Database,
  ownerId: string,
  messageIds: string[],
) {
  if (!messageIds.length) return [];
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
    .filter((source) => ids.has(source.message_id) && current.ownerSource(source))
    .map((source) => {
      const snapshot = current.snapshot(source);
      return {
        id: source.message_id,
        turnId: source.turn_id,
        state: source.state,
        revision: snapshot.revision,
        sourceIds: snapshot.sourceIds,
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

export async function currentChatDraftCapture(
  database: Database,
  ownerId: string,
  capture: { messageId: string; revision: string },
) {
  const current = await load(database, ownerId, true);
  const source = current.sources.find((candidate) => candidate.message_id === capture.messageId);
  if (!source || source.state !== 'pending' || source.revision !== capture.revision) return false;
  const snapshot = current.snapshot(source);
  return snapshot.complete && snapshot.revision === capture.revision;
}

export async function finishChatDraftCapture(
  database: Database,
  ownerId: string,
  capture: { messageId: string; revision: string },
  state: 'relevant' | 'clear',
) {
  if (!(await currentChatDraftCapture(database, ownerId, capture))) return;
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
    if (!current.ownerSource(source)) return [];
    const forced = forcedIds.includes(source.message_id);
    const outsideTask =
      taskId && source.task_id !== taskId && (!task || source.input_at > task.created_at);
    if (outsideTask && !forced) return [];
    const inScope =
      !outsideTask &&
      source.thread_id === threadId &&
      (source.task_id === taskId || (taskId !== null && source.task_id === null));
    if (!inScope && !forced) return [];
    const snapshot = current.snapshot(source);
    const verified =
      snapshot.complete &&
      source.revision === snapshot.revision &&
      source.policy_revision === policyRevision;
    if (
      source.state === 'clear' &&
      !forced &&
      snapshot.intact &&
      current.matches(source.condition_sources) &&
      source.revision === snapshot.revision &&
      source.policy_revision === policyRevision
    )
      return [];
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
        sourceIds: snapshot.sourceIds,
        draftId: null,
        connectionId: null,
        target: inScope
          ? verified
            ? {
                inheritedConditions: source.condition_sources
                  .filter((ref) => ref.kind === 'authority')
                  .flatMap((ref) => {
                    const authority = current.authorities.find(
                      (candidate) => candidate.key === ref.id,
                    );
                    return authority
                      ? [
                          {
                            ownerData: authority.payload.data,
                            messages: authority.payload.evidence.messages.map((message) => ({
                              at: message.at,
                              text: message.text,
                              canAuthorize: false,
                            })),
                          },
                        ]
                      : [];
                  }),
              }
            : {}
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
         AND (m.role<>'user' OR m.approval_answer IS NOT NULL OR NOT ${ownerMessageContentSql('m')}))
     UNION SELECT c.message_id,c.id,c.proved FROM chain c LEFT JOIN messages m ON m.id=c.message_id AND m.owner_id=$1
       WHERE c.message_id IS NOT NULL AND (m.id IS NULL OR (m.role='user' AND m.approval_answer IS NULL AND ${ownerMessageContentSql('m')}))
     UNION SELECT NULL::uuid,c.id,c.proved FROM chain c LEFT JOIN messages m ON m.id=c.message_id AND m.owner_id=$1
       WHERE c.message_id IS NULL OR m.id IS NULL OR (m.role='user' AND m.approval_answer IS NULL AND ${ownerMessageContentSql('m')})`,
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
  const known = messageIds.length
    ? (
        await database.query<{ id: string }>(
          `SELECT m.id FROM messages m WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[]) AND (m.role<>'user' OR m.approval_answer IS NOT NULL OR NOT ${ownerMessageContentSql('m')})`,
          [ownerId, messageIds],
        )
      ).rows.map((row) => row.id)
    : [];
  return {
    messageIds: [...new Set(messageIds.filter((id) => !known.includes(id)))],
    turnIds: [...new Set(turnIds)],
    provedTurnIds: [...new Set(provedTurnIds)],
  };
}

export async function linkedChatDraftMessageIds(...args: Parameters<typeof linkedDraftSources>) {
  return (await linkedDraftSources(...args)).messageIds;
}
