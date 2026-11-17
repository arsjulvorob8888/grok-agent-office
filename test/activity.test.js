'use strict';

// Пульс агента и расчёт activity. Сервер один на файл, сценарии идут по очереди.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activityFor, activeWindowMs, pickCurrentTask } = require('../lib/activity');

const hook = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});

let base;
let server;
let office;

before(async () => {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-activity-'));
  process.env.APP_PASSWORD = 'pw-act';
  process.env.AGENT_TOKEN = 'tok-act';
  process.env.GROK_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.GROK_WEBHOOK_KEY = 'hook-key';
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
  process.env.KREMLIN_WEBHOOK_KEY = 'hook-key';
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  process.env.PUBLIC_URL = 'https://example.test';
  delete process.env.AGENT_ACTIVE_MINUTES;
  delete process.env.ACTIVITY_WINDOW_MIN;
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

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

function agentOf(body, id) {
  return body.agents.find((a) => a.id === id);
}

test('окно активности: по умолчанию 30 минут, мусор тоже 30', () => {
  assert.equal(activeWindowMs({}), 30 * 60 * 1000);
  assert.equal(activeWindowMs({ ACTIVITY_WINDOW_MIN: '' }), 30 * 60 * 1000);
  assert.equal(activeWindowMs({ ACTIVITY_WINDOW_MIN: 'нет' }), 30 * 60 * 1000);
  assert.equal(activeWindowMs({ ACTIVITY_WINDOW_MIN: '-3' }), 30 * 60 * 1000);
  assert.equal(activeWindowMs({ ACTIVITY_WINDOW_MIN: '2' }), 2 * 60 * 1000);
});

test('activityFor: приказ, пульс и граница окна', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const windowMs = 10 * 60 * 1000;
  const dev = { id: 'dev', lastSeenAt: null, heartbeatNote: '' };
  const stale = [
    { id: 't-stale', agentId: 'dev', fromAgentId: 'grok', orderStatus: 'sent', text: 'час назад', createdAt: '2026-11-17T11:00:00.000Z' },
  ];
  assert.equal(activityFor(dev, stale, now, windowMs).activity, 'resting');
  assert.equal(activityFor({ id: 'grok' }, stale, now, windowMs).activity, 'resting');

  const orders = [
    { id: 't-sent', agentId: 'dev', fromAgentId: 'grok', orderStatus: 'sent', text: 'ещё не взял', createdAt: '2026-11-17T11:55:00.000Z' },
    { id: 't-old', agentId: 'dev', orderStatus: 'done', text: 'старое', createdAt: '2026-11-17T10:00:00.000Z' },
  ];
  assert.equal(activityFor(dev, orders, now, windowMs).activity, 'working');
  assert.equal(activityFor(dev, orders, now, windowMs).currentTask, 'ещё не взял');
  assert.equal(activityFor({ id: 'grok', name: 'Путин' }, orders, now, windowMs).activity, 'working');

  orders.push({ id: 't-acc', agentId: 'dev', agent: 'dev', fromAgentId: 'grok', orderStatus: 'accepted', text: 'Принятая задача', createdAt: '2026-11-17T11:56:00.000Z' });
  const accepted = activityFor(dev, orders, now, windowMs);
  assert.equal(accepted.activity, 'working');
  assert.equal(accepted.currentTask, 'Принятая задача');
  assert.equal(accepted.lastSeenAt, null);

  orders.push({
    id: 't-go',
    agentId: 'dev',
    fromAgentId: 'grok',
    orderStatus: 'in_progress',
    text: 'Уже делаю',
    createdAt: '2026-11-17T11:40:00.000Z',
    history: [{ status: 'in_progress', at: '2026-11-17T11:58:00.000Z' }],
  });
  assert.equal(pickCurrentTask('dev', orders).id, 't-go');
  assert.equal(activityFor(dev, orders, now, windowMs).currentTask, 'Уже делаю');

  const sender = activityFor({ id: 'grok', name: 'Путин' }, orders, now, windowMs);
  assert.equal(sender.activity, 'working');
  assert.equal(sender.currentTask, 'Уже делаю');

  const archived = activityFor({
    id: 'trading',
    archived: true,
    lastSeenAt: new Date(now).toISOString(),
    heartbeatNote: 'не должен светиться',
  }, orders.map((o) => ({ ...o, agentId: 'trading', agent: 'trading' })), now, windowMs);
  assert.equal(archived.activity, 'resting');
  assert.equal(archived.currentTask, null);

  const beat = { id: 'lang', lastSeenAt: new Date(now - windowMs).toISOString(), heartbeatNote: 'На линии' };
  assert.equal(activityFor(beat, [], now, windowMs).activity, 'working');
  assert.equal(activityFor(beat, [], now, windowMs).currentTask, 'На линии');
  const expired = { ...beat, lastSeenAt: new Date(now - windowMs - 1).toISOString() };
  const gone = activityFor(expired, [], now, windowMs);
  assert.equal(gone.activity, 'resting');
  assert.equal(gone.currentTask, null);
  assert.equal(gone.lastSeenAt, expired.lastSeenAt);

  const both = { id: 'dev', lastSeenAt: expired.lastSeenAt, heartbeatNote: 'заметка пульса' };
  assert.equal(activityFor(both, orders, now, windowMs).currentTask, 'Уже делаю');
});

test('окно 10 минут: отданный и полученный приказ, сообщение, forAgent и координирование', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const windowMs = 30 * 60 * 1000;
  const freshAt = new Date(now - 2 * 60 * 1000).toISOString();
  const oldAt = new Date(now - 11 * 60 * 1000).toISOString();
  const grok = { id: 'grok', name: 'Путин', parentId: null };
  const dev = { id: 'dev', name: 'Программирование', parentId: null };
  const invest = { id: 'invest', name: 'Инвестиции', parentId: 'finance' };
  const finance = { id: 'finance', name: 'Финансы', parentId: null };
  const agents = [grok, dev, finance, invest];

  const sent = [{ id: 't-1', agentId: 'dev', fromAgentId: 'grok', orderStatus: 'sent', text: 'Сверстай экран', createdAt: freshAt }];
  assert.equal(activityFor(dev, sent, now, windowMs, { agents }).activity, 'working');
  assert.equal(activityFor(grok, sent, now, windowMs, { agents }).activity, 'working');
  assert.notEqual(activityFor(grok, sent, now, windowMs, { agents }).activity, 'coordinating');

  const aged = [{ id: 't-1', agentId: 'dev', fromAgentId: 'grok', orderStatus: 'in_progress', text: 'Сверстай экран', createdAt: oldAt, history: [{ at: oldAt, status: 'in_progress' }] }];
  assert.equal(activityFor(dev, aged, now, windowMs, { agents }).activity, 'resting');
  assert.equal(activityFor(grok, aged, now, windowMs, { agents }).activity, 'resting');

  const edge = [{ id: 't-edge', agentId: 'dev', fromAgentId: 'grok', orderStatus: 'sent', text: 'на границе', createdAt: new Date(now - 10 * 60 * 1000).toISOString() }];
  assert.equal(activityFor(dev, edge, now, windowMs, { agents }).activity, 'resting');

  const messages = [{ id: 'm-1', agentId: 'dev', fromAgentId: 'grok', role: 'owner', text: 'Держи задачу', createdAt: freshAt, source: 'app' }];
  assert.equal(activityFor(dev, [], now, windowMs, { agents, messages }).activity, 'working');
  assert.equal(activityFor(grok, [], now, windowMs, { agents, messages }).activity, 'working');
  const oldMessages = [{ ...messages[0], createdAt: oldAt }];
  assert.equal(activityFor(dev, [], now, windowMs, { agents, messages: oldMessages }).activity, 'resting');
  assert.equal(activityFor(grok, [], now, windowMs, { agents, messages: oldMessages }).activity, 'resting');

  const liveDev = {
    ...dev,
    live: {
      status: 'working',
      doing: 'Пишу модуль',
      since: freshAt,
      until: new Date(now + 8 * 60 * 1000).toISOString(),
      forAgent: 'grok',
    },
  };
  const behalf = activityFor(grok, [], now, windowMs, { agents: [grok, liveDev, finance, invest] });
  assert.equal(behalf.activity, 'working');
  assert.match(behalf.currentTask, /Программирование/);
  assert.match(behalf.currentTask, /Пишу модуль/);

  const quietGrok = { ...grok };
  const busyDev = {
    ...dev,
    live: {
      status: 'working',
      doing: 'Сверстаю сам',
      since: freshAt,
      until: new Date(now + 8 * 60 * 1000).toISOString(),
      forAgent: null,
    },
  };
  const coord = activityFor(quietGrok, aged, now, windowMs, { agents: [quietGrok, busyDev, finance, invest] });
  assert.equal(coord.activity, 'coordinating');
  assert.match(coord.currentTask, /Программирование/);

  const own = {
    ...grok,
    live: {
      status: 'working',
      doing: 'Сам разбираю',
      since: freshAt,
      until: new Date(now + 8 * 60 * 1000).toISOString(),
    },
  };
  assert.equal(activityFor(own, aged, now, windowMs, { agents: [own, busyDev, finance, invest] }).activity, 'working');

  const nested = activityFor(grok, [{ id: 't-f', agentId: 'invest', fromAgentId: 'finance', orderStatus: 'in_progress', text: 'Сводка', createdAt: freshAt }], now, windowMs, {
    agents: [grok, dev, finance, { ...invest, live: busyDev.live }],
  });
  assert.equal(nested.activity, 'resting');
  const financeView = activityFor(finance, [{ id: 't-f', agentId: 'invest', fromAgentId: 'finance', orderStatus: 'sent', text: 'Сводка', createdAt: oldAt }], now, windowMs, {
    agents: [grok, finance, { ...invest, live: busyDev.live }],
  });
  assert.equal(financeView.activity, 'coordinating');
});

test('пульс: токен, 404 и расчёт activity на сервере', async () => {
  const noToken = await json('/api/agents/dev/heartbeat', { method: 'POST', body: '{}' });
  assert.equal(noToken.status, 401);
  const badToken = await json('/api/agents/dev/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'nope' },
    body: '{}',
  });
  assert.equal(badToken.status, 401);

  const missing = await json('/api/agents/no-such-agent/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: '{}',
  });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Неизвестный агент/);

  for (const id of ['trading', 'biz', 'lang']) {
    const archivedBeat = await json(`/api/agents/${id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-act' },
      body: JSON.stringify({ note: 'архив не пульсирует' }),
    });
    assert.ok(archivedBeat.status >= 400 && archivedBeat.status < 500, `${id} ${archivedBeat.status}`);
    assert.equal(archivedBeat.status, 409);
    assert.match(archivedBeat.body.error, /архив/i);
  }

  const badNote = await json('/api/agents/dev/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ note: 12 }),
  });
  assert.equal(badNote.status, 400);

  const longNote = await json('/api/agents/dev/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ note: 'я'.repeat(201) }),
  });
  assert.equal(longNote.status, 400);

  const bare = await json('/api/agents/poker/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
  });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.ok, true);
  assert.equal(bare.body.activity, 'working');
  assert.equal(bare.body.currentTask, null);
  assert.equal(Number.isNaN(Date.parse(bare.body.lastSeenAt)), false);

  const noted = await json('/api/agents/advisor/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ note: '  Смотрю сводку  ' }),
  });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.currentTask, 'Смотрю сводку');

  const state1 = await json('/api/state');
  assert.equal(state1.status, 200);
  const poker = agentOf(state1.body, 'poker');
  const advisor = agentOf(state1.body, 'advisor');
  const dev = agentOf(state1.body, 'dev');
  assert.equal(poker.activity, 'working');
  assert.equal(poker.currentTask, null);
  assert.ok(poker.lastSeenAt);
  assert.equal(advisor.activity, 'working');
  assert.equal(advisor.currentTask, 'Смотрю сводку');
  assert.equal(advisor.number, '10');
  assert.equal(advisor.parentId, null);
  assert.equal(dev.activity, 'resting');
  assert.equal(dev.lastSeenAt, null);
  assert.equal(JSON.stringify(state1.body).includes('tok-act'), false);

  const task = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-act' },
    body: JSON.stringify({ agent: 'dev', text: 'Собрать отчёт по активности', fromAgentId: 'grok' }),
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.orderStatus, 'sent');

  const sentState = await json('/api/state');
  const devSent = agentOf(sentState.body, 'dev');
  const grok = agentOf(sentState.body, 'grok');
  assert.equal(devSent.status, 'working');
  assert.equal(devSent.activity, 'working', 'открытый приказ — это работа');
  assert.equal(devSent.currentTask, 'Собрать отчёт по активности');
  assert.equal(grok.activity, 'working', 'свежий отданный приказ — это тоже работа');

  const accepted = await json(`/api/orders/${task.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);
  const accState = await json('/api/state');
  const devAcc = agentOf(accState.body, 'dev');
  assert.equal(devAcc.activity, 'working');
  assert.equal(devAcc.currentTask, 'Собрать отчёт по активности');

  const progress = await json(`/api/orders/${task.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'in_progress', progress: 30, note: 'считаю' }),
  });
  assert.equal(progress.status, 200);
  const mid = agentOf((await json('/api/state')).body, 'dev');
  assert.equal(mid.activity, 'working');
  assert.equal(mid.currentTask, 'Собрать отчёт по активности');

  const other = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-act' },
    body: JSON.stringify({ agent: 'dev', text: 'Вторая, только принятая', fromAgentId: 'qa' }),
  });
  assert.equal(other.status, 201);
  await json(`/api/orders/${other.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  const prefer = agentOf((await json('/api/state')).body, 'dev');
  assert.equal(prefer.currentTask, 'Собрать отчёт по активности');
  assert.equal(agentOf((await json('/api/state')).body, 'qa').activity, 'working', 'отправитель свежего приказа тоже работает');

  const done = await json(`/api/orders/${task.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'done', result: 'Готово' }),
  });
  assert.equal(done.status, 200);
  await json(`/api/orders/${other.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'failed', note: 'не то' }),
  });
  const after = agentOf((await json('/api/state')).body, 'dev');
  assert.equal(after.activity, 'working');
  assert.equal(after.currentTask, null);

  process.env.ACTIVITY_WINDOW_MIN = '0.001';
  const beat = await json('/api/agents/temshik/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ note: 'минутный график' }),
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.activity, 'working');
  assert.equal(beat.body.currentTask, 'минутный график');
  await new Promise((r) => setTimeout(r, 250));
  const cooled = agentOf((await json('/api/state')).body, 'temshik');
  assert.equal(cooled.activity, 'resting');
  assert.equal(cooled.currentTask, null);
  assert.equal(cooled.lastSeenAt, beat.body.lastSeenAt);

  const hold = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-act' },
    body: JSON.stringify({ agent: 'temshik', text: 'Держит приказ после пульса', fromAgentId: 'grok' }),
  });
  await json(`/api/orders/${hold.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  const still = agentOf((await json('/api/state')).body, 'temshik');
  assert.equal(still.activity, 'working');
  assert.equal(still.currentTask, 'Держит приказ после пульса');

  office.state.tasks.unshift({
    id: 't-archive-hide',
    agent: 'trading',
    agentId: 'trading',
    fromAgentId: 'grok',
    parentOrderId: null,
    text: 'ARCHIVE-HIDDEN старый приказ трейдинга',
    status: 'отправлена',
    orderStatus: 'accepted',
    progress: null,
    note: '',
    createdAt: '2026-01-02T00:00:00.000Z',
    forwardStatus: null,
    result: null,
    history: [],
    attachments: [],
    messageId: 'task:t-archive-hide',
  });
  const hidden = agentOf((await json('/api/state')).body, 'trading');
  assert.equal(hidden.archived, true);
  assert.equal(hidden.activity, 'resting');
  assert.equal(hidden.currentTask, null);
  assert.equal(hidden.lastSeenAt, null);
  const biz = agentOf((await json('/api/state')).body, 'biz');
  assert.equal(biz.archived, true);
  assert.equal(biz.activity, 'resting');
  const langHidden = agentOf((await json('/api/state')).body, 'lang');
  assert.equal(langHidden.archived, true);
  assert.equal(langHidden.activity, 'resting');
  assert.equal(langHidden.number, '');
  delete process.env.ACTIVITY_WINDOW_MIN;

  const fresh = await json('/api/state');
  for (const id of ['social', 'routines']) {
    const agent = agentOf(fresh.body, id);
    assert.equal(agent.archived, false, id);
    assert.equal(agent.activity, 'resting', id);
    assert.equal(agent.currentTask, null, id);
    assert.equal(agent.lastSeenAt, null, id);
  }
  assert.equal(agentOf(fresh.body, 'social').number, '11');
  assert.equal(agentOf(fresh.body, 'routines').number, '12');

  const socialBeat = await json('/api/agents/social/heartbeat', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ note: 'Смотрю охваты' }),
  });
  assert.equal(socialBeat.status, 200);
  assert.equal(socialBeat.body.activity, 'working');
  assert.equal(socialBeat.body.currentTask, 'Смотрю охваты');
  const socialNow = agentOf((await json('/api/state')).body, 'social');
  assert.equal(socialNow.activity, 'working');
  assert.equal(socialNow.currentTask, 'Смотрю охваты');

  const routineTask = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-act' },
    body: JSON.stringify({ agent: 'routines', text: 'Собрать утреннюю рутину', fromAgentId: 'grok' }),
  });
  assert.equal(routineTask.status, 201);
  assert.equal(agentOf((await json('/api/state')).body, 'routines').activity, 'working');
  const acceptedRoutine = await json(`/api/orders/${routineTask.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-act' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(acceptedRoutine.status, 200);
  const routinesNow = agentOf((await json('/api/state')).body, 'routines');
  assert.equal(routinesNow.activity, 'working');
  assert.equal(routinesNow.currentTask, 'Собрать утреннюю рутину');
});
