import type { Pool } from 'pg';
import { presentationSchema, presentationText } from '../shared/presentation.ts';
import {
  hasOwnerInstructions,
  instructionSourceMessageIds,
  ownerMessageContentSql,
  type OwnerInstructions,
} from './owner-instructions.ts';
import { withdrawnSql } from './turn-chain.ts';
import {
  chatDraftInstructionBindings,
  draftConditionBindingStates,
  draftSourceRevision,
  type DraftConditionSource,
} from './chat-draft-instructions.ts';
import type { TrustWords } from './trust-basis.ts';

type Database = Pick<Pool, 'query'>;
type Authority = {
  kind: 'schedule' | 'standing' | 'rules';
  scope: string;
  data: unknown;
  evidence: OwnerInstructions;
  context: unknown;
  sourceIds: string[];
  bindings: Array<{ id: string; state: string; revision: string }>;
  conditionSources?: DraftConditionSource[];
  empty?: boolean;
  unavailable?: boolean;
};
type Source = {
  key: string;
  base_key: string;
  attempt_turn_id: string | null;
  owner_id: string;
  thread_id: string;
  task_id: string | null;
  kind: Authority['kind'];
  authority_scope: string;
  payload: Authority;
  source_ids: string[];
  source_revision: string;
  policy_revision: string;
  state: 'pending' | 'relevant' | 'clear';
  attempted: boolean;
  created_at: Date;
};
const digest = draftSourceRevision;

export async function initializeDraftAuthorityInstructions(database: Database) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS draft_authority_instructions (
      key text PRIMARY KEY, base_key text NOT NULL, attempt_turn_id uuid, owner_id text NOT NULL, thread_id uuid NOT NULL, task_id uuid,
      kind text NOT NULL CHECK (kind IN ('schedule','standing','rules')), authority_scope text NOT NULL,
      payload jsonb NOT NULL, source_ids uuid[] NOT NULL, source_revision text NOT NULL,
      policy_revision text NOT NULL, state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','relevant','clear')), attempted boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS draft_authority_instructions_owner ON draft_authority_instructions(owner_id,created_at,key);
    CREATE INDEX IF NOT EXISTS draft_authority_instructions_base ON draft_authority_instructions(owner_id,base_key);
    CREATE TABLE IF NOT EXISTS draft_authority_turns (
      owner_id text NOT NULL, turn_id uuid NOT NULL, source_key text NOT NULL,
      PRIMARY KEY(owner_id,turn_id,source_key)
    );
    CREATE TABLE IF NOT EXISTS draft_owner_field_versions (
      owner_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('standing','rules')),
      versions jsonb NOT NULL, PRIMARY KEY(owner_id,kind)
    );
  `);
}

export async function draftOwnerField(
  database: Database,
  ownerId: string,
  kind: 'standing' | 'rules',
  value: string,
) {
  await database.query(
    'INSERT INTO draft_owner_field_versions(owner_id,kind,versions) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ownerId, kind, JSON.stringify([{ value }])],
  );
  const row = (
    await database.query<{ versions: Array<{ value: string }> }>(
      'SELECT versions FROM draft_owner_field_versions WHERE owner_id=$1 AND kind=$2 FOR UPDATE',
      [ownerId, kind],
    )
  ).rows[0]!;
  if (row.versions.at(-1)?.value !== value) {
    row.versions.push({ value });
    await database.query(
      'UPDATE draft_owner_field_versions SET versions=$3 WHERE owner_id=$1 AND kind=$2',
      [ownerId, kind, JSON.stringify(row.versions)],
    );
  }
  return { field: kind === 'standing' ? 'notification_rule' : 'rules', versions: row.versions };
}

function instructionContexts(payload: Authority) {
  const values = [
    ...(payload.kind === 'schedule' ? [payload.data] : []),
    ...(Array.isArray(payload.context)
      ? payload.context
          .filter((entry) => Object(entry).kind === 'active')
          .flatMap((entry) => Object(entry).ownerData ?? [])
          .filter((entry) => Object(entry).kind === 'schedule')
          .map((entry) => Object(entry).ownerData)
      : []),
  ];
  return values.map((value) => {
    if (
      !Array.isArray(Object(value).messages) ||
      !Object(value).messages.every(
        (message: unknown) =>
          typeof Object(message).at === 'string' &&
          typeof Object(message).text === 'string' &&
          (Object(message).id === null ||
            (typeof Object(message).id === 'string' &&
              /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
                Object(message).id,
              ))) &&
          (!Object(message).replyTo ||
            (typeof Object(message).replyTo.id === 'string' &&
              /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
                Object(message).replyTo.id,
              ) &&
              typeof Object(message).replyTo.text === 'string')),
      )
    )
      return undefined;
    return hasOwnerInstructions(value as OwnerInstructions)
      ? (value as OwnerInstructions)
      : undefined;
  });
}

async function snapshots(database: Database, ownerId: string, payloads: Authority[], lock = false) {
  const sourceIds = (payload: Authority) =>
    [
      ...new Set([
        ...payload.sourceIds,
        ...instructionSourceMessageIds(payload.evidence),
        ...instructionContexts(payload).flatMap((context) =>
          context ? instructionSourceMessageIds(context) : [],
        ),
      ]),
    ].sort();
  const ids = [...new Set(payloads.flatMap(sourceIds))];
  const rows = ids.length
    ? (
        await database.query<{
          id: string;
          role: string;
          text: string;
          created_at: Date;
          hidden_at: Date | null;
          withdrawn: boolean;
          presentation: unknown;
          owner_authored: boolean;
        }>(
          `SELECT m.id,m.role,m.text,m.created_at,m.hidden_at,m.presentation,${withdrawnSql('m')} AS withdrawn,${ownerMessageContentSql('m')} AS owner_authored
     FROM messages m WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[]) ORDER BY m.id${lock ? ' FOR SHARE OF m' : ''}`,
          [ownerId, ids],
        )
      ).rows
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const liveBindings = await chatDraftInstructionBindings(
    database,
    ownerId,
    payloads.flatMap((payload) => payload.bindings.map((binding) => binding.id)),
  );
  const conditionStates = await draftConditionBindingStates(
    database,
    ownerId,
    payloads.flatMap((payload) => payload.conditionSources ?? []),
  );
  return (payload: Authority) => {
    const selectedIds = sourceIds(payload);
    const selected = selectedIds.map((id) => byId.get(id)).filter((row) => row !== undefined);
    const bindingsMatch = payload.bindings.every((binding) =>
      liveBindings.some(
        (live) =>
          live.id === binding.id &&
          live.state === binding.state &&
          live.revision === binding.revision,
      ),
    );
    const contexts = instructionContexts(payload);
    const complete =
      contexts.every((context) => context && !context.requiresReplacement) &&
      !payload.unavailable &&
      !payload.evidence.requiresReplacement &&
      selected.length === selectedIds.length &&
      bindingsMatch &&
      (payload.conditionSources ?? []).every((ref) => {
        const live = conditionStates.get(`${ref.kind}:${ref.id}`);
        return (
          ref.available &&
          live?.available &&
          live.state === ref.state &&
          live.revision === ref.revision
        );
      }) &&
      (!Array.isArray(payload.context) ||
        payload.context.every((entry) => !Object(entry).unavailable)) &&
      selected.every(
        (row) =>
          !row.withdrawn && row.hidden_at === null && (row.role !== 'user' || row.owner_authored),
      ) &&
      [payload.evidence, ...contexts.filter((context) => context !== undefined)]
        .flatMap((context) => context.messages)
        .every((message) => {
          const own = message.id ? byId.get(message.id) : undefined;
          if (
            message.id &&
            (!own ||
              own.role !== 'user' ||
              own.text !== message.text ||
              own.created_at.toISOString() !== message.at)
          )
            return false;
          const answer = message.replyTo ? byId.get(message.replyTo.id) : undefined;
          if (!message.replyTo) return true;
          const visual = answer && presentationSchema.safeParse(answer.presentation);
          return (
            answer?.role === 'assistant' &&
            [answer.text, visual?.success ? presentationText(visual.data) : '']
              .filter(Boolean)
              .join('\n\n') === message.replyTo.text
          );
        });
    return { ids: selectedIds, complete, revision: digest(selected) };
  };
}

const snapshot = async (database: Database, ownerId: string, payload: Authority, lock = false) =>
  (await snapshots(database, ownerId, [payload], lock))(payload);

export async function pendingDraftAuthorityInstructions(
  database: Database,
  ownerId: string,
  turn: { threadId: string; turnId: string },
  taskId: string | null,
  authorities: Authority[],
  policyRevision: string,
) {
  const keys: string[] = [];
  const baseKeys = authorities.map((original) =>
    digest({
      ownerId,
      threadId: turn.threadId,
      taskId,
      kind: original.kind,
      scope: original.scope,
      data: original.data,
      intrinsicSourceIds: instructionContexts(original)
        .flatMap((context) => (context ? instructionSourceMessageIds(context) : []))
        .sort(),
      activeOwnerData: Array.isArray(original.context)
        ? original.context
            .filter((entry) => Object(entry).kind === 'active')
            .map((entry) => Object(entry).ownerData)
        : [],
      policyRevision,
    }),
  );
  const same = baseKeys;
  for (const [index, original] of authorities.entries()) {
    const baseKey = baseKeys[index]!;
    const payload = {
      ...original,
      context: Array.isArray(original.context)
        ? original.context.filter((entry) => !same.includes(Object(entry).id))
        : original.context,
      conditionSources: original.conditionSources?.filter(
        (ref) => ref.kind !== 'authority' || !same.includes(ref.id),
      ),
    };
    const currentSnapshot = await snapshots(database, ownerId, [payload]);
    const current = currentSnapshot(payload);
    const key = baseKey;
    await database.query(
      `INSERT INTO draft_authority_instructions(key,owner_id,thread_id,task_id,kind,authority_scope,payload,source_ids,source_revision,policy_revision,state,attempted,base_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [
        key,
        ownerId,
        turn.threadId,
        taskId,
        payload.kind,
        payload.scope,
        JSON.stringify(payload),
        current.ids,
        current.revision,
        policyRevision,
        payload.kind !== 'schedule' && payload.empty && current.complete ? 'clear' : 'pending',
        Boolean(payload.kind !== 'schedule' && payload.empty && current.complete),
        baseKey,
      ],
    );
    await database.query(
      'INSERT INTO draft_authority_turns(owner_id,turn_id,source_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ownerId, turn.turnId, key],
    );
    keys.push(key);
  }
  return keys;
}

export async function prepareDraftAuthorityCapture(
  database: Database,
  ownerId: string,
  key: string,
  turnId: string,
) {
  const source = (
    await database.query<Source>(
      'SELECT * FROM draft_authority_instructions WHERE owner_id=$1 AND key=$2 FOR UPDATE',
      [ownerId, key],
    )
  ).rows[0];
  if (!source || source.state !== 'pending' || source.attempted) return;
  const current = await snapshot(database, ownerId, source.payload);
  const complete = current.complete && current.revision === source.source_revision;
  if (
    complete &&
    !(
      await database.query(
        "UPDATE draft_authority_instructions SET attempted=true,attempt_turn_id=$3 WHERE owner_id=$1 AND key=$2 AND state='pending' AND attempted=false RETURNING key",
        [ownerId, key, turnId],
      )
    ).rowCount
  )
    return;
  return {
    key,
    turnId,
    revision: source.source_revision,
    complete,
    input: {
      purpose: 'message_condition_capture',
      newMessages: [
        { authority: source.kind, ownerData: source.payload.data, canAuthorize: false },
      ],
      userMessages: source.payload.evidence.messages.map(({ id, approvalId, ...message }) => ({
        ...message,
        canAuthorize: false,
      })),
      inheritedConditions: Array.isArray(source.payload.context)
        ? source.payload.context.map(({ id, baseKey, ...entry }) => entry)
        : source.payload.context,
    },
  };
}

export async function finishDraftAuthorityCapture(
  database: Database,
  ownerId: string,
  capture: { key: string; revision: string; turnId: string },
  state: 'clear' | 'relevant',
) {
  const source = (
    await database.query<Source>(
      'SELECT * FROM draft_authority_instructions WHERE owner_id=$1 AND key=$2 FOR UPDATE',
      [ownerId, capture.key],
    )
  ).rows[0];
  if (
    !source ||
    source.state !== 'pending' ||
    !source.attempted ||
    source.attempt_turn_id !== capture.turnId ||
    source.source_revision !== capture.revision
  )
    return;
  const current = await snapshot(database, ownerId, source.payload, true);
  if (!current.complete || current.revision !== capture.revision) return;
  await database.query(
    "UPDATE draft_authority_instructions SET state=$3 WHERE owner_id=$1 AND key=$2 AND state='pending'",
    [ownerId, capture.key, state],
  );
}

export async function retainedDraftAuthorityInstructions(
  database: Database,
  ownerId: string,
  threadId: string,
  taskId: string | null,
  policyRevision: string,
  forcedTurnIds: string[] = [],
  lock = false,
) {
  const sources = (
    await database.query<Source & { forced: boolean }>(
      `SELECT s.*,EXISTS (SELECT 1 FROM draft_authority_turns p WHERE p.owner_id=$1 AND p.source_key=s.key AND p.turn_id=ANY($2::uuid[])) AS forced
     FROM draft_authority_instructions s WHERE s.owner_id=$1 ORDER BY s.created_at,s.key${lock ? ' FOR SHARE OF s' : ''}`,
      [ownerId, forcedTurnIds],
    )
  ).rows;
  const task = taskId
    ? (
        await database.query<{ created_at: Date }>(
          'SELECT created_at FROM tasks WHERE owner_id=$1 AND id=$2',
          [ownerId, taskId],
        )
      ).rows[0]
    : undefined;
  const retained: Array<
    NonNullable<TrustWords['messageDrafts']>[number] & { sourceRevision: string }
  > = [];
  const currentSnapshot = await snapshots(
    database,
    ownerId,
    sources.map((source) => source.payload),
    lock,
  );
  for (const source of sources) {
    const inScope =
      source.thread_id === threadId &&
      (source.task_id === taskId ||
        (taskId !== null &&
          source.task_id === null &&
          Boolean(task && source.created_at <= task.created_at)));
    if (!inScope && !source.forced) continue;
    const current = currentSnapshot(source.payload);
    const verified =
      current.complete &&
      current.revision === source.source_revision &&
      source.policy_revision === policyRevision;
    if (source.state === 'clear' && verified && !source.forced) continue;
    const available = inScope && verified && source.state !== 'pending';
    retained.push({
      sourceRevision: digest({
        source,
        live: current.revision,
        complete: current.complete,
        inScope,
        policyRevision,
      }),
      kind: 'authority' as const,
      draftId: null,
      connectionId: null,
      target: {
        authority: source.kind,
        ...(!inScope ? { scope: 'other_work' } : {}),
        ...(available ? { ownerData: source.payload.data } : {}),
        ...(available
          ? {
              inheritedConditions: Array.isArray(source.payload.context)
                ? source.payload.context.map(({ id, baseKey, ...entry }) => entry)
                : source.payload.context,
            }
          : {}),
      },
      messages: available
        ? source.payload.evidence.messages.map((message) => ({
            at: message.at,
            text: message.text,
            canAuthorize: false as const,
          }))
        : [],
      unavailable: !available,
    });
  }
  if (forcedTurnIds.length) {
    const linked = (
      await database.query<{ turn_id: string }>(
        'SELECT DISTINCT turn_id FROM draft_authority_turns WHERE owner_id=$1 AND turn_id=ANY($2::uuid[])',
        [ownerId, forcedTurnIds],
      )
    ).rows.map((row) => row.turn_id);
    const missing = forcedTurnIds.filter((id) => !linked.includes(id));
    if (missing.length)
      retained.push({
        sourceRevision: digest({ missing, policyRevision }),
        kind: 'authority' as const,
        draftId: null,
        connectionId: null,
        target: { authority: 'unavailable' },
        messages: [],
        unavailable: true,
      });
  }
  return retained;
}
