'use strict';

// Общий вебхук Путина читается и из строки putin, и из личного id grok.
// Строка grok не переписывается. Без маршрута очередь не тратит попытки.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NO_ROUTE = 'нет маршрута доставки';
const GROK_KEY = 'fixture-grok-shared-GGGG';
const PUTIN_KEY = 'fixture-putin-shared-PPPP';

delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-grok-route-'));
process.env.APP_PASSWORD = 'pw-shared';
process.env.AGENT_TOKEN = 'tok-shared';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
delete process.env.KREMLIN_WEBHOOK_HEADER;
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const cryptoBox = require('../lib/webhook-crypto');
const delivery = require('../lib/delivery');

test('маршрут finance: свой, затем putin, затем grok, затем env', () => {
  const env = {
    WEBHOOK_SECRETS_KEY: process.env.WEBHOOK_SECRETS_KEY,
    KREMLIN_WEBHOOK_URL: 'https://example.test/env-hook',
    KREMLIN_WEBHOOK_KEY: 'env-key',
  };
  const grokUrl = 'https://example.test/grok-only';
  const putinUrl = 'https://example.test/putin-first';
  const state = {
    webhookTargets: {
      grok: { id: 'grok', ...cryptoBox.seal('grok', { url: grokUrl, key: GROK_KEY }, env) },
    },
  };
  const viaGrok = delivery.resolveDestination('finance', state, env);
  assert.equal(viaGrok.via, 'putin');
  assert.equal(viaGrok.url, grokUrl);
  assert.equal(viaGrok.key, GROK_KEY);
  assert.equal(delivery.routeFor('finance', state, env), 'putin');
  assert.equal(delivery.routeFor('grok', state, env), 'putin');
  assert.equal(delivery.publicWebhookSummary(state).putinWebhookSet, true);
  assert.equal(delivery.publicWebhookSummary(state).agentWebhooks, 0);
  const ownForGrok = delivery.resolveDestination('grok', state, env);
  assert.equal(ownForGrok.url, grokUrl);
  assert.equal(ownForGrok.via, 'putin');

  state.webhookTargets.putin = {
    id: 'putin',
    ...cryptoBox.seal('putin', { url: putinUrl, key: PUTIN_KEY }, env),
  };
  const viaPutin = delivery.resolveDestination('finance', state, env);
  assert.equal(viaPutin.url, putinUrl);
  assert.equal(viaPutin.key, PUTIN_KEY);
  assert.equal(viaPutin.via, 'putin');
  const putinWinsForGrok = delivery.resolveDestination('grok', state, env);
  assert.equal(putinWinsForGrok.url, putinUrl);
  assert.equal(delivery.routeFor('finance', state, env), 'putin');

  state.webhookTargets.finance = {
    id: 'finance',
    ...cryptoBox.seal('finance', { url: 'https://example.test/finance-own', key: 'own' }, env),
  };
  const own = delivery.resolveDestination('finance', state, env);
  assert.equal(own.via, 'agent');
  assert.equal(own.url, 'https://example.test/finance-own');

  state.webhookTargets.putin.ciphertext = Buffer.from('broken').toString('base64');
  assert.throws(() => delivery.resolveDestination('army', state, env), (err) => err.code === 'BAD_SECRETS_KEY');

  delete state.webhookTargets.putin;
  delete state.webhookTargets.finance;
  delete state.webhookTargets.grok;
  delete env.KREMLIN_WEBHOOK_URL;
  assert.equal(delivery.resolveDestination('finance', state, env), null);
  assert.equal(delivery.routeFor('finance', state, env), 'none');
  assert.equal(delivery.publicWebhookSummary(state).putinWebhookSet, false);
});

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
    hits.push({ url: req.url || '', headers: req.headers, body: parsed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let base;
let server;
let office;
let grokUrl;

function queued(id, at) {
  return {
    id,
    at,
    agentId: 'finance',
    taskId: `task-${id}`,
    status: 'queued',
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
    lastStatus: null,
    deliveredAt: null,
    payload: {
      id,
      type: 'owner_task',
      agentId: 'finance',
      text: `зависший ${id}`,
      at,
      atMsk: '22.11 12:00 МСК',
      appUrl: 'https://example.test',
      taskId: `task-${id}`,
    },
  };
}

function seedTask(item) {
  return {
    id: item.taskId,
    agent: 'finance',
    agentId: 'finance',
    fromAgentId: 'owner',
    text: item.payload.text,
    status: 'в очереди агента',
    delivery: 'queue',
    orderStatus: 'sent',
    createdAt: item.at,
    forwardStatus: null,
    history: [],
    attachments: [],
  };
}

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  grokUrl = `http://127.0.0.1:${hook.address().port}/grok-hook`;
  office = require('../server.js');
  const env = { WEBHOOK_SECRETS_KEY: process.env.WEBHOOK_SECRETS_KEY };
  office.state.webhookTargets.grok = {
    id: 'grok',
    ...cryptoBox.seal('grok', { url: grokUrl, key: GROK_KEY }, env),
    updatedAt: '2026-11-22T09:00:00.000Z',
  };
  const older = queued('ob-1', '2026-11-22T09:00:00.000Z');
  const newer = queued('ob-2', '2026-11-22T09:05:00.000Z');
  office.state.outbox = [newer, older];
  office.state.tasks = [seedTask(newer), seedTask(older)];
  office.state.nextOutboxId = 3;
  office.state.nextTaskId = 3;
  server = await new Promise((resolve) => {
    const listening = office.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  let delivered = false;
  while (Date.now() - started < 4000) {
    const ids = hits.map((hit) => hit.body && hit.body.id);
    const state = office.state.outbox || [];
    delivered = ids.includes('ob-1') && ids.includes('ob-2')
      && state.every((item) => item.status === 'delivered');
    if (delivered) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(delivered, true, `старт не отправил очередь: ${JSON.stringify(hits.map((hit) => hit.body && hit.body.id))}`);
});

after(() => {
  server && server.close();
  hook.close();
});

function call(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}

test('flush при старте один раз шлёт зависшие queued через строку grok', async () => {
  assert.deepEqual(
    hits.filter((hit) => hit.body && (hit.body.id === 'ob-1' || hit.body.id === 'ob-2')).map((hit) => hit.body.id),
    ['ob-1', 'ob-2'],
  );
  assert.equal(hits.filter((hit) => hit.body && hit.body.id === 'ob-1').length, 1);
  assert.equal(hits.filter((hit) => hit.body && hit.body.id === 'ob-2').length, 1);
  assert.equal(hits.every((hit) => hit.url === '/grok-hook'), true);
  assert.equal(hits.every((hit) => hit.headers['x-webhook-key'] === GROK_KEY), true);
  const row = office.state.webhookTargets.grok;
  assert.equal(row.id, 'grok');
  assert.equal(office.state.webhookTargets.putin, undefined);
  const opened = cryptoBox.open('grok', row, process.env);
  assert.equal(opened.url, grokUrl);
  assert.equal(opened.key, GROK_KEY);
  assert.throws(() => cryptoBox.open('putin', row, process.env));
  const state = await call('/api/state');
  for (const id of ['ob-1', 'ob-2']) {
    const item = state.body.outbox.find((entry) => entry.id === id);
    assert.equal(item.status, 'delivered');
    assert.equal(item.attempts, 1);
    assert.equal(item.lastError, null);
    const task = state.body.tasks.find((entry) => entry.id === item.taskId);
    assert.equal(task.deliveryLabel, 'Отправлена');
  }
  const again = await call('/api/delivery/retry', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-shared' },
    body: '{}',
  });
  assert.equal(again.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(hits.filter((hit) => hit.body && hit.body.id === 'ob-1').length, 1);
  assert.equal(hits.filter((hit) => hit.body && hit.body.id === 'ob-2').length, 1);
});

test('приказ finance уходит на grok, putin важнее, без маршрута попытки не растут', async () => {
  const before = hits.length;
  const viaGrok = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ agent: 'finance', text: 'Только строка grok' }),
  });
  assert.equal(viaGrok.status, 201);
  assert.equal(viaGrok.body.deliveryLabel, 'Отправлена');
  const grokHit = hits.slice(before).find((hit) => hit.body && hit.body.taskId === viaGrok.body.id);
  assert.ok(grokHit);
  assert.equal(grokHit.url, '/grok-hook');
  assert.equal(grokHit.headers['x-webhook-key'], GROK_KEY);
  assert.equal(office.state.webhookTargets.grok.id, 'grok');
  assert.equal(office.state.webhookTargets.putin, undefined);

  const putinUrl = `http://127.0.0.1:${hook.address().port}/putin-hook`;
  const savedPutin = await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ url: putinUrl, key: PUTIN_KEY }),
  });
  assert.equal(savedPutin.status, 200);
  assert.equal(savedPutin.body.id, 'putin');
  const savedGrok = await call('/api/agents/grok/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ url: grokUrl, key: GROK_KEY }),
  });
  assert.equal(savedGrok.status, 200);
  assert.equal(savedGrok.body.agentId, 'grok');
  const marked = hits.length;
  const viaPutin = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ agent: 'finance', text: 'putin важнее grok' }),
  });
  assert.equal(viaPutin.status, 201);
  assert.equal(viaPutin.body.deliveryLabel, 'Отправлена');
  const putinHit = hits.slice(marked).find((hit) => hit.body && hit.body.taskId === viaPutin.body.id);
  assert.ok(putinHit);
  assert.equal(putinHit.url, '/putin-hook');
  assert.equal(putinHit.headers['x-webhook-key'], PUTIN_KEY);
  assert.equal(hits.slice(marked).some((hit) => hit.url === '/grok-hook' && hit.body && hit.body.taskId === viaPutin.body.id), false);
  assert.equal(office.state.webhookTargets.grok.id, 'grok');
  assert.equal(office.state.webhookTargets.putin.id, 'putin');

  await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ url: '' }),
  });
  await call('/api/agents/grok/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ url: '' }),
  });
  const quietAt = hits.length;
  const quiet = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ agent: 'finance', text: 'Маршрута нет' }),
  });
  assert.equal(quiet.status, 201);
  assert.equal(quiet.body.forwardStatus, null);
  assert.equal(quiet.body.deliveryLabel, NO_ROUTE);
  assert.equal(hits.length, quietAt);
  const listed = await call('/api/state');
  const item = listed.body.outbox.find((entry) => entry.taskId === quiet.body.id);
  assert.equal(item.status, 'queued');
  assert.equal(item.attempts, 0);
  assert.equal(item.lastError, NO_ROUTE);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const later = await call('/api/state');
  const held = later.body.outbox.find((entry) => entry.id === item.id);
  assert.equal(held.attempts, 0);
  assert.equal(held.lastError, NO_ROUTE);
  assert.equal(hits.length, quietAt);

  const restored = await call('/api/agents/grok/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-shared' },
    body: JSON.stringify({ url: grokUrl, key: GROK_KEY }),
  });
  assert.equal(restored.status, 200);
  const started = Date.now();
  let sent = null;
  while (Date.now() - started < 4000) {
    const state = await call('/api/state');
    sent = state.body.outbox.find((entry) => entry.id === item.id);
    if (sent && sent.status === 'delivered') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sent.status, 'delivered');
  assert.equal(sent.lastError, null);
  assert.equal(sent.attempts, 1);
  const wake = hits.filter((hit) => hit.body && hit.body.id === item.id);
  assert.equal(wake.length, 1);
  assert.equal(wake[0].url, '/grok-hook');
  const task = (await call('/api/state')).body.tasks.find((entry) => entry.id === quiet.body.id);
  assert.equal(task.deliveryLabel, 'Отправлена');
});
