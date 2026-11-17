'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-dash-'));
process.env.APP_PASSWORD = 'pw-dash';
process.env.AGENT_TOKEN = 'tok-dash';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';

const { app, dashboards } = require('../server.js');
const { SCHEMA_SQL } = require('../lib/dashboards');

let server;
let base;

before(async () => {
  await dashboards.ready();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
});

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), text: '' }));

const token = { 'x-agent-token': 'tok-dash' };

function sample(extra = {}) {
  return {
    title: 'Сводка',
    blocks: [
      { type: 'kpi', label: 'Выполнено', value: 12, unit: 'задач', target: 15, delta: 2, trend: 'up' },
      { type: 'chart', title: 'По дням', kind: 'line', labels: ['Пн', 'Вт'], series: [{ name: 'Закрыто', data: [1, 3] }] },
      { type: 'forecast', label: 'Срок', value: 'пятница', horizon: '5 дней', confidence: 0.7 },
      { type: 'markdown', text: '## Статус\nВсё **в графике**.' },
      { type: 'links', items: [{ label: 'Доска', url: 'https://example.com/board' }] },
    ],
    ...extra,
  };
}

test('без DATABASE_URL дашборды остаются в памяти, таблица описана', () => {
  assert.equal(dashboards.mode(), 'memory');
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS agent_dashboards/);
  assert.match(SCHEMA_SQL, /agent_id text NOT NULL/);
  assert.match(SCHEMA_SQL, /payload jsonb NOT NULL/);
  assert.match(SCHEMA_SQL, /created_at timestamptz/);
  assert.match(SCHEMA_SQL, /id serial PRIMARY KEY/);
});

test('POST /api/agents/:id/dashboard требует токен и известного агента', async () => {
  assert.equal((await json('/api/agents/army/dashboard', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await json('/api/agents/army/dashboard', {
    method: 'POST', headers: { 'x-agent-token': 'nope' }, body: '{}',
  })).status, 401);
  const missing = await json('/api/agents/nope/dashboard', {
    method: 'POST', headers: token, body: JSON.stringify(sample()),
  });
  assert.equal(missing.status, 404);
});

test('кривое тело дашборда — понятный 400', async () => {
  const post = (body) => json('/api/agents/army/dashboard', { method: 'POST', headers: token, body });
  assert.equal((await post('')).status, 400);
  assert.match((await post('{')).body.error, /JSON/);
  assert.match((await post('[]')).body.error, /объект/);
  assert.match((await post('{}')).body.error, /blocks/);
  assert.match((await post(JSON.stringify({ blocks: [{ type: 'table' }] }))).body.error, /type/);
  assert.match((await post(JSON.stringify({ blocks: [{ type: 'kpi', label: 'A', value: 1, trend: 'sideways' }] }))).body.error, /trend/);
  assert.match((await post(JSON.stringify({
    blocks: [{ type: 'forecast', label: 'A', value: 1, horizon: 'день', confidence: 1.2 }],
  }))).body.error, /confidence/);
  assert.match((await post(JSON.stringify({
    blocks: [{ type: 'links', items: [{ label: 'x', url: 'javascript:alert(1)' }] }],
  }))).body.error, /http или https/);
  assert.match((await post(JSON.stringify({
    blocks: [{ type: 'chart', title: 'A', kind: 'pie', labels: ['a'], series: [{ name: 's', data: [1] }] }],
  }))).body.error, /line или bar/);
  assert.match((await post(JSON.stringify({
    blocks: [{ type: 'chart', title: 'A', kind: 'bar', labels: ['a', 'b'], series: [{ name: 's', data: [1] }] }],
  }))).body.error, /той же длины/);
  const edge = await post(JSON.stringify({
    blocks: [{ type: 'forecast', label: 'Край', value: 0, horizon: 'сейчас', confidence: 0 }],
  }));
  assert.equal(edge.status, 201);
  const top = await post(JSON.stringify({
    blocks: [{ type: 'forecast', label: 'Край', value: 1, horizon: 'сейчас', confidence: 1 }],
  }));
  assert.equal(top.status, 201);
});

test('тело больше 200 КБ отклоняется', async () => {
  const pad = 'x'.repeat(210 * 1024);
  const res = await json('/api/agents/army/dashboard', {
    method: 'POST',
    headers: token,
    body: JSON.stringify({ blocks: [], pad }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /200 КБ/);
});

test('публикация пишет версию, историю и updatedAt в state', async () => {
  const first = await json('/api/agents/poker/dashboard', {
    method: 'POST', headers: token, body: JSON.stringify(sample()),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.versions, 1);
  assert.equal(first.body.dashboard.title, 'Сводка');
  assert.equal(first.body.dashboard.blocks[0].type, 'kpi');
  assert.ok(first.body.updatedAt);
  assert.equal((await json('/api/agents/poker/dashboard')).status, 200);

  const secondBody = sample({ title: 'Сводка 2' });
  delete secondBody.updatedAt;
  const second = await json('/api/agents/poker/dashboard', {
    method: 'POST', headers: token, body: JSON.stringify(secondBody),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.versions, 2);
  assert.notEqual(second.body.updatedAt, first.body.updatedAt);

  const current = await json('/api/agents/poker/dashboard');
  assert.equal(current.status, 200);
  assert.equal(current.body.versions, 2);
  assert.equal(current.body.updatedAt, second.body.updatedAt);
  assert.equal(current.body.dashboard.title, 'Сводка 2');
  assert.equal(current.body.dashboard.blocks[3].type, 'markdown');

  const history = await json('/api/agents/poker/dashboard/history');
  assert.equal(history.status, 200);
  assert.equal(history.body.versions.length, 2);
  assert.equal(history.body.versions[0].version, 2);
  assert.equal(history.body.versions[0].dashboard.title, 'Сводка 2');
  assert.equal(history.body.versions[1].version, 1);
  assert.equal(history.body.versions[1].dashboard.title, 'Сводка');

  const state = await json('/api/state');
  const poker = state.body.agents.find((a) => a.id === 'poker');
  assert.equal(poker.dashboardUpdatedAt, second.body.updatedAt);
  const army = state.body.agents.find((a) => a.id === 'biz');
  assert.equal(army.dashboardUpdatedAt, null);

  const empty = await json('/api/agents/biz/dashboard');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.versions, 0);
  assert.equal(empty.body.dashboard, null);
  assert.equal((await json('/api/agents/biz/dashboard/history')).body.versions.length, 0);
});
