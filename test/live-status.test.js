'use strict';

// Живой статус агента, TTL, лимит и поток событий.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activityFor } = require('../lib/activity');

let live = null;
try {
  live = require('../lib/live-status');
} catch (_) {
  live = null;
}
let stream = null;
try {
  stream = require('../lib/stream');
} catch (_) {
  stream = null;
}

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-live-'));
process.env.APP_PASSWORD = 'pw-live';
process.env.AGENT_TOKEN = 'tok-live';
process.env.AGENT_STATUS_TOKEN = 'status-live';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.PORYADOK_INGEST_TOKEN;
delete process.env.ACTIVITY_WINDOW_MIN;

const { app } = require('../server.js');

let base;
let server;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (live && live.setNow) live.setNow(null);
  if (server) await new Promise((resolve) => server.close(resolve));
});

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (r) => ({
    status: r.status,
    headers: r.headers,
    body: await r.json().catch(() => null),
  }));

function agentOf(body, id) {
  return body.agents.find((a) => a.id === id);
}

function postStatus(body, headers = {}) {
  return json('/api/agent-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer status-live', ...headers },
    body: JSON.stringify(body),
  });
}

function liveMessages(agentId) {
  const { state } = require('../server.js');
  return state.messages.filter((m) => m.agentId === agentId && m.source === 'live');
}

test('модуль живого статуса подключается', () => {
  assert.ok(live && typeof live.setNow === 'function', 'нет lib/live-status.js');
  assert.ok(stream && stream.KEEPALIVE_MS === 25000, 'keepalive потока должен быть 25 секунд');
  assert.equal(stream.MAX_CLIENTS, 40);
});

test('activityFor: живой working, doing и истечение по часам', () => {
  const t0 = Date.parse('2031-04-01T00:00:00.000Z');
  const agent = {
    id: 'dev',
    status: 'idle',
    now: 'Жду задач',
    live: {
      status: 'working',
      doing: 'Пишу тесты',
      since: new Date(t0).toISOString(),
      until: new Date(t0 + 10 * 60 * 1000).toISOString(),
    },
  };
  const orders = [{ id: 't-1', agentId: 'dev', orderStatus: 'accepted', text: 'Старый приказ', createdAt: new Date(t0).toISOString() }];
  const fresh = activityFor(agent, orders, t0, 30 * 60 * 1000);
  assert.equal(fresh.activity, 'working');
  assert.equal(fresh.doing, 'Пишу тесты');
  assert.equal(fresh.currentTask, 'Пишу тесты');
  assert.equal(fresh.doingSince, agent.live.since);

  const edge = activityFor(agent, [], t0 + 10 * 60 * 1000 - 1, 30 * 60 * 1000);
  assert.equal(edge.activity, 'working');
  assert.equal(edge.doing, 'Пишу тесты');

  const expired = activityFor(agent, [], t0 + 10 * 60 * 1000, 30 * 60 * 1000);
  assert.equal(expired.activity, 'resting');
  assert.equal(expired.doing, null);
  assert.equal(expired.doingSince, null);
  assert.equal(expired.currentTask, null);

  const archived = activityFor({ ...agent, archived: true }, orders, t0, 30 * 60 * 1000);
  assert.equal(archived.activity, 'resting');
  assert.equal(archived.currentTask, null);
});

test('без токена, с чужим и со старым AGENT_TOKEN живой статус закрыт', async () => {
  const missing = await json('/api/agent-status', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'dev', status: 'working' }),
  });
  assert.equal(missing.status, 401);

  const bearerAgent = await postStatus(
    { agentId: 'dev', status: 'working' },
    { Authorization: 'Bearer tok-live' },
  );
  assert.equal(bearerAgent.status, 401);

  const headerAgent = await json('/api/agent-status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-live' },
    body: JSON.stringify({ agentId: 'dev', status: 'working' }),
  });
  assert.equal(headerAgent.status, 401);

  const password = await postStatus(
    { agentId: 'dev', status: 'working' },
    { Authorization: 'Bearer pw-live' },
  );
  assert.equal(password.status, 401);

  const previous = process.env.AGENT_STATUS_TOKEN;
  delete process.env.AGENT_STATUS_TOKEN;
  try {
    const unconfigured = await postStatus({ agentId: 'dev', status: 'working' });
    assert.equal(unconfigured.status, 503);
    assert.match(unconfigured.body.error, /AGENT_STATUS_TOKEN/);
  } finally {
    process.env.AGENT_STATUS_TOKEN = previous;
  }

  const state = await json('/api/state');
  assert.equal(agentOf(state.body, 'dev').activity, 'resting');
  assert.equal(JSON.stringify(state.body).includes('status-live'), false);
  assert.equal(JSON.stringify(state.body).includes('tok-live'), false);
});

test('имя «Программирование · Кремль» становится dev, лишние поля отбрасываются', async () => {
  const named = await postStatus({
    agentId: 'Программирование · Кремль',
    status: 'working',
    doing: '  Пишу модуль  ',
    now: 'НЕ-ДОЛЖНО',
    secret: 'status-live',
    agent: 'grok',
  });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.deepEqual(Object.keys(named.body).sort(), ['activity', 'doing', 'forAgent', 'id', 'ok', 'since', 'status', 'until']);
  assert.equal(named.body.ok, true);
  assert.equal(named.body.id, 'dev');
  assert.equal(named.body.status, 'working');
  assert.equal(named.body.activity, 'working');
  assert.equal(named.body.doing, 'Пишу модуль');
  assert.equal(JSON.stringify(named.body).includes('НЕ-ДОЛЖНО'), false);
  assert.equal(JSON.stringify(named.body).includes('secret'), false);

  const state = await json('/api/state');
  const dev = agentOf(state.body, 'dev');
  assert.equal(dev.activity, 'working');
  assert.equal(dev.doing, 'Пишу модуль');
  assert.equal(dev.currentTask, 'Пишу модуль');
  assert.equal(dev.now, 'Жду задач');
  assert.equal(JSON.stringify(state.body).includes('НЕ-ДОЛЖНО'), false);
  assert.ok(dev.doingSince);

  const plain = await postStatus({ agentId: 'программирование', status: 'working', doing: 'Всё ещё пишу' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.id, 'dev');
  assert.equal(plain.body.since, named.body.since, 'продление не сдвигает начало хода');

  const upper = await postStatus({ agentId: 'DEV', status: 'idle' });
  assert.equal(upper.status, 200);
  assert.equal(upper.body.id, 'dev');
  assert.equal(upper.body.status, 'idle');
  assert.equal(upper.body.doing, null);

  const unknown = await postStatus({ agentId: 'Нет такого · Кремль', status: 'working' });
  assert.equal(unknown.status, 404);

  const archived = await postStatus({ agentId: 'Language Coach', status: 'working', doing: 'архив' });
  assert.equal(archived.status, 409);
  assert.equal(archived.body.agentId, 'lang');
  assert.equal(archived.body.error, 'агент в архиве на карте — статус не принят');

  const noId = await postStatus({ agent: 'dev', status: 'working' });
  assert.equal(noId.status, 400);

  const html = await postStatus({ agentId: 'qa', status: 'working', doing: '<b>жир</b>' });
  assert.equal(html.status, 400);
  assert.match(html.body.error, /HTML/);

  const long = await postStatus({ agentId: 'qa', status: 'working', doing: 'я'.repeat(81) });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /80/);

  const notString = await postStatus({ agentId: 'qa', status: 'working', doing: 12 });
  assert.equal(notString.status, 400);

  const badStatus = await postStatus({ agentId: 'qa', status: 'waiting' });
  assert.equal(badStatus.status, 400);

  const qa = agentOf((await json('/api/state')).body, 'qa');
  assert.equal(qa.activity, 'resting');
  assert.equal(qa.doing, null);
});

test('переход пишется в ленту один раз, продление working молчит, idle снимает сразу', async () => {
  const first = await postStatus({ agentId: 'temshik', status: 'working', doing: 'Ищу тему' });
  assert.equal(first.status, 200);
  const afterFirst = liveMessages('temshik');
  assert.equal(afterFirst.length, 1);
  assert.match(afterFirst[0].text, /Темщик отметился: работает · Ищу тему/);
  assert.equal(afterFirst[0].role, 'system');

  const again = await postStatus({ agentId: 'temshik', status: 'working', doing: 'Уточняю тему' });
  assert.equal(again.status, 200);
  assert.equal(liveMessages('temshik').length, 1, 'продление working не пишет вторую строку');
  assert.equal(again.body.since, first.body.since);

  const idle = await postStatus({ agentId: 'temshik', status: 'idle' });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.activity, 'resting');
  assert.equal(idle.body.doing, null);
  const lines = liveMessages('temshik');
  assert.equal(lines.length, 2);
  assert.match(lines[1].text, /Темщик отметился: свободен/);

  const idleAgain = await postStatus({ agentId: 'temshik', status: 'idle' });
  assert.equal(idleAgain.status, 200);
  assert.equal(liveMessages('temshik').length, 2);

  const back = await postStatus({ agentId: 'temshik', status: 'working' });
  assert.equal(back.status, 200);
  assert.equal(liveMessages('temshik').length, 3);
  assert.match(liveMessages('temshik')[2].text, /Темщик отметился: работает$/);
});

test('TTL 15 минут: фейковые часы, продление working и пульсом, явный idle', async () => {
  assert.ok(live, 'нет lib/live-status.js');
  const t0 = Date.parse('2031-06-01T08:00:00.000Z');
  const hold = 15 * 60 * 1000;
  let clock = t0;
  live.setNow(() => clock);
  try {
    const started = await postStatus({ agentId: 'qa', status: 'working', doing: 'Считаю' });
    assert.equal(started.status, 200);
    assert.equal(started.body.until, new Date(t0 + hold).toISOString());

    clock = t0 + hold - 1;
    let view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.activity, 'working');
    assert.equal(view.doing, 'Считаю');

    clock = t0 + hold;
    view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.activity, 'resting');
    assert.equal(view.doing, null);
    assert.equal(liveMessages('qa').length, 1, 'истечение TTL ленту не пишет');

    clock = t0 + 60 * 60 * 1000;
    const second = await postStatus({ agentId: 'qa', status: 'working', doing: 'Считаю снова' });
    assert.equal(second.status, 200);
    clock = t0 + 60 * 60 * 1000 + 9 * 60 * 1000;
    const extended = await postStatus({ agentId: 'qa', status: 'working', doing: 'Ещё считаю' });
    assert.equal(extended.status, 200);
    assert.equal(extended.body.since, second.body.since);
    assert.equal(liveMessages('qa').length, 2);
    clock = t0 + 60 * 60 * 1000 + 23 * 60 * 1000;
    view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.activity, 'working');
    assert.equal(view.doing, 'Ещё считаю');
    clock = t0 + 60 * 60 * 1000 + 24 * 60 * 1000;
    view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.activity, 'resting');

    clock = t0 + 3 * 60 * 60 * 1000;
    await postStatus({ agentId: 'qa', status: 'working', doing: 'Держит линию' });
    const beforeBeat = liveMessages('qa').length;
    const beatAt = clock + 9 * 60 * 1000;
    clock = beatAt;
    const beat = await json('/api/agents/qa/heartbeat', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-live' },
      body: JSON.stringify({ note: 'на линии' }),
    });
    assert.equal(beat.status, 200);
    clock = beatAt + 60 * 1000;
    view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.doing, 'Держит линию', 'пульс продлевает живой working');
    assert.equal(liveMessages('qa').length, beforeBeat, 'пульс не пишет строку в ленту');
    clock = beatAt + 15 * 60 * 1000;
    process.env.ACTIVITY_WINDOW_MIN = '5';
    view = agentOf((await json('/api/state')).body, 'qa');
    assert.equal(view.doing, null);
    assert.equal(view.activity, 'resting');
    delete process.env.ACTIVITY_WINDOW_MIN;

    clock = t0 + 5 * 60 * 60 * 1000;
    await postStatus({ agentId: 'social', status: 'working', doing: 'Смотрю ленту' });
    clock += 1000;
    const stopped = await postStatus({ agentId: 'social', status: 'idle' });
    assert.equal(stopped.status, 200);
    view = agentOf((await json('/api/state')).body, 'social');
    assert.equal(view.activity, 'resting');
    assert.equal(view.doing, null);
  } finally {
    live.setNow(null);
    delete process.env.ACTIVITY_WINDOW_MIN;
  }
});

test('сообщение, приказ и пульс по старому токену тоже занятость', async () => {
  const note = await json('/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-live' },
    body: JSON.stringify({ id: 'analyst-note-1', agentId: 'analyst', role: 'agent', text: 'Смотрю отчёт' }),
  });
  assert.equal(note.status, 201);
  assert.equal(agentOf((await json('/api/state')).body, 'analyst').activity, 'working');

  const beat = await json('/api/agents/invest/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-live' },
    body: '{}',
  });
  assert.equal(beat.status, 200);
  assert.equal(agentOf((await json('/api/state')).body, 'invest').activity, 'working');

  const task = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-live' },
    body: JSON.stringify({ agent: 'routines', text: 'Проверить рутину', fromAgentId: 'grok' }),
  });
  assert.equal(task.status, 201);
  const moved = await json(`/api/orders/${task.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-live' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(moved.status, 200);
  assert.equal(agentOf((await json('/api/state')).body, 'routines').activity, 'resting');
  const { state } = require('../server.js');
  const row = state.tasks.find((item) => item.id === task.body.id);
  assert.equal(row.forwardStatus, null);
  row.forwardStatus = 200;
  assert.equal(agentOf((await json('/api/state')).body, 'routines').activity, 'working');
  assert.equal(row.status, 'в очереди агента');
});

test('живой статус не стирает стойкие поля агента и не пишет live в базу', async () => {
  const store = require('../lib/store');
  const { state } = require('../server.js');
  await store.ready;
  const dev = state.agents.find((agent) => agent.id === 'dev');
  dev.analysis = 'смотрит риски';
  dev.completed = 4;
  dev.status = 'idle';
  dev.now = 'Жду задач';
  dev.done = ['было'];
  const seen = dev.lastSeenAt || null;
  if (store.enabled()) {
    store.noteAgent(dev);
    await store.flush();
  }
  const posted = await postStatus({
    agentId: 'dev',
    status: 'working',
    doing: 'Только память',
    now: 'НЕ-ДОЛЖНО',
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(dev.completed, 4);
  assert.equal(dev.analysis, 'смотрит риски');
  assert.equal(dev.status, 'idle');
  assert.equal(dev.now, 'Жду задач');
  assert.deepEqual(dev.done, ['было']);
  assert.ok(dev.lastSeenAt);
  if (seen) assert.ok(Date.parse(dev.lastSeenAt) >= Date.parse(seen));
  const pub = agentOf((await json('/api/state')).body, 'dev');
  assert.equal(pub.completed, 4);
  assert.equal(pub.analysis, 'смотрит риски');
  assert.equal(pub.now, 'Жду задач');
  assert.equal(pub.activity, 'working');
  assert.equal(pub.doing, 'Только память');
  if (process.env.DATABASE_URL && store.enabled()) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const schema = `t_${process.pid}`;
      const row = await client.query(`SELECT payload FROM "${schema}".agent_state WHERE id = 'dev'`);
      assert.equal(row.rows.length, 1);
      const payload = row.rows[0].payload;
      assert.equal(payload.live, undefined);
      assert.equal(payload.completed, 4);
      assert.equal(payload.analysis, 'смотрит риски');
      assert.equal(payload.status, 'idle');
      assert.equal(payload.now, 'Жду задач');
      assert.equal(JSON.stringify(payload).includes('Только память'), false);
    } finally {
      await client.end();
    }
  }
  const idle = await postStatus({ agentId: 'dev', status: 'idle' });
  assert.equal(idle.status, 200);
});

test('не больше 30 принятых запросов агента в минуту', async () => {
  assert.ok(live, 'нет lib/live-status.js');
  live.resetForTests();
  const t0 = Date.parse('2032-01-01T00:00:00.000Z');
  let clock = t0;
  live.setNow(() => clock);
  try {
    for (let i = 0; i < 30; i += 1) {
      const ok = await postStatus({ agentId: 'army', status: 'working', doing: 'ход' });
      assert.equal(ok.status, 200, `запрос ${i + 1}`);
    }
    const blocked = await postStatus({ agentId: 'army', status: 'working', doing: 'лишний' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /часто/);
    assert.equal(blocked.headers.get('retry-after'), '60');

    const other = await postStatus({ agentId: 'poker', status: 'working', doing: 'другой агент' });
    assert.equal(other.status, 200, 'лимит не общий на всех');

    clock = t0 + 60 * 1000;
    const later = await postStatus({ agentId: 'army', status: 'idle' });
    assert.equal(later.status, 200);
  } finally {
    live.resetForTests();
    live.setNow(null);
  }
});

function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/stream`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      resolve({
        req,
        res,
        text: () => Buffer.concat(chunks).toString('utf8'),
      });
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('поток получает пустое событие после POST и не содержит приватных данных', async () => {
  const sse = await openSse();
  try {
    assert.equal(sse.res.statusCode, 200);
    assert.match(String(sse.res.headers['content-type'] || ''), /text\/event-stream/);
    assert.equal(sse.res.headers['cache-control'], 'no-cache');
    assert.equal(sse.res.headers['x-accel-buffering'], 'no');
    const opened = await waitFor(() => sse.text().includes(': stream') || sse.text().includes(': keepalive'));
    assert.equal(opened, true, sse.text());

    const posted = await postStatus({
      agentId: 'blog',
      status: 'working',
      doing: 'СЕКРЕТ-ДЕЛАЮ-XYZ',
    });
    assert.equal(posted.status, 200);
    const got = await waitFor(() => sse.text().includes('event: state') && sse.text().includes('data: {}'));
    assert.equal(got, true, sse.text());
    assert.equal(sse.text().includes('СЕКРЕТ-ДЕЛАЮ-XYZ'), false);
    assert.equal(sse.text().includes('status-live'), false);
    assert.equal(sse.text().includes('tok-live'), false);
  } finally {
    sse.req.destroy();
  }
});

test('лишнее подключение к потоку получает 503, закрытые места освобождаются', async () => {
  assert.ok(stream, 'нет lib/stream.js');
  const open = [];
  try {
    for (let i = 0; i < stream.MAX_CLIENTS; i += 1) open.push(await openSse());
    const extra = await json('/api/stream');
    assert.equal(extra.status, 503);
    assert.match(extra.body.error, /подписчик/);
  } finally {
    for (const item of open) item.req.destroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const again = await openSse();
  try {
    assert.equal(again.res.statusCode, 200);
  } finally {
    again.req.destroy();
  }
});

test('хаб пишет keepalive и отпускает подписчика при обрыве', async () => {
  assert.ok(stream, 'нет lib/stream.js');
  const hub = stream.createHub({ keepaliveMs: 30, maxClients: 2 });
  const chunks = [];
  let closed = false;
  const req = {
    on(event, fn) {
      if (event === 'close') req._close = fn;
    },
  };
  const res = {
    statusCode: 0,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    flushHeaders() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    on() {},
  };
  assert.equal(hub.attach(req, res), true);
  const seen = await waitFor(() => chunks.some((chunk) => chunk.includes(': keepalive')), 500);
  assert.equal(seen, true, chunks.join(''));
  req._close();
  closed = true;
  assert.equal(hub.clientCount(), 0);
  assert.equal(closed, true);
  hub.close();
});

test('forAgent putin будит Путина, координирование слабее своего working', async () => {
  const { state } = require('../server.js');
  const named = await postStatus({
    agentId: 'army',
    status: 'working',
    doing: 'Свожу отчёт',
    forAgent: 'putin',
  });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.forAgent, 'grok');
  let view = agentOf((await json('/api/state')).body, 'grok');
  assert.equal(view.activity, 'working');

  const alias = await postStatus({
    agentId: 'army',
    status: 'working',
    onBehalfOf: 'Путин · Кремль',
    doing: 'Свожу отчёт',
  });
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  assert.equal(alias.body.forAgent, 'grok');

  const unknown = await postStatus({ agentId: 'army', status: 'working', forAgent: 'никто-такой' });
  assert.equal(unknown.status, 400);

  const idle = await postStatus({ agentId: 'army', status: 'idle' });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.forAgent, null);

  const task = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-live' },
    body: JSON.stringify({ agent: 'army', text: 'Старый приказ Путина', fromAgentId: 'grok' }),
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const row = state.tasks.find((item) => item.id === task.body.id);
  if (row) row.forwardStatus = 200;
  const queued = (state.outbox || []).find((item) => item.taskId === task.body.id);
  if (queued) queued.status = 'delivered';
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const grok = state.agents.find((agent) => agent.id === 'grok');
  grok.live = null;
  grok.lastSeenAt = null;
  grok.lastStatusAt = null;
  grok.lastDashboardAt = null;
  grok.heartbeatNote = '';
  for (const item of state.tasks) {
    if (item.fromAgentId === 'grok' || item.agentId === 'grok' || item.agent === 'grok') {
      item.createdAt = old;
      for (const step of item.history || []) step.at = old;
    }
  }
  for (const message of state.messages) {
    if (message.agentId === 'grok' || message.fromAgentId === 'grok' || message.toAgentId === 'grok') {
      message.createdAt = old;
      message.timestamp = old;
    }
  }
  const child = await postStatus({ agentId: 'army', status: 'working', doing: 'Делаю приказ' });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  view = agentOf((await json('/api/state')).body, 'grok');
  const childView = agentOf((await json('/api/state')).body, 'army');
  assert.equal(childView.activity, 'working');
  assert.equal(view.activity, 'coordinating');

  const boss = await postStatus({ agentId: 'grok', status: 'working', doing: 'Сам на линии' });
  assert.equal(boss.status, 200, JSON.stringify(boss.body));
  view = agentOf((await json('/api/state')).body, 'grok');
  assert.equal(view.activity, 'working');

  await postStatus({ agentId: 'grok', status: 'idle' });
  const marked = await postStatus({ agentId: 'army', status: 'working', doing: 'По задаче', forAgent: 'putin' });
  assert.equal(marked.status, 200);
  view = agentOf((await json('/api/state')).body, 'grok');
  assert.equal(view.activity, 'working');
  assert.match(view.currentTask, /Военная служба/);
  assert.match(view.currentTask, /По задаче/);
});
