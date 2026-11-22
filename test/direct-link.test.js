'use strict';

// Прямая связь: строка статуса, честная фраза, ping не становится задачей, ключ не целиком.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'fixture-direct-key-not-shown-ZZZZ';
const ON = 'Прямая связь: подключена';
const OFF = 'Прямая связь: не подключена';
const VIA = 'Сообщение уйдёт через Путина';
const NO_ADDRESS = 'Адрес не задан — сообщения идут через Путина';
const DELIVERED = 'Доставлено';
const DOWN = 'Адрес не отвечает';
const BAD_KEY = 'Ключ не подошёл (401/403)';

delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-direct-'));
process.env.APP_PASSWORD = 'pw-direct';
process.env.AGENT_TOKEN = 'tok-direct';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
delete process.env.KREMLIN_WEBHOOK_HEADER;
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_HEADER = '';
process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
process.env.WEBHOOK_PROBE_TIMEOUT_MS = '250';
process.env.AGENT_STATUS_TOKEN = 'status-direct-token';

const feed = require('../public/js/feed.js');
const linkCheck = require('../lib/link-check');
const { buildDashboard } = require('../lib/agent-dashboard');

test('строка статуса: с адресом, без адреса и без оговорки у Путина', () => {
  assert.equal(feed.directLinkLine({ id: 'dev', deliveryRoute: 'agent' }), ON);
  assert.equal(feed.directLinkLine({ id: 'army', deliveryRoute: 'putin' }), VIA);
  assert.equal(feed.directLinkLine({ id: 'army', deliveryRoute: 'env' }), VIA);
  assert.equal(feed.directLinkLine({ id: 'army', deliveryRoute: 'none' }), VIA);
  assert.equal(feed.directLinkLine({ id: 'grok', deliveryRoute: 'putin' }), ON);
  assert.equal(feed.directLinkLine({ id: 'grok', deliveryRoute: 'env' }), OFF);
  assert.equal(feed.directLinkLine({ id: 'grok', deliveryRoute: 'none' }), OFF);
  assert.equal(feed.directLinkLine({ id: 'grok', deliveryRoute: 'none' }).includes('через Путина'), false);
});

const hits = [];
const sockets = new Set();
const hook = http.createServer((req, res) => {
  if (req.url === '/hang') return;
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
    hits.push({ url: req.url || '', headers: req.headers, body: parsed });
    const status = req.url === '/denied' ? 401 : req.url === '/forbidden' ? 403 : 204;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
hook.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let server;
let office;
let base;
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
  for (const socket of sockets) socket.destroy();
  if (server) server.close();
  hook.close();
});

function call(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}

function auth(extra) {
  return { 'x-app-password': 'pw-direct', ...(extra || {}) };
}

function snap() {
  const tasks = office.state.tasks || [];
  const split = feed.journalSplit(tasks);
  const panel = feed.processPanel(tasks, office.state.routines || [], Date.now(), {
    agents: office.state.agents,
    messages: office.state.messages,
  });
  return {
    tasks: tasks.length,
    messages: (office.state.messages || []).length,
    outbox: (office.state.outbox || []).length,
    journal: split.badge,
    processes: panel.total,
    ping: tasks.some((item) => item && String(item.text || '').includes('Проверка связи')),
    working: (office.state.agents || []).filter((agent) => agent.status === 'working').map((agent) => agent.id).join(','),
  };
}

test('сводка берёт всех неархивных агентов и не берёт архив', () => {
  const ids = feed.serviceAgents(office.state.agents).map((agent) => agent.id);
  const live = office.state.agents.filter((agent) => !agent.archived && !agent.vacant).map((agent) => agent.id);
  assert.equal(ids.length, live.length);
  for (const id of live) assert.equal(ids.includes(id), true, id);
  assert.equal(ids.includes('grok'), true);
  assert.equal(ids.includes('invest'), true);
  assert.equal(ids.includes('analyst'), true);
  assert.equal(ids.includes('trading'), false);
  assert.equal(ids.includes('biz'), false);
  assert.equal(ids.includes('lang'), false);
});

test('ключ не возвращается целиком, в логе его нет', async () => {
  const url = `${hookOrigin}/save-hook`;
  const { value, logs } = await quietLogs(() => call('/api/agents/qa/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url, key: KEY }),
  }));
  assert.equal(value.status, 200);
  assert.equal(value.body.keySet, true);
  assert.equal('key' in value.body, false);
  assert.equal(JSON.stringify(value.body).includes(KEY), false);
  const read = await call('/api/agents/qa/delivery', { headers: auth() });
  assert.equal(read.status, 200);
  assert.equal(JSON.stringify(read.body).includes(KEY), false);
  const state = await call('/api/state');
  assert.equal(JSON.stringify(state.body).includes(KEY), false);
  const blob = logs.join('\n');
  assert.equal(blob.includes(KEY), false);
  assert.equal(blob.includes('save-hook'), false);
});

test('после сохранения адреса и ключа уходит ping и ждёт ответ', async () => {
  const before = snap();
  const beforeHits = hits.length;
  const saved = await call('/api/agents/dev/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${hookOrigin}/ok`, key: KEY }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.linkCheck.phase, 'checking');
  assert.equal(feed.directLinkLine({ id: 'dev', deliveryRoute: 'agent', linkCheck: saved.body.linkCheck }), 'Проверяю…');
  assert.equal(JSON.stringify(saved.body).includes(KEY), false);
  assert.equal(hits.length, beforeHits + 1);
  const hit = hits[hits.length - 1];
  assert.equal(hit.url, '/ok');
  assert.equal(hit.body.type, 'ping');
  assert.equal(hit.body.text, 'Проверка связи');
  assert.match(hit.body.taskId, /^ping-dev-\d+$/);
  assert.equal(hit.headers['x-webhook-key'], KEY);
  assert.deepEqual(snap(), before);

  const agent = office.state.agents.find((item) => item.id === 'dev');
  const statusBefore = agent.status;
  const liveBefore = JSON.stringify(agent.live || null);
  const answered = await call('/api/agent-status', {
    method: 'POST',
    headers: { authorization: 'Bearer status-direct-token' },
    body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: hit.body.taskId }),
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.acknowledged, true);
  const state = await call('/api/state');
  const dev = state.body.agents.find((item) => item.id === 'dev');
  assert.equal(dev.linkCheck.phase, 'ok');
  assert.match(dev.linkCheck.answeredAtMsk, /МСК$/);
  assert.match(feed.directLinkLine(dev), /^Связь работает · .+ МСК$/);
  assert.equal(agent.status, statusBefore);
  assert.equal(JSON.stringify(agent.live || null), liveBefore);
  assert.deepEqual(snap(), before);
  assert.equal(JSON.stringify(state.body).includes(KEY), false);

  const againHits = hits.length;
  const again = await call('/api/agents/dev/delivery/test', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ url: `${hookOrigin}/foreign-should-not-be-called`, key: KEY }),
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.linkCheck.phase, 'checking');
  assert.notEqual(again.body.linkCheck.taskId, hit.body.taskId);
  assert.equal(hits.length, againHits + 1);
  assert.equal(hits[hits.length - 1].url, '/ok');
  assert.equal(JSON.stringify(again.body).includes(KEY), false);
  const stale = await call('/api/agent-status', {
    method: 'POST',
    headers: { authorization: 'Bearer status-direct-token' },
    body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: hit.body.taskId, reply: 'Проверка связи' }),
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.acknowledged, false);
  assert.deepEqual(snap(), before);
});

test('красный: ключ, адрес и тишина 5 минут', async () => {
  const denied = await call('/api/agents/social/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${hookOrigin}/denied`, key: KEY }),
  });
  assert.equal(denied.body.linkCheck.phase, 'key');
  assert.equal(feed.directLinkLine({ id: 'social', linkCheck: denied.body.linkCheck }), 'ключ не подошёл');
  assert.equal(JSON.stringify(denied.body).includes(KEY), false);

  const forbidden = await call('/api/agents/blog/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${hookOrigin}/forbidden`, key: KEY }),
  });
  assert.equal(forbidden.body.linkCheck.phase, 'key');

  const slow = await call('/api/agents/poker/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${hookOrigin}/hang`, key: KEY }),
  });
  assert.equal(slow.body.linkCheck.phase, 'down');
  assert.equal(feed.directLinkLine({ id: 'poker', linkCheck: slow.body.linkCheck }), 'адрес не отвечает');
  assert.equal(JSON.stringify(slow.body).includes(KEY), false);

  const sentAt = 1_700_000_000_000;
  linkCheck.setNow(() => sentAt);
  try {
    const quiet = await call('/api/agents/qa/delivery', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ url: `${hookOrigin}/ok`, key: KEY }),
    });
    assert.equal(quiet.body.linkCheck.phase, 'checking');
    linkCheck.setNow(() => sentAt + linkCheck.WAIT_MS);
    const state = await call('/api/state');
    const qa = state.body.agents.find((item) => item.id === 'qa');
    assert.equal(qa.linkCheck.phase, 'timeout');
    assert.equal(feed.directLinkLine(qa), 'агент не ответил за 5 мин');
    const reloaded = await call('/api/agents/qa/delivery', { headers: auth() });
    assert.equal(reloaded.body.linkCheck.phase, 'timeout');
    assert.equal(JSON.stringify(reloaded.body).includes(KEY), false);
  } finally {
    linkCheck.resetForTests();
  }
});

test('служебный ping не виден в журнале, переписке, процессах и активностях', () => {
  const ping = { id: 'ping-dev-1', agentId: 'dev', text: 'Проверка связи', orderStatus: 'sent', status: 'в очереди агента', createdAt: new Date().toISOString() };
  const message = { id: 'm-ping', agentId: 'dev', role: 'agent', taskId: 'ping-dev-1', text: 'Проверка связи', createdAt: new Date().toISOString() };
  const real = { id: 't-real', agentId: 'dev', text: 'Настоящая задача', orderStatus: 'sent', status: 'в очереди агента', createdAt: new Date().toISOString() };
  assert.equal(feed.isOpenOrder(ping), false);
  const split = feed.journalSplit([ping, real]);
  assert.equal(split.badge, 1);
  assert.equal(split.active.some((item) => item.id === 'ping-dev-1'), false);
  const talk = feed.messagesForAgent([message, { id: 'm-real', agentId: 'dev', role: 'agent', taskId: 't-real', text: 'Ответ', createdAt: new Date().toISOString() }], [real], 'dev');
  assert.equal(talk.some((item) => String(item.taskId || '').startsWith('ping-')), false);
  const panel = feed.processPanel([ping, real], [], Date.now(), { agents: [{ id: 'dev' }], messages: [] });
  assert.equal(panel.entries.some((item) => item && String(item.id).startsWith('ping-')), false);
  const dash = buildDashboard({
    agent: { id: 'dev', name: 'Программирование', completed: 0 },
    tasks: [ping, real],
    messages: [message],
    activity: { activity: 'resting' },
    now: Date.now(),
  });
  assert.equal(dash.tasks.some((item) => String(item.id).startsWith('ping-')), false);
  assert.equal(dash.messages.some((item) => String(item.taskId || '').startsWith('ping-')), false);
  assert.equal(dash.activityLog.some((item) => String(item.text).includes('Проверка связи')), false);
});
