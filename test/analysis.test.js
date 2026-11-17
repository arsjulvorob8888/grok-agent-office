'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-analysis-'));
process.env.APP_PASSWORD = 'pw-an';
process.env.AGENT_TOKEN = 'tok-an';
process.env.GROK_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';

const { app } = require('../server.js');

let server;
let base;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server && server.close(); });

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), text: '' }));

test('анализ: токен, пароль, длина и архив', async () => {
  assert.equal((await json('/api/agents/army/analysis', { method: 'PUT', body: '{"text":"x"}' })).status, 401);
  const empty = await json('/api/agents/army/analysis', {
    method: 'PUT', headers: { 'x-agent-token': 'tok-an' }, body: '{"text":"  "}',
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /text/);
  const long = await json('/api/agents/army/analysis', {
    method: 'PUT',
    headers: { 'x-agent-token': 'tok-an' },
    body: JSON.stringify({ text: 'a'.repeat(4001) }),
  });
  assert.equal(long.status, 400);

  const saved = await json('/api/agents/army/analysis', {
    method: 'PUT',
    headers: { 'x-agent-token': 'tok-an' },
    body: JSON.stringify({ text: 'Неделя <script>alert(1)</script> в графике' }),
  });
  assert.equal(saved.status, 200);
  assert.match(saved.body.text, /<script>/);
  assert.ok(saved.body.updatedAt);

  const pub = await json('/api/agents/army/analysis');
  assert.equal(pub.status, 200);
  assert.match(pub.body.text, /<script>/);

  const byPassword = await json('/api/agents/poker/analysis', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-an' },
    body: JSON.stringify({ text: 'Смотрю сессии', updatedAt: '2026-11-17T12:00:00.000Z' }),
  });
  assert.equal(byPassword.status, 200);
  assert.equal(byPassword.body.updatedAt, '2026-11-17T12:00:00.000Z');

  assert.equal((await json('/api/agents/trading/analysis', {
    method: 'PUT', headers: { 'x-agent-token': 'tok-an' }, body: '{"text":"нет"}',
  })).status, 404);
  assert.equal((await json('/api/agents/nope/analysis')).status, 404);
});

test('финансы отдают анализ только с паролем штаба', async () => {
  const saved = await json('/api/agents/finance/analysis', {
    method: 'PUT',
    headers: { 'x-agent-token': 'tok-an' },
    body: JSON.stringify({ text: 'Доля закрытых задач выросла. Сумм нет.' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await json('/api/agents/finance/analysis')).status, 401);
  assert.equal((await json('/api/agents/invest/analysis')).status, 401);
  const opened = await json('/api/agents/finance/analysis', { headers: { 'x-app-password': 'pw-an' } });
  assert.equal(opened.status, 200);
  assert.match(opened.body.text, /Доля закрытых/);
  assert.doesNotMatch(opened.body.text, /₽|\bруб/);
});

test('страница /agent/:id и заглушка архива', async () => {
  const live = await fetch(base + '/agent/army');
  assert.equal(live.status, 200);
  assert.match(await live.text(), /<html lang="ru"/);
  const archived = await fetch(base + '/agent/trading');
  assert.equal(archived.status, 404);
  assert.match(await archived.text(), /Агент в архиве/);
  const biz = await fetch(base + '/agent/biz');
  assert.equal(biz.status, 404);
  assert.match(await biz.text(), /Агент в архиве/);
  const missing = await fetch(base + '/agent/no-such');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Агент не найден/);
});
