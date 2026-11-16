import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { accessCookie, registerLocalAccess } from '../src/server/access.ts';
import { registerClientApi } from '../src/server/client-api.ts';

test('client capabilities require bearer auth without weakening host or origin controls', async (t) => {
  const key = randomBytes(32).toString('base64url');
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key, origin: 'https://nod.example', bearer: true });
  registerClientApi(app);

  const authorized = { host: 'nod.example', authorization: `Bearer ${key}` };
  const response = await app.inject({
    url: '/api/client/capabilities',
    headers: authorized,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    contractVersion: 1,
    authentication: { mode: 'bearer' },
    features: { attachments: true },
  });
  assert.equal(response.body.includes(key), false);

  for (const headers of [
    { host: 'nod.example' },
    { host: 'nod.example', cookie: `${accessCookie(4310)}=${key}` },
    { host: 'nod.example', authorization: 'Bearer wrong' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 401);

  for (const headers of [
    { ...authorized, host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
    { ...authorized, origin: 'https://attacker.example' },
    { ...authorized, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 403);
});
