import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  initializeChatDraftInstructions,
  pendingChatDraftInstructions,
  prepareChatDraftCapture,
  finishChatDraftCapture,
  retainedChatDraftInstructions,
  linkedChatDraftMessageIds,
  linkedDraftSources,
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
      hidden_at timestamptz,approval_answer boolean,presentation jsonb,reply_to_message_id uuid);
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
        const captured = await prepareDraftAuthorityCapture(database, f.ownerId, a.key);
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
        assert.equal(await prepareDraftAuthorityCapture(database, f.ownerId, a.key), undefined);
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

    await t.test('a known authority condition cannot be overwritten by a later clear', async () => {
      const f = await fixture();
      const a = await authority(f);
      const captured = await prepareDraftAuthorityCapture(database, f.ownerId, a.key);
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
          const captured = await prepareDraftAuthorityCapture(database, f.ownerId, a.key);
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

    await t.test('an interrupted authority capture stays pending and is not replayed', async () => {
      const f = await fixture();
      const a = await authority(f);
      const captured = await prepareDraftAuthorityCapture(database, f.ownerId, a.key);
      assert.ok(captured?.complete);
      await database.query('UPDATE turns SET withdrawn=true WHERE id=$1', [a.message.turnId]);
      await finishDraftAuthorityCapture(database, f.ownerId, captured, 'clear');
      assert.equal(await prepareDraftAuthorityCapture(database, f.ownerId, a.key), undefined);
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
      'authority keys bind the full saved fields, approvals, context and task scope',
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
            context: [{ messages: [{ text: 'Different inherited synthetic condition.' }] }],
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
        for (const value of values) await draftOwnerField(database, f.ownerId, 'rules', value);
        const data = await draftOwnerField(database, f.ownerId, 'rules', '');
        assert.deepEqual(
          data.versions.map((version) => version.value),
          values,
        );
        const turn = { threadId: f.threadId, turnId: randomUUID() };
        const payload = {
          kind: 'rules' as const,
          scope: 'rules',
          data,
          evidence: { messages: [] },
          sourceIds: [],
          context: [],
          bindings: [],
        };
        const [key] = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [payload],
          '1',
        );
        const captured = await prepareDraftAuthorityCapture(database, f.ownerId, key!);
        assert.ok(captured?.complete);
        assert.deepEqual(captured.input.newMessages[0].ownerData, data);
        await finishDraftAuthorityCapture(database, f.ownerId, captured, 'relevant');
        const [source] = await retainedDraftAuthorityInstructions(
          database,
          f.ownerId,
          f.threadId,
          null,
          '1',
        );
        assert.deepEqual(source.target.ownerData, data);
      },
    );

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
        assert.equal(await prepareDraftAuthorityCapture(database, f.ownerId, empty!), undefined);
        const [missing] = await pendingDraftAuthorityInstructions(
          database,
          f.ownerId,
          turn,
          null,
          [{ ...base, kind: 'schedule', unavailable: true }],
          '1',
        );
        assert.equal(
          (await prepareDraftAuthorityCapture(database, f.ownerId, missing!))?.complete,
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
