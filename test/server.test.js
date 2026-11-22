'use strict';

// Тесты API: node --test  (Node 18+). Переменные окружения задаются до require.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const received = [];
const grokHits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
const grokHook = http.createServer((req, res) => {
  grokHits.push(req.url || '');
  req.resume();
  res.writeHead(204);
  res.end();
});

let base;
let server;
let office;

before(async () => {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  await new Promise((r) => grokHook.listen(0, '127.0.0.1', r));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-uploads-'));
  process.env.APP_PASSWORD = 'pw-test';
  process.env.AGENT_TOKEN = 'tok-test';
  process.env.GROK_WEBHOOK_URL = `http://127.0.0.1:${grokHook.address().port}/old`;
  process.env.GROK_WEBHOOK_KEY = 'hook-key';
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.KREMLIN_WEBHOOK_KEY = 'hook-key';
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  process.env.PUBLIC_URL = 'https://example.test';
  delete process.env.PORYADOK_INGEST_TOKEN;
  office = require('../server.js');
  const { app } = office;
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  hook.close();
  grokHook.close();
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
  for (const id of ['grok', 'army', 'poker', 'trading', 'devops', 'dev', 'qa', 'temshik', 'blog', 'finance', 'invest', 'analyst', 'lang', 'biz', 'advisor', 'social', 'routines', 'health']) {
    assert.ok(ids.includes(id), `нет агента ${id}`);
  }
  const grok = body.agents.find((a) => a.id === 'grok');
  assert.equal(grok.name, 'Путин');
  assert.equal(grok.kind, 'putin');
  assert.equal(grok.tier, 'main');
  assert.equal(grok.number, '1');
  assert.equal(grok.archived, false);
  assert.ok(grok.links.includes('advisor'));
  assert.ok(!grok.links.includes('trading') && !grok.links.includes('biz') && !grok.links.includes('lang'));
  const army = body.agents.find((a) => a.id === 'army');
  assert.ok(army.responsibilities.length >= 4);
  assert.equal(army.completed, 0);
  assert.equal(army.number, '2');
  const numbers = {
    poker: '3',
    devops: '4',
    dev: '5',
    temshik: '6',
    finance: '7',
    invest: '7.1',
    analyst: '7.2',
    qa: '8',
    blog: '9',
    advisor: '10',
    social: '11',
    routines: '12',
    health: '13',
  };
  for (const [id, number] of Object.entries(numbers)) {
    const agent = body.agents.find((a) => a.id === id);
    assert.equal(agent.number, number, id);
    assert.equal(agent.archived, false, id);
  }
  const advisor = body.agents.find((a) => a.id === 'advisor');
  assert.equal(advisor.name, 'Советник Путина');
  assert.equal(advisor.role, 'Стратегический советник Путина');
  assert.equal(advisor.kind, 'advisor');
  assert.equal(advisor.tier, 'dept');
  assert.equal(advisor.parentId, null);
  assert.equal(advisor.district, 'Кремль');
  const grokAgentIds = {
    grok: '8b9d4ad0-4222-49a8-84b4-b125d3b7ec01',
    army: 'b174ea11-d3ab-4ad7-ab65-8feacca27cf4',
    poker: 'e15adfa3-6299-4980-a224-1b7adea71c45',
    devops: 'd2ed048e-12e7-4b0e-b42c-36225ed71745',
    dev: '8117cf6a-c57d-42cc-ba6f-2421fe7af6ad',
    temshik: '6a1deccc-2411-4fd1-8da7-e7ba9fce6df2',
    finance: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    invest: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    analyst: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    qa: '892a92c9-8133-48d2-b22d-c77e653309af',
    blog: '118a97ac-2030-4f25-b684-ac19252fb4aa',
    advisor: '961b2d3d-5f80-4891-b87a-c6913bbf2971',
    social: 'a1bd53f2-5655-446b-8207-393e61fc20e1',
    routines: 'd6b45571-e211-4218-a1e2-1c0918973ddc',
    health: '0ed66c28-6327-4768-8bf1-f2e06f72c2ac',
    trading: '504035c8-ccd8-467b-9e34-f16305493533',
    biz: 'a64c9436-36bc-4122-af1b-89d56950b0c1',
    lang: '5f09e2b6-ec92-44ef-bcbd-b1f848daed18',
  };
  for (const [id, grokAgentId] of Object.entries(grokAgentIds)) {
    assert.equal(body.agents.find((a) => a.id === id).grokAgentId, grokAgentId, id);
  }
  assert.equal(advisor.grokAgentId, '961b2d3d-5f80-4891-b87a-c6913bbf2971');
  assert.ok(Math.hypot(advisor.x - grok.x, advisor.y - grok.y) < 220);
  const finance = body.agents.find((a) => a.id === 'finance');
  assert.equal(finance.name, 'Финансы');
  assert.equal(finance.vacant, false);
  assert.equal(finance.kind, 'finance');
  const invest = body.agents.find((a) => a.id === 'invest');
  const analyst = body.agents.find((a) => a.id === 'analyst');
  assert.equal(invest.parentId, 'finance');
  assert.equal(analyst.parentId, 'finance');
  assert.equal(invest.tier, 'sub');
  const qa = body.agents.find((a) => a.id === 'qa');
  assert.equal(qa.name, 'Тестировщик ПО');
  assert.equal(qa.kind, 'qa');
  const socialAgent = body.agents.find((a) => a.id === 'social');
  assert.equal(socialAgent.name, 'Соцсети');
  assert.equal(socialAgent.number, '11');
  assert.equal(socialAgent.kind, 'social');
  assert.equal(socialAgent.tier, 'dept');
  assert.equal(socialAgent.parentId, null);
  assert.equal(socialAgent.archived, false);
  assert.equal(socialAgent.district, 'ВДНХ');
  const routines = body.agents.find((a) => a.id === 'routines');
  assert.equal(routines.name, 'Рутины · Кремль');
  assert.equal(routines.number, '12');
  assert.equal(routines.kind, 'routines');
  assert.equal(routines.tier, 'dept');
  assert.equal(routines.parentId, null);
  assert.equal(routines.archived, false);
  assert.equal(routines.district, 'Хамовники');
  assert.match(routines.role, /рутинам и автоматизации/);
  assert.match(routines.role, /обучает владельца/);
  const health = body.agents.find((a) => a.id === 'health');
  assert.equal(health.name, 'Здоровье и спорт · Кремль');
  assert.equal(health.number, '13');
  assert.equal(health.kind, 'health');
  assert.equal(health.district, 'Лужники');
  assert.deepEqual([health.x, health.y], [556, 620]);
  for (const id of ['trading', 'biz', 'lang']) {
    const archived = body.agents.find((a) => a.id === id);
    assert.equal(archived.archived, true, id);
    assert.equal(archived.number, '', id);
    assert.equal(archived.name.length > 0, true, id);
  }
  assert.ok(finance.links.includes('invest') && finance.links.includes('analyst'));
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
  const finance = await json('/api/task', {
    method: 'POST', headers: h, body: JSON.stringify({ agent: 'finance', text: 'Сведи кассу' }),
  });
  assert.equal(finance.status, 201);
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
  assert.equal(r.body.status, 'отправлена Путину');
  assert.equal(r.body.delivery, 'queue');
  assert.equal(r.body.forwardStatus, 200);
  const hit = received.find((x) => x.body && x.body.taskId === r.body.id);
  assert.ok(hit);
  assert.equal(hit.headers.authorization, 'Bearer hook-key');
  assert.equal(hit.headers['x-webhook-key'], 'hook-key');
  assert.equal(hit.body.type, 'owner_task');
  assert.equal(hit.body.agentId, 'army');
  assert.equal(hit.body.text, 'Сделай дашборд по личному составу');
  assert.equal(hit.body.taskId, r.body.id);
  assert.equal(hit.body.needId, undefined);
  assert.equal(hit.body.appUrl, 'https://example.test');
  assert.match(hit.body.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(hit.body.atMsk, /^\d{2}\.\d{2} \d{2}:\d{2} МСК$/);
  assert.equal(grokHits.length, 0);
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
  assert.equal(a.number, '14');
  assert.equal(a.archived, false);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
  assert.ok(st.body.agents.find((x) => x.id === 'grok').links.includes('crypto'));
});

test('помощник Финансов принимает задачу и сообщения', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const t = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'invest', text: 'Доля кэша в портфеле' }),
  });
  assert.equal(t.status, 201);
  const msg = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: 'invest-note-1', agentId: 'invest', role: 'agent', text: 'Кэш 18%, смотрю ОФЗ' }),
  });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.message.agentId, 'invest');
  const again = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: 'invest-note-1', agentId: 'invest', role: 'agent', text: 'повтор' }),
  });
  assert.equal(again.body.duplicate, true);
  const child = await json('/api/status', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ agent: 'credit', parentId: 'finance', name: 'Кредиты', role: 'Займы' }),
  });
  assert.equal(child.status, 200);
  assert.equal(child.body.agent.parentId, 'finance');
  assert.equal(child.body.agent.number, '7.3');
  const st = await json('/api/state');
  const created = st.body.agents.find((a) => a.id === 'credit');
  assert.equal(created.tier, 'sub');
  assert.ok(!st.body.agents.find((a) => a.id === 'grok').links.includes('credit'));
  assert.ok(st.body.agents.find((a) => a.id === 'finance').links.includes('credit'));
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('вложение сохраняется, отдаётся и попадает в вебхук', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'экран.png');
  const up = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.equal(up.status, 401);

  const upOk = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: (() => {
      const body = new FormData();
      body.append('files', new Blob([PNG], { type: 'image/png' }), 'экран.png');
      return body;
    })(),
  });
  assert.equal(upOk.status, 201);
  const uploaded = await upOk.json();
  assert.equal(uploaded.attachments.length, 1);
  const att = uploaded.attachments[0];
  assert.match(att.id, /^[a-f0-9]{32}$/);
  assert.equal(att.name, 'экран.png');
  assert.equal(att.mime, 'image/png');
  assert.equal(att.url, `/api/files/${att.id}`);

  const task = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'dev', text: 'Посмотри скриншот', attachmentIds: [att.id] }),
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.attachments[0].id, att.id);
  assert.equal(task.body.messageId, `task:${task.body.id}`);

  const file = await fetch(base + att.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, PNG.length);

  const hit = received.find((x) => x.body && x.body.taskId === task.body.id);
  assert.ok(hit);
  assert.equal(hit.body.type, 'owner_task');
  assert.equal(hit.body.text, 'Посмотри скриншот');
  assert.equal(hit.body.agentId, 'dev');
  assert.equal(hit.body.attachments, undefined);

  const st = await json('/api/state');
  const saved = st.body.tasks.find((t) => t.id === task.body.id);
  assert.equal(saved.attachments[0].name, 'экран.png');
  const msg = st.body.messages.find((m) => m.id === task.body.messageId);
  assert.equal(msg.role, 'owner');
  assert.equal(msg.agentId, 'dev');
  assert.equal(msg.source, 'app');
  assert.equal(msg.attachments[0].url, att.url);
});

test('слишком большой файл и лишние файлы отклоняются', async () => {
  const big = new FormData();
  big.append('files', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'big.bin');
  const over = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: big,
  });
  assert.equal(over.status, 413);
  assert.match(over.headers.get('content-type') || '', /application\/json/);
  assert.equal((await over.json()).error, 'Файл слишком большой (макс. 10 МБ)');

  const many = new FormData();
  for (let i = 0; i < 6; i++) many.append('files', new Blob(['x']), `f${i}.txt`);
  const tooMany = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: many,
  });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /5/);
});

test('JSON больше 1 МБ отвечает 413 JSON, а не HTML', async () => {
  const payload = JSON.stringify({ agent: 'dev', text: 'я'.repeat(700000) });
  assert.ok(Buffer.byteLength(payload) > 1024 * 1024);
  const r = await fetch(base + '/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-test' },
    body: payload,
  });
  assert.equal(r.status, 413);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  const body = await r.json();
  assert.equal(body.error, 'Файл слишком большой (макс. 10 МБ)');
});

test('общая переписка: push, дедуп и курсор новых реплик владельца', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  assert.equal((await json('/api/messages?agentId=blog')).status, 401);
  const bad = await json('/api/messages', {
    method: 'POST', headers: h, body: JSON.stringify({ agentId: 'blog', role: 'guest', text: 'нет' }),
  });
  assert.equal(bad.status, 400);

  const first = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      id: 'relay-blog-1',
      agentId: 'blog',
      role: 'agent',
      text: 'Черновик поста готов',
      timestamp: '2026-11-17T10:00:00.000Z',
    }),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.message.role, 'agent');
  assert.equal(first.body.message.timestamp, '2026-11-17T10:00:00.000Z');

  const again = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: 'relay-blog-1', agentId: 'blog', role: 'agent', text: 'другой текст' }),
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.message.text, 'Черновик поста готов');

  const ownerFromGrok = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: 'relay-blog-owner', agentId: 'blog', role: 'owner', text: 'Это написано в Grok, не в Кремле', timestamp: '2026-11-17T10:05:00.000Z' }),
  });
  assert.equal(ownerFromGrok.status, 201);

  const task = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'blog', text: 'Напиши пост про Render' }),
  });
  assert.equal(task.status, 201);

  const pulled = await json('/api/messages?agentId=blog', { headers: h });
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.messages.length, 1);
  assert.equal(pulled.body.messages[0].id, task.body.messageId);
  assert.equal(pulled.body.messages[0].text, 'Напиши пост про Render');
  assert.equal(pulled.body.messages[0].source, 'app');

  const after = await json(`/api/messages?agentId=blog&since=${encodeURIComponent(task.body.messageId)}`, { headers: h });
  assert.equal(after.body.messages.length, 0);
  assert.equal(after.body.cursor, task.body.messageId);

  const sinceTime = await json('/api/messages?agentId=blog&since=2000-01-01T00:00:00.000Z', { headers: h });
  assert.equal(sinceTime.body.messages.length, 1);

  const batch = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      messages: [
        { id: 'relay-blog-2', agentId: 'blog', role: 'agent', text: 'Добавляю абзац', timestamp: '2026-11-17T10:10:00.000Z' },
        { id: 'relay-blog-1', agentId: 'blog', role: 'agent', text: 'повтор' },
      ],
    }),
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.results[0].duplicate, false);
  assert.equal(batch.body.results[1].duplicate, true);

  const st = await json('/api/state');
  const ids = st.body.messages.filter((m) => m.agentId === 'blog').map((m) => m.id);
  assert.deepEqual(ids.filter((id) => id === 'relay-blog-1'), ['relay-blog-1']);
  assert.ok(ids.includes('relay-blog-2'));
  assert.ok(ids.includes('relay-blog-owner'));
  assert.ok(ids.includes(task.body.messageId));
});

test('результат статуса попадает в переписку один раз', async () => {
  const t = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ agent: 'advisor', text: 'Сводка по сделкам' }),
  });
  const h = { 'x-agent-token': 'tok-test' };
  const body = { agent: 'advisor', status: 'idle', now: 'Жду задач', taskId: t.body.id, result: 'Три сделки в плюсе' };
  await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const echoed = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: `result:${t.body.id}`, agentId: 'advisor', role: 'agent', text: 'другой итог', taskId: t.body.id }),
  });
  assert.equal(echoed.body.duplicate, true);
  assert.equal(echoed.body.message.text, 'Три сделки в плюсе');
  const st = await json('/api/state');
  const replies = st.body.messages.filter((m) => m.agentId === 'advisor' && m.role === 'agent' && m.taskId === t.body.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'Три сделки в плюсе');
  const sys = st.body.messages.filter((m) => m.role === 'system' && m.taskId === t.body.id);
  assert.equal(sys.length, 2);
  assert.equal(sys.filter((m) => m.text.startsWith('Выполнено:')).length, 1);
});

test('приказ: отправитель, цепочка и жизненный цикл', async () => {
  const pw = { 'x-app-password': 'pw-test' };
  const tok = { 'x-agent-token': 'tok-test' };

  const dev = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'dev', text: 'Поправь экран' }),
  });
  assert.equal(dev.status, 201);
  assert.equal(dev.body.status, 'отправлена Путину');
  assert.equal(dev.body.agent, 'dev');
  assert.equal(dev.body.agentId, 'dev');
  assert.equal(dev.body.fromAgentId, 'grok');
  assert.equal(dev.body.parentOrderId, null);
  assert.equal(dev.body.orderStatus, 'sent');
  assert.equal(dev.body.history.length, 1);
  assert.equal(dev.body.history[0].status, 'sent');
  assert.ok(dev.body.history[0].at);

  const personal = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'grok', text: 'Сводка' }),
  });
  assert.equal(personal.body.fromAgentId, 'owner');

  const child = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({
      agent: 'qa',
      text: 'Проверь правку',
      fromAgentId: 'dev',
      parentOrderId: dev.body.id,
    }),
  });
  assert.equal(child.status, 201);
  assert.equal(child.body.agentId, 'qa');
  assert.equal(child.body.fromAgentId, 'dev');
  assert.equal(child.body.parentOrderId, dev.body.id);

  const missingParent = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'qa', text: 'x', parentOrderId: 't-nope' }),
  });
  assert.equal(missingParent.status, 400);
  const badFrom = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'qa', text: 'x', fromAgentId: 'nobody' }),
  });
  assert.equal(badFrom.status, 400);

  assert.equal((await json(`/api/orders/${dev.body.id}`, { method: 'POST', body: '{"status":"accepted"}' })).status, 401);
  const unknown = await json('/api/orders/t-missing', {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(unknown.status, 404);

  const skip = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'done', result: 'рано' }),
  });
  assert.equal(skip.status, 400);
  const badProgress = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'accepted', progress: 10 }),
  });
  assert.equal(badProgress.status, 400);

  const accepted = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.unchanged, false);
  assert.equal(accepted.body.task.orderStatus, 'accepted');
  const acceptedAgain = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(acceptedAgain.status, 200);
  assert.equal(acceptedAgain.body.unchanged, true);
  assert.equal(acceptedAgain.body.task.history.length, accepted.body.task.history.length);

  const progress = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'in_progress', progress: 40, note: 'Смотрю вёрстку' }),
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.task.orderStatus, 'in_progress');
  assert.equal(progress.body.task.progress, 40);
  assert.equal(progress.body.task.note, 'Смотрю вёрстку');
  assert.equal(progress.body.task.status, 'отправлена Путину');
  const sameProgress = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'in_progress', progress: 40, note: 'Смотрю вёрстку' }),
  });
  assert.equal(sameProgress.body.unchanged, true);
  assert.equal(sameProgress.body.task.history.length, progress.body.task.history.length);

  const fraction = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'in_progress', progress: 40.5 }),
  });
  assert.equal(fraction.status, 400);
  const longNote = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'in_progress', progress: 50, note: 'я'.repeat(201) }),
  });
  assert.equal(longNote.status, 400);

  const moved = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'in_progress', progress: 80, note: 'Почти' }),
  });
  assert.equal(moved.body.unchanged, false);
  assert.equal(moved.body.task.progress, 80);

  const done = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'done', result: 'Экран поправлен' }),
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.orderStatus, 'done');
  assert.equal(done.body.task.status, 'выполнена');
  assert.equal(done.body.task.result, 'Экран поправлен');
  const doneAgain = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'done', result: 'Экран поправлен' }),
  });
  assert.equal(doneAgain.body.unchanged, true);
  const doneOther = await json(`/api/orders/${dev.body.id}`, {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'done', result: 'Другой текст' }),
  });
  assert.equal(doneOther.status, 400);

  const noResult = await json(`/api/orders/${child.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(noResult.status, 400);

  const st = await json('/api/state');
  const saved = st.body.tasks.find((t) => t.id === dev.body.id);
  assert.equal(saved.history.filter((h) => h.status === 'in_progress').length, 2);
  assert.equal(saved.history[0].status, 'sent');
  assert.equal(saved.history.at(-1).status, 'done');
  const devLines = st.body.messages.filter((m) => m.agentId === 'dev' && m.role === 'system' && m.taskId === dev.body.id);
  assert.equal(devLines.length, saved.history.length);
  const ids = devLines.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(devLines.filter((m) => m.text.includes('40%')).length, 1);
  assert.equal(devLines.filter((m) => m.text.startsWith('Выполнено:')).length, 1);
  const devAgent = st.body.agents.find((a) => a.id === 'dev');
  assert.equal(devAgent.completed, 1);

  const childState = st.body.tasks.find((t) => t.id === child.body.id);
  assert.equal(childState.parentOrderId, dev.body.id);
  assert.equal(childState.fromAgentId, 'dev');
  assert.equal(childState.agentId, 'qa');
});

test('пункты «нужно от вас»: посев, токен, создание и закрытие', async () => {
  const open = await json('/api/needs');
  assert.equal(open.status, 200);
  assert.equal(open.body.needs.find((n) => n.id === 'need-render-api'), undefined);
  assert.equal(open.body.needs.find((n) => n.id === 'need-academy'), undefined);
  const social = open.body.needs.find((n) => n.id === 'need-social');
  const finance = open.body.needs.find((n) => n.id === 'need-finance');
  assert.ok(social && finance);
  assert.equal(open.body.needs.find((n) => n.id === 'need-test-qa'), undefined);
  assert.equal(open.body.needs.find((n) => n.id === 'need-test-question'), undefined);
  assert.equal(open.body.needs.some((n) => n.kind === 'test'), false);
  assert.equal((await json('/api/needs?includeTest=true')).body.needs.some((n) => n.kind === 'test'), false);
  const flagged = await json('/api/needs?includeTest=1');
  const qa = flagged.body.needs.find((n) => n.id === 'need-test-qa');
  assert.ok(qa);
  const directQa = await json('/api/needs/need-test-qa');
  assert.equal(directQa.status, 200);
  assert.equal(directQa.body.id, 'need-test-qa');
  assert.ok(office.state.needs.find((n) => n.id === 'need-test-qa'));
  assert.ok(office.state.needs.find((n) => n.id === 'need-test-question'));
  assert.equal(finance.where, 'Чат Путина или Финансов');
  assert.match(social.what, /Instagram и YouTube/);
  assert.equal(social.fromAgentId, 'social');
  assert.equal(finance.fromAgentId, 'finance');
  assert.equal(finance.urgency, 'normal');
  assert.match(finance.what, /шесть финансовых вопросов/);
  assert.equal(finance.actionUrl, '/needs/need-finance');
  assert.equal(finance.docUrl, 'grokbot://app/v1/agent?id=8b9d4ad0-4222-49a8-84b4-b125d3b7ec01');
  assert.equal(finance.actionHint, 'Откройте в Grok чат «Путин · Кремль»');
  assert.equal(social.actionUrl, '/needs/need-social');
  assert.equal(social.docUrl, 'grokbot://app/v1/agent?id=a1bd53f2-5655-446b-8207-393e61fc20e1');
  assert.equal(social.actionHint, 'Откройте в Grok чат «Соцсети · Кремль»');
  assert.equal(qa.kind, 'test');
  assert.equal(qa.answerMode, 'yesno');
  assert.equal(qa.yesNo, true);
  assert.match(qa.what, /^ТЕСТ:/);
  assert.equal(qa.actionUrl, '/needs/need-test-qa');
  const question = flagged.body.needs.find((n) => n.id === 'need-test-question');
  assert.ok(question);
  assert.equal(question.kind, 'test');
  assert.equal(question.answerMode, 'text');
  assert.equal(question.yesNo, false);
  assert.equal(question.what, 'ТЕСТ: вопрос с ответом текстом');
  assert.equal(question.actionUrl, '/needs/need-test-question');
  assert.equal(finance.answerMode, 'text');

  const st = await json('/api/state');
  const socialAgent = st.body.agents.find((a) => a.id === 'social');
  const routinesAgent = st.body.agents.find((a) => a.id === 'routines');
  assert.ok(socialAgent);
  assert.equal(socialAgent.number, '11');
  assert.equal(routinesAgent.number, '12');
  assert.equal(social.fromAgentId, 'social');
  assert.equal(social.fromAgentId, socialAgent.id);
  assert.equal(st.body.needs.filter((n) => n.id === 'need-render-api').length, 0);
  assert.equal(st.body.needs.filter((n) => n.id === 'need-academy').length, 0);
  const stateFinance = st.body.needs.find((n) => n.id === 'need-finance');
  assert.equal(stateFinance.actionUrl, '/needs/need-finance');
  assert.equal(stateFinance.docUrl, finance.docUrl);
  assert.equal(stateFinance.actionHint, finance.actionHint);
  assert.equal(stateFinance.where, 'Чат Путина или Финансов');
  const raw = JSON.stringify(st.body);
  assert.ok(!raw.includes('pw-test') && !raw.includes('tok-test') && !raw.includes('hook-key'));

  assert.equal((await json('/api/needs', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await json('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'wrong' },
    body: '{}',
  })).status, 401);
  const byPasswordCreate = await json('/api/needs', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ what: 'x', where: 'y', fromAgentId: 'grok', urgency: 'low', kind: 'secret' }),
  });
  assert.equal(byPasswordCreate.status, 201);
  assert.ok(byPasswordCreate.body.updatedAt);
  assert.equal(byPasswordCreate.body.kind, 'secret');
  assert.equal((await json(`/api/needs/${byPasswordCreate.body.id}/close`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: '{}',
  })).status, 200);
  assert.equal((await json('/api/needs/need-missing/close', { method: 'POST', body: '{}' })).status, 401);

  const h = { 'x-agent-token': 'tok-test' };
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Проверить', where: 'Чат', fromAgentId: 'grok', urgency: 'urgent' }),
  })).status, 400);
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Проверить', where: 'Чат', fromAgentId: 'nobody', urgency: 'low' }),
  })).status, 400);
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: '   ', where: 'Чат', fromAgentId: 'grok', urgency: 'low' }),
  })).status, 400);
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ where: 'Чат', fromAgentId: 'grok', urgency: 'low' }),
  })).status, 400);
  for (const actionUrl of ['http://example.com', 'javascript:alert(1)', 'ftp://files.example/a', 'https://', 'https://example.com/a b', 'not-a-url']) {
    assert.equal((await json('/api/needs', {
      method: 'POST', headers: h,
      body: JSON.stringify({ what: 'Ссылка', where: 'Чат', fromAgentId: 'grok', urgency: 'low', actionUrl }),
    })).status, 400, actionUrl);
  }
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Ссылка', where: 'Чат', fromAgentId: 'grok', urgency: 'low', actionUrl: `https://example.com/${'a'.repeat(500)}` }),
  })).status, 400);
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Ссылка', where: 'Чат', fromAgentId: 'grok', urgency: 'low', actionUrl: 12 }),
  })).status, 400);
  assert.equal((await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Ссылка', where: 'Чат', fromAgentId: 'grok', urgency: 'low', actionHint: { text: 'x' } }),
  })).status, 400);

  const exact = `https://example.com/${'a'.repeat(500 - 'https://example.com/'.length)}`;
  assert.equal(exact.length, 500);
  const limit = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Ровно 500', where: 'Чат', fromAgentId: 'grok', urgency: 'low', actionUrl: exact }),
  });
  assert.equal(limit.status, 201);
  assert.equal(limit.body.actionUrl, `/needs/${limit.body.id}`);
  assert.equal(limit.body.docUrl, exact);
  assert.equal((await json(`/api/needs/${limit.body.id}/close`, { method: 'POST', headers: h, body: JSON.stringify({ agentId: 'grok' }) })).status, 200);

  const created = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Подтвердить черновик',
      where: 'Чат Темщика',
      fromAgentId: 'temshik',
      urgency: 'low',
      actionUrl: '  https://example.com/solve?q=1  ',
      actionLabel: 'Открыть',
      actionHint: 'если не открылось',
    }),
  });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^n-\d+$/);
  assert.equal(created.body.urgency, 'low');
  assert.equal(created.body.fromAgentId, 'temshik');
  assert.equal(created.body.closedAt, null);
  assert.equal(created.body.where, 'Чат Темщика');
  assert.equal(created.body.actionUrl, `/needs/${created.body.id}`);
  assert.equal(created.body.docUrl, 'https://example.com/solve?q=1');
  assert.equal(created.body.actionLabel, 'Открыть');
  assert.equal(created.body.actionHint, 'если не открылось');

  const listed = await json('/api/state');
  const listedNeed = listed.body.needs.find((n) => n.id === created.body.id);
  assert.ok(listedNeed);
  assert.equal(listedNeed.actionUrl, `/needs/${created.body.id}`);
  assert.equal(listedNeed.docUrl, 'https://example.com/solve?q=1');
  assert.equal(listedNeed.actionHint, 'если не открылось');
  const listedOpen = await json('/api/needs');
  assert.equal(listedOpen.body.needs.find((n) => n.id === created.body.id).actionLabel, 'Открыть');

  const closed = await json(`/api/needs/${created.body.id}/close`, { method: 'POST', headers: h, body: JSON.stringify({ agent: 'temshik' }) });
  assert.equal(closed.status, 200);
  assert.ok(closed.body.closedAt);
  const again = await json(`/api/needs/${created.body.id}/close`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(again.status, 200);
  assert.equal(again.body.closedAt, closed.body.closedAt);

  const after = await json('/api/needs');
  assert.ok(after.body.needs.some((n) => n.id === 'need-social'));
  assert.equal(after.body.needs.some((n) => n.id === 'need-test-qa'), false);
  assert.ok((await json('/api/needs?includeTest=1')).body.needs.some((n) => n.id === 'need-test-qa'));
  assert.ok(!after.body.needs.some((n) => n.id === created.body.id));
  assert.equal((await json('/api/needs/no-such/close', { method: 'POST', headers: h, body: '{}' })).status, 404);

  const byPassword = await json('/api/needs/need-finance/close', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: '{}',
  });
  assert.equal(byPassword.status, 200);
  assert.ok(byPassword.body.closedAt);
  const samePassword = await json('/api/needs/need-finance/close', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: '{}',
  });
  assert.equal(samePassword.body.closedAt, byPassword.body.closedAt);
  const sameToken = await json('/api/needs/need-finance/close', { method: 'POST', headers: h, body: '{}' });
  assert.equal(sameToken.status, 200);
  assert.equal(sameToken.body.closedAt, byPassword.body.closedAt);
  assert.equal((await json('/api/needs')).body.needs.find((n) => n.id === 'need-finance'), undefined);
  assert.equal(byPassword.body.closedBy, 'user');
});

test('закрытие пункта пишет closedBy и одну строку в лог', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const created = await json('/api/needs', {
      method: 'POST', headers: h,
      body: JSON.stringify({ what: 'Закрыть с автором', where: 'Чат', fromAgentId: 'dev', urgency: 'low' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.closedBy, null);
    const bare = await json(`/api/needs/${created.body.id}/close`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(bare.status, 400);
    const unknown = await json(`/api/needs/${created.body.id}/close`, {
      method: 'POST', headers: h, body: JSON.stringify({ agentId: 'no-such' }),
    });
    assert.equal(unknown.status, 400);
    const byAgent = await json(`/api/needs/${created.body.id}/close`, {
      method: 'POST', headers: h, body: JSON.stringify({ agentId: 'dev' }),
    });
    assert.equal(byAgent.status, 200);
    assert.equal(byAgent.body.closedBy, 'dev');
    assert.ok(byAgent.body.closedAt);
    const again = await json(`/api/needs/${created.body.id}/close`, {
      method: 'POST', headers: h, body: JSON.stringify({ agentId: 'qa' }),
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.closedBy, 'dev');
    assert.equal(again.body.closedAt, byAgent.body.closedAt);

    const other = await json('/api/needs', {
      method: 'POST', headers: h,
      body: JSON.stringify({ what: 'Закрыть паролем', where: 'Чат', fromAgentId: 'grok', urgency: 'low' }),
    });
    const byUser = await json(`/api/needs/${other.body.id}/close`, {
      method: 'POST',
      headers: { 'x-app-password': 'pw-test', 'x-agent-token': 'tok-test' },
      body: JSON.stringify({ agentId: 'dev' }),
    });
    assert.equal(byUser.status, 200);
    assert.equal(byUser.body.closedBy, 'user');

    const st = await json('/api/state');
    assert.equal(st.body.needs.find((n) => n.id === created.body.id).closedBy, 'dev');
    assert.equal(st.body.needs.find((n) => n.id === other.body.id).closedBy, 'user');
    assert.deepEqual(
      logs.filter((line) => line.startsWith('need closed:')),
      [`need closed: ${created.body.id} by dev`, `need closed: ${other.body.id} by user`],
    );
    const blob = logs.join('\n');
    assert.equal(blob.includes('tok-test'), false);
    assert.equal(blob.includes('pw-test'), false);
  } finally {
    console.log = orig;
  }
});

test('need-render-api не сеется, открытая сохранённая копия закрывается', () => {
  const { state, migrateOwnerNeeds } = require('../server.js');
  assert.equal(state.needs.filter((n) => n.id === 'need-render-api').length, 0);
  migrateOwnerNeeds();
  assert.equal(state.needs.filter((n) => n.id === 'need-render-api').length, 0);

  state.needs.push({
    id: 'need-render-api',
    what: 'Ключ Render API — ввести через защищённую форму в чате DevOps',
    fromAgentId: 'devops',
    where: 'Защищённая форма в чате DevOps',
    urgency: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    checkedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedBy: null,
    resolvesWhenEnv: null,
  });
  migrateOwnerNeeds();
  const copies = state.needs.filter((n) => n.id === 'need-render-api');
  assert.equal(copies.length, 1);
  assert.ok(copies[0].closedAt);
  const stamp = copies[0].closedAt;
  migrateOwnerNeeds();
  assert.equal(state.needs.filter((n) => n.id === 'need-render-api').length, 1);
  assert.equal(copies[0].closedAt, stamp);
  assert.equal(copies[0].what, 'Ключ Render API — ввести через защищённую форму в чате DevOps');
});

test('академия закрывается на месте и не сеется снова', () => {
  const { state, migrateOwnerNeeds, ACADEMY_WHERE } = require('../server.js');
  const item = {
    id: 'need-academy',
    what: 'Одобрить Академию агентов: нажать «Да» в чатах Программирования, Тестировщика и Business Adviser',
    fromAgentId: 'grok',
    where: 'Чат главного агента',
    urgency: 'normal',
    closedAt: null,
    closedBy: null,
  };
  state.needs.push(item);
  migrateOwnerNeeds();
  migrateOwnerNeeds();
  const all = state.needs.filter((n) => n.id === 'need-academy');
  assert.equal(all.length, 1);
  assert.equal(all[0], item);
  assert.doesNotMatch(all[0].what, /Business Adviser/);
  assert.equal(all[0].where, ACADEMY_WHERE);
  assert.equal(all[0].closedBy, 'putin');
  assert.ok(all[0].closedAt);
  const stamp = all[0].closedAt;
  migrateOwnerNeeds();
  assert.equal(all[0].closedAt, stamp);
  assert.equal(state.needs.filter((n) => n.id === 'need-academy' && !n.closedAt).length, 0);
});

test('«где» у финансов мигрирует на месте, ссылка остаётся', () => {
  const { state, migrateOwnerNeeds, FINANCE_WHERE, FINANCE_ACTION_URL } = require('../server.js');
  const item = state.needs.find((n) => n.id === 'need-finance');
  assert.ok(item);
  const closedAt = item.closedAt;
  const what = item.what;
  item.where = 'Чат Финансов';
  item.docUrl = null;
  item.actionUrl = FINANCE_ACTION_URL;
  migrateOwnerNeeds();
  migrateOwnerNeeds();
  const all = state.needs.filter((n) => n.id === 'need-finance');
  assert.equal(all.length, 1);
  assert.equal(all[0], item);
  assert.equal(item.where, FINANCE_WHERE);
  assert.equal(item.where, 'Чат Путина или Финансов');
  assert.equal(item.docUrl, FINANCE_ACTION_URL);
  assert.equal(item.what, what);
  assert.equal(item.closedAt, closedAt);
});

test('actionUrl посева ставится, если его нет, и второй проход ничего не меняет', () => {
  const {
    state,
    migrateOwnerNeeds,
    ACADEMY_ACTION_URL,
    FINANCE_ACTION_URL,
    FINANCE_ACTION_HINT,
    SOCIAL_ACTION_URL,
    SOCIAL_ACTION_HINT,
  } = require('../server.js');
  const finance = state.needs.find((n) => n.id === 'need-finance');
  const social = state.needs.find((n) => n.id === 'need-social');
  assert.equal(finance.docUrl, FINANCE_ACTION_URL);
  assert.equal(finance.actionHint, FINANCE_ACTION_HINT);
  assert.equal(social.docUrl, SOCIAL_ACTION_URL);
  assert.equal(social.actionHint, SOCIAL_ACTION_HINT);

  const custom = 'https://example.com/keep';
  finance.docUrl = custom;
  finance.actionHint = 'своя подсказка';
  social.docUrl = null;
  social.actionHint = '';
  const before = state.needs.length;
  migrateOwnerNeeds();
  assert.equal(state.needs.filter((n) => n.id === 'need-academy' && !n.closedAt).length, 0);
  assert.equal(finance.docUrl, custom);
  assert.equal(finance.actionHint, 'своя подсказка');
  assert.equal(social.docUrl, SOCIAL_ACTION_URL);
  assert.equal(social.actionHint, SOCIAL_ACTION_HINT);
  assert.equal(state.needs.length, before + (state.needs.filter((n) => n.id === 'need-academy').length ? 0 : 0));
  const stamp = {
    financeUrl: finance.docUrl,
    financeHint: finance.actionHint,
    socialUrl: social.docUrl,
    socialHint: social.actionHint,
  };
  migrateOwnerNeeds();
  assert.equal(finance.docUrl, stamp.financeUrl);
  assert.equal(finance.actionHint, stamp.financeHint);
  assert.equal(social.docUrl, stamp.socialUrl);
  assert.equal(social.actionHint, stamp.socialHint);
  assert.equal(state.needs.filter((n) => n.id === 'need-social').length, 1);
  finance.actionHint = FINANCE_ACTION_HINT;
});

test('устаревание считается от checkedAt с подменённым временем', () => {
  const { isNeedStale } = require('../server.js');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const need = { closedAt: null, checkedAt: new Date(t0).toISOString(), createdAt: new Date(t0).toISOString() };
  assert.equal(isNeedStale(need, t0 + 24 * 60 * 60 * 1000, 24), false);
  assert.equal(isNeedStale(need, t0 + 24 * 60 * 60 * 1000 + 1, 24), true);
  assert.equal(isNeedStale({ ...need, closedAt: new Date(t0).toISOString() }, t0 + 48 * 60 * 60 * 1000, 24), false);
  assert.equal(isNeedStale({ closedAt: null, createdAt: new Date(t0).toISOString() }, t0 + 25 * 60 * 60 * 1000, 24), true);
  assert.equal(isNeedStale(need, t0 + 30 * 60 * 1000, 0), true);
});

test('confirm: токен, 401 без него, 404 и снятие stale', async () => {
  const { state } = require('../server.js');
  const id = 'need-social';
  const item = state.needs.find((n) => n.id === id);
  item.checkedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const before = (await json('/api/state')).body.needs.find((n) => n.id === id);
  assert.equal(before.stale, true);
  assert.equal((await json(`/api/needs/${id}/confirm`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await json(`/api/needs/${id}/confirm`, {
    method: 'POST',
    headers: { 'x-agent-token': 'wrong' },
    body: '{}',
  })).status, 401);
  assert.equal((await json(`/api/needs/${id}/confirm`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: '{}',
  })).status, 401);
  assert.equal((await json('/api/needs/missing-need/confirm', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: '{}',
  })).status, 404);
  const confirmed = await json(`/api/needs/${id}/confirm`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: '{}',
  });
  assert.equal(confirmed.status, 200);
  assert.ok(Date.parse(confirmed.body.checkedAt) > Date.parse(before.checkedAt));
  assert.equal(confirmed.body.stale, false);
  const after = (await json('/api/state')).body.needs.find((n) => n.id === id);
  assert.equal(after.stale, false);
  assert.equal(after.checkedAt, confirmed.body.checkedAt);
});

test('открытый пункт закрывается по переменной окружения, значение не отдаётся', async () => {
  const { state, resolveNeedsByEnv } = require('../server.js');
  const secret = 'env-value-should-not-leak-9f3a';
  const name = 'NEED_TEST_RESOLVE_FLAG';
  delete process.env[name];
  const h = { 'x-agent-token': 'tok-test' };
  const created = await json('/api/needs', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      what: 'Жду переменную',
      where: 'Окружение',
      fromAgentId: 'devops',
      urgency: 'high',
      resolvesWhenEnv: name,
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.closedAt, null);
  assert.equal(created.body.resolvesWhenEnv, name);
  assert.equal(created.body.closedBy, null);
  resolveNeedsByEnv();
  const live = state.needs.find((n) => n.id === created.body.id);
  assert.equal(live.closedAt, null);
  process.env[name] = secret;
  try {
    resolveNeedsByEnv();
    assert.ok(live.closedAt);
    assert.equal(live.closedBy, 'auto-env');
    const frozen = live.closedAt;
    resolveNeedsByEnv();
    assert.equal(live.closedAt, frozen);
    const body = await json('/api/state');
    const saved = body.body.needs.find((n) => n.id === created.body.id);
    assert.equal(saved.closedBy, 'auto-env');
    assert.equal(saved.resolvesWhenEnv, name);
    assert.equal(JSON.stringify(body.body).includes(secret), false);
    assert.equal((await json('/api/needs')).body.needs.some((n) => n.id === created.body.id), false);
  } finally {
    delete process.env[name];
  }
  assert.equal((await json('/api/needs', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ what: 'x', where: 'y', fromAgentId: 'grok', urgency: 'low', resolvesWhenEnv: 'not valid' }),
  })).status, 400);
});

test('архивные агенты не принимают задачи, история читается', async () => {
  const pw = { 'x-app-password': 'pw-test' };
  const tok = { 'x-agent-token': 'tok-test' };
  for (const agent of ['trading', 'biz', 'lang']) {
    const denied = await json('/api/task', {
      method: 'POST', headers: pw,
      body: JSON.stringify({ agent, text: `Новый приказ ${agent}` }),
    });
    assert.ok(denied.status >= 400 && denied.status < 500, `${agent} ${denied.status}`);
    assert.equal(denied.status, 409);
    assert.match(denied.body.error, /архив/i);
  }
  const clean = await json('/api/state');
  assert.equal(clean.body.tasks.some((t) => t.text === 'Новый приказ trading' || t.text === 'Новый приказ biz'), false);

  const fd = new FormData();
  fd.append('agentId', 'trading');
  fd.append('role', 'agent');
  fd.append('id', 'archive-trading-note');
  fd.append('text', 'Старая сводка по архиву');
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'сделка.png');
  const posted = await fetch(base + '/api/messages', { method: 'POST', headers: tok, body: fd });
  assert.equal(posted.status, 201);
  const postedBody = await posted.json();
  assert.equal(postedBody.message.agentId, 'trading');
  assert.equal(postedBody.message.attachments.length, 1);
  const file = await fetch(base + postedBody.message.attachments[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');

  office.state.tasks.unshift({
    id: 't-archive-trading',
    agent: 'trading',
    agentId: 'trading',
    fromAgentId: 'owner',
    parentOrderId: null,
    text: 'Старая сводка по сделкам',
    status: 'отправлена',
    orderStatus: 'sent',
    progress: null,
    note: '',
    createdAt: '2026-01-02T00:00:00.000Z',
    forwardStatus: null,
    result: null,
    history: [{ status: 'sent', at: '2026-01-02T00:00:01.000Z', progress: null, note: '', result: null }],
    attachments: [],
    messageId: 'task:t-archive-trading',
  });
  office.state.messages.push({
    id: 'task:t-archive-trading',
    agentId: 'trading',
    role: 'owner',
    text: 'Старая сводка по сделкам',
    attachments: [],
    createdAt: '2026-01-02T00:00:00.000Z',
    source: 'app',
    taskId: 't-archive-trading',
  });

  const read = await json('/api/messages?agentId=trading', { headers: tok });
  assert.equal(read.status, 200);
  assert.ok(read.body.messages.some((m) => m.id === 'task:t-archive-trading' && m.text === 'Старая сводка по сделкам'));
  const bizRead = await json('/api/messages?agentId=biz', { headers: tok });
  assert.equal(bizRead.status, 200);
  assert.ok(Array.isArray(bizRead.body.messages));
  const langRead = await json('/api/messages?agentId=lang', { headers: tok });
  assert.equal(langRead.status, 200);
  assert.ok(Array.isArray(langRead.body.messages));

  const moved = await json('/api/orders/t-archive-trading', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.task.agentId, 'trading');
  assert.equal(moved.body.task.orderStatus, 'accepted');

  const st = await json('/api/state');
  const task = st.body.tasks.find((t) => t.id === 't-archive-trading');
  assert.equal(task.text, 'Старая сводка по сделкам');
  assert.equal(task.orderStatus, 'accepted');
  assert.ok(st.body.messages.some((m) => m.id === 'archive-trading-note' && m.attachments.length === 1));
  assert.equal(st.body.agents.find((a) => a.id === 'trading').archived, true);
  assert.equal(st.body.agents.find((a) => a.id === 'biz').archived, true);
  assert.equal(st.body.agents.find((a) => a.id === 'lang').archived, true);
  assert.equal(st.body.agents.find((a) => a.id === 'advisor').parentId, null);
  assert.equal(st.body.agents.find((a) => a.id === 'advisor').number, '10');

  const need = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Архивный вопрос советника', where: 'Сколково', fromAgentId: 'biz', urgency: 'low' }),
  });
  assert.equal(need.status, 201);
  const needs = await json('/api/needs');
  assert.ok(needs.body.needs.some((n) => n.id === need.body.id && n.fromAgentId === 'biz'));
  const bizPage = await json(`/api/needs/${need.body.id}`);
  assert.equal(bizPage.status, 404);

  const langNeed = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({
      what: 'Архивный вопрос репетитора',
      where: 'МГУ',
      fromAgentId: 'lang',
      urgency: 'low',
      answerable: true,
      details: 'Текст урока не должен открыться',
    }),
  });
  assert.equal(langNeed.status, 201);
  const listed = await json('/api/needs');
  assert.ok(listed.body.needs.some((n) => n.id === langNeed.body.id && n.fromAgentId === 'lang'));
  const langPage = await json(`/api/needs/${langNeed.body.id}`, { headers: pw });
  assert.equal(langPage.status, 404);
  assert.equal(JSON.stringify(langPage.body).includes('Текст урока'), false);
  assert.equal(JSON.stringify(langPage.body).includes('Language Coach'), false);
  const langAnswer = await json(`/api/needs/${langNeed.body.id}/answer`, {
    method: 'POST', headers: pw,
    body: JSON.stringify({ text: 'Ответ архивному репетитору' }),
  });
  assert.equal(langAnswer.status, 201);
  assert.equal(langAnswer.body.answers.at(-1).text, 'Ответ архивному репетитору');
  const after = await json('/api/state');
  assert.equal(after.body.tasks.some((t) => t.agent === 'lang' && /Ответ архивному репетитору/.test(t.text || '')), false);
  const queuedLang = after.body.tasks.find((t) => t.agent === 'grok' && /Ответ архивному репетитору/.test(t.text || ''));
  assert.ok(queuedLang);
  assert.equal(queuedLang.delivery, 'queue');
  assert.equal(queuedLang.fromAgentId, 'owner');
  assert.ok(after.body.needs.some((n) => n.id === langNeed.body.id && n.fromAgentId === 'lang'));
});

test('безопасный markdown не делает html и grokbot ссылкой', () => {
  const { renderSafeMarkdown } = require('../public/js/markdown.js');
  const html = renderSafeMarkdown('Смотри https://example.com/q и grokbot://app/v1/agent?id=1\n\n<script>alert(1)</script>');
  assert.match(html, /<a href="https:\/\/example.com\/q"/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="grokbot:/);
  assert.doesNotMatch(html, /href="http:/);
  assert.match(html, /grokbot:\/\/app\/v1\/agent\?id=1/);
  assert.match(html, /откройте чат агента в Grok/);
  const httpLink = renderSafeMarkdown('Черновик http://example.com/plain');
  assert.doesNotMatch(httpLink, /<a /);
  assert.match(httpLink, /http:\/\/example.com\/plain/);
});

test('details и ответы только с паролем штаба, ответ ставит задачу', async () => {
  const secret = 'Выдуманный вопрос QZX-42 про лимит';
  const answer = 'Ответ QZX-42 берём паузу';
  const h = { 'x-agent-token': 'tok-test' };
  const pw = { 'x-app-password': 'pw-test' };
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  const previous = process.env.NEEDS_DETAILS_JSON;
  try {
    process.env.NEEDS_DETAILS_JSON = '{"need-finance": {"details": "LEAK-THIS-SECRET"';
    office.migrateOwnerNeeds();
    assert.ok(warns.some((line) => line.includes('NEEDS_DETAILS_JSON')));
    assert.equal(warns.join('\n').includes('LEAK-THIS-SECRET'), false);
    const finance = office.state.needs.find((n) => n.id === 'need-finance');
    assert.equal(String(finance.details || '').includes('LEAK-THIS-SECRET'), false);

    process.env.NEEDS_DETAILS_JSON = JSON.stringify({
      'need-finance': { details: secret, answerable: true },
    });
    office.migrateOwnerNeeds();
    assert.equal(finance.details, secret);
    assert.equal(finance.answerable, true);

    const bad = await json('/api/needs', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        what: 'Плохие поля', where: 'Чат', fromAgentId: 'temshik', urgency: 'low', answerable: 'true',
      }),
    });
    assert.equal(bad.status, 400);

    const created = await json('/api/needs', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        what: 'Подтвердить черновик вопроса',
        where: 'Чат Темщика',
        fromAgentId: 'temshik',
        urgency: 'low',
        details: `${secret} <script>`,
        answerable: true,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.details, undefined);
    assert.equal(created.body.answers, undefined);
    assert.equal(created.body.hasDetails, true);
    assert.equal(created.body.answerable, true);
    assert.equal(created.body.answerStatus, null);
    assert.equal(JSON.stringify(created.body).includes(secret), false);

    const open = await json('/api/needs');
    const pub = open.body.needs.find((n) => n.id === created.body.id);
    assert.equal(pub.details, undefined);
    assert.equal(pub.answers, undefined);
    assert.equal(pub.hasDetails, true);
    assert.equal(JSON.stringify(open.body).includes(secret), false);

    const state = await json('/api/state');
    assert.equal(JSON.stringify(state.body.needs).includes(secret), false);
    assert.equal(state.body.needs.find((n) => n.id === 'need-finance').details, undefined);
    assert.equal(state.body.needs.find((n) => n.id === 'need-finance').hasDetails, true);

    const agentView = await json('/api/needs', { headers: h });
    assert.equal(JSON.stringify(agentView.body).includes(secret), false);
    const stateAgent = await json('/api/state', { headers: h });
    assert.equal(JSON.stringify(stateAgent.body.needs).includes(secret), false);

    const wrong = await json(`/api/needs/${created.body.id}`, { headers: { 'x-app-password': 'nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(JSON.stringify(wrong.body).includes(secret), false);

    const authedList = await json('/api/needs', { headers: pw });
    assert.equal(authedList.body.needs.find((n) => n.id === created.body.id).details, `${secret} <script>`);
    const authedState = await json('/api/state', { headers: pw });
    assert.equal(authedState.body.needs.find((n) => n.id === 'need-finance').details, secret);
    assert.equal(authedState.body.needs.find((n) => n.id === 'need-finance').answerable, true);
    assert.ok(Array.isArray(authedState.body.needs.find((n) => n.id === 'need-finance').answers));

    const page = await fetch(`${base}/needs/${created.body.id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="needPage"/);

    const denied = await json(`/api/needs/${created.body.id}/answer`, {
      method: 'POST', body: JSON.stringify({ text: answer }),
    });
    assert.equal(denied.status, 401);
    const empty = await json(`/api/needs/${created.body.id}/answer`, {
      method: 'POST', headers: pw, body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);
    const tooLong = await json(`/api/needs/${created.body.id}/answer`, {
      method: 'POST', headers: pw, body: JSON.stringify({ text: 'я'.repeat(5001) }),
    });
    assert.equal(tooLong.status, 400);

    const sent = await json(`/api/needs/${created.body.id}/answer`, {
      method: 'POST', headers: pw, body: JSON.stringify({ text: answer }),
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.answerStatus, 'answered');
    assert.equal(sent.body.answerMode, 'text');
    assert.equal(sent.body.yesNo, false);
    assert.ok(sent.body.closedAt);
    assert.equal(sent.body.closedBy, 'owner-answer');
    assert.equal(sent.body.answers.length, 1);
    assert.equal(sent.body.answers[0].text, answer);
    assert.equal(sent.body.answers[0].by, 'owner');
    assert.ok(sent.body.answers[0].at);
    const again = await json(`/api/needs/${created.body.id}/answer`, {
      method: 'POST', headers: pw, body: JSON.stringify({ text: 'ещё раз' }),
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'Пункт уже закрыт');
    const kept = await json(`/api/needs/${created.body.id}`, { headers: pw });
    assert.equal(kept.body.closedAt, sent.body.closedAt);
    assert.equal(kept.body.closedBy, 'owner-answer');
    assert.equal(kept.body.answers.length, 1);

    const after = await json('/api/state');
    const shown = after.body.needs.find((n) => n.id === created.body.id);
    assert.equal(shown.answerStatus, 'answered');
    assert.equal(shown.answers, undefined);
    assert.equal(shown.details, undefined);
    assert.equal(JSON.stringify(shown).includes(answer), false);
    assert.equal(JSON.stringify(shown).includes(secret), false);
    const task = after.body.tasks.find((t) => t.agent === 'temshik' && t.text.includes(answer));
    assert.ok(task);
    assert.equal(task.text, `Ответ Арсения на «Подтвердить черновик вопроса»: ${answer}`);
    assert.equal(task.fromAgentId, 'owner');
    const message = after.body.messages.find((m) => m.taskId === task.id);
    assert.equal(message.agentId, 'temshik');
    assert.equal(message.role, 'owner');
    assert.equal(message.source, 'app');
    assert.equal(message.text, task.text);
  } finally {
    console.warn = orig;
    if (previous === undefined) delete process.env.NEEDS_DETAILS_JSON;
    else process.env.NEEDS_DETAILS_JSON = previous;
  }
});

test('PATCH пункта меняет поля, ставит updatedAt и закрывает', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const created = await json('/api/needs', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      what: 'Удалить черновик',
      where: 'База',
      fromAgentId: 'dev',
      urgency: 'low',
      kind: 'delete',
    }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.updatedAt);
  const bad = await json(`/api/needs/${created.body.id}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ what: '   ' }),
  });
  assert.equal(bad.status, 400);
  const edited = await json(`/api/needs/${created.body.id}`, {
    method: 'PATCH',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({
      what: 'Удалить черновик сегодня',
      urgency: 'high',
      docUrl: 'https://example.com/wipe',
    }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.what, 'Удалить черновик сегодня');
  assert.equal(edited.body.urgency, 'high');
  assert.equal(edited.body.docUrl, 'https://example.com/wipe');
  assert.equal(edited.body.actionUrl, `/needs/${created.body.id}`);
  assert.ok(Date.parse(edited.body.updatedAt) >= Date.parse(created.body.updatedAt));
  const closed = await json(`/api/needs/${created.body.id}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ closed: true, agentId: 'dev' }),
  });
  assert.equal(closed.status, 200);
  assert.ok(closed.body.closedAt);
  assert.equal(closed.body.closedBy, 'dev');
  assert.equal((await json('/api/needs')).body.needs.find((n) => n.id === created.body.id), undefined);
});

test('answerMode, частичный ответ и тестовый вопрос текстом', async () => {
  const h = { 'x-agent-token': 'tok-test' };
  const pw = { 'x-app-password': 'pw-test' };
  const badMode = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Режим', where: 'Чат', fromAgentId: 'finance', urgency: 'low', kind: 'money', answerMode: 'maybe',
    }),
  });
  assert.equal(badMode.status, 400);

  const money = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Сколько отложить в тест',
      where: 'Чат Финансов',
      fromAgentId: 'finance',
      urgency: 'normal',
      kind: 'money',
      answerable: true,
      details: 'Вопрос один',
    }),
  });
  assert.equal(money.status, 201);
  assert.equal(money.body.kind, 'money');
  assert.equal(money.body.answerMode, 'text');
  assert.equal(money.body.yesNo, false);
  const patched = await json(`/api/needs/${money.body.id}`, {
    method: 'PATCH', headers: pw, body: JSON.stringify({ answerMode: 'yesno' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.answerMode, 'yesno');
  assert.equal(patched.body.yesNo, true);
  const back = await json(`/api/needs/${money.body.id}`, {
    method: 'PATCH', headers: pw, body: JSON.stringify({ answerMode: 'text' }),
  });
  assert.equal(back.body.answerMode, 'text');
  const textOnly = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(textOnly.status, 400);
  const partial = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'черновик <b>1</b>', partial: true }),
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.closedAt, null);
  assert.equal(partial.body.answers.length, 1);
  assert.equal(partial.body.answers[0].text, 'черновик <b>1</b>');
  assert.equal(partial.body.answers[0].by, 'owner');
  assert.ok(partial.body.updatedAt);
  const task1 = (await json('/api/state')).body.tasks.find((t) => t.agent === 'finance' && t.text.includes('черновик <b>1</b>'));
  assert.ok(task1);
  const partial2 = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'уточнение', partial: true }),
  });
  assert.equal(partial2.status, 201);
  assert.equal(partial2.body.closedAt, null);
  assert.equal(partial2.body.answers.length, 2);
  const badPartial = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'нет', partial: 'true' }),
  });
  assert.equal(badPartial.status, 400);
  const full = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'итог' }),
  });
  assert.equal(full.status, 201);
  assert.ok(full.body.closedAt);
  assert.equal(full.body.closedBy, 'owner-answer');
  assert.equal(full.body.answers.length, 3);
  const repeat = await json(`/api/needs/${money.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'поздно', partial: true }),
  });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.error, 'Пункт уже закрыт');
  const still = await json(`/api/needs/${money.body.id}`, { headers: pw });
  assert.equal(still.body.closedAt, full.body.closedAt);
  assert.equal(still.body.closedBy, 'owner-answer');
  assert.equal(still.body.answers.length, 3);
  assert.equal(still.body.answers.some((a) => a.text === 'поздно'), false);

  const approval = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Одобрить черновик', where: 'Сайт', fromAgentId: 'blog', urgency: 'low', kind: 'approval' }),
  });
  assert.equal(approval.body.answerMode, 'yesno');
  assert.equal(approval.body.yesNo, true);
  const notText = await json(`/api/needs/${approval.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'словами' }),
  });
  assert.equal(notText.status, 400);
  const no = await json(`/api/needs/${approval.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ answer: 'no' }),
  });
  assert.equal(no.status, 201);
  assert.equal(no.body.answer, 'no');
  assert.equal(no.body.closedBy, 'owner-answer');
  assert.equal(no.body.answers[0].text, 'Нет');
  const noAgain = await json(`/api/needs/${approval.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(noAgain.status, 409);
  const noKept = await json(`/api/needs/${approval.body.id}`, { headers: pw });
  assert.equal(noKept.body.closedAt, no.body.closedAt);
  assert.equal(noKept.body.closedBy, 'owner-answer');
  assert.equal(noKept.body.answer, 'no');

  const tasksBefore = (await json('/api/state')).body.tasks.length;
  const draft = await json('/api/needs/need-test-question/answer', {
    method: 'POST', body: JSON.stringify({ text: 'пробный ответ', partial: true }),
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.closedAt, null);
  assert.equal(draft.body.answers.at(-1).text, 'пробный ответ');
  assert.equal(draft.body.answers.at(-1).by, 'owner');
  assert.equal((await json('/api/state')).body.tasks.length, tasksBefore);
  assert.equal((await json('/api/state')).body.tasks.some((t) => String(t.text || '').includes('пробный ответ')), false);
  const more = await json('/api/needs/need-test-question/answer', {
    method: 'POST', body: JSON.stringify({ text: 'вторая часть', partial: true }),
  });
  assert.equal(more.status, 201);
  assert.equal(more.body.answers.length, 2);
  assert.equal(more.body.closedAt, null);
  const done = await json('/api/needs/need-test-question/answer', {
    method: 'POST', body: JSON.stringify({ text: 'готово' }),
  });
  assert.equal(done.status, 201);
  assert.equal(done.body.closedBy, 'owner-answer');
  assert.equal(done.body.answers.length, 3);
  const late = await json('/api/needs/need-test-question/answer', {
    method: 'POST', body: JSON.stringify({ text: 'ещё' }),
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'Пункт уже закрыт');
  const question = office.state.needs.find((n) => n.id === 'need-test-question');
  assert.equal(question.closedAt, done.body.closedAt);
  assert.equal(question.closedBy, 'owner-answer');
  const soon = Date.now();
  assert.equal(office.reopenTestNeeds(soon), 0);
  assert.ok(question.closedAt);
  question.closedAt = new Date(soon - office.TEST_REOPEN_MS - 1000).toISOString();
  assert.ok(office.reopenTestNeeds(soon) >= 1);
  assert.equal(question.closedAt, null);
  assert.equal(question.answers.length, 0);

  const limit = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Длинная история', where: 'Чат', fromAgentId: 'temshik', urgency: 'low', kind: 'money', answerable: true,
    }),
  });
  for (let i = 0; i < office.ANSWERS_MAX + 1; i += 1) {
    const row = await json(`/api/needs/${limit.body.id}/answer`, {
      method: 'POST', headers: pw, body: JSON.stringify({ text: `строка ${i}`, partial: true }),
    });
    assert.equal(row.status, 201, JSON.stringify(row.body));
  }
  const limited = await json(`/api/needs/${limit.body.id}`, { headers: pw });
  assert.equal(limited.body.answers.length, office.ANSWERS_MAX);
  assert.equal(limited.body.answers[0].text, 'строка 1');
  assert.equal(limited.body.answers.at(-1).text, `строка ${office.ANSWERS_MAX}`);
  assert.equal(limited.body.closedAt, null);

  const previous = process.env.NEEDS_DETAILS_JSON;
  try {
    process.env.NEEDS_DETAILS_JSON = JSON.stringify({
      'need-finance': { answerMode: 'yesno', answerable: true, details: 'режим из json' },
    });
    office.migrateOwnerNeeds();
    const finance = office.state.needs.find((n) => n.id === 'need-finance');
    assert.equal(finance.answerMode, 'yesno');
    assert.equal(finance.details, 'режим из json');
    assert.equal(finance.answerable, true);
    const qa = office.state.needs.find((n) => n.id === 'need-test-qa');
    assert.equal(qa.answerMode, 'yesno');
    assert.equal(office.state.needs.find((n) => n.id === 'need-test-question').answerMode, 'text');
  } finally {
    if (previous === undefined) delete process.env.NEEDS_DETAILS_JSON;
    else process.env.NEEDS_DETAILS_JSON = previous;
    office.migrateOwnerNeeds();
    const finance = office.state.needs.find((n) => n.id === 'need-finance');
    if (finance) finance.answerMode = 'text';
  }
});

test('ответ владельца дописывается в журнал, тест и секрет — нет', async () => {
  const denied = await json('/api/decisions');
  assert.equal(denied.status, 401);
  const deniedMd = await fetch(base + '/api/decisions.md');
  assert.equal(deniedMd.status, 401);
  assert.equal((await json('/api/decisions', { headers: { 'x-agent-token': 'wrong' } })).status, 401);

  const pw = { 'x-app-password': 'pw-test' };
  const h = { 'x-agent-token': 'tok-test' };
  const yes = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Одобрить поставку | срочно',
      where: 'Сайт',
      fromAgentId: 'blog',
      urgency: 'low',
      kind: 'approval',
    }),
  });
  assert.equal(yes.status, 201);
  const yesAnswer = await json(`/api/needs/${yes.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(yesAnswer.status, 201);
  assert.equal(yesAnswer.body.closedBy, 'owner-answer');
  assert.ok(yesAnswer.body.closedAt);
  assert.equal(yesAnswer.body.answers[0].text, 'Да');
  assert.equal((await json('/api/needs')).body.needs.some((n) => n.id === yes.body.id), false);
  const yesPage = await json(`/api/needs/${yes.body.id}`, { headers: pw });
  assert.equal(yesPage.status, 200);
  assert.equal(yesPage.body.closedBy, 'owner-answer');
  assert.equal(yesPage.body.closedAt, yesAnswer.body.closedAt);

  const textNeed = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Сколько заложить',
      where: 'Финансы',
      fromAgentId: 'finance',
      urgency: 'normal',
      kind: 'money',
      answerable: true,
    }),
  });
  const partial = await json(`/api/needs/${textNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'часть\nсуммы', partial: true }),
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.closedAt, null);
  assert.equal((await json('/api/needs')).body.needs.some((n) => n.id === textNeed.body.id), true);
  const full = await json(`/api/needs/${textNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: `вся сумма и hook-key` }),
  });
  assert.equal(full.status, 201);
  assert.equal(full.body.closedBy, 'owner-answer');
  assert.equal((await json('/api/needs')).body.needs.some((n) => n.id === textNeed.body.id), false);
  const textPage = await json(`/api/needs/${textNeed.body.id}`, { headers: pw });
  assert.equal(textPage.status, 200);
  assert.equal(textPage.body.answers.length, 2);

  const secretText = 'vault-secret-should-not-leak-77';
  const secretNeed = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'Пришли ключ',
      where: 'Секрет',
      fromAgentId: 'devops',
      urgency: 'high',
      kind: 'secret',
      answerable: true,
    }),
  });
  const secretAnswer = await json(`/api/needs/${secretNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: secretText }),
  });
  assert.equal(secretAnswer.status, 201);

  const testNeed = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      what: 'ТЕСТ: не в журнал',
      where: 'QA',
      fromAgentId: 'qa',
      urgency: 'low',
      kind: 'test',
      answerable: true,
      answerMode: 'text',
    }),
  });
  assert.equal(testNeed.status, 201);
  assert.equal((await json('/api/needs')).body.needs.some((n) => n.id === testNeed.body.id), false);
  assert.equal((await json(`/api/needs/${testNeed.body.id}`)).status, 200);
  const testAnswer = await json(`/api/needs/${testNeed.body.id}/answer`, {
    method: 'POST', body: JSON.stringify({ text: 'тестовый ответ не в журнал', partial: true }),
  });
  assert.equal(testAnswer.status, 201);

  const owner = await json('/api/decisions', { headers: pw });
  assert.equal(owner.status, 200);
  const rows = owner.body.decisions.filter((row) => row.needId === textNeed.body.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].answer, 'часть\nсуммы');
  assert.equal(rows[1].answer, 'вся сумма и ***');
  assert.equal(rows[0].what, 'Сколько заложить');
  assert.equal(rows[0].fromAgentId, 'finance');
  assert.equal(rows[0].source, 'сайт');
  assert.match(rows[0].atMsk, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} МСК$/);
  assert.equal(rows[0].needId, textNeed.body.id);
  const yesRow = owner.body.decisions.find((row) => row.needId === yes.body.id);
  assert.equal(yesRow.answer, 'Да');
  assert.equal(yesRow.what, 'Одобрить поставку | срочно');
  assert.equal(yesRow.fromAgentId, 'blog');
  assert.equal(owner.body.decisions.some((row) => row.needId === secretNeed.body.id), false);
  assert.equal(owner.body.decisions.some((row) => row.needId === testNeed.body.id), false);
  assert.equal(owner.body.decisions.some((row) => row.needId === 'need-test-qa' || row.needId === 'need-test-question'), false);
  const raw = JSON.stringify(owner.body);
  assert.equal(raw.includes(secretText), false);
  assert.equal(raw.includes('pw-test'), false);
  assert.equal(raw.includes('tok-test'), false);
  assert.equal(raw.includes('hook-key'), false);

  const bearer = await json('/api/decisions', { headers: { authorization: 'Bearer tok-test' } });
  assert.equal(bearer.status, 200);
  assert.equal((await json('/api/decisions', { headers: h })).status, 200);

  const mdRes = await fetch(base + '/api/decisions.md', { headers: h });
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get('content-type') || '', /markdown/);
  const md = await mdRes.text();
  const lines = md.split('\n').filter((line) => line.startsWith('- '));
  const partialLine = lines.find((line) => line.includes('часть суммы'));
  const fullLine = lines.find((line) => line.includes('вся сумма'));
  assert.match(partialLine, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} МСК \| сайт \| Сколько заложить \| часть суммы$/);
  assert.match(fullLine, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} МСК \| сайт \| Сколько заложить \| вся сумма и \*\*\*$/);
  assert.match(md, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} МСК \| сайт \| Одобрить поставку \/ срочно \| Да$/m);
  assert.ok(lines.indexOf(partialLine) < lines.indexOf(fullLine));
  assert.equal(md.includes(secretText), false);
  assert.equal(md.includes('hook-key'), false);
  assert.equal(md.includes('pw-test'), false);
  assert.equal(md.includes('need-test-qa'), false);
  assert.equal(md.includes('тестовый ответ не в журнал'), false);
  assert.equal(md.includes('Пришли ключ'), false);
});

test('в production закрытый тестовый пункт остаётся закрытым', async () => {
  const { spawn } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const script = `
    const office = require('./server.js');
    const closedAt = '2020-01-01T00:00:00.000Z';
    for (const id of ['need-test-qa', 'need-test-question']) {
      const item = office.state.needs.find((n) => n.id === id);
      item.closedAt = closedAt;
      item.closedBy = 'owner-answer';
      item.answer = id === 'need-test-qa' ? 'yes' : null;
      item.answers = [{ text: id === 'need-test-qa' ? 'Да' : 'прошлый ответ', at: closedAt, by: 'owner' }];
    }
    const forced = office.reopenTestNeeds(Date.now(), true);
    office.migrateOwnerNeeds();
    const after = office.state.needs.filter((n) => n.id === 'need-test-qa' || n.id === 'need-test-question');
    process.stdout.write(JSON.stringify({
      forced,
      timer: office.testReopenTimer == null,
      rows: after.map((n) => ({ id: n.id, closedAt: n.closedAt, answers: n.answers.length })),
    }));
    process.exit(0);
  `;
  function run(extra) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], {
        cwd: root,
        env: {
          NODE_ENV: 'production',
          TEST_NEEDS_AUTOREOPEN: '',
          DATABASE_URL: '',
          APP_PASSWORD: 'pw-test',
          AGENT_TOKEN: 'tok-test',
          PORYADOK_INGEST_TOKEN: '',
          ...extra,
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`код ${code}\n${out}\n${err}`));
          return;
        }
        const line = out.trim().split('\n').filter((row) => row.startsWith('{')).pop();
        resolve(JSON.parse(line));
      });
    });
  }
  const closed = await run();
  assert.equal(closed.forced, 0);
  assert.equal(closed.timer, true);
  assert.equal(closed.rows.length, 2);
  for (const row of closed.rows) {
    assert.equal(row.closedAt, '2020-01-01T00:00:00.000Z', row.id);
    assert.equal(row.answers, 1, row.id);
  }
  const onRender = await run({ NODE_ENV: 'development', RENDER: 'true' });
  assert.equal(onRender.forced, 0);
  assert.equal(onRender.timer, true);
  for (const row of onRender.rows) {
    assert.equal(row.closedAt, '2020-01-01T00:00:00.000Z', row.id);
    assert.equal(row.answers, 1, row.id);
  }
  const opened = await run({ TEST_NEEDS_AUTOREOPEN: '1' });
  assert.ok(opened.forced >= 1);
  assert.equal(opened.rows.every((row) => row.closedAt == null && row.answers === 0), true);
});
