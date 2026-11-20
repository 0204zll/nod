import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg, { type PoolClient } from 'pg';
import {
  initializeChatDraftInstructions,
  pendingChatDraftInstructions,
  prepareChatDraftCapture,
  finishChatDraftCapture,
  retainedChatDraftInstructions,
  linkedChatDraftMessageIds,
  linkedDraftSources,
  captureDraftConditionContext,
  eligibleChatDraftInputIds,
} from '../src/server/chat-draft-instructions.ts';
import {
  initializeDraftAuthorityInstructions,
  draftOwnerField,
  pendingDraftAuthorityInstructions,
  prepareDraftAuthorityCapture,
  finishDraftAuthorityCapture,
  retainedDraftAuthorityInstructions,
} from '../src/server/draft-authority-instructions.ts';

test(
  'chat draft sources keep exact owner conditions',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `chat_sources_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    let database = new pg.Pool({ connectionString: url.href });
    t.after(async () => {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal(
        (
          await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1', [
            schema,
          ])
        ).rows[0].count,
        0,
      );
      await admin.end();
    });
    await database.query(`
    CREATE TABLE threads(id uuid PRIMARY KEY);
    CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL,
      message_id uuid,source text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL,
      task_id uuid,parent_turn_id uuid,channel text NOT NULL DEFAULT 'web',withdrawn boolean NOT NULL DEFAULT false);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL,
      turn_id uuid,role text NOT NULL,text text NOT NULL,created_at timestamptz NOT NULL,
      hidden_at timestamptz,approval_answer boolean,presentation jsonb,suggestions jsonb,reply_to_message_id uuid);
    CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,
      created_at timestamptz NOT NULL);
  `);
    await initializeChatDraftInstructions(database);
    await initializeDraftAuthorityInstructions(database);
    const fixture = async () => {
      const ownerId = randomUUID();
      const threadId = randomUUID();
      await database.query('INSERT INTO threads(id) VALUES($1)', [threadId]);
      const add = async (
        text: string,
        at = '2026-11-19T10:00:00.000Z',
        turnId = randomUUID(),
        role = 'user',
      ) => {
        const id = randomUUID();
        await database.query(
          `INSERT INTO turns(id,owner_id,thread_id,message_id,created_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
          [turnId, ownerId, threadId, role === 'user' ? id : null, at],
        );
        await database.query(
          `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [id, ownerId, threadId, turnId, role, text, at],
        );
        return { id, turnId, text, at };
      };
      const pending = async (
        message: Awaited<ReturnType<typeof add>>,
        taskId: string | null = null,
        turnId = message.turnId,
      ) => {
        await pendingChatDraftInstructions(
          database,
          ownerId,
          { threadId, turnId },
          [message.id],
          taskId,
        );
      };
      const capture = async (
        message: Awaited<ReturnType<typeof add>>,
        state: 'clear' | 'relevant',
        words = [message],
      ) => {
        await pending(message);
        const captured = await prepareChatDraftCapture(database, ownerId, message.id, {
          messages: words,
        });
        assert.ok(captured?.complete);
        await finishChatDraftCapture(database, ownerId, captured, state);
        return captured;
      };
      const retained = (taskId: string | null = null) =>
        retainedChatDraftInstructions(database, ownerId, threadId, taskId);
      const row = async (id: string) =>
        (await database.query('SELECT * FROM chat_draft_instructions WHERE message_id=$1', [id]))
          .rows[0];
      return { ownerId, threadId, add, pending, capture, retained, row };
    };
    const authority = async (
      f: Awaited<ReturnType<typeof fixture>>,
      text = 'Show the saved synthetic report before sending.',
    ) => {
      const message = await f.add(text);
      const payload: Parameters<typeof pendingDraftAuthorityInstructions>[4][number] = {
        kind: 'schedule',
        scope: randomUUID(),
        data: { messages: [message] },
        evidence: { messages: [message] },
        sourceIds: [message.id],
        context: [],
        bindings: [],
      };
      const turn = { turnId: message.turnId, threadId: f.threadId };
      const [key] = await pendingDraftAuthorityInstructions(
        database,
        f.ownerId,
        turn,
        null,
        [payload],
        '1',
      );
      assert.ok(key);
      return { message, payload, turn, key };
    };

    await t.test(
      'unchanged saved authority reuses one completed capture across automatic turns',
      async () => {
        const f = await fixture();
        const a = await authority(f, 'Read the synthetic report.');
        const captured = await prepareDraftAuthorityCapture(
          database,
          f.ownerId,
          a.key,
          a.turn.turnId,
        );
        assert.ok(captured?.complete);
        await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
        const next = { ...a.turn, turnId: randomUUID() };
        assert.deepEqual(
          await pendingDraftAuthorityInstructions(
            database,
            f.ownerId,
            next,
            null,
            [a.payload],
            '1',
          ),
          [a.key],
        );
        assert.equal(
          await prepareDraftAuthorityCapture(database, f.ownerId, a.key, a.turn.turnId),
          undefined,
        );
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM draft_authority_instructions WHERE owner_id=$1',
              [f.ownerId],
            )
          ).rows[0].count,
          1,
        );
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM draft_authority_turns WHERE owner_id=$1',
              [f.ownerId],
            )
          ).rows[0].count,
          2,
        );
        assert.deepEqual(
          await retainedDraftAuthorityInstructions(database, f.ownerId, f.threadId, null, '1'),
          [],
        );
      },
    );

    await t.test(
      'unchanged active authority fields do not inherit each other as new versions',
      async () => {
        const f = await fixture();
        const turn = { turnId: randomUUID(), threadId: f.threadId };
        const data = [
          {
            kind: 'rules' as const,
            scope: 'rules',
            data: {
              field: 'rules',
              versions: [{ value: 'Show the synthetic draft before sending.' }],
            },
          },
          {
            kind: 'schedule' as const,
            scope: randomUUID(),
            data: {
              messages: [
                {
                  id: null,
                  at: '2026-11-19T10:00:00.000Z',
                  text: 'Show the synthetic report before sending.',
                },
              ],
            },
          },
        ];
        const active = {
          kind: 'active',
          ownerData: data.map(({ kind, data }) => ({ kind, ownerData: data, canAuthorize: false })),
          unavailable: false,
        };
        const payloads = (context: Awaited<ReturnType<typeof captureDraftConditionContext>>) =>
          data.map((entry) => ({
            ...entry,
            evidence: { messages: [] },
            sourceIds: [],
            bindings: [],
            conditionSources: context.conditions,
            context: [...context.input, active],
          }));
        const context = await captureDraftConditionContext(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        const keys = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          payloads(context),
          '1',
        );
        for (const key of keys) {
          const captured = await prepareDraftAuthorityCapture(
            database,
            f.ownerId,
            key,
            turn.turnId,
          );
          assert.ok(captured?.complete);
          await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
        }
        for (let index = 0; index < 3; index++) {
          const current = await captureDraftConditionContext(
            database,
            f.ownerId,
            f.threadId,
            null,
            '1',
          );
          assert.deepEqual(
            await pendingDraftAuthorityInstructions(
              database,
              f.ownerId,
              { ...turn, turnId: randomUUID() },
              null,
              payloads(current),
              '1',
            ),
            keys,
          );
        }
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM draft_authority_instructions WHERE owner_id=$1',
              [f.ownerId],
            )
          ).rows[0].count,
          2,
        );
        for (const key of keys)
          assert.equal(
            await prepareDraftAuthorityCapture(database, f.ownerId, key, turn.turnId),
            undefined,
          );
      },
    );

    for (const state of ['clear', 'relevant'] as const) {
      await t.test(
        `an unchanged field keeps one ${state} capture across 21 owner inputs`,
        async () => {
          const f = await fixture();
          const data = await draftOwnerField(
            database,
            f.ownerId,
            'rules',
            'Use clear synthetic report text.',
          );
          const keys = new Set<string>();
          let captures = 0;
          let firstPayload: unknown;
          for (let index = 0; index < 21; index++) {
            const message = await f.add(
              `Explain synthetic value ${index}.`,
              new Date(Date.parse('2026-11-19T10:00:00.000Z') + index * 1000).toISOString(),
            );
            const turn = { threadId: f.threadId, turnId: message.turnId };
            const [key] = await pendingDraftAuthorityInstructions(
              database,
              f.ownerId,
              turn,
              null,
              [
                {
                  kind: 'rules',
                  scope: 'rules',
                  data,
                  evidence: { messages: [message] },
                  sourceIds: [message.id],
                  bindings: [],
                  context: [
                    {
                      kind: 'active',
                      ownerData: [{ kind: 'rules', ownerData: data, canAuthorize: false }],
                      unavailable: false,
                    },
                  ],
                },
              ],
              '1',
            );
            assert.ok(key);
            keys.add(key);
            const captured = await prepareDraftAuthorityCapture(
              database,
              f.ownerId,
              key,
              turn.turnId,
            );
            if (captured) {
              captures++;
              assert.ok(captured.complete);
              await finishDraftAuthorityCapture(database, f.ownerId, captured, state);
            }
            const payload = (
              await database.query(
                'SELECT payload FROM draft_authority_instructions WHERE key=$1',
                [key],
              )
            ).rows[0].payload;
            if (index === 0) firstPayload = payload;
            else assert.deepEqual(payload, firstPayload);
            await f.capture(message, 'clear');
          }
          assert.equal(keys.size, 1);
          assert.equal(captures, 1);
          assert.equal(
            (
              await database.query(
                'SELECT count(*)::int AS count FROM draft_authority_turns WHERE owner_id=$1',
                [f.ownerId],
              )
            ).rows[0].count,
            21,
          );
          const retained = await retainedDraftAuthorityInstructions(
            database,
            f.ownerId,
            f.threadId,
            null,
            '1',
          );
          assert.equal(retained.length, state === 'clear' ? 0 : 1);
          const forced = await retainedDraftAuthorityInstructions(
            database,
            f.ownerId,
            f.threadId,
            null,
            '1',
            [
              (
                await database.query(
                  'SELECT turn_id FROM draft_authority_turns WHERE owner_id=$1 ORDER BY turn_id LIMIT 1',
                  [f.ownerId],
                )
              ).rows[0].turn_id,
            ],
          );
          assert.equal(forced.length, 1);
          assert.equal(forced[0].unavailable, false);
        },
      );
    }

    for (const mode of ['withdrawn', 'deleted', 'edited', 'malformed'] as const) {
      await t.test(`an active schedule source that is ${mode} cannot reuse clear`, async () => {
        const f = await fixture();
        const parent = await f.add('Keep the synthetic schedule review condition.');
        const current = await f.add('Explain a synthetic value.', '2026-11-19T10:01:00.000Z');
        const data = await draftOwnerField(
          database,
          f.ownerId,
          'rules',
          'Use that saved synthetic schedule.',
        );
        const payload = {
          kind: 'rules' as const,
          scope: 'rules',
          data,
          evidence: { messages: [current] },
          sourceIds: [current.id],
          bindings: [],
          context: [
            {
              kind: 'active',
              ownerData: [
                { kind: 'schedule', ownerData: mode === 'malformed' ? {} : { messages: [parent] } },
              ],
              unavailable: false,
            },
          ],
        };
        const turn = { threadId: f.threadId, turnId: current.turnId };
        const [key] = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [payload],
          '1',
        );
        const captured = await prepareDraftAuthorityCapture(database, f.ownerId, key!, turn.turnId);
        assert.ok(captured);
        if (mode === 'malformed') {
          assert.equal(captured.complete, false);
        } else {
          assert.equal(captured.complete, true);
          await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
          if (mode === 'withdrawn')
            await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [parent.turnId]);
          if (mode === 'deleted')
            await database.query('DELETE FROM messages WHERE id=$1', [parent.id]);
          if (mode === 'edited')
            await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
              parent.id,
              'Changed synthetic schedule words.',
            ]);
          assert.deepEqual(
            await pendingDraftAuthorityInstructions(
              database,
              f.ownerId,
              { ...turn, turnId: randomUUID() },
              null,
              [{ ...payload, evidence: { messages: [] }, sourceIds: [] }],
              '1',
            ),
            [key],
          );
        }
        await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
        const repeated = await prepareDraftAuthorityCapture(database, f.ownerId, key!, turn.turnId);
        if (mode === 'malformed') {
          assert.equal(repeated?.complete, false);
          assert.deepEqual(
            (
              await database.query(
                'SELECT attempted,attempt_turn_id FROM draft_authority_instructions WHERE key=$1',
                [key],
              )
            ).rows[0],
            { attempted: false, attempt_turn_id: null },
          );
        } else assert.equal(repeated, undefined);
        const retained = await retainedDraftAuthorityInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        assert.equal(retained.length, 1);
        assert.equal(retained[0].unavailable, true);
        assert.ok(!JSON.stringify(retained).includes(parent.text));
      });
    }

    await t.test('a known authority condition cannot be overwritten by a later clear', async () => {
      const f = await fixture();
      const a = await authority(f);
      const captured = await prepareDraftAuthorityCapture(
        database,
        f.ownerId,
        a.key,
        a.turn.turnId,
      );
      assert.ok(captured?.complete);
      await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
      await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
      const [source] = await retainedDraftAuthorityInstructions(
        database,
        f.ownerId,
        f.threadId,
        null,
        '1',
      );
      assert.equal(source.unavailable, false);
      assert.equal(source.messages[0].text, a.message.text);
      assert.equal(source.messages[0].canAuthorize, false);
    });

    for (const mode of ['hidden', 'withdrawn', 'deleted', 'edited', 'policy'] as const) {
      await t.test(
        `a ${mode} authority source cannot reuse clear or expose its saved words`,
        async () => {
          const f = await fixture();
          const a = await authority(f, `Synthetic saved-authority-${mode}.`);
          const captured = await prepareDraftAuthorityCapture(
            database,
            f.ownerId,
            a.key,
            a.turn.turnId,
          );
          assert.ok(captured?.complete);
          await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
          if (mode === 'hidden')
            await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [a.message.id]);
          if (mode === 'withdrawn')
            await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [a.message.turnId]);
          if (mode === 'deleted')
            await database.query('DELETE FROM messages WHERE id=$1', [a.message.id]);
          if (mode === 'edited')
            await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
              a.message.id,
              'Changed synthetic authority.',
            ]);
          const [source] = await retainedDraftAuthorityInstructions(
            database,
            f.ownerId,
            f.threadId,
            null,
            mode === 'policy' ? '2' : '1',
          );
          assert.equal(source.unavailable, true);
          assert.deepEqual(source.messages, []);
          assert.equal(JSON.stringify(source).includes(a.message.text), false);
        },
      );
    }

    await t.test('a later automatic turn can claim an unattempted field once', async () => {
      const f = await fixture();
      const stopped = await f.add('Synthetic automatic notice.');
      await database.query("UPDATE turns SET source='event',message_id=NULL WHERE id=$1", [
        stopped.turnId,
      ]);
      const payload = {
        kind: 'rules' as const,
        scope: 'rules',
        data: await draftOwnerField(database, f.ownerId, 'rules', 'Use clear synthetic text.'),
        evidence: { messages: [] },
        sourceIds: [],
        context: [],
        bindings: [],
      };
      const [key] = await pendingDraftAuthorityInstructions(
        database,
        f.ownerId,
        { threadId: f.threadId, turnId: stopped.turnId },
        null,
        [payload],
        '1',
      );
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [stopped.turnId]);
      const later = await f.add('Another synthetic automatic notice.', '2026-11-19T10:01:00.000Z');
      await database.query("UPDATE turns SET source='event',message_id=NULL WHERE id=$1", [
        later.turnId,
      ]);
      assert.deepEqual(
        await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          { threadId: f.threadId, turnId: later.turnId },
          null,
          [payload],
          '1',
        ),
        [key],
      );
      const captured = await prepareDraftAuthorityCapture(database, f.ownerId, key!, later.turnId);
      assert.ok(captured?.complete);
      const row = (
        await database.query(
          'SELECT state,attempted,attempt_turn_id FROM draft_authority_instructions WHERE key=$1',
          [key],
        )
      ).rows[0];
      assert.deepEqual(row, { state: 'pending', attempted: true, attempt_turn_id: later.turnId });
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [later.turnId]);
      const nextTurnId = randomUUID();
      assert.equal(
        await prepareDraftAuthorityCapture(database, f.ownerId, key!, nextTurnId),
        undefined,
      );
      await finishDraftAuthorityCapture(
        database,
        f.ownerId,
        { ...captured, turnId: nextTurnId },
        'clear',
      );
      const [source] = await retainedDraftAuthorityInstructions(
        database,
        f.ownerId,
        f.threadId,
        null,
        '1',
      );
      assert.equal(source.unavailable, true);
    });

    await t.test('a later first attempt cannot replace withdrawn original context', async () => {
      const f = await fixture();
      const original = await f.add('Use the synthetic report for the saved rule.');
      const payload = {
        kind: 'rules' as const,
        scope: 'rules',
        data: { field: 'rules', versions: [{ value: 'Use that synthetic report.' }] },
        evidence: { messages: [original] },
        sourceIds: [original.id],
        context: [],
        bindings: [],
      };
      const [key] = await pendingDraftAuthorityInstructions(
        database,
        f.ownerId,
        { threadId: f.threadId, turnId: original.turnId },
        null,
        [payload],
        '1',
      );
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [original.turnId]);
      const turn = { threadId: f.threadId, turnId: randomUUID() };
      assert.deepEqual(
        await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [{ ...payload, evidence: { messages: [] }, sourceIds: [] }],
          '1',
        ),
        [key],
      );
      const captured = await prepareDraftAuthorityCapture(database, f.ownerId, key!, turn.turnId);
      assert.equal(captured?.complete, false);
      assert.deepEqual(
        (
          await database.query(
            'SELECT state,attempted,attempt_turn_id FROM draft_authority_instructions WHERE key=$1',
            [key],
          )
        ).rows[0],
        { state: 'pending', attempted: false, attempt_turn_id: null },
      );
      const [source] = await retainedDraftAuthorityInstructions(
        database,
        f.ownerId,
        f.threadId,
        null,
        '1',
      );
      assert.equal(source.unavailable, true);
      assert.deepEqual(source.messages, []);
    });

    await t.test('two first callers claim one authority capture', async () => {
      const f = await fixture();
      const [key] = await pendingDraftAuthorityInstructions(
        database,
        f.ownerId,
        { threadId: f.threadId, turnId: randomUUID() },
        null,
        [
          {
            kind: 'rules',
            scope: 'rules',
            data: { field: 'rules', versions: [{ value: 'Use clear synthetic words.' }] },
            evidence: { messages: [] },
            sourceIds: [],
            context: [],
            bindings: [],
          },
        ],
        '1',
      );
      const captures = await Promise.all(
        [randomUUID(), randomUUID()].map((turnId) =>
          prepareDraftAuthorityCapture(database, f.ownerId, key!, turnId),
        ),
      );
      const claimed = captures.filter((capture) => capture?.complete);
      assert.equal(claimed.length, 1);
      const winner = claimed[0]!;
      const row = (
        await database.query(
          'SELECT state,attempted,attempt_turn_id FROM draft_authority_instructions WHERE key=$1',
          [key],
        )
      ).rows[0];
      assert.deepEqual(row, { state: 'pending', attempted: true, attempt_turn_id: winner.turnId });
      await finishDraftAuthorityCapture(
        database,
        f.ownerId,
        { ...winner, turnId: randomUUID() },
        'clear',
      );
      assert.equal(
        (await database.query('SELECT state FROM draft_authority_instructions WHERE key=$1', [key]))
          .rows[0].state,
        'pending',
      );
      await finishDraftAuthorityCapture(database, f.ownerId, winner, 'clear');
      assert.equal(
        (await database.query('SELECT state FROM draft_authority_instructions WHERE key=$1', [key]))
          .rows[0].state,
        'clear',
      );
    });

    await t.test('an interrupted authority capture stays pending and is not replayed', async () => {
      const f = await fixture();
      const a = await authority(f);
      const captured = await prepareDraftAuthorityCapture(
        database,
        f.ownerId,
        a.key,
        a.turn.turnId,
      );
      assert.ok(captured?.complete);
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [a.message.turnId]);
      await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
      assert.equal(
        await prepareDraftAuthorityCapture(database, f.ownerId, a.key, a.turn.turnId),
        undefined,
      );
      const [source] = await retainedDraftAuthorityInstructions(
        database,
        f.ownerId,
        f.threadId,
        null,
        '1',
      );
      assert.equal(source.unavailable, true);
      assert.deepEqual(source.messages, []);
    });

    await t.test(
      'authority versions bind saved fields, approvals, active context and task scope',
      async () => {
        const f = await fixture();
        const a = await authority(f);
        const keys = [a.key];
        for (const payload of [
          { ...a.payload, data: { fields: { prompt: 'Show a changed synthetic report.' } } },
          {
            ...a.payload,
            data: {
              approvals: [
                { id: randomUUID(), at: a.message.at, definition: { prompt: a.message.text } },
              ],
            },
          },
          {
            ...a.payload,
            context: [
              {
                kind: 'active',
                ownerData: [
                  {
                    kind: 'rules',
                    ownerData: {
                      field: 'rules',
                      versions: [{ value: 'Show the changed synthetic report.' }],
                    },
                  },
                ],
                unavailable: false,
              },
            ],
          },
        ])
          keys.push(
            ...(await pendingDraftAuthorityInstructions(
              database,
              f.ownerId,
              a.turn,
              null,
              [payload],
              '1',
            )),
          );
        keys.push(
          ...(await pendingDraftAuthorityInstructions(
            database,
            f.ownerId,
            a.turn,
            randomUUID(),
            [a.payload],
            '1',
          )),
        );
        keys.push(
          ...(await pendingDraftAuthorityInstructions(
            database,
            f.ownerId,
            a.turn,
            null,
            [a.payload],
            '2',
          )),
        );
        assert.equal(new Set(keys).size, keys.length);
      },
    );

    await t.test(
      'field replacements preserve A to B to A and a later empty replacement',
      async () => {
        const f = await fixture();
        const values = [
          'Show the synthetic draft before sending.',
          'Do not send the synthetic draft.',
          'Show the synthetic draft before sending.',
          '',
        ];
        const keys = [];
        for (const [index, value] of values.entries()) {
          const data = await draftOwnerField(database, f.ownerId, 'rules', value);
          const turn = { threadId: f.threadId, turnId: randomUUID() };
          const [key] = await pendingDraftAuthorityInstructions(
            database,
            f.ownerId,
            turn,
            null,
            [
              {
                kind: 'rules',
                scope: 'rules',
                data,
                evidence: { messages: [] },
                sourceIds: [],
                context: [],
                bindings: [],
              },
            ],
            '1',
          );
          assert.ok(key);
          keys.push(key);
          const captured = await prepareDraftAuthorityCapture(
            database,
            f.ownerId,
            key,
            turn.turnId,
          );
          assert.ok(captured?.complete);
          assert.deepEqual(
            data.versions.map((version) => version.value),
            values.slice(0, index + 1),
          );
          assert.deepEqual(captured.input.newMessages[0].ownerData, data);
          await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
        }
        assert.equal(new Set(keys).size, values.length);
        const sources = await retainedDraftAuthorityInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        assert.equal(sources.length, values.length);
        assert.ok(sources.every((source) => !source.unavailable));
        assert.deepEqual(
          Object(sources.at(-1)!.target.ownerData).versions.map(
            (version: { value: string }) => version.value,
          ),
          values,
        );
      },
    );

    for (const active of [false, true]) {
      for (const approved of [false, true]) {
        await t.test(
          `an empty ${active ? 'active' : 'saved'} schedule needs complete owner approval: ${approved}`,
          async () => {
            const f = await fixture();
            const turn = { threadId: f.threadId, turnId: randomUUID() };
            const data = {
              messages: [],
              ...(approved
                ? {
                    approvals: [
                      {
                        id: randomUUID(),
                        at: '2026-11-19T10:00:00.000Z',
                        definition: { prompt: 'Read the synthetic report.' },
                      },
                    ],
                  }
                : {}),
            };
            const [key] = await pendingDraftAuthorityInstructions(
              database,
              f.ownerId,
              turn,
              null,
              [
                {
                  kind: active ? 'rules' : 'schedule',
                  scope: randomUUID(),
                  data: active
                    ? { field: 'rules', versions: [{ value: 'Use the saved synthetic schedule.' }] }
                    : data,
                  evidence: { messages: [] },
                  sourceIds: [],
                  bindings: [],
                  context: active
                    ? [
                        {
                          kind: 'active',
                          ownerData: [{ kind: 'schedule', ownerData: data }],
                          unavailable: false,
                        },
                      ]
                    : [],
                },
              ],
              '1',
            );
            const captured = await prepareDraftAuthorityCapture(
              database,
              f.ownerId,
              key!,
              turn.turnId,
            );
            assert.ok(captured);
            assert.equal(captured.complete, approved);
            await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
            const sources = await retainedDraftAuthorityInstructions(
              database,
              f.ownerId,
              f.threadId,
              null,
              '1',
            );
            assert.equal(sources.length, approved ? 0 : 1);
            if (!approved) assert.equal(sources[0].unavailable, true);
          },
        );
      }
    }

    await t.test(
      'never-populated empty fields need no model but missing schedule authority stays pending',
      async () => {
        const f = await fixture();
        const turn = { threadId: f.threadId, turnId: randomUUID() };
        const base = {
          scope: 'empty',
          data: null,
          evidence: { messages: [] },
          sourceIds: [],
          context: [],
          bindings: [],
          empty: true,
        };
        const [empty] = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [{ ...base, kind: 'rules' }],
          '1',
        );
        assert.equal(
          await prepareDraftAuthorityCapture(database, f.ownerId, empty!, turn.turnId),
          undefined,
        );
        const [missing] = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [{ ...base, kind: 'schedule', unavailable: true }],
          '1',
        );
        assert.equal(
          (await prepareDraftAuthorityCapture(database, f.ownerId, missing!, turn.turnId))
            ?.complete,
          false,
        );
        const sources = await retainedDraftAuthorityInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        assert.equal(sources.length, 1);
        assert.equal(sources[0].unavailable, true);
      },
    );

    for (const prior of ['chat', 'authority'] as const)
      for (const next of ['chat', 'authority'] as const) {
        await t.test(
          `a new ${next} relation receives the complete older ${prior} condition`,
          async () => {
            const f = await fixture();
            const condition = `Show synthetic draft X before sending. complete-${prior}-${next}`;
            if (prior === 'chat') await f.capture(await f.add(condition), 'relevant');
            else {
              const a = await authority(f, condition);
              const captured = await prepareDraftAuthorityCapture(
                database,
                f.ownerId,
                a.key,
                a.turn.turnId,
              );
              assert.ok(captured?.complete);
              await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
            }
            const unrelated = [];
            for (let index = 1; index <= 6; index++) {
              const message = await f.add(
                `Unrelated synthetic value ${index}.`,
                `2026-11-19T10:0${index}:00.000Z`,
              );
              await f.capture(message, 'clear');
              unrelated.push(message);
            }
            const message = await f.add(
              'Use that same review step for synthetic draft Y.',
              '2026-11-19T10:07:00.000Z',
            );
            const words = [...unrelated.slice(-4), message];
            if (next === 'chat') {
              await f.pending(message);
              const captured = await prepareChatDraftCapture(database, f.ownerId, message.id, {
                messages: words,
              });
              assert.ok(captured?.complete);
              assert.equal(JSON.stringify(captured.input).includes(condition), true);
              await finishChatDraftCapture(database, f.ownerId, captured, 'relevant');
              assert.equal(JSON.stringify(await f.retained()).includes(condition), true);
            } else {
              const context = await captureDraftConditionContext(
                database,
                f.ownerId,
                f.threadId,
                null,
                '1',
                [],
                message.turnId,
              );
              const payload = {
                kind: 'schedule' as const,
                scope: randomUUID(),
                data: { messages: words },
                evidence: { messages: words },
                sourceIds: words.map((word) => word.id),
                context: context.input,
                conditionSources: context.conditions,
                bindings: [],
              };
              const [key] = await pendingDraftAuthorityInstructions(
                database,
                f.ownerId,
                { turnId: message.turnId, threadId: f.threadId },
                null,
                [payload],
                '1',
              );
              const captured = await prepareDraftAuthorityCapture(
                database,
                f.ownerId,
                key!,
                message.turnId,
              );
              assert.ok(captured?.complete);
              assert.equal(JSON.stringify(captured.input).includes(condition), true);
              await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
              assert.equal(
                JSON.stringify(
                  await retainedDraftAuthorityInstructions(
                    database,
                    f.ownerId,
                    f.threadId,
                    null,
                    '1',
                  ),
                ).includes(condition),
                true,
              );
            }
          },
        );
      }

    await t.test('a required pending context refuses a new clear result', async () => {
      const f = await fixture();
      const first = await f.add('Show the synthetic unknown draft before sending.');
      await f.pending(first);
      const next = await f.add(
        'Use that same step for another synthetic draft.',
        '2026-11-19T10:01:00.000Z',
      );
      await f.pending(next);
      const captured = await prepareChatDraftCapture(database, f.ownerId, next.id, {
        messages: [next],
      });
      assert.ok(captured);
      assert.equal(captured.complete, false);
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.equal((await f.row(next.id)).state, 'pending');
    });

    await t.test('a changed older condition refuses a new clear after capture', async () => {
      const f = await fixture();
      const first = await f.add('Show the synthetic inherited draft before sending.');
      await f.capture(first, 'relevant');
      const next = await f.add(
        'Use that same step for another synthetic draft.',
        '2026-11-19T10:01:00.000Z',
      );
      await f.pending(next);
      const captured = await prepareChatDraftCapture(database, f.ownerId, next.id, {
        messages: [next],
      });
      assert.ok(captured?.complete);
      await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [first.id]);
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.equal((await f.row(next.id)).state, 'pending');
      assert.equal(JSON.stringify(await f.retained()).includes(first.text), false);
    });

    await t.test('a future condition survives without any assistant output', async () => {
      const f = await fixture();
      const message = await f.add('Show the synthetic draft before any later send.');
      const captured = await f.capture(message, 'relevant');
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.equal((await f.row(message.id)).state, 'relevant');
      const [source] = await f.retained();
      assert.equal(source.kind, 'chat');
      assert.equal(source.unavailable, false);
      assert.equal(source.connectionId, null);
      assert.deepEqual(
        source.messages.map((value) => [value.text, value.canAuthorize]),
        [[message.text, false]],
      );
    });

    await t.test(
      'a child task reference does not change a parent input scope or clear cache',
      async () => {
        const f = await fixture();
        const first = await f.add('Explain a synthetic value and start its research.');
        await f.capture(first, 'clear');
        const later = await f.add('Use that synthetic research model.', '2026-11-19T10:01:00.000Z');
        await f.capture(later, 'clear', [first, later]);
        const before = await f.row(later.id);
        const taskId = randomUUID();
        await database.query(
          'INSERT INTO tasks(id,owner_id,title,created_at) VALUES($1,$2,$3,$4)',
          [taskId, f.ownerId, 'Synthetic referenced research', '2026-11-19T10:02:00.000Z'],
        );
        await database.query(
          "INSERT INTO turns(id,owner_id,thread_id,message_id,task_id,source,created_at) VALUES($1,$2,$3,$4,$5,'task',$6)",
          [randomUUID(), f.ownerId, f.threadId, first.id, taskId, '2026-11-19T10:02:00.000Z'],
        );
        assert.deepEqual(await f.retained(), []);
        assert.deepEqual(await f.retained(taskId), []);
        assert.equal((await f.row(later.id)).revision, before.revision);
      },
    );

    await t.test('a clear cache depends on its checked sources instead of later chat', async () => {
      const f = await fixture();
      const first = await f.add('Explain a synthetic number.');
      await f.capture(first, 'clear');
      const before = await f.row(first.id);
      for (let index = 0; index < 8; index++) {
        const message = await f.add(
          `Synthetic unrelated question ${index}.`,
          `2026-11-19T10:0${index + 1}:00.000Z`,
        );
        await f.capture(message, 'clear');
      }
      assert.equal((await f.row(first.id)).revision, before.revision);
      t.diagnostic(
        JSON.stringify({
          clearBefore: before.revision,
          clearAfterUnrelated: (await f.row(first.id)).revision,
          unrelatedCaptures: 8,
        }),
      );
      assert.deepEqual(await f.retained(), []);
    });

    await t.test(
      'withdrawal alone keeps a completed clear result without exposing old words',
      async () => {
        const f = await fixture();
        const stopped = await f.add('Explain a synthetic neutral value.');
        await f.capture(stopped, 'clear');
        const other = await f.add(
          'Explain a separate synthetic value.',
          '2026-11-19T10:01:00.000Z',
        );
        await f.capture(other, 'clear');
        const before = await f.row(other.id);
        assert.deepEqual(await f.retained(), []);
        await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [stopped.turnId]);
        const sources = await f.retained();
        assert.deepEqual(sources, []);
        assert.equal((await f.row(other.id)).revision, before.revision);
        const forced = await retainedChatDraftInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          false,
          '1',
          [stopped.id],
        );
        assert.equal(forced.length, 1);
        assert.equal(forced[0].unavailable, true);
        assert.deepEqual(forced[0].messages, []);
      },
    );

    for (const mode of ['withdrawn', 'hidden', 'deleted', 'edited'] as const) {
      await t.test(`a parent that is ${mode} invalidates a child's clear result`, async () => {
        const f = await fixture();
        const parent = await f.add('Show the synthetic draft before sending.');
        await f.capture(parent, 'relevant');
        const child = await f.add(
          'Use that review condition for the next synthetic report.',
          '2026-11-19T10:01:00.000Z',
        );
        await f.capture(child, 'clear');
        assert.equal((await f.row(child.id)).state, 'clear');
        if (mode === 'withdrawn')
          await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [parent.turnId]);
        if (mode === 'hidden')
          await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [parent.id]);
        if (mode === 'deleted')
          await database.query('DELETE FROM messages WHERE id=$1', [parent.id]);
        if (mode === 'edited')
          await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
            parent.id,
            'Show the changed synthetic draft before sending.',
          ]);
        const retained = await f.retained();
        assert.equal(retained.length, 2);
        assert.ok(retained.every((source) => source.unavailable));
        assert.ok(JSON.stringify(retained).includes(child.text));
        if (mode !== 'edited') assert.ok(!JSON.stringify(retained).includes(parent.text));
        const context = await captureDraftConditionContext(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        assert.equal(context.complete, false);
        assert.equal(context.input.length, 2);
        assert.ok(JSON.stringify(context.input).includes(child.text));
        if (mode !== 'edited') assert.ok(!JSON.stringify(context.input).includes(parent.text));
      });
    }

    await t.test('a changed transitive condition edge invalidates a clear result', async () => {
      const f = await fixture();
      const parent = await f.add('Show the synthetic report before sending.');
      await f.capture(parent, 'relevant');
      const middle = await f.add('Keep that review condition.', '2026-11-19T10:01:00.000Z');
      await f.capture(middle, 'relevant');
      const child = await f.add('Use the same synthetic report.', '2026-11-19T10:02:00.000Z');
      await f.capture(child, 'clear');
      assert.equal((await f.retained()).length, 2);
      await database.query(
        'UPDATE chat_draft_instructions SET condition_sources=$2 WHERE message_id=$1',
        [
          parent.id,
          JSON.stringify([
            {
              kind: 'chat',
              id: randomUUID(),
              state: 'relevant',
              revision: 'synthetic',
              available: false,
            },
          ]),
        ],
      );
      const retained = await f.retained();
      assert.equal(retained.length, 3);
      assert.ok(retained.every((source) => source.unavailable));
      assert.ok(JSON.stringify(retained).includes(child.text));
      const context = await captureDraftConditionContext(
        database,
        f.ownerId,
        f.threadId,
        null,
        '1',
      );
      assert.equal(context.complete, false);
      assert.equal(context.input.length, 3);
    });

    await t.test('a stopped capture cannot save a late clear result', async () => {
      const f = await fixture();
      const stopped = await f.add('Synthetic late-stop sentinel.');
      await f.pending(stopped);
      const captured = await prepareChatDraftCapture(database, f.ownerId, stopped.id, {
        messages: [stopped],
      });
      assert.ok(captured?.complete);
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [stopped.turnId]);
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.equal((await f.row(stopped.id)).state, 'pending');
      assert.equal(
        await prepareChatDraftCapture(database, f.ownerId, stopped.id, { messages: [stopped] }),
        undefined,
      );
      const [source] = await f.retained();
      assert.equal(source.unavailable, true);
      assert.deepEqual(source.messages, []);
    });

    for (const mode of ['source', 'hidden', 'deleted', 'policy'] as const) {
      await t.test(`a ${mode} change invalidates a completed clear result`, async () => {
        const f = await fixture();
        const message = await f.add(`Synthetic clear-source-${mode}.`);
        await f.capture(message, 'clear');
        if (mode === 'source')
          await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
            message.id,
            'Changed synthetic words.',
          ]);
        if (mode === 'hidden')
          await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [message.id]);
        if (mode === 'deleted')
          await database.query('DELETE FROM messages WHERE id=$1', [message.id]);
        const sources = await retainedChatDraftInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          false,
          mode === 'policy' ? '2' : '1',
        );
        assert.equal(sources.length, 1);
        assert.equal(sources[0].unavailable, true);
      });
    }

    await t.test('a direct reply recovers a stopped clear source without its words', async () => {
      const f = await fixture();
      const stopped = await f.add('Synthetic stopped original grant.');
      await f.capture(stopped, 'clear');
      const answer = await f.add(
        'Synthetic original draft.',
        '2026-11-19T10:00:01.000Z',
        stopped.turnId,
        'assistant',
      );
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [stopped.turnId]);
      const next = await f.add('Send that synthetic draft.', '2026-11-19T10:01:00.000Z');
      await database.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
        next.id,
        answer.id,
      ]);
      const links = await linkedChatDraftMessageIds(database, f.ownerId, {
        turnId: next.turnId,
        threadId: f.threadId,
      });
      assert.ok(links.includes(stopped.id));
      const sources = await retainedChatDraftInstructions(
        database,
        f.ownerId,
        f.threadId,
        null,
        false,
        '1',
        links,
      );
      assert.equal(sources.length, 1);
      assert.equal(sources[0].unavailable, true);
      assert.deepEqual(sources[0].messages, []);
    });

    await t.test(
      'source recovery excludes verified card answers and keeps missing owner pointers',
      async () => {
        const f = await fixture();
        const original = await f.add('Show the synthetic original draft.');
        await f.capture(original, 'relevant');
        const cardAnswer = await f.add('Send', '2026-11-19T10:01:00.000Z');
        await database.query('UPDATE messages SET approval_answer=true WHERE id=$1', [
          cardAnswer.id,
        ]);
        await database.query('UPDATE turns SET parent_turn_id=$2 WHERE id=$1', [
          cardAnswer.turnId,
          original.turnId,
        ]);
        const answer = await f.add(
          'Synthetic completed action.',
          '2026-11-19T10:01:01.000Z',
          cardAnswer.turnId,
          'assistant',
        );
        const next = await f.add('Explain that synthetic result.', '2026-11-19T10:02:00.000Z');
        await database.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
          next.id,
          answer.id,
        ]);
        const turn = { turnId: next.turnId, threadId: f.threadId };
        assert.deepEqual(await linkedChatDraftMessageIds(database, f.ownerId, turn), [original.id]);
        await database.query('UPDATE messages SET approval_answer=false WHERE id=$1', [
          cardAnswer.id,
        ]);
        assert.deepEqual(await linkedChatDraftMessageIds(database, f.ownerId, turn), [original.id]);
        await database.query('UPDATE messages SET approval_answer=NULL,text=$2 WHERE id=$1', [
          cardAnswer.id,
          'No, show all synthetic edits first.',
        ]);
        assert.deepEqual(
          new Set(await linkedChatDraftMessageIds(database, f.ownerId, turn)),
          new Set([original.id, cardAnswer.id]),
        );
        await database.query('DELETE FROM messages WHERE id=$1', [original.id]);
        assert.deepEqual(
          new Set(await linkedChatDraftMessageIds(database, f.ownerId, turn)),
          new Set([original.id, cardAnswer.id]),
        );
      },
    );

    await t.test(
      'artifact IDs and stored byte versions recover exact work without proving authorship',
      async () => {
        const f = await fixture();
        const original = await f.add('Show this synthetic attachment before sharing.');
        await f.capture(original, 'relevant');
        const artifactId = randomUUID();
        const sha256 = 'a'.repeat(64);
        await database.query(
          'INSERT INTO draft_artifact_sources(artifact_id,owner_id,thread_id,turn_id,sha256,size) VALUES($1,$2,$3,$4,$5,7)',
          [artifactId, f.ownerId, f.threadId, original.turnId, sha256],
        );
        const later = await f.add('Send a synthetic attachment.', '2026-11-19T10:01:00.000Z');
        const turn = { turnId: later.turnId, threadId: f.threadId };
        for (const args of [
          { body: `Synthetic link /api/artifacts/${artifactId}` },
          { attachments: [{ workspaceFile: 'renamed.txt', sha256, size: 7 }] },
        ]) {
          const linked = await linkedDraftSources(database, f.ownerId, turn, args);
          assert.deepEqual(linked.messageIds, [original.id]);
          assert.ok(linked.provedTurnIds.includes(original.turnId));
        }
        assert.deepEqual(
          (
            await linkedDraftSources(database, f.ownerId, turn, {
              attachment: { workspaceFile: 'old.txt', sha256: 'b'.repeat(64), size: 7 },
            })
          ).messageIds,
          [],
        );
        await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [original.id]);
        const linked = await linkedDraftSources(database, f.ownerId, turn, {
          body: `/api/artifacts/${artifactId}`,
        });
        const [source] = await retainedChatDraftInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          false,
          '1',
          linked.messageIds,
        );
        assert.equal(source.unavailable, true);
        assert.deepEqual(source.messages, []);
      },
    );

    await t.test(
      'a reset keeps old sources for exact recovery without sending them to unrelated work',
      async () => {
        const f = await fixture();
        const original = await f.add('Show the synthetic reset draft before sending.');
        await f.capture(original, 'relevant');
        const answer = await f.add(
          'Synthetic exact reset draft.',
          '2026-11-19T10:00:01.000Z',
          original.turnId,
          'assistant',
        );
        const nextThread = randomUUID();
        await database.query('INSERT INTO threads(id) VALUES($1)', [nextThread]);
        assert.deepEqual(
          await retainedChatDraftInstructions(database, f.ownerId, nextThread, null),
          [],
        );
        const turnId = randomUUID();
        await database.query(
          'INSERT INTO turns(id,owner_id,thread_id,created_at) VALUES($1,$2,$3,now())',
          [turnId, f.ownerId, nextThread],
        );
        const linked = await linkedDraftSources(
          database,
          f.ownerId,
          { turnId, threadId: nextThread },
          { body: answer.text },
        );
        assert.ok(linked.provedTurnIds.includes(original.turnId));
        const [source] = await retainedChatDraftInstructions(
          database,
          f.ownerId,
          nextThread,
          null,
          false,
          '1',
          linked.messageIds,
        );
        assert.equal(source.unavailable, true);
        assert.deepEqual(source.messages, []);
        assert.equal((await f.row(original.id)).state, 'relevant');
        const retained = await retainedDraftAuthorityInstructions(
          database,
          f.ownerId,
          nextThread,
          null,
          '1',
          linked.provedTurnIds,
        );
        assert.equal(retained.length, 1);
        assert.equal(retained[0].unavailable, true);
        assert.equal(JSON.stringify(retained).includes(original.text), false);
      },
    );

    await t.test(
      'canonical capture filters clicked answers even when origin IDs include them',
      async () => {
        const f = await fixture();
        const original = await f.add('Show the synthetic draft before sending.');
        const yes = await f.add('Send', '2026-11-19T10:01:00.000Z');
        const no = await f.add('Cancel', '2026-11-19T10:02:00.000Z');
        const typed = await f.add(
          'No, show the synthetic changes first.',
          '2026-11-19T10:03:00.000Z',
        );
        await database.query('UPDATE messages SET approval_answer=true WHERE id=$1', [yes.id]);
        await database.query('UPDATE messages SET approval_answer=false WHERE id=$1', [no.id]);
        const missing = randomUUID();
        const ids = await eligibleChatDraftInputIds(
          database,
          f.ownerId,
          { turnId: typed.turnId, threadId: f.threadId },
          [original.id, yes.id, no.id, typed.id, missing],
        );
        assert.deepEqual(new Set(ids), new Set([original.id, typed.id, missing]));
      },
    );

    for (const title of [
      'Prepare the synthetic draft and show it before sending.',
      'Send the synthetic draft without another review.',
    ]) {
      await t.test(`Nod task titles stay out of condition sources: ${title}`, async () => {
        const f = await fixture();
        const original = await f.add(
          'Show the original synthetic draft before sending.',
          '2026-11-19T09:58:00.000Z',
        );
        await f.capture(original, 'relevant');
        const offer = await f.add(
          'Choose a synthetic task.',
          '2026-11-19T09:59:00.000Z',
          randomUUID(),
          'assistant',
        );
        await database.query('UPDATE messages SET suggestions=$2 WHERE id=$1', [
          offer.id,
          { tasks: [{ title }] },
        ]);
        const tapped = await f.add(title);
        await f.pending(tapped);
        assert.equal(await f.row(tapped.id), undefined);
        assert.deepEqual(
          await eligibleChatDraftInputIds(
            database,
            f.ownerId,
            { turnId: tapped.turnId, threadId: f.threadId },
            [tapped.id],
          ),
          [],
        );
        await initializeChatDraftInstructions(database);
        assert.equal(await f.row(tapped.id), undefined);
        await database.query(
          "INSERT INTO chat_draft_instructions(message_id,owner_id,thread_id,turn_id,input_at,source_ids,state,revision,policy_revision) VALUES($1,$2,$3,$4,$5,ARRAY[$1::uuid],'relevant','legacy','1')",
          [tapped.id, f.ownerId, f.threadId, tapped.turnId, tapped.at],
        );
        assert.equal(
          await prepareChatDraftCapture(database, f.ownerId, tapped.id, { messages: [] }),
          undefined,
        );
        const retained = await retainedChatDraftInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          false,
          '1',
          [tapped.id],
        );
        assert.equal(retained.length, 1);
        assert.equal(
          retained[0].messages.some((message) => message.text === title),
          false,
        );
        assert.equal(
          retained[0].messages.some((message) => message.text === original.text),
          true,
        );
        const answer = await f.add(
          'Synthetic offered task response.',
          '2026-11-19T10:00:01.000Z',
          tapped.turnId,
          'assistant',
        );
        const qualified = await f.add(
          `${title} But show the complete synthetic message first.`,
          '2026-11-19T10:01:00.000Z',
        );
        await database.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
          qualified.id,
          answer.id,
        ]);
        const links = await linkedDraftSources(database, f.ownerId, {
          turnId: qualified.turnId,
          threadId: f.threadId,
        });
        assert.equal(links.messageIds.includes(tapped.id), false);
        assert.equal(links.provedTurnIds.includes(tapped.turnId), false);
        await f.pending(qualified);
        const captured = await prepareChatDraftCapture(database, f.ownerId, qualified.id, {
          messages: [qualified],
        });
        assert.ok(captured?.complete);
        assert.equal(captured.input.newMessages[0].text, qualified.text);
        assert.equal(
          captured.input.userMessages.some((message) => message.text === title),
          false,
        );
      });
    }

    await t.test('a later Nod title does not replace earlier genuine owner words', async () => {
      const f = await fixture();
      const text = 'Show the synthetic complete message before sending.';
      const original = await f.add(text, '2026-11-19T09:58:00.000Z');
      await f.capture(original, 'relevant');
      const offer = await f.add(
        'Synthetic later offer.',
        '2026-11-19T09:59:00.000Z',
        randomUUID(),
        'assistant',
      );
      await database.query('UPDATE messages SET suggestions=$2 WHERE id=$1', [
        offer.id,
        { tasks: [{ title: text }] },
      ]);
      const [source] = await f.retained();
      assert.equal(source.unavailable, false);
      assert.equal(source.messages[0].text, text);
    });

    await t.test('a late clear cannot replace a changed source', async () => {
      const f = await fixture();
      const message = await f.add('Explain the synthetic draft.');
      await f.pending(message);
      const captured = await prepareChatDraftCapture(database, f.ownerId, message.id, {
        messages: [message],
      });
      assert.ok(captured?.complete);
      await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
        message.id,
        'Show the synthetic draft before sending.',
      ]);
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.equal((await f.row(message.id)).state, 'pending');
      assert.equal((await f.retained())[0].unavailable, true);
    });

    await t.test('an assistant-context change invalidates a clear result', async () => {
      const f = await fixture();
      const context = await f.add(
        'Synthetic message context.',
        '2026-11-19T09:59:00.000Z',
        randomUUID(),
        'assistant',
      );
      const message = await f.add('Explain that synthetic text.');
      await f.pending(message);
      const captured = await prepareChatDraftCapture(database, f.ownerId, message.id, {
        messages: [{ ...message, replyTo: { id: context.id, text: context.text } }],
      });
      assert.ok(captured?.complete);
      await finishChatDraftCapture(database, f.ownerId, captured, 'clear');
      assert.deepEqual(await f.retained(), []);
      await database.query('UPDATE messages SET text=$2 WHERE id=$1', [
        context.id,
        'Changed synthetic message context.',
      ]);
      assert.equal((await f.retained())[0].unavailable, true);
    });

    await t.test('steering adds a source without overwriting a known condition', async () => {
      const f = await fixture();
      const original = await f.add('Show the first synthetic email before sending.');
      await f.capture(original, 'relevant');
      const before = await f.row(original.id);
      const correction = await f.add(
        'For the second synthetic email, no review is needed.',
        '2026-11-19T10:01:00.000Z',
        original.turnId,
      );
      await f.capture(correction, 'relevant', [original, correction]);
      const after = await f.row(original.id);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.source_ids, before.source_ids);
      const sources = await f.retained();
      assert.ok(
        sources.some((source) => source.messages.some((message) => message.text === original.text)),
      );
      assert.ok(
        sources.some(
          (source) =>
            source.messages.map((message) => message.text).join('|') ===
            `${original.text}|${correction.text}`,
        ),
      );
    });

    for (const mode of ['hidden', 'withdrawn', 'deleted'] as const) {
      await t.test(
        `${mode} owner words stay out while their source remains unavailable`,
        async () => {
          const f = await fixture();
          const message = await f.add(`Show synthetic private-source-${mode} before sending.`);
          await f.capture(message, 'relevant');
          if (mode === 'hidden')
            await database.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [message.id]);
          else if (mode === 'withdrawn')
            await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [message.turnId]);
          else await database.query('DELETE FROM messages WHERE id=$1', [message.id]);
          const sources = await f.retained();
          assert.equal(sources.length, 1);
          assert.equal(sources[0].unavailable, true);
          assert.ok(!JSON.stringify(sources).includes(`private-source-${mode}`));
        },
      );
    }

    await t.test('a child keeps its frozen chat boundary after later parent steering', async () => {
      const f = await fixture();
      const original = await f.add('Show the initial synthetic email before sending.');
      await f.capture(original, 'relevant');
      const taskId = randomUUID();
      await database.query('INSERT INTO tasks(id,owner_id,title,created_at) VALUES($1,$2,$3,$4)', [
        taskId,
        f.ownerId,
        'Synthetic child',
        '2026-11-19T10:01:00.000Z',
      ]);
      const later = await f.add(
        'Later main-chat condition that is outside the child.',
        '2026-11-19T10:02:00.000Z',
        original.turnId,
      );
      await f.capture(later, 'relevant', [original, later]);
      const child = await f.retained(taskId);
      assert.ok(JSON.stringify(child).includes(original.text));
      assert.ok(!JSON.stringify(child).includes(later.text));
      assert.equal(child.length, 1);
      const reply = await f.add(
        'Show this child draft before its send.',
        '2026-11-19T10:03:00.000Z',
        original.turnId,
      );
      const queued = randomUUID();
      await database.query(
        'INSERT INTO turns(id,owner_id,thread_id,message_id,created_at,task_id) VALUES($1,$2,$3,$4,$5,$6)',
        [queued, f.ownerId, f.threadId, reply.id, reply.at, taskId],
      );
      await f.pending(reply, taskId, queued);
      const captured = await prepareChatDraftCapture(database, f.ownerId, reply.id, {
        messages: [original, reply],
      });
      assert.ok(captured?.complete);
      await finishChatDraftCapture(database, f.ownerId, captured, 'relevant');
      assert.ok(JSON.stringify(await f.retained(taskId)).includes(reply.text));
      assert.ok(!JSON.stringify(await f.retained()).includes(reply.text));
    });

    await t.test(
      'legacy backfill keeps the first main input scope after a child reference',
      async () => {
        const f = await fixture();
        const original = await f.add(
          'Show the synthetic legacy report before sending.',
          '2026-11-19T09:58:00.000Z',
        );
        const taskId = randomUUID();
        const childTurnId = randomUUID();
        await database.query(
          'INSERT INTO tasks(id,owner_id,title,created_at) VALUES($1,$2,$3,$4)',
          [taskId, f.ownerId, 'Synthetic child task', '2026-11-19T10:00:00.000Z'],
        );
        await database.query(
          "INSERT INTO turns(id,owner_id,thread_id,message_id,source,created_at,task_id,parent_turn_id) VALUES($1,$2,$3,$4,'task',$5,$6,$7)",
          [
            childTurnId,
            f.ownerId,
            f.threadId,
            original.id,
            '2026-11-19T10:01:00.000Z',
            taskId,
            original.turnId,
          ],
        );
        await initializeChatDraftInstructions(database);
        const row = await f.row(original.id);
        assert.equal(row.turn_id, original.turnId);
        assert.equal(row.task_id, null);
        const retained = await f.retained();
        assert.equal(retained.length, 1);
        assert.equal(retained[0].unavailable, true);
        assert.ok(JSON.stringify(retained).includes(original.text));
      },
    );

    await t.test('legacy backfill keeps a queued reply with its first accepting task', async () => {
      const f = await fixture();
      const original = await f.add(
        'Prepare the synthetic parent report.',
        '2026-11-19T09:58:00.000Z',
      );
      const reply = await f.add(
        'Show the synthetic task report before sending.',
        '2026-11-19T10:02:00.000Z',
        original.turnId,
      );
      const tasks = [randomUUID(), randomUUID()];
      const turns = [randomUUID(), randomUUID()];
      for (const [index, taskId] of tasks.entries()) {
        await database.query(
          'INSERT INTO tasks(id,owner_id,title,created_at) VALUES($1,$2,$3,$4)',
          [taskId, f.ownerId, `Synthetic accepting task ${index}.`, '2026-11-19T10:00:00.000Z'],
        );
        await database.query(
          "INSERT INTO turns(id,owner_id,thread_id,message_id,source,created_at,task_id,parent_turn_id) VALUES($1,$2,$3,$4,'task',$5,$6,$7)",
          [
            turns[index],
            f.ownerId,
            f.threadId,
            reply.id,
            `2026-11-19T10:0${index + 2}:00.000Z`,
            taskId,
            original.turnId,
          ],
        );
      }
      await initializeChatDraftInstructions(database);
      const row = await f.row(reply.id);
      assert.equal(row.turn_id, turns[0]);
      assert.equal(row.task_id, tasks[0]);
      const main = await f.retained();
      assert.ok(!JSON.stringify(main).includes(reply.text));
      const task = await f.retained(tasks[0]);
      assert.ok(JSON.stringify(task).includes(reply.text));
    });

    await t.test('legacy backfill preserves a missing message as pending', async () => {
      const f = await fixture();
      const message = await f.add('Synthetic legacy condition.');
      await database.query('DELETE FROM messages WHERE id=$1', [message.id]);
      await initializeChatDraftInstructions(database);
      const row = await f.row(message.id);
      assert.equal(row.state, 'pending');
      assert.deepEqual(row.source_ids, [message.id]);
      assert.equal((await f.retained())[0].unavailable, true);
    });

    await t.test('records survive a database reconnect and stay owner-scoped', async () => {
      const f = await fixture();
      const message = await f.add('Show the durable synthetic draft before sending.');
      await f.capture(message, 'relevant');
      const before = await f.row(message.id);
      await database.end();
      database = new pg.Pool({ connectionString: url.href });
      assert.deepEqual(await f.row(message.id), before);
      assert.equal((await f.retained())[0].unavailable, false);
      assert.deepEqual(
        await retainedChatDraftInstructions(database, randomUUID(), f.threadId, null),
        [],
      );
    });
  },
);

test(
  'draft captures use one thread lock before source locks',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `draft_lock_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    url.searchParams.set('application_name', schema);
    const environment = {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
      NOD_DATA_ROOT: process.env.NOD_DATA_ROOT,
    };
    t.after(() => {
      for (const [key, value] of Object.entries(environment))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const root = await mkdtemp(join(tmpdir(), 'nod-draft-lock-'));
    process.env.DATABASE_URL = url.href;
    process.env.DATABASE_POOL_MAX = '2';
    process.env.NOD_DATA_ROOT = root;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const { ownerId } = await import('../src/server/config.ts');
    const { transaction } = await import('../src/server/transaction.ts');
    const { lockThread, withDraftLock } = await import('../src/server/thread.ts');
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal(
        (
          await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1', [
            schema,
          ])
        ).rows[0].count,
        0,
      );
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    await initializeDatabase();
    await pool.query(`CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,created_at timestamptz NOT NULL);
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS task_id uuid;`);
    const threadId = (await transaction((client) => lockThread(client), pool)).id;
    const make = async (kind: 'chat' | 'authority') => {
      const id = randomUUID();
      const turnId = randomUUID();
      const taskId = randomUUID();
      const at = new Date().toISOString();
      const text = 'Explain the synthetic draft lock.';
      const ref = { threadId, turnId };
      await pool.query('INSERT INTO tasks(id,owner_id,title,created_at) VALUES($1,$2,$3,$4)', [
        taskId,
        ownerId,
        'Synthetic lock task',
        new Date(Date.parse(at) - 1000),
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,session_id,task_id,source,status,message_id,created_at,prompt) VALUES($1,$2,$3,$4,$4,'user','running',$5,$6,$7)",
        [turnId, ownerId, threadId, taskId, id, at, text],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,created_at) VALUES($1,$2,$3,$4,'user',$5,$6)",
        [id, ownerId, threadId, turnId, text, at],
      );
      if (kind === 'chat') {
        const capture = await withDraftLock(ref, undefined, async (client) => {
          await pendingChatDraftInstructions(client, ownerId, ref, [id], taskId);
          return prepareChatDraftCapture(client, ownerId, id, { messages: [{ id, at, text }] });
        });
        assert.ok(capture?.complete);
        return {
          ref,
          finish: (client: PoolClient) => finishChatDraftCapture(client, ownerId, capture, 'clear'),
          state: async () =>
            (
              await pool.query('SELECT state FROM chat_draft_instructions WHERE message_id=$1', [
                id,
              ])
            ).rows[0].state,
        };
      }
      const capture = await withDraftLock(ref, undefined, async (client) => {
        const [key] = await pendingDraftAuthorityInstructions(
          client,
          ownerId,
          ref,
          taskId,
          [
            {
              kind: 'schedule',
              scope: randomUUID(),
              data: { messages: [{ id, at, text }] },
              evidence: { messages: [{ id, at, text }] },
              sourceIds: [id],
              context: [],
              bindings: [],
            },
          ],
          '1',
        );
        return prepareDraftAuthorityCapture(client, ownerId, key!, turnId);
      });
      assert.ok(capture?.complete);
      return {
        ref,
        finish: (client: PoolClient) =>
          finishDraftAuthorityCapture(client, ownerId, capture, 'clear'),
        state: async () =>
          (
            await pool.query('SELECT state FROM draft_authority_instructions WHERE key=$1', [
              capture.key,
            ])
          ).rows[0].state,
      };
    };
    for (const mode of [
      'chat-chat',
      'chat-authority',
      'authority-authority',
      'stop',
      'stop-authority',
      'rollback',
    ] as const) {
      await t.test(mode, async () => {
        const stopped = mode === 'stop' || mode === 'stop-authority';
        const first = await make(mode === 'authority-authority' ? 'authority' : 'chat');
        const second = await make(mode.includes('authority') ? 'authority' : 'chat');
        const deferred = () => {
          let resolve!: () => void;
          const promise = new Promise<void>((done) => {
            resolve = done;
          });
          return { promise, resolve };
        };
        const reached = deferred();
        const release = deferred();
        const controller = new AbortController();
        const entries = [0, 0];
        const updates = [0, 0];
        const wrap = (client: PoolClient, index: number) =>
          ({
            async query(sql: string, values?: unknown[]) {
              if (
                /UPDATE (?:chat_draft_instructions|draft_authority_instructions) SET state=/.test(
                  sql,
                )
              ) {
                updates[index]++;
                if (index === 0) {
                  reached.resolve();
                  await release.promise;
                }
              }
              return client.query(sql, values);
            },
          }) as PoolClient;
        const settle = (work: Promise<unknown>) =>
          work.then(
            () => ({ status: 'fulfilled' }),
            (error: unknown) => ({ status: 'rejected', error }),
          );
        const firstWork = settle(
          withDraftLock(first.ref, undefined, async (client) => {
            entries[0]++;
            await first.finish(wrap(client, 0));
            if (mode === 'rollback') throw new Error('Roll back the synthetic capture.');
          }),
        );
        let secondWork: ReturnType<typeof settle> | undefined;
        try {
          await Promise.race([
            reached.promise,
            delay(3000).then(() => {
              throw new Error('The first capture did not reach its update.');
            }),
          ]);
          secondWork = settle(
            withDraftLock(second.ref, controller.signal, async (client) => {
              entries[1]++;
              await second.finish(wrap(client, 1));
            }),
          );
          let waiting = false;
          for (let index = 0; index < 100; index++) {
            waiting =
              (
                await admin.query(
                  "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%nod_locks%' AND query LIKE '%FOR UPDATE%' AND application_name=$1",
                  [schema],
                )
              ).rows[0].count > 0;
            if (waiting) break;
            await delay(10);
          }
          assert.equal(waiting, true);
          assert.equal(entries[1], 0);
          if (stopped) {
            controller.abort(new Error('Stop the synthetic capture.'));
            assert.equal(
              (
                await Promise.race([
                  secondWork,
                  delay(1000).then(() => {
                    throw new Error('Stop did not end the waiting capture.');
                  }),
                ])
              ).status,
              'rejected',
            );
            assert.equal(entries[1], 0);
          }
        } finally {
          release.resolve();
        }
        const results = await Promise.all([firstWork, secondWork!]);
        assert.deepEqual(entries, [1, stopped ? 0 : 1]);
        assert.deepEqual(updates, [1, stopped ? 0 : 1]);
        assert.equal(results[0].status, mode === 'rollback' ? 'rejected' : 'fulfilled');
        assert.equal(results[1].status, stopped ? 'rejected' : 'fulfilled');
        assert.equal(await first.state(), mode === 'rollback' ? 'pending' : 'clear');
        assert.equal(await second.state(), stopped ? 'pending' : 'clear');
      });
    }
  },
);
