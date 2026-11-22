'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildDashboard } = require('../lib/agent-dashboard');

test('дашборд не выдумывает подпись доставки из forwardStatus', () => {
  const view = buildDashboard({
    agent: { id: 'dev', name: 'Программирование', completed: 0, done: [] },
    tasks: [{
      id: 't-work',
      agent: 'dev',
      agentId: 'dev',
      fromAgentId: 'owner',
      text: 'Уже в работе',
      orderStatus: 'in_progress',
      forwardStatus: 502,
      deliveryLabel: null,
      createdAt: '2026-11-17T08:00:00Z',
      history: [],
    }],
    messages: [{
      id: 'm-old',
      agentId: 'dev',
      role: 'system',
      text: 'Приказ: Владелец → Программирование',
      createdAt: '2026-11-17T08:00:01Z',
    }],
    activity: { activity: 'working', currentTask: 'Уже в работе' },
    now: Date.parse('2026-11-17T12:00:00Z'),
  });
  assert.equal(view.tasks[0].deliveryLabel, null);
  assert.equal(view.messages[0].text, 'Приказ: Путин → Программирование');
  assert.equal(view.messages[0].deliveryLabel, null);
  assert.equal(view.analytics.delivered, null);
});

test('пустой дашборд не подставляет нули аналитики', () => {
  const view = buildDashboard({
    agent: { id: 'army', name: 'Военная служба', number: '2', role: 'Сводка', status: 'idle', now: '', completed: 0, done: [] },
    tasks: [],
    messages: [],
    activity: { activity: 'resting', currentTask: null },
    now: Date.parse('2026-11-17T12:00:00Z'),
  });
  assert.equal(view.agent.id, 'army');
  assert.equal(view.agent.live, null);
  assert.equal(view.agent.level.lvl, 1);
  assert.equal(view.agent.level.xp, 0);
  assert.equal(view.agent.level.need, 150);
  assert.deepEqual(view.metrics, { total: 0, done: 0, inProgress: 0 });
  assert.equal(view.analytics.days, null);
  assert.equal(view.analytics.byStatus, null);
  assert.equal(view.analytics.avgCompletionMs, null);
  assert.equal(view.analytics.delivered, null);
  assert.deepEqual(view.tasks, []);
  assert.deepEqual(view.activityLog, []);
  assert.equal(JSON.stringify(view).includes('APP_PASSWORD'), false);
});

test('дашборд считает колонки, московские дни, опыт и доставку', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const view = buildDashboard({
    agent: {
      id: 'dev',
      name: 'Программирование',
      number: '5',
      role: 'Код',
      status: 'working',
      now: 'Смотрю карту',
      completed: 1,
      done: ['Собрал отчёт'],
      live: { status: 'working', doing: 'Смотрю карту', token: 'secret-live' },
    },
    tasks: [
      {
        id: 't-old',
        agent: 'dev',
        agentId: 'dev',
        fromAgentId: 'owner',
        text: 'Старая',
        status: 'выполнена',
        orderStatus: 'done',
        createdAt: '2026-11-01T09:00:00Z',
        forwardStatus: 200,
        deliveryLabel: null,
        history: [{ status: 'done', at: '2026-11-01T10:00:00Z' }],
      },
      {
        id: 't-new',
        agent: 'dev',
        agentId: 'dev',
        fromAgentId: 'owner',
        text: 'Свежая',
        status: 'в очереди агента',
        orderStatus: 'sent',
        createdAt: '2026-11-17T08:00:00Z',
        forwardStatus: null,
        deliveryLabel: 'В очереди, доставка не подключена',
        history: [{ status: 'sent', at: '2026-11-17T08:00:01Z' }],
      },
      {
        id: 't-ok',
        agent: 'dev',
        agentId: 'dev',
        fromAgentId: 'owner',
        text: 'Дошло',
        status: 'отправлена Путину',
        orderStatus: 'sent',
        createdAt: '2026-11-17T07:00:00Z',
        forwardStatus: 200,
        deliveryLabel: 'Отправлена',
        history: [{ status: 'sent', at: '2026-11-17T07:00:01Z' }],
      },
      {
        id: 't-work',
        agent: 'dev',
        agentId: 'dev',
        fromAgentId: 'owner',
        text: 'В работе',
        status: 'отправлена Путину',
        orderStatus: 'in_progress',
        createdAt: '2026-11-16T20:30:00Z',
        forwardStatus: 502,
        deliveryLabel: null,
        history: [{ status: 'in_progress', at: '2026-11-16T21:00:00Z' }],
      },
      {
        id: 't-other',
        agent: 'qa',
        agentId: 'qa',
        fromAgentId: 'dev',
        text: 'Чужая задача',
        orderStatus: 'sent',
        createdAt: '2026-11-17T08:00:00Z',
        forwardStatus: 200,
      },
    ],
    messages: [
      { id: 'task:t-old', agentId: 'dev', role: 'owner', text: 'Старая', createdAt: '2026-11-01T09:00:00Z', source: 'app', taskId: 't-old' },
      { id: 'task:t-new', agentId: 'dev', role: 'owner', text: 'Свежая', createdAt: '2026-11-17T08:00:00Z', source: 'app', taskId: 't-new' },
      { id: 'task:t-ok', agentId: 'dev', role: 'owner', text: 'Дошло', createdAt: '2026-11-17T07:00:00Z', source: 'app', taskId: 't-ok' },
      { id: 'm-agent', agentId: 'dev', role: 'agent', text: 'Принял', createdAt: '2026-11-17T09:00:00Z', source: 'relay', taskId: null },
    ],
    activity: { activity: 'working', currentTask: 'В работе' },
    now,
  });

  assert.equal(view.agent.currentTask, 'В работе');
  assert.deepEqual(view.agent.live, { status: 'working', doing: 'Смотрю карту' });
  assert.equal(JSON.stringify(view).includes('secret-live'), false);
  assert.equal(view.metrics.total, 4);
  assert.equal(view.metrics.done, 1);
  assert.equal(view.metrics.inProgress, 1);
  assert.equal(view.agent.level.xp, 1 * 100 + 4 * 10);
  assert.equal(view.agent.level.lvl, 1);
  assert.equal(view.agent.level.into, 140);

  const byId = Object.fromEntries(view.tasks.map((task) => [task.id, task]));
  assert.equal(byId['t-new'].column, 'new');
  assert.equal(byId['t-new'].deliveryLabel, 'В очереди, доставка не подключена');
  assert.equal(byId['t-work'].column, 'work');
  assert.equal(byId['t-work'].deliveryLabel, null);
  assert.equal(byId['t-ok'].deliveryLabel, 'Отправлена');
  assert.equal(byId['t-old'].column, 'done');
  assert.equal(byId['t-old'].deliveryLabel, null);
  assert.equal(byId['t-other'], undefined);

  assert.equal(view.analytics.days.length, 14);
  assert.equal(view.analytics.days[0].date, '2026-11-04');
  assert.equal(view.analytics.days[13].date, '2026-11-17');
  assert.equal(view.analytics.days[13].count, 2);
  assert.equal(view.analytics.days[12].count, 1);
  assert.equal(view.analytics.days.reduce((sum, day) => sum + day.count, 0), 3);
  assert.deepEqual(view.analytics.byStatus, { sent: 2, accepted: 0, in_progress: 1, done: 1, failed: 0 });
  assert.equal(view.analytics.avgCompletionMs, 60 * 60 * 1000);
  assert.deepEqual(view.analytics.delivered, { delivered: 1, total: 2 });

  const owner = view.messages.find((item) => item.id === 'task:t-new');
  assert.equal(owner.deliveryLabel, 'В очереди, доставка не подключена');
  const reply = view.messages.find((item) => item.id === 'm-agent');
  assert.equal(reply.deliveryLabel, null);
  assert.ok(view.activityLog.some((line) => line.text.startsWith('Путин: ')));
  assert.equal(view.activityLog.some((line) => line.text.includes('Владелец')), false);
  assert.ok(view.activityLog.some((line) => line.text === 'Собрал отчёт' && line.at == null));
  assert.ok(view.activityLog.some((line) => line.at === '2026-11-17T09:00:00Z'));
});

test('незавершённые задачи не дают среднее время и долю 0%', () => {
  const view = buildDashboard({
    agent: { id: 'qa', name: 'Тестировщик ПО', completed: 0, done: [] },
    tasks: [{
      id: 't-1',
      agent: 'qa',
      agentId: 'qa',
      text: 'Проверь',
      orderStatus: 'sent',
      status: 'в очереди агента',
      createdAt: '2026-11-17T08:00:00Z',
      forwardStatus: null,
      history: [],
    }],
    messages: [],
    activity: { activity: 'working', currentTask: 'Проверь' },
    now: Date.parse('2026-11-17T12:00:00Z'),
  });
  assert.ok(Array.isArray(view.analytics.days));
  assert.equal(view.analytics.avgCompletionMs, null);
  assert.equal(view.analytics.delivered, null);
  assert.equal(view.metrics.done, 0);
  assert.equal(view.metrics.inProgress, 0);
  assert.equal(view.metrics.total, 1);
});

const hook = http.createServer((_req, res) => {
  res.writeHead(204);
  res.end();
});

let base;
let server;

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-dash-'));
  process.env.APP_PASSWORD = 'pw-dash';
  process.env.AGENT_TOKEN = 'tok-dash';
  process.env.KREMLIN_WEBHOOK_URL = '';
  process.env.GROK_WEBHOOK_URL = '';
  delete process.env.DATABASE_URL;
  delete process.env.PORYADOK_INGEST_TOKEN;
  const { app } = require('../server.js');
  server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => hook.close(resolve));
});

function json(pathname, opts = {}) {
  return fetch(base + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

test('GET дашборда неизвестного агента — 404', async () => {
  const res = await json('/api/agents/no-such-agent/dashboard');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Неизвестный агент');
});

test('GET дашборда отдаёт задачи агента и не содержит секретов', async () => {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash' },
    body: JSON.stringify({ agent: 'army', text: 'Сводка для дашборда', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.fromAgentId, 'owner');

  const res = await json('/api/agents/army/dashboard');
  assert.equal(res.status, 200);
  const task = res.body.tasks.find((item) => item.id === created.body.id);
  assert.ok(task);
  assert.equal(task.column, 'new');
  assert.equal(task.deliveryLabel, 'нет маршрута доставки');
  assert.equal(res.body.metrics.total >= 1, true);
  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes('pw-dash'), false);
  assert.equal(raw.includes('tok-dash'), false);
  assert.equal(raw.includes('forwardError'), false);
});

test('смена статуса приказа защищена паролем штаба', async () => {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash' },
    body: JSON.stringify({ agent: 'poker', text: 'Сдвинуть колонку', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const noPassword = await json(`/api/agents/poker/orders/${id}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(noPassword.status, 401);

  const badPassword = await json(`/api/agents/poker/orders/${id}`, {
    method: 'POST',
    headers: { 'x-app-password': 'wrong' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(badPassword.status, 401);

  const skip = await json(`/api/agents/poker/orders/${id}`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash' },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(skip.status, 400);

  const otherAgent = await json(`/api/agents/dev/orders/${id}`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(otherAgent.status, 404);

  const accepted = await json(`/api/agents/poker/orders/${id}`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.task.orderStatus, 'accepted');
  assert.equal(accepted.body.task.fromAgentId, 'owner');

  const view = await json('/api/agents/poker/dashboard');
  const task = view.body.tasks.find((item) => item.id === id);
  assert.equal(task.column, 'work');
});
