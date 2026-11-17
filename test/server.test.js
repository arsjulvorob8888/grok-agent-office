'use strict';

// Тесты API: node --test  (Node 18+). Переменные окружения задаются до require.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
let office;

before(async () => {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-uploads-'));
  process.env.APP_PASSWORD = 'pw-test';
  process.env.AGENT_TOKEN = 'tok-test';
  process.env.GROK_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.GROK_WEBHOOK_KEY = 'hook-key';
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
  for (const id of ['grok', 'army', 'poker', 'trading', 'devops', 'dev', 'qa', 'temshik', 'blog', 'finance', 'invest', 'analyst']) {
    assert.ok(ids.includes(id), `нет агента ${id}`);
  }
  const grok = body.agents.find((a) => a.id === 'grok');
  assert.equal(grok.kind, 'putin');
  assert.equal(grok.tier, 'main');
  assert.equal(grok.number, '1');
  assert.equal(grok.archived, false);
  assert.ok(!grok.links.includes('trading') && !grok.links.includes('biz'));
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
    lang: '10',
  };
  for (const [id, number] of Object.entries(numbers)) {
    const agent = body.agents.find((a) => a.id === id);
    assert.equal(agent.number, number, id);
    assert.equal(agent.archived, false, id);
  }
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
  for (const id of ['trading', 'biz']) {
    const archived = body.agents.find((a) => a.id === id);
    assert.equal(archived.archived, true, id);
    assert.equal(archived.number, '');
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
  assert.equal(r.body.status, 'отправлена');
  assert.equal(r.body.forwardStatus, 200);
  const hit = received.find((x) => x.body && x.body.taskId === r.body.id);
  assert.ok(hit);
  assert.equal(hit.headers.authorization, 'Bearer hook-key');
  assert.equal(hit.headers['x-webhook-key'], 'hook-key');
  assert.deepEqual(hit.body, {
    agent: 'army',
    text: 'Сделай дашборд по личному составу',
    taskId: r.body.id,
    messageId: `task:${r.body.id}`,
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
  assert.equal(a.number, '11');
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
  assert.match(hit.body.text, /Посмотри скриншот/);
  assert.match(hit.body.text, new RegExp(`https://example\\.test/api/files/${att.id}`));
  assert.equal(hit.body.attachments[0].url, `https://example.test/api/files/${att.id}`);

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
    body: JSON.stringify({ agent: 'lang', text: 'Сводка по сделкам' }),
  });
  const h = { 'x-agent-token': 'tok-test' };
  const body = { agent: 'lang', status: 'idle', now: 'Жду задач', taskId: t.body.id, result: 'Три сделки в плюсе' };
  await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  await json('/api/status', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const echoed = await json('/api/messages', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ id: `result:${t.body.id}`, agentId: 'lang', role: 'agent', text: 'другой итог', taskId: t.body.id }),
  });
  assert.equal(echoed.body.duplicate, true);
  assert.equal(echoed.body.message.text, 'Три сделки в плюсе');
  const st = await json('/api/state');
  const replies = st.body.messages.filter((m) => m.agentId === 'lang' && m.role === 'agent' && m.taskId === t.body.id);
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
  assert.equal(dev.body.status, 'отправлена');
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
  assert.equal(progress.body.task.status, 'отправлена');
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
  assert.equal(open.body.needs.length, 3);
  assert.equal(open.body.needs.find((n) => n.id === 'need-render-api'), undefined);
  const academy = open.body.needs.find((n) => n.id === 'need-academy');
  const social = open.body.needs.find((n) => n.id === 'need-social');
  const finance = open.body.needs.find((n) => n.id === 'need-finance');
  assert.equal(academy.fromAgentId, 'grok');
  assert.equal(academy.urgency, 'normal');
  assert.equal(academy.stale, false);
  assert.equal(academy.what, 'Одобрить Академию агентов: нажать «Да» в чатах Программирования, Тестировщика и Business Adviser');
  assert.equal(academy.where, 'Чаты агентов в Grok');
  assert.ok(academy.checkedAt);
  assert.match(social.what, /Instagram и YouTube/);
  assert.equal(finance.fromAgentId, 'finance');
  assert.equal(finance.urgency, 'normal');
  assert.match(finance.what, /шесть финансовых вопросов/);

  const st = await json('/api/state');
  const socialAgent = st.body.agents.find((a) => /соцсет/i.test(`${a.name} ${a.id}`));
  assert.equal(social.fromAgentId, socialAgent ? socialAgent.id : 'grok');
  assert.equal(st.body.needs.filter((n) => n.id === 'need-render-api').length, 0);
  assert.equal(st.body.needs.filter((n) => ['need-academy', 'need-social', 'need-finance'].includes(n.id)).length, 3);
  assert.equal(st.body.needs.filter((n) => n.id === 'need-academy').length, 1);
  const raw = JSON.stringify(st.body);
  assert.ok(!raw.includes('pw-test') && !raw.includes('tok-test') && !raw.includes('hook-key'));

  assert.equal((await json('/api/needs', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await json('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'wrong' },
    body: '{}',
  })).status, 401);
  assert.equal((await json('/api/needs', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ what: 'x', where: 'y', fromAgentId: 'grok', urgency: 'low' }),
  })).status, 401);
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

  const created = await json('/api/needs', {
    method: 'POST', headers: h,
    body: JSON.stringify({ what: 'Подтвердить черновик', where: 'Чат Темщика', fromAgentId: 'temshik', urgency: 'low' }),
  });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^n-\d+$/);
  assert.equal(created.body.urgency, 'low');
  assert.equal(created.body.fromAgentId, 'temshik');
  assert.equal(created.body.closedAt, null);
  assert.equal(created.body.where, 'Чат Темщика');

  const listed = await json('/api/state');
  assert.ok(listed.body.needs.some((n) => n.id === created.body.id));

  const closed = await json(`/api/needs/${created.body.id}/close`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(closed.status, 200);
  assert.ok(closed.body.closedAt);
  const again = await json(`/api/needs/${created.body.id}/close`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(again.status, 200);
  assert.equal(again.body.closedAt, closed.body.closedAt);

  const after = await json('/api/needs');
  assert.equal(after.body.needs.length, 3);
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

test('текст академии мигрирует на месте и не дублируется', () => {
  const { state, migrateOwnerNeeds, ACADEMY_WHAT, ACADEMY_WHERE } = require('../server.js');
  const item = state.needs.find((n) => n.id === 'need-academy');
  assert.ok(item);
  item.what = 'Одобрить «Академию агентов»';
  item.where = 'Чат главного агента';
  migrateOwnerNeeds();
  migrateOwnerNeeds();
  const all = state.needs.filter((n) => n.id === 'need-academy');
  assert.equal(all.length, 1);
  assert.equal(all[0], item);
  assert.equal(all[0].what, ACADEMY_WHAT);
  assert.equal(all[0].where, ACADEMY_WHERE);
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
  const id = 'need-academy';
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
  for (const agent of ['trading', 'biz']) {
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

  const need = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Архивный вопрос советника', where: 'Сколково', fromAgentId: 'biz', urgency: 'low' }),
  });
  assert.equal(need.status, 201);
  const needs = await json('/api/needs');
  assert.ok(needs.body.needs.some((n) => n.id === need.body.id && n.fromAgentId === 'biz'));
});
