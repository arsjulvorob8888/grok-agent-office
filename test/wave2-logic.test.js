'use strict';

// Волна 2: гашение статуса, подпись «Путин →», блок «Не доставлено», отмена.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');

const { activityFor, orderRoute, STATUS_HOLD_MS } = require('../lib/activity');
const { normalizeCancelledOrders } = require('../lib/outbox-retry');
const Feed = require('../public/js/feed');
const Status = require('../public/js/agent-status');

const savedDatabaseUrl = process.env.DATABASE_URL || '';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const HOLD = 15 * 60 * 1000;

test('ручная отметка гаснет ровно через 15 минут', () => {
  assert.equal(STATUS_HOLD_MS, HOLD);
  const freshAt = new Date(NOW - HOLD + 1).toISOString();
  const edgeAt = new Date(NOW - HOLD).toISOString();
  const dev = { id: 'dev', name: 'Программирование' };

  const working = activityFor({ ...dev, status: 'working', now: 'пишу', lastStatusAt: freshAt }, [], NOW);
  assert.equal(working.activity, 'working');
  assert.equal(working.currentTask, 'пишу');

  const idle = activityFor({ ...dev, status: 'idle', lastStatusAt: freshAt }, [], NOW);
  assert.equal(idle.activity, 'working');

  const waiting = activityFor({ ...dev, status: 'waiting', now: 'нужен ответ', lastStatusAt: freshAt }, [], NOW);
  assert.equal(waiting.activity, 'waiting');

  const faded = activityFor({ ...dev, status: 'working', now: 'пишу', lastStatusAt: edgeAt }, [], NOW);
  assert.equal(faded.activity, 'resting');
  assert.equal(faded.currentTask, null);

  const fadedWait = activityFor({ ...dev, status: 'waiting', lastStatusAt: edgeAt }, [], NOW);
  assert.equal(fadedWait.activity, 'resting');

  const unmarked = activityFor({ ...dev, status: 'working', now: 'старое' }, [], NOW);
  assert.equal(unmarked.activity, 'resting');

  const beat = activityFor({
    ...dev,
    status: 'idle',
    lastStatusAt: edgeAt,
    lastSeenAt: freshAt,
    heartbeatNote: 'на линии',
  }, [], NOW, 30 * 60 * 1000);
  assert.equal(beat.activity, 'working');
  assert.equal(beat.currentTask, 'на линии');
});

test('зелёная точка и яркость фигурки берутся из одного статуса', () => {
  const modes = ['working', 'coordinating', 'waiting', 'resting'];
  for (const mode of modes) {
    const look = Status.presence({ activity: mode, status: 'working', id: mode === 'working' ? 'health' : 'social' });
    if (mode === 'resting') assert.equal(Status.finalStatus({ status: 'working', activity: 'resting' }), 'resting');
    assert.equal(look.mode, mode);
    assert.equal(look.dot, look.tone);
    if (mode === 'resting') {
      assert.notEqual(look.dot, 'working');
      assert.ok(look.opacity < 1, mode);
      assert.match(look.filter, /grayscale/);
    } else {
      assert.equal(look.opacity, 1, mode);
      assert.equal(look.filter, 'none', mode);
    }
    if (mode === 'working') assert.equal(look.dot, 'working');
  }
});

test('карта, сайдбар, окно и дашборд берут один статус', () => {
  const asleep = Status.viewStatus({
    activity: 'resting',
    status: 'working',
    lastStatusAt: new Date(NOW - HOLD).toISOString(),
    now: 'старое',
  });
  assert.equal(asleep.mode, 'resting');
  assert.equal(asleep.map, asleep.sidebar);
  assert.equal(asleep.panel, asleep.dashboard);
  assert.equal(asleep.panel, 'Спит');
  assert.equal(asleep.map, 'idle');

  const busy = Status.viewStatus({ activity: 'working', status: 'idle' });
  assert.equal(busy.mode, 'working');
  assert.equal(busy.map, busy.sidebar);
  assert.equal(busy.panel, busy.dashboard);
  assert.equal(busy.panel, 'Работает');
  assert.equal(busy.map, 'working');

  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  for (const file of ['public/js/app.js', 'public/js/activity-view.js', 'public/js/agent-dashboard.js']) {
    assert.match(read(file), /AgentStatus\.activityMode|AgentStatus\.activityLabel|AgentStatus\.statusTone|AgentStatus\.viewStatus/, file);
  }
});

test('приказ владельца подписывается «Путин →»', () => {
  const names = (id) => (id === 'dev' ? 'Программирование' : id);
  const route = orderRoute({ fromAgentId: 'owner', agentId: 'dev', agent: 'dev' }, names);
  assert.equal(route, 'Путин → Программирование');
  assert.equal(route.includes('Вы →'), false);
  assert.equal(route.includes('Владелец →'), false);
  const blank = orderRoute({ fromAgentId: '', agentId: 'qa' }, (id) => (id === 'qa' ? 'Тестировщик' : id));
  assert.equal(blank, 'Путин → Тестировщик');
});

test('корзины процессов: живые, недоставленные старше часа, отменённые нигде', () => {
  const now = NOW;
  const hour = 60 * 60 * 1000;
  const tasks = [
    { id: 'live-sent', orderStatus: 'sent', forwardStatus: 200, createdAt: new Date(now - hour - 5000).toISOString(), text: 'доставлен' },
    { id: 'live-acc', orderStatus: 'accepted', forwardStatus: null, createdAt: new Date(now - 2 * hour).toISOString(), text: 'принят' },
    { id: 'live-work', orderStatus: 'in_progress', forwardStatus: 200, createdAt: new Date(now - 1000).toISOString(), text: 'в работе' },
    { id: 'young', orderStatus: 'sent', forwardStatus: null, createdAt: new Date(now - hour).toISOString(), text: 'ещё час' },
    { id: 'stuck', orderStatus: 'sent', forwardStatus: 502, createdAt: new Date(now - hour - 1).toISOString(), text: 'завис' },
    { id: 't-1', orderStatus: 'cancelled', status: 'в очереди агента', delivery: 'queue', forwardStatus: null, createdAt: new Date(now - 5 * hour).toISOString(), text: 'отменён' },
    { id: 'closed', orderStatus: 'done', forwardStatus: 200, createdAt: new Date(now - 1000).toISOString(), text: 'готов' },
  ];
  const routines = [
    { id: 'r-1', active: true, finishedAt: null, name: 'Сводка' },
    { id: 'r-2', active: false, finishedAt: new Date(now).toISOString(), name: 'Старая' },
  ];
  const buckets = Feed.processBuckets(tasks, routines, now);
  assert.deepEqual(buckets.live.map((task) => task.id), ['live-work']);
  assert.deepEqual(buckets.undelivered.map((task) => task.id), ['stuck']);
  assert.deepEqual(buckets.pulses.map((item) => item.id), []);
  const ids = [...buckets.live, ...buckets.undelivered].map((task) => task.id);
  assert.equal(ids.includes('t-1'), false);
  assert.equal(ids.includes('young'), false);
});

test('бейдж отменённого приказа — «Отменено», и это не очередь', () => {
  const task = {
    id: 't-1',
    agent: 'dev',
    orderStatus: 'cancelled',
    status: 'в очереди агента',
    delivery: 'queue',
    forwardStatus: null,
    history: [{ status: 'sent', at: '2026-11-17T08:00:00.000Z' }],
  };
  assert.deepEqual(
    Feed.taskBadge(task, { agent: { status: 'working' }, latest: task, mode: 'working' }),
    ['cancel', 'Отменено'],
  );
  const word = Feed.historyCaption(task, task.history[0]);
  assert.equal(word, 'Отменено');
  assert.equal(word.includes('В очереди'), false);
  assert.equal(Feed.countsAsQueued(task), false);
  assert.equal(Feed.countsAsQueued({ id: 'q', orderStatus: 'sent', status: 'в очереди агента', delivery: 'queue' }), true);
});

test('уже отменённые t-1 и t-2 теряют очередь и молчащий outbox', () => {
  const tasks = [
    {
      id: 't-1',
      orderStatus: 'cancelled',
      status: 'в очереди агента',
      delivery: 'queue',
      text: 'первый',
    },
    {
      id: 't-2',
      orderStatus: 'cancelled',
      status: 'в очереди агента',
      delivery: 'queue',
      text: 'второй',
    },
    {
      id: 't-9',
      orderStatus: 'sent',
      status: 'в очереди агента',
      delivery: 'queue',
      text: 'живой',
    },
  ];
  const outbox = [
    { id: 'ob-1', taskId: 't-1', status: 'queued' },
    { id: 'ob-2', taskId: 't-2', status: 'sending' },
    { id: 'ob-9', taskId: 't-9', status: 'queued' },
    { id: 'ob-done', taskId: 't-1', status: 'delivered' },
  ];
  const plan = normalizeCancelledOrders(tasks, outbox);
  assert.equal(tasks[0].status, 'отменён');
  assert.equal(tasks[0].delivery, null);
  assert.equal(tasks[0].orderStatus, 'cancelled');
  assert.equal(tasks[1].status, 'отменён');
  assert.equal(tasks[1].delivery, null);
  assert.equal(tasks[2].status, 'в очереди агента');
  assert.equal(tasks[2].delivery, 'queue');
  assert.equal(outbox[0].status, 'cancelled');
  assert.equal(outbox[1].status, 'cancelled');
  assert.equal(outbox[2].status, 'queued');
  assert.equal(outbox[3].status, 'delivered');
  assert.equal(plan.tasks.map((task) => task.id).sort().join(','), 't-1,t-2');
  const again = normalizeCancelledOrders(tasks, outbox);
  assert.equal(again.tasks.length, 0);
  assert.equal(again.outbox.length, 0);
});

const hookHits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    hookHits.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let base;
let server;
let office;

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-wave2-'));
  process.env.APP_PASSWORD = 'pw-wave2';
  process.env.AGENT_TOKEN = 'tok-wave2';
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.KREMLIN_WEBHOOK_KEY = 'hook-key';
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  delete process.env.PORYADOK_INGEST_TOKEN;
  delete process.env.DATABASE_URL;
  process.env.PUBLIC_URL = 'https://example.test';
  office = require('../server.js');
  const { app } = office;
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  hook.close();
});

function json(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

test('маршрут в API и отмена: 401, поля, запись на месте, outbox не уходит', async () => {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-wave2' },
    body: JSON.stringify({ agent: 'dev', text: 'Сводка волны', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  assert.match(created.body.routeLabel, /^Путин → /);
  assert.equal(created.body.routeLabel.includes('Вы →'), false);
  assert.equal(created.body.routeLabel.includes('Владелец →'), false);
  assert.equal(created.body.fromAgentId, 'owner');
  const hitsAtCreate = hookHits.filter((hit) => hit && hit.taskId === created.body.id).length;

  const denied = await json(`/api/orders/${created.body.id}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const still = office.state.tasks.find((task) => task.id === created.body.id);
  assert.notEqual(still.orderStatus, 'cancelled');

  const cancelled = await json(`/api/orders/${created.body.id}/cancel`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-wave2' },
    body: '{}',
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.task.orderStatus, 'cancelled');
  assert.equal(cancelled.body.task.status, 'отменён');
  assert.equal(cancelled.body.task.delivery, null);
  assert.equal(office.state.tasks.some((task) => task.id === created.body.id), true);

  const open = await json('/api/agents/dev/tasks?status=open', {
    headers: { 'x-agent-token': 'tok-wave2' },
  });
  assert.equal(open.status, 200);
  assert.equal(open.body.tasks.some((task) => task.id === created.body.id), false);

  const rows = (office.state.outbox || []).filter((item) => item.taskId === created.body.id);
  assert.ok(rows.length >= 1);
  assert.equal(rows.every((item) => item.status === 'cancelled' || item.status === 'delivered'), true);

  await json('/api/delivery/retry', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-wave2' },
    body: '{}',
  });
  await json('/api/outbox/retry', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-wave2' },
    body: '{}',
  });
  const hitsAfter = hookHits.filter((hit) => hit && hit.taskId === created.body.id).length;
  assert.equal(hitsAfter, hitsAtCreate);
});

test('посаженные t-1 и t-2 нормализуются и не досылаются', async () => {
  const hits = hookHits.length;
  for (const id of ['t-1', 't-2']) {
    office.state.tasks.unshift({
      id,
      agent: 'dev',
      agentId: 'dev',
      fromAgentId: 'owner',
      text: `старый ${id}`,
      status: 'в очереди агента',
      delivery: 'queue',
      orderStatus: 'cancelled',
      createdAt: '2026-11-17T08:00:00.000Z',
      forwardStatus: null,
      history: [{ status: 'sent', at: '2026-11-17T08:00:00.000Z', note: '' }],
      attachments: [],
    });
    office.state.outbox.push({
      id: `ob-${id}`,
      at: '2026-11-17T08:00:00.000Z',
      agentId: 'dev',
      taskId: id,
      status: 'queued',
      attempts: 0,
      lastError: null,
      payload: { id: `ob-${id}`, type: 'owner_task', agentId: 'dev', text: `старый ${id}`, taskId: id },
    });
  }
  const flushed = await json('/api/delivery/retry', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-wave2' },
    body: '{}',
  });
  assert.equal(flushed.status, 200);
  for (const id of ['t-1', 't-2']) {
    const task = office.state.tasks.find((item) => item.id === id);
    assert.equal(task.orderStatus, 'cancelled');
    assert.equal(task.status, 'отменён');
    assert.equal(task.delivery, null);
    const item = office.state.outbox.find((row) => row.taskId === id && row.id === `ob-${id}`);
    assert.equal(item.status, 'cancelled');
  }
  const leaked = hookHits.slice(hits).filter((hit) => hit && (hit.taskId === 't-1' || hit.taskId === 't-2'));
  assert.equal(leaked.length, 0);
  const state = await json('/api/state');
  const shown = state.body.tasks.find((task) => task.id === 't-1');
  assert.equal(shown.status, 'отменён');
  assert.equal(shown.delivery, null);
  assert.equal(Feed.taskBadge(shown, { agent: { status: 'working' }, latest: shown, mode: 'working' })[1], 'Отменено');
  assert.equal(Feed.historyCaption(shown, shown.history[0]).includes('В очереди'), false);
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

test('перезапуск Postgres нормализует отменённые и не шлёт их outbox', { skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан', timeout: 90000 }, async () => {
  const saved = savedDatabaseUrl;
  const schema = `w2_${crypto.randomBytes(3).toString('hex')}`;
  const root = path.join(__dirname, '..');
  const port = await freePort();
  const hookPort = await freePort();
  const hits = [];
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => sink.listen(hookPort, '127.0.0.1', resolve));

  function childEnv(extra) {
    const env = { ...process.env, ...extra };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_CHANNEL_FD;
    delete env.PORYADOK_INGEST_TOKEN;
    env.APP_PASSWORD = 'pw-wave2';
    env.AGENT_TOKEN = 'tok-wave2';
    env.DATABASE_URL = saved;
    env.STORE_SCHEMA = schema;
    env.PORT = String(port);
    env.PUBLIC_URL = 'https://example.test';
    env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${hookPort}/hook`;
    env.KREMLIN_WEBHOOK_KEY = 'hook-key';
    return env;
  }

  async function boot(env) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const url = `http://127.0.0.1:${port}`;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (child.exitCode != null) throw new Error(log);
      try {
        const res = await fetch(`${url}/healthz`);
        if (res.ok && (await res.text()) === 'ok') return { child, url, log: () => log };
      } catch (_) { /* ещё стартует */ }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    child.kill('SIGKILL');
    throw new Error(log || 'сервер не поднялся');
  }

  function stop(child) {
    return new Promise((resolve) => {
      if (!child || child.exitCode != null) return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  const { Pool } = require('pg');
  let first;
  try {
    first = await boot(childEnv({ KREMLIN_WEBHOOK_URL: '' }));
    await stop(first.child);
    const pool = new Pool({ connectionString: saved, max: 1 });
    try {
      for (const id of ['t-1', 't-2']) {
        await pool.query(
          `INSERT INTO ${schema}.orders (
             id, seq, agent, agent_id, from_agent_id, body, status, order_status, note, created_at, history, attachments, extra
           ) VALUES ($1, $2, 'dev', 'dev', 'owner', $3, 'в очереди агента', 'cancelled', '', $4, $5::jsonb, '[]'::jsonb, '{"delivery":"queue"}'::jsonb)`,
          [id, id === 't-1' ? 1 : 2, `старый ${id}`, '2026-11-17T08:00:00.000Z', JSON.stringify([{ status: 'sent', at: '2026-11-17T08:00:00.000Z' }])],
        );
        await pool.query(
          `INSERT INTO ${schema}.outbox (
             id, seq, created_at, agent_id, task_id, status, attempts, payload
           ) VALUES ($1, $2, $3, 'dev', $4, 'queued', 0, $5::jsonb)`,
          [`ob-${id}`, id === 't-1' ? 1 : 2, '2026-11-17T08:00:00.000Z', id, JSON.stringify({ id: `ob-${id}`, type: 'owner_task', agentId: 'dev', text: `старый ${id}`, taskId: id })],
        );
      }
    } finally {
      await pool.end();
    }
    const second = await boot(childEnv({}));
    try {
      const url = second.url;
      let body = null;
      const started = Date.now();
      while (Date.now() - started < 8000) {
        const res = await fetch(`${url}/api/state`);
        body = await res.json();
        const row = (body.tasks || []).find((task) => task.id === 't-1');
        if (row && row.status === 'отменён') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const id of ['t-1', 't-2']) {
        const row = body.tasks.find((task) => task.id === id);
        assert.ok(row, id);
        assert.equal(row.orderStatus, 'cancelled');
        assert.equal(row.status, 'отменён');
        assert.equal(row.delivery, null);
        const box = (body.outbox || []).find((item) => item.id === `ob-${id}`);
        assert.equal(box && box.status, 'cancelled');
      }
      const check = new Pool({ connectionString: saved, max: 1 });
      try {
        const startedSave = Date.now();
        let stored = false;
        while (Date.now() - startedSave < 8000) {
          const rows = await check.query(
            `SELECT status, extra->>'delivery' AS delivery FROM ${schema}.orders WHERE id IN ('t-1', 't-2')`,
          );
          const boxes = await check.query(
            `SELECT status FROM ${schema}.outbox WHERE id IN ('ob-t-1', 'ob-t-2')`,
          );
          stored = rows.rows.length === 2
            && rows.rows.every((row) => row.status === 'отменён' && row.delivery == null)
            && boxes.rows.length === 2
            && boxes.rows.every((row) => row.status === 'cancelled');
          if (stored) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(stored, true);
      } finally {
        await check.end();
      }
      assert.equal(hits.filter((hit) => hit && (hit.taskId === 't-1' || hit.taskId === 't-2')).length, 0);
    } finally {
      await stop(second.child);
    }
    const third = await boot(childEnv({}));
    try {
      const res = await fetch(`${third.url}/api/state`);
      const body = await res.json();
      for (const id of ['t-1', 't-2']) {
        const row = body.tasks.find((task) => task.id === id);
        assert.equal(row.status, 'отменён');
        assert.equal(row.delivery, null);
        const box = (body.outbox || []).find((item) => item.id === `ob-${id}`);
        assert.equal(box && box.status, 'cancelled');
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(hits.filter((hit) => hit && (hit.taskId === 't-1' || hit.taskId === 't-2')).length, 0);
    } finally {
      await stop(third.child);
    }
  } finally {
    if (first) await stop(first.child);
    sink.close();
    const drop = new Pool({ connectionString: saved, max: 1 });
    try {
      await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await drop.end();
    }
  }
});
