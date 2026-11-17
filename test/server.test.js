'use strict';

// Тесты API: node --test  (Node 18+). Переменные окружения задаются до require.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const received = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let base;
let server;

before(async () => {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  process.env.APP_PASSWORD = 'pw-test';
  process.env.AGENT_TOKEN = 'tok-test';
  process.env.GROK_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.GROK_WEBHOOK_KEY = 'hook-key';
  process.env.PUBLIC_URL = 'https://example.test';
  const { app } = require('../server.js');
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  hook.close();
});

const json = (path, opts = {}) =>
  fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test('healthz отвечает ok', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('state содержит новый ростер без секретов', async () => {
  const { status, body } = await json('/api/state');
  assert.equal(status, 200);
  const ids = body.agents.map((a) => a.id);
  for (const id of ['grok', 'army', 'poker', 'trading', 'devops', 'dev', 'temshik', 'blog', 'slot8']) {
    assert.ok(ids.includes(id), `нет агента ${id}`);
  }
  const grok = body.agents.find((a) => a.id === 'grok');
  assert.equal(grok.kind, 'putin');
  assert.equal(grok.tier, 'main');
  const army = body.agents.find((a) => a.id === 'army');
  assert.ok(army.responsibilities.length >= 4);
  assert.equal(army.completed, 0);
  assert.equal(body.agents.find((a) => a.id === 'slot8').vacant, true);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('pw-test') && !raw.includes('tok-test') && !raw.includes('hook-key'));
  assert.ok(Array.isArray(body.tasks));
});

test('главная страница отдаётся', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html lang="ru"/);
});

test('POST /api/task требует пароль', async () => {
  const r = await json('/api/task', { method: 'POST', body: JSON.stringify({ agent: 'army', text: 'x' }) });
  assert.equal(r.status, 401);
  const r2 = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'wrong' },
    body: JSON.stringify({ agent: 'army', text: 'x' }),
  });
  assert.equal(r2.status, 401);
});

test('POST /api/task валидирует поля и агента', async () => {
  const h = { 'x-app-password': 'pw-test' };
  assert.equal((await json('/api/task', { method: 'POST', headers: h, body: '{}' })).status, 400);
  const unknown = await json('/api/task', {
    method: 'POST', headers: h, body: JSON.stringify({ agent: 'nope', text: 'x' }),
  });
  assert.equal(unknown.status, 400);
  const vacant = await json('/api/task', {
    method: 'POST', headers: h, body: JSON.stringify({ agent: 'slot8', text: 'x' }),
  });
  assert.equal(vacant.status, 400);
});

test('задача создаётся и пересылается в вебхук', async () => {
  received.length = 0;
  const r = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'army', text: 'Сделай дашборд по личному составу' }),
  });
  assert.equal(r.status, 201);
  assert.match(r.body.id, /^t-\d+$/);
  assert.equal(r.body.status, 'отправлена');
  assert.equal(r.body.forwardStatus, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].headers.authorization, 'Bearer hook-key');
  assert.equal(received[0].headers['x-webhook-key'], 'hook-key');
  assert.deepEqual(received[0].body, {
    agent: 'army',
    text: 'Сделай дашборд по личному составу',
    taskId: r.body.id,
    appUrl: 'https://example.test',
  });
  const st = await json('/api/state');
  const army = st.body.agents.find((a) => a.id === 'army');
  assert.equal(army.status, 'working');
  assert.equal(st.body.tasks[0].id, r.body.id);
});

test('POST /api/status требует токен и валидирует статус', async () => {
  assert.equal((await json('/api/status', { method: 'POST', body: '{"agent":"army"}' })).status, 401);
  const h = { 'x-agent-token': 'tok-test' };
  assert.equal((await json('/api/status', { method: 'POST', headers: h, body: '{}' })).status, 400);
  const bad = await json('/api/status', {
    method: 'POST', headers: h, body: JSON.stringify({ agent: 'army', status: 'sleeping' }),
  });
  assert.equal(bad.status, 400);
});

test('результат закрывает задачу и даёт опыт один раз', async () => {
  const t = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'poker', text: 'Посчитай эквити AKo против 22' }),
  });
  const h = { 'x-agent-token': 'tok-test' };
  const body = { agent: 'poker', status: 'idle', now: 'Жду задач', done: 'Эквити посчитано', taskId: t.body.id, result: '≈53%' };
  const r = await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.agent.completed, 1);
  await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const st = await json('/api/state');
  const task = st.body.tasks.find((x) => x.id === t.body.id);
  assert.equal(task.status, 'выполнена');
  assert.equal(task.result, '≈53%');
  const poker = st.body.agents.find((a) => a.id === 'poker');
  assert.equal(poker.completed, 1);
  assert.equal(poker.status, 'idle');
  assert.equal(poker.done[0], 'Эквити посчитано');
});

test('неизвестный агент создаётся на лету и подключается к главному', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const r = await json('/api/status', {
    method: 'POST', headers: h,
    body: JSON.stringify({ agent: 'crypto', name: 'Крипта', color: '#ff0', role: 'Крипторынок', status: 'working', now: 'Смотрю BTC' }),
  });
  assert.equal(r.status, 200);
  const st = await json('/api/state');
  const a = st.body.agents.find((x) => x.id === 'crypto');
  assert.equal(a.name, 'Крипта');
  assert.equal(a.status, 'working');
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
  assert.ok(st.body.agents.find((x) => x.id === 'grok').links.includes('crypto'));
});

test('свободный слот занимается при передаче имени', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const r = await json('/api/status', {
    method: 'POST', headers: h, body: JSON.stringify({ agent: 'slot8', name: 'Здоровье', role: 'Спорт и питание' }),
  });
  assert.equal(r.body.agent.vacant, false);
  const t = await json('/api/task', {
    method: 'POST', headers: { 'x-app-password': 'pw-test' }, body: JSON.stringify({ agent: 'slot8', text: 'План тренировок' }),
  });
  assert.equal(t.status, 201);
});
