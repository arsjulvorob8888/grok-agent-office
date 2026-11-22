'use strict';

// Журнал: «Доставлено», свёрнутые отменённые, маршрут в деталях.
// Процессы: доставленное и протухшее старше 15 минут не считаются работой.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const Feed = require('../public/js/feed');
const { STATUS_HOLD_MS } = require('../lib/activity');

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const ENV_KEY = 'journal-env-key-SHOULD-NOT-LEAK';
const AGENT_KEY = 'journal-agent-key-SHOULD-NOT-LEAK';
const PUTIN_KEY = 'journal-putin-key-SHOULD-NOT-LEAK';

test('окно процесса равно STATUS_HOLD_MS, ровно 15 минут уже не свежие', () => {
  assert.equal(Feed.PROCESS_HOLD_MS, STATUS_HOLD_MS);
  assert.equal(Feed.PROCESS_HOLD_MS, 15 * 60 * 1000);
});

test('доставленный outbox и 2xx — одна подпись «Доставлено» в журнале и в деталях', () => {
  assert.equal(Feed.deliveryCaption(200, { route: 'putin' }), 'Отправлена');
  assert.equal(Feed.deliveryCaption(200, { outboxStatus: 'delivered', route: 'env' }), 'Доставлено');
  const task = {
    id: 't-3',
    orderStatus: 'sent',
    forwardStatus: 200,
    outboxStatus: 'delivered',
    deliveryLabel: 'Отправлена',
    deliveryRoute: 'env',
    history: [{ status: 'sent', at: '2026-11-17T14:00:00.000Z' }],
  };
  assert.equal(Feed.taskDeliveryLabel(task), 'Доставлено');
  assert.equal(Feed.taskBadge(task)[1], 'Доставлено');
  assert.equal(Feed.historyCaption(task, task.history[0]), 'Доставлено');
  const twin = { ...task, id: 't-4', deliveryLabel: 'Доставлено' };
  assert.equal(Feed.taskDeliveryLabel(twin), Feed.historyCaption(twin, twin.history[0]));
});

test('отменённые «тест» остаются в данных, но не входят в бейдж', () => {
  const tasks = [
    { id: 'live', orderStatus: 'sent', text: 'Сводка' },
    { id: 'stub-1', orderStatus: 'cancelled', text: 'тест' },
    { id: 'stub-2', orderStatus: 'cancelled', text: ' тест ' },
    { id: 'done', orderStatus: 'done', text: 'Готово' },
  ];
  const view = Feed.journalSplit(tasks);
  assert.deepEqual(view.active.map((task) => task.id), ['live']);
  assert.deepEqual(view.delivered.map((task) => task.id), ['done']);
  assert.deepEqual(view.cancelled.map((task) => task.id), ['stub-1', 'stub-2']);
  assert.equal(view.badge, 1);
  assert.equal(tasks.length, 4);
  assert.equal(Feed.sentRoutePhrase('agent'), 'Куда ушёл приказ: Свой вебхук агента');
  assert.equal(Feed.sentRoutePhrase('putin'), 'Куда ушёл приказ: Через Путина');
  assert.equal(Feed.sentRoutePhrase('env'), 'Куда ушёл приказ: Адрес из окружения');
  assert.equal(Feed.sentRoutePhrase('none'), '');
});

test('доставленные, закрытые и старше 15 минут не процессы, счётчик пустой', () => {
  const hold = Feed.PROCESS_HOLD_MS;
  const freshAt = new Date(NOW - hold + 1000).toISOString();
  const staleAt = new Date(NOW - hold).toISOString();
  const tasks = [
    {
      id: 't-3',
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      agentId: 'social',
      text: 'Ответ соцсетям',
      createdAt: freshAt,
      history: [{ status: 'sent', at: freshAt }],
    },
    {
      id: 't-4',
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      agentId: 'finance',
      text: 'Ответ финансам',
      createdAt: new Date(NOW - 115 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'fresh',
      orderStatus: 'accepted',
      agentId: 'social',
      createdAt: freshAt,
      history: [{ status: 'accepted', at: freshAt }],
    },
    {
      id: 'stale',
      orderStatus: 'accepted',
      agentId: 'finance',
      createdAt: staleAt,
      history: [{ status: 'accepted', at: staleAt }],
    },
    {
      id: 'quiet',
      orderStatus: 'in_progress',
      agentId: 'qa',
      createdAt: staleAt,
      history: [{ status: 'in_progress', at: staleAt }],
    },
    {
      id: 'awake',
      orderStatus: 'in_progress',
      agentId: 'dev',
      createdAt: staleAt,
      history: [{ status: 'in_progress', at: staleAt }],
    },
    { id: 'done', orderStatus: 'done', forwardStatus: 200, createdAt: freshAt },
    { id: 'cancel', orderStatus: 'cancelled', text: 'тест', createdAt: freshAt },
    { id: 'fail', orderStatus: 'failed', createdAt: freshAt },
  ];
  const agents = [
    { id: 'social', activity: 'working', lastSeenAt: freshAt },
    { id: 'finance', activity: 'resting', lastSeenAt: staleAt },
    { id: 'qa', activity: 'resting', lastSeenAt: staleAt },
    { id: 'dev', activity: 'working', lastSeenAt: freshAt },
  ];
  const routines = [
    { id: 'hot', active: true, finishedAt: null, agentId: 'qa', startedAt: freshAt, name: 'Свежий' },
    { id: 'cold', active: true, finishedAt: null, agentId: 'qa', startedAt: staleAt, name: 'Спит' },
  ];
  const buckets = Feed.processBuckets(tasks, routines, NOW, { agents });
  assert.deepEqual(buckets.live.map((task) => task.id), ['fresh', 'awake']);
  assert.equal(buckets.live.some((task) => task.id === 't-3' || task.id === 't-4'), false);
  assert.equal(buckets.undelivered.some((task) => task.orderStatus === 'cancelled' || task.orderStatus === 'done'), false);
  assert.deepEqual(buckets.pulses.map((item) => item.id), ['hot']);
  assert.equal(buckets.live.length + buckets.pulses.length, 3);
  const none = Feed.processBuckets(
    tasks.filter((task) => task.id === 't-3' || task.id === 't-4' || task.id === 'done' || task.id === 'cancel' || task.id === 'fail'),
    [],
    NOW,
    { agents },
  );
  assert.equal(none.live.length + none.pulses.length, 0);
});

test('панель пересчитывает список по officestate и по локальному таймеру', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/processes.js'), 'utf8');
  assert.match(source, /officestate/);
  assert.match(source, /setInterval\(\(\) => \{\s*render\(\);\s*\}, 1000\)/);
  assert.equal(source.includes("addEventListener('state'"), false);
  const stream = fs.readFileSync(path.join(root, 'public/js/live-stream.js'), 'utf8');
  assert.equal(stream.includes('processBuckets'), false);
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

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.DATABASE_URL;
  delete env.STORE_SCHEMA;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-journal';
  env.AGENT_TOKEN = 'tok-journal';
  env.PUBLIC_URL = 'http://127.0.0.1';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extra) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-journal-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extra, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) return { base, child, logs };
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function call(base, urlPath, opts = {}) {
  const res = await fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: res.status, body, text };
}

function listenHook() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ url: req.url || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        hits,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('API: delivered 2xx — «Доставлено», маршрут без адреса, отмена не стирает «тест»', async () => {
  const hook = await listenHook();
  const secrets = crypto.randomBytes(32).toString('base64');
  let office;
  try {
    office = await startOffice({
      WEBHOOK_SECRETS_KEY: secrets,
      KREMLIN_WEBHOOK_URL: `${hook.origin}/env-hook`,
      KREMLIN_WEBHOOK_KEY: ENV_KEY,
    });
    const sent = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ agent: 'social', text: 'ЖУРНАЛ-ДОСТАВКА ответ соцсетям', fromAgentId: 'owner' }),
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.deliveryLabel, 'Доставлено');
    assert.equal(sent.body.forwardStatus >= 200 && sent.body.forwardStatus < 300, true);
    assert.equal(sent.body.sentRoute, 'env');
    assert.equal(sent.text.includes(ENV_KEY), false);
    assert.equal(sent.text.includes('/env-hook'), false);

    const state = await call(office.base, '/api/state');
    const task = state.body.tasks.find((item) => item.id === sent.body.id);
    const box = state.body.outbox.find((item) => item.taskId === sent.body.id);
    assert.equal(task.deliveryLabel, 'Доставлено');
    assert.equal(task.outboxStatus, 'delivered');
    assert.equal(box.status, 'delivered');
    assert.equal(box.attempts, 1);
    assert.equal(task.forwardStatus, 200);
    assert.equal(Feed.taskDeliveryLabel(task), 'Доставлено');
    assert.equal(Feed.historyCaption(task, (task.history || [])[0]), 'Доставлено');
    assert.equal(state.text.includes(ENV_KEY), false);
    assert.equal(state.text.includes('/env-hook'), false);

    const own = await call(office.base, '/api/agents/finance/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ url: `${hook.origin}/finance-hook`, key: AGENT_KEY }),
    });
    assert.equal(own.status, 200);
    const viaAgent = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ agent: 'finance', text: 'Свой канал финансов', fromAgentId: 'owner' }),
    });
    assert.equal(viaAgent.body.sentRoute, 'agent');
    assert.equal(viaAgent.body.deliveryLabel, 'Доставлено');
    assert.equal(viaAgent.text.includes(AGENT_KEY), false);
    assert.equal(viaAgent.text.includes('/finance-hook'), false);

    const putin = await call(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ url: `${hook.origin}/putin-hook`, key: PUTIN_KEY }),
    });
    assert.equal(putin.status, 200);
    const viaPutin = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ agent: 'qa', text: 'Через общий канал', fromAgentId: 'owner' }),
    });
    assert.equal(viaPutin.body.sentRoute, 'putin');
    assert.equal(viaPutin.text.includes(PUTIN_KEY), false);

    const again = await call(office.base, '/api/state');
    const first = again.body.tasks.find((item) => item.id === sent.body.id);
    assert.equal(first.sentRoute, 'env');
    assert.equal(again.text.includes(ENV_KEY), false);
    assert.equal(again.text.includes(AGENT_KEY), false);
    assert.equal(again.text.includes(PUTIN_KEY), false);

    const stub = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal' },
      body: JSON.stringify({ agent: 'advisor', text: 'тест', fromAgentId: 'owner' }),
    });
    assert.equal(stub.status, 201);
    const cancelled = await call(office.base, `/api/orders/${stub.body.id}/cancel`, {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal' },
      body: '{}',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.orderStatus, 'cancelled');
    const finalState = await call(office.base, '/api/state');
    const kept = finalState.body.tasks.find((item) => item.id === stub.body.id);
    assert.ok(kept);
    assert.equal(kept.text, 'тест');
    assert.equal(kept.orderStatus, 'cancelled');
    const split = Feed.journalSplit(finalState.body.tasks);
    assert.equal(split.cancelled.some((item) => item.id === stub.body.id), true);
    assert.equal(split.active.some((item) => item.id === stub.body.id), false);
    assert.equal(split.badge, split.active.length);
  } finally {
    await stopOffice(office);
    await hook.close();
  }
});
