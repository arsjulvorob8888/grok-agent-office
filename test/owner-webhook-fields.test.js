'use strict';

// Вебхук приказа и прямого сообщения: ownerText, sentAtMsk, taskTitle. Пинг не трогаем.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = null; }
    hits.push(parsed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let office;
let server;
let base;
let hookOrigin;

function clockMsk(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const pick = (type) => (parts.find((part) => part.type === type) || {}).value || '00';
  let hour = pick('hour');
  if (hour === '24') hour = '00';
  return `${hour}:${pick('minute')}`;
}

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const port = hook.address().port;
  hookOrigin = `http://127.0.0.1:${port}`;
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-hook-fields-'));
  process.env.APP_PASSWORD = 'pw-hook-fields';
  process.env.AGENT_TOKEN = 'tok-hook-fields';
  process.env.PUBLIC_URL = 'http://127.0.0.1';
  process.env.KREMLIN_WEBHOOK_URL = `${hookOrigin}/hook`;
  process.env.KREMLIN_WEBHOOK_KEY = 'hook-fields-key';
  process.env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  delete process.env.DATABASE_URL;
  delete process.env.PORYADOK_INGEST_TOKEN;
  office = require('../server.js');
  server = await new Promise((resolve) => {
    const handle = office.app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${handle.address().port}`;
      resolve(handle);
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => hook.close(resolve));
});

test('тело вебхука приказа содержит ownerText, sentAtMsk и taskTitle', async () => {
  const text = 'Владелец просит собрать сводку по всем направлениям и прислать её сегодня вечером без сокращений';
  const res = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-hook-fields' },
    body: JSON.stringify({ agent: 'dev', text, fromAgentId: 'owner' }),
  });
  const created = await res.json();
  assert.equal(res.status, 201);
  const started = Date.now();
  while (!hits.some((item) => item && item.taskId === created.id) && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const body = hits.find((item) => item && item.taskId === created.id);
  assert.ok(body, 'вебхук не пришёл');
  assert.equal(body.type, 'owner_task');
  assert.equal(body.text, text);
  assert.equal(body.ownerText, text);
  assert.equal(body.taskId, created.id);
  assert.match(body.atMsk, /МСК/);
  assert.match(body.sentAtMsk, /^\d{2}:\d{2}$/);
  assert.equal(body.sentAtMsk, clockMsk(body.at));
  assert.ok(body.taskTitle.length <= 80, body.taskTitle);
  assert.ok(body.taskTitle.endsWith('…'), body.taskTitle);
  assert.ok(text.startsWith(body.taskTitle.slice(0, 20)), body.taskTitle);
  assert.equal(body.taskTitle.includes(created.id), false);
});

async function waitHit(pred) {
  const started = Date.now();
  while (!hits.some(pred) && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return hits.find(pred) || null;
}

test('«тест» владельца уходит дословно, автопинг остаётся ping без ownerText', async () => {
  const probe = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-hook-fields' },
    body: JSON.stringify({ agent: 'qa', text: 'тест', fromAgentId: 'owner' }),
  });
  const created = await probe.json();
  assert.equal(probe.status, 201, JSON.stringify(created));
  const body = await waitHit((item) => item && item.taskId === created.id);
  assert.ok(body, 'вебхук пробного сообщения не пришёл');
  assert.equal(body.ownerText, 'тест');
  assert.equal(body.text, 'тест');
  assert.notEqual(body.type, 'ping');
  assert.match(body.sentAtMsk, /^\d{2}:\d{2}$/);
  assert.equal(body.taskTitle, 'тест');

  const written = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-hook-fields' },
    body: JSON.stringify({ agent: 'qa', text: 'проверка связи', fromAgentId: 'owner' }),
  });
  const linkTask = await written.json();
  assert.equal(written.status, 201, JSON.stringify(linkTask));
  const linkBody = await waitHit((item) => item && item.taskId === linkTask.id);
  assert.ok(linkBody, 'вебхук «проверка связи» не пришёл');
  assert.equal(linkBody.ownerText, 'проверка связи');
  assert.notEqual(linkBody.type, 'ping');
  assert.match(linkBody.sentAtMsk, /^\d{2}:\d{2}$/);
  assert.equal(linkBody.taskTitle, 'проверка связи');

  const saved = await fetch(`${base}/api/agents/army/delivery`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-hook-fields' },
    body: JSON.stringify({ url: `${hookOrigin}/auto-ping`, key: 'hook-fields-key' }),
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  const ping = await waitHit((item) => item && item.type === 'ping' && item.agentId === 'army');
  assert.ok(ping, 'автопинг не пришёл');
  assert.equal(ping.type, 'ping');
  assert.equal(Object.prototype.hasOwnProperty.call(ping, 'ownerText'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ping, 'sentAtMsk'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ping, 'taskTitle'), false);
});
