'use strict';

// Вебхук агента и общий вебхук Путина: шифр, маршрут, API без ключа, локальная проверка.
// Фикстуры нарочно не похожи на боевые секреты.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';
const FIXTURE_KEY = 'fixture-key-not-a-secret-ABCD';
const FIXTURE_URL = 'https://example.test/fixture-hook-path';
const ENV_KEY = 'fixture-env-key-EEEE';
const AGENT_KEY = 'fixture-agent-key-AAAA';
const PUTIN_KEY = 'fixture-putin-key-PPPP';
const NO_KEY = 'Не задан WEBHOOK_SECRETS_KEY, вебхук не сохранён';
const BAD_KEY = 'Ключ WEBHOOK_SECRETS_KEY не подходит, вебхук не прочитан';

delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-delivery-'));
process.env.APP_PASSWORD = 'pw-delivery';
process.env.AGENT_TOKEN = 'tok-delivery';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
delete process.env.KREMLIN_WEBHOOK_HEADER;
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_HEADER = '';
process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const cryptoBox = require('../lib/webhook-crypto');
const delivery = require('../lib/delivery');

function keyEnv(raw) {
  return { WEBHOOK_SECRETS_KEY: raw };
}

test('шифр возвращает url и ключ, у каждой записи свой IV', () => {
  const env = keyEnv(crypto.randomBytes(32).toString('base64'));
  const first = cryptoBox.seal('army', { url: FIXTURE_URL, key: FIXTURE_KEY }, env);
  const second = cryptoBox.seal('army', { url: FIXTURE_URL, key: FIXTURE_KEY }, env);
  assert.equal(first.iv === second.iv, false);
  assert.equal(JSON.stringify(first).includes(FIXTURE_KEY), false);
  assert.equal(JSON.stringify(first).includes('fixture-hook-path'), false);
  const opened = cryptoBox.open('army', first, env);
  assert.deepEqual(opened, { url: FIXTURE_URL, key: FIXTURE_KEY });
  const view = cryptoBox.publicDelivery(opened);
  assert.equal(view.keySet, true);
  assert.equal(view.keyTail, 'ABCD');
  assert.equal('key' in view, false);
});

test('без ключа шифра и с чужим ключом открытый текст не всплывает', () => {
  const env = keyEnv(crypto.randomBytes(32).toString('base64'));
  const sealed = cryptoBox.seal('army', { url: FIXTURE_URL, key: FIXTURE_KEY }, env);
  assert.throws(() => cryptoBox.seal('army', { url: FIXTURE_URL, key: FIXTURE_KEY }, {}), (err) => {
    assert.equal(err.code, 'NO_SECRETS_KEY');
    assert.equal(String(err.message).includes(FIXTURE_KEY), false);
    assert.equal(String(err.message).includes('fixture-hook-path'), false);
    return true;
  });
  assert.throws(() => cryptoBox.seal('army', { url: FIXTURE_URL, key: FIXTURE_KEY }, keyEnv(Buffer.from('short').toString('base64'))), (err) => {
    assert.equal(err.code, 'BAD_KEY_LENGTH');
    assert.equal(String(err.message).includes(FIXTURE_KEY), false);
    return true;
  });
  assert.throws(() => cryptoBox.open('army', sealed, keyEnv(crypto.randomBytes(32).toString('base64'))), (err) => {
    assert.equal(err.code, 'BAD_SECRETS_KEY');
    assert.equal(err.message, BAD_KEY);
    assert.equal(String(err.message).includes(FIXTURE_KEY), false);
    return true;
  });
  assert.throws(() => cryptoBox.open('blog', sealed, env), (err) => {
    assert.equal(err.code, 'BAD_SECRETS_KEY');
    return true;
  });
});

test('маршрут агент, затем Путин, затем env', () => {
  const env = keyEnv(crypto.randomBytes(32).toString('base64'));
  env.KREMLIN_WEBHOOK_URL = 'https://example.test/env-hook';
  env.KREMLIN_WEBHOOK_KEY = ENV_KEY;
  const state = {
    webhookTargets: {
      army: { id: 'army', ...cryptoBox.seal('army', { url: 'https://example.test/agent-hook', key: AGENT_KEY }, env) },
      putin: { id: 'putin', ...cryptoBox.seal('putin', { url: 'https://example.test/putin-hook', key: PUTIN_KEY }, env) },
    },
  };
  const own = delivery.resolveDestination('army', state, env);
  assert.equal(own.via, 'agent');
  assert.equal(own.url, 'https://example.test/agent-hook');
  assert.equal(own.key, AGENT_KEY);
  delete state.webhookTargets.army;
  const shared = delivery.resolveDestination('army', state, env);
  assert.equal(shared.via, 'putin');
  assert.equal(shared.url, 'https://example.test/putin-hook');
  delete state.webhookTargets.putin;
  const fallback = delivery.resolveDestination('army', state, env);
  assert.equal(fallback.via, 'env');
  assert.equal(fallback.url, 'https://example.test/env-hook');
  assert.equal(fallback.key, ENV_KEY);
  delete env.KREMLIN_WEBHOOK_URL;
  assert.equal(delivery.resolveDestination('army', state, env), null);
});

test('битая запись агента не сваливается в env', () => {
  const env = keyEnv(crypto.randomBytes(32).toString('base64'));
  const sealed = cryptoBox.seal('army', { url: 'https://example.test/agent-hook', key: AGENT_KEY }, env);
  env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  env.KREMLIN_WEBHOOK_URL = 'https://example.test/env-hook';
  const state = { webhookTargets: { army: { id: 'army', ...sealed } } };
  assert.throws(() => delivery.resolveDestination('army', state, env), (err) => {
    assert.equal(err.code, 'BAD_SECRETS_KEY');
    assert.equal(String(err.message).includes(AGENT_KEY), false);
    return true;
  });
});

test('сохранение без ключа шифра ничего не записывает', () => {
  const state = { webhookTargets: {} };
  const noted = [];
  const store = {
    noteWebhookTarget(row) { noted.push(row); },
    noteWebhookTargetRemoved() { noted.push('removed'); },
  };
  assert.throws(() => delivery.saveDelivery(state, store, 'army', { url: FIXTURE_URL, key: FIXTURE_KEY }, {}), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.expose, NO_KEY);
    assert.equal(String(err.expose).includes(FIXTURE_KEY), false);
    return true;
  });
  assert.deepEqual(state.webhookTargets, {});
  assert.deepEqual(noted, []);
});

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
    hits.push({ url: req.url || '', headers: req.headers, body: parsed });
    const code = String(req.url || '').includes('/fail') ? 500 : 200;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(code === 200 ? '{"ok":true}' : '{"ok":false}');
  });
});

let base;
let server;
let office;
let hookOrigin;

function quietLogs(run) {
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    })
    .then((value) => ({ value, logs }));
}

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookOrigin = `http://127.0.0.1:${hook.address().port}`;
  office = require('../server.js');
  server = await new Promise((resolve) => {
    const listening = office.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  hook.close();
});

function call(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null), text: '' }));
}

test('API не отдаёт ключ и требует пароль штаба', async () => {
  const saved = await call('/api/agents/dev/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/dev-hook`, key: FIXTURE_KEY }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.agentId, 'dev');
  assert.equal(saved.body.url, `${hookOrigin}/dev-hook`);
  assert.equal(saved.body.keySet, true);
  assert.equal(saved.body.keyTail, 'ABCD');
  assert.equal(saved.body.route, 'agent');
  assert.equal('key' in saved.body, false);
  assert.equal(JSON.stringify(saved.body).includes(FIXTURE_KEY), false);
  const row = office.state.webhookTargets.dev;
  assert.equal(JSON.stringify(row).includes(FIXTURE_KEY), false);
  assert.equal(JSON.stringify(row).includes('dev-hook'), false);

  const open = await call('/api/agents/dev/delivery');
  assert.equal(open.status, 401);
  assert.equal(JSON.stringify(open.body).includes(FIXTURE_KEY), false);
  assert.equal(JSON.stringify(open.body).includes('dev-hook'), false);

  const read = await call('/api/agents/dev/delivery', { headers: { 'x-app-password': 'pw-delivery' } });
  assert.equal(read.status, 200);
  assert.equal(read.body.keyTail, 'ABCD');
  assert.equal(JSON.stringify(read.body).includes(FIXTURE_KEY), false);

  const state = await call('/api/state');
  assert.equal(JSON.stringify(state.body).includes(FIXTURE_KEY), false);
  assert.equal(JSON.stringify(state.body).includes('ciphertext'), false);

  const kept = await call('/api/agents/dev/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/dev-hook`, key: '' }),
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.keySet, true);
  assert.equal(kept.body.keyTail, 'ABCD');

  const missing = await call('/api/agents/no-such-agent/delivery', { headers: { 'x-app-password': 'pw-delivery' } });
  assert.equal(missing.status, 404);

  const qaUrl = `${hookOrigin}/qa-hook`;
  const savedQa = await call('/api/agents/qa/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: qaUrl, key: FIXTURE_KEY }),
  });
  assert.equal(savedQa.status, 200);
  const cleared = await call('/api/agents/qa/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: qaUrl, clearKey: true }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.keySet, false);
  assert.equal(cleared.body.keyTail, '');
  assert.equal(JSON.stringify(cleared.body).includes(FIXTURE_KEY), false);
});

test('проверка вебхука бьёт в локальный сервер и не кладёт ключ в лог', async () => {
  const beforeHits = hits.length;
  const beforeOutbox = office.state.outbox.length;
  const { value, logs } = await quietLogs(() => call('/api/agents/dev/delivery/test', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/dev-hook` }),
  }));
  assert.equal(value.status, 200);
  assert.equal(value.body.ok, true);
  assert.equal(value.body.status, 200);
  assert.equal(JSON.stringify(value.body).includes(FIXTURE_KEY), false);
  assert.equal(hits.length, beforeHits + 1);
  const hit = hits[hits.length - 1];
  assert.equal(hit.body.type, 'test');
  assert.equal(hit.body.agentId, 'dev');
  assert.equal(hit.body.text, 'Проверка доставки');
  assert.equal(hit.headers.authorization, `Bearer ${FIXTURE_KEY}`);
  assert.equal(hit.headers['x-webhook-key'], FIXTURE_KEY);
  assert.equal(office.state.outbox.length, beforeOutbox);
  const blob = logs.join('\n');
  assert.equal(blob.includes(FIXTURE_KEY), false);
  assert.equal(blob.includes('dev-hook'), false);
  assert.match(blob, /webhook test target=dev http=200/);

  const other = await call('/api/agents/dev/delivery/test', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/other-hook` }),
  });
  assert.equal(other.status, 200);
  const bare = hits[hits.length - 1];
  assert.equal(bare.url, '/other-hook');
  assert.equal(bare.headers.authorization, undefined);
  assert.equal(bare.headers['x-webhook-key'], undefined);
});

test('проверка нового URL без ключа не уносит сохранённый ключ', async () => {
  const savedKey = 'fixture-saved-key-ZZZZ';
  const ownUrl = `${hookOrigin}/own-hook`;
  const foreignUrl = `${hookOrigin}/foreign-hook`;
  const saved = await call('/api/agents/poker/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: ownUrl, key: savedKey }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.keyTail, 'ZZZZ');
  const before = hits.length;
  const foreign = await call('/api/agents/poker/delivery/test', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: foreignUrl }),
  });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.status, 200);
  assert.equal(JSON.stringify(foreign.body).includes(savedKey), false);
  const hit = hits[hits.length - 1];
  assert.equal(hits.length, before + 1);
  assert.equal(hit.url, '/foreign-hook');
  assert.equal(hit.headers.authorization, undefined);
  assert.equal(hit.headers['x-webhook-key'], undefined);
  assert.equal(JSON.stringify(hit.headers).includes(savedKey), false);
  assert.equal(JSON.stringify(hit.body).includes(savedKey), false);
  const own = await call('/api/agents/poker/delivery/test', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: ownUrl }),
  });
  assert.equal(own.status, 200);
  const ownHit = hits[hits.length - 1];
  assert.equal(ownHit.url, '/own-hook');
  assert.equal(ownHit.headers['x-webhook-key'], savedKey);
});

test('здоровье доставки считает вебхуки и не отдаёт адреса', async () => {
  assert.equal((await call('/api/health/delivery')).status, 401);
  const agentsBefore = Object.keys(office.state.webhookTargets).filter((id) => id !== 'putin').length;
  const socialUrl = `${hookOrigin}/social-hook`;
  const socialKey = 'fixture-social-key-SSSS';
  const putinUrl = `${hookOrigin}/putin-health-hook`;
  const savedAgent = await call('/api/agents/social/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: socialUrl, key: socialKey }),
  });
  assert.equal(savedAgent.status, 200);
  const savedPutin = await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: putinUrl, key: PUTIN_KEY }),
  });
  assert.equal(savedPutin.status, 200);
  const health = await call('/api/health/delivery', { headers: { 'x-app-password': 'pw-delivery' } });
  assert.equal(health.status, 200);
  assert.equal(health.body.agentWebhooks, agentsBefore + 1);
  assert.equal(health.body.putinWebhookSet, true);
  assert.equal(Number.isInteger(health.body.agentWebhooks), true);
  const raw = JSON.stringify(health.body);
  assert.equal(raw.includes(socialKey), false);
  assert.equal(raw.includes(PUTIN_KEY), false);
  assert.equal(raw.includes('social-hook'), false);
  assert.equal(raw.includes('putin-health-hook'), false);
  assert.equal(raw.includes(socialUrl), false);
  const cleared = await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: '' }),
  });
  assert.equal(cleared.status, 200);
  const after = await call('/api/health/delivery', {
    headers: { authorization: 'Bearer tok-delivery' },
  });
  assert.equal(after.status, 200);
  assert.equal(after.body.putinWebhookSet, false);
  assert.equal(after.body.agentWebhooks, agentsBefore + 1);
  assert.equal(JSON.stringify(after.body).includes(socialKey), false);
});

test('задача идёт агенту, потом Путину, потом в env', async () => {
  process.env.KREMLIN_WEBHOOK_URL = `${hookOrigin}/env-hook`;
  process.env.KREMLIN_WEBHOOK_KEY = ENV_KEY;
  await call('/api/agents/army/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: '', key: '' }),
  });
  await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: '', key: '' }),
  });

  const envTask = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'army', text: 'fixture-task-env' }),
  });
  assert.equal(envTask.status, 201);
  assert.equal(envTask.body.deliveryLabel, 'Отправлена');
  const envHit = hits.filter((hit) => hit.body && hit.body.taskId === envTask.body.id).pop();
  assert.equal(envHit.url, '/env-hook');
  assert.equal(envHit.headers['x-webhook-key'], ENV_KEY);

  await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/putin-hook`, key: PUTIN_KEY }),
  });
  const putinTask = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'army', text: 'fixture-task-putin' }),
  });
  assert.equal(putinTask.body.deliveryLabel, 'Отправлена');
  const putinHit = hits.filter((hit) => hit.body && hit.body.taskId === putinTask.body.id).pop();
  assert.equal(putinHit.url, '/putin-hook');
  assert.equal(putinHit.headers['x-webhook-key'], PUTIN_KEY);

  await call('/api/agents/army/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/fail/agent-hook`, key: AGENT_KEY }),
  });
  const agentTask = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'army', text: 'fixture-task-agent' }),
  });
  assert.match(agentTask.body.deliveryLabel, /^Ошибка доставки, повтор в \d{2}:\d{2} МСК$/);
  const agentHit = hits.filter((hit) => hit.body && hit.body.taskId === agentTask.body.id).pop();
  assert.equal(agentHit.url, '/fail/agent-hook');
  assert.equal(agentHit.headers['x-webhook-key'], AGENT_KEY);
  assert.equal(hits.filter((hit) => hit.body && hit.body.taskId === agentTask.body.id && hit.url === '/env-hook').length, 0);

  const putinRead = await call('/api/delivery/putin', { headers: { 'x-app-password': 'pw-delivery' } });
  assert.equal(putinRead.status, 200);
  assert.equal(putinRead.body.id, 'putin');
  assert.equal(putinRead.body.keyTail, 'PPPP');
  assert.equal(JSON.stringify(putinRead.body).includes(PUTIN_KEY), false);

  process.env.KREMLIN_WEBHOOK_URL = '';
  process.env.KREMLIN_WEBHOOK_KEY = '';
});

test('2xx через вебхук агента или Путина делает working, недоставка нет', async () => {
  delete process.env.KREMLIN_WEBHOOK_URL;
  delete process.env.KREMLIN_WEBHOOK_KEY;
  process.env.KREMLIN_WEBHOOK_URL = '';
  process.env.KREMLIN_WEBHOOK_KEY = '';
  for (const id of ['putin', 'qa', 'temshik', 'devops', 'routines']) {
    const path = id === 'putin' ? '/api/delivery/putin' : `/api/agents/${id}/delivery`;
    const cleared = await call(path, {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-delivery' },
      body: JSON.stringify({ url: '' }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.url, '');
  }
  async function activityOf(id) {
    const state = await call('/api/state');
    const agent = state.body.agents.find((item) => item.id === id);
    return agent ? agent.activity : '';
  }
  const quiet = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'qa', text: 'fixture-task-quiet' }),
  });
  assert.equal(quiet.status, 201);
  assert.equal(quiet.body.forwardStatus, null);
  assert.equal(quiet.body.deliveryLabel, 'В очереди, доставка не подключена');
  assert.equal(await activityOf('qa'), 'resting');

  await call('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/putin-live`, key: PUTIN_KEY }),
  });
  const viaPutin = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'temshik', text: 'fixture-task-putin-live' }),
  });
  assert.equal(viaPutin.body.deliveryLabel, 'Отправлена');
  assert.equal(viaPutin.body.forwardStatus >= 200 && viaPutin.body.forwardStatus < 300, true);
  assert.equal(await activityOf('temshik'), 'working');

  await call('/api/agents/devops/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/fail/devops-live`, key: AGENT_KEY }),
  });
  const failed = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'devops', text: 'fixture-task-devops-live' }),
  });
  assert.match(failed.body.deliveryLabel, /^Ошибка доставки, повтор в \d{2}:\d{2} МСК$/);
  assert.notEqual(await activityOf('devops'), 'working');

  await call('/api/agents/routines/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/routines-live`, key: AGENT_KEY }),
  });
  const viaAgent = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'routines', text: 'fixture-task-routines-live' }),
  });
  assert.equal(viaAgent.body.deliveryLabel, 'Отправлена');
  assert.equal(viaAgent.body.forwardStatus >= 200 && viaAgent.body.forwardStatus < 300, true);
  assert.equal(await activityOf('routines'), 'working');
  assert.equal(await activityOf('qa'), 'working');
});

test('без ключа шифра сохранение отказывает и не подменяет адрес', async () => {
  const savedKey = process.env.WEBHOOK_SECRETS_KEY;
  process.env.WEBHOOK_SECRETS_KEY = '';
  process.env.KREMLIN_WEBHOOK_URL = `${hookOrigin}/env-hook`;
  process.env.KREMLIN_WEBHOOK_KEY = ENV_KEY;
  const before = hits.length;
  const denied = await call('/api/agents/blog/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ url: `${hookOrigin}/blog-hook`, key: FIXTURE_KEY }),
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.body.error, NO_KEY);
  assert.equal(JSON.stringify(denied.body).includes(FIXTURE_KEY), false);
  assert.equal(JSON.stringify(denied.body).includes('blog-hook'), false);
  assert.equal(office.state.webhookTargets.blog, undefined);
  process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  const unread = await call('/api/agents/dev/delivery', { headers: { 'x-app-password': 'pw-delivery' } });
  assert.equal(unread.status, 503);
  assert.equal(unread.body.error, BAD_KEY);
  assert.equal(JSON.stringify(unread.body).includes('dev-hook'), false);
  const broken = await call('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-delivery' },
    body: JSON.stringify({ agent: 'dev', text: 'fixture-task-locked' }),
  });
  assert.equal(broken.status, 201);
  assert.match(broken.body.deliveryLabel, /^Ошибка доставки, повтор в \d{2}:\d{2} МСК$/);
  assert.equal(hits.length, before);
  process.env.WEBHOOK_SECRETS_KEY = savedKey;
  process.env.KREMLIN_WEBHOOK_URL = '';
  process.env.KREMLIN_WEBHOOK_KEY = '';
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  env.APP_PASSWORD = 'pw-test';
  env.AGENT_TOKEN = 'tok-test';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-delivery-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.status === 200) { up = true; break; }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return { base: origin, child, logs, text() { return `${logs.out}\n${logs.err}`; } };
}

async function stopOffice(officeProc) {
  if (!officeProc || !officeProc.child || officeProc.child.exitCode != null) return;
  officeProc.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { officeProc.child.kill('SIGKILL'); resolve(); }, 3000);
    officeProc.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function dropSchema(schema) {
  if (!savedDatabaseUrl) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch (_) { /* схема могла не создаться */ } finally {
    await pool.end();
  }
}

test('Postgres хранит шифротекст вебхука между процессами', { skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `d_${crypto.randomBytes(4).toString('hex')}`;
  const secrets = crypto.randomBytes(32).toString('base64');
  const dbKey = 'fixture-db-key-QQQQ';
  const dbUrl = 'https://example.test/fixture-db-path';
  const env = { DATABASE_URL: savedDatabaseUrl, STORE_SCHEMA: schema, WEBHOOK_SECRETS_KEY: secrets };
  const first = await startOffice(env);
  try {
    const saved = await callOn(first.base, '/api/agents/advisor/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: dbUrl, key: dbKey }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.keyTail, 'QQQQ');
    assert.equal(JSON.stringify(saved.body).includes(dbKey), false);
    assert.equal(first.text().includes(dbKey), false);
    assert.equal(first.text().includes('fixture-db-path'), false);
  } finally {
    await stopOffice(first);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
  try {
    const rows = await pool.query(`SELECT iv, tag, ciphertext FROM ${schema}.webhook_targets`);
    assert.equal(rows.rows.length, 1);
    const blob = JSON.stringify(rows.rows[0]);
    assert.equal(blob.includes(dbKey), false);
    assert.equal(blob.includes('fixture-db-path'), false);
  } finally {
    await pool.end();
  }

  const second = await startOffice(env);
  try {
    const read = await callOn(second.base, '/api/agents/advisor/delivery', {
      headers: { 'x-app-password': 'pw-test' },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.url, dbUrl);
    assert.equal(read.body.keySet, true);
    assert.equal(read.body.keyTail, 'QQQQ');
    assert.equal(JSON.stringify(read.body).includes(dbKey), false);
    assert.equal(second.text().includes(dbKey), false);
  } finally {
    await stopOffice(second);
    await dropSchema(schema);
  }
});

function callOn(origin, urlPath, opts = {}) {
  return fetch(origin + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}
