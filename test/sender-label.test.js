'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sender = require('../public/js/sender-label');

let base;
let server;

before(async () => {
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-sender-'));
  process.env.APP_PASSWORD = 'pw-sender';
  process.env.AGENT_TOKEN = 'tok-sender';
  delete process.env.DATABASE_URL;
  delete process.env.KREMLIN_WEBHOOK_URL;
  delete process.env.KREMLIN_WEBHOOK_KEY;
  delete process.env.GROK_WEBHOOK_URL;
  delete process.env.GROK_WEBHOOK_KEY;
  delete process.env.PORYADOK_INGEST_TOKEN;
  const { app } = require('../server.js');
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

async function json(urlPath, opts = {}) {
  const res = await fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('задача от владельца подписывается «Путин → …», fromAgentId остаётся owner', async () => {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-sender' },
    body: JSON.stringify({ agent: 'dev', text: 'Сводка для подписи', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.fromAgentId, 'owner');
  const state = await json('/api/state');
  const line = (state.body.messages || []).find((m) => m.taskId === created.body.id && m.role === 'system' && String(m.text).startsWith('Приказ:'));
  assert.ok(line, 'нет системной строки приказа');
  assert.equal(line.text, 'Приказ: Путин → Программирование');
});

test('уже сохранённая подпись «Владелец → …» показывается как «Путин → …»', () => {
  assert.equal(Sender.senderName('owner'), 'Путин');
  assert.equal(Sender.senderName(''), 'Путин');
  assert.equal(Sender.senderName(null), 'Путин');
  assert.equal(Sender.senderName('dev'), '');
  assert.equal(Sender.displayOrderSender('Приказ: Владелец → Программирование'), 'Приказ: Путин → Программирование');
  assert.equal(Sender.displayOrderSender('Принял заказ · Владелец ждёт'), 'Принял заказ · Владелец ждёт');
});

test('принятый заказ возвращает «Принял заказ · Владелец ждёт»', async () => {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-sender' },
    body: JSON.stringify({ agent: 'dev', text: 'Нейтральная проверка принятия', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.fromAgentId, 'owner');

  const accepted = await json(`/api/orders/${created.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-sender' },
    body: JSON.stringify({ status: 'accepted', note: 'Владелец ждёт' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.task.orderStatus, 'accepted');
  assert.equal(accepted.body.task.fromAgentId, 'owner');
  assert.equal(accepted.body.task.note, 'Владелец ждёт');

  const state = await json('/api/state');
  const messages = (state.body.messages || []).filter((item) => item.taskId === created.body.id && item.role === 'system');
  const orderLine = messages.find((item) => String(item.text).startsWith('Приказ:'));
  const acceptedLine = messages.find((item) => String(item.text).startsWith('Принял заказ'));
  assert.ok(orderLine, 'нет системной строки приказа');
  assert.ok(acceptedLine, 'нет системной строки принятия');
  assert.equal(orderLine.text, 'Приказ: Путин → Программирование');
  assert.equal(acceptedLine.text, 'Принял заказ · Владелец ждёт');
  assert.equal(Sender.displayOrderSender(acceptedLine.text), 'Принял заказ · Владелец ждёт');

  const dash = await json('/api/agents/dev/dashboard');
  assert.equal(dash.status, 200);
  const shownOrder = (dash.body.messages || []).find((item) => item.taskId === created.body.id && String(item.text).startsWith('Приказ:'));
  const shownAccepted = (dash.body.messages || []).find((item) => item.taskId === created.body.id && String(item.text).startsWith('Принял заказ'));
  assert.ok(shownOrder);
  assert.ok(shownAccepted);
  assert.equal(shownOrder.text, 'Приказ: Путин → Программирование');
  assert.equal(shownAccepted.text, 'Принял заказ · Владелец ждёт');
  const task = (dash.body.tasks || []).find((item) => item.id === created.body.id);
  assert.equal(task.orderStatus, 'accepted');
  assert.equal(task.note, 'Владелец ждёт');
  assert.equal(task.fromAgentId, 'owner');
});

test('имя отправителя задано одной функцией', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['public/js/app.js', 'public/js/processes.js', 'server.js']) {
    const src = read(file);
    assert.equal(src.includes("'Владелец'"), false, file);
    assert.match(src, /senderName\(/, file);
  }
  assert.match(read('public/js/app.js'), /displayOrderSender\(/);
  assert.match(read('public/index.html'), /\/js\/sender-label\.js/);
});
