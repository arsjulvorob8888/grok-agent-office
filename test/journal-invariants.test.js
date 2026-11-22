'use strict';

// Инварианты журнала и «Процессов сейчас».
// Сетка статусов и возрастов фиксированная, не случайная: проверяется свойство, а не один пример.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Feed = require('../public/js/feed');
const { STATUS_HOLD_MS } = require('../lib/activity');

const NOW = Date.parse('2026-11-22T15:00:00.000Z');
const HOLD = STATUS_HOLD_MS;
const root = path.join(__dirname, '..');

const ORDER_STATUSES = ['sent', 'accepted', 'in_progress', 'done', 'cancelled', 'failed'];
const FORWARD = [null, 200, 204, 500];
const OUTBOX = [null, 'queued', 'delivered', 'cancelled'];
const AGES = [0, 1000, HOLD - 1, HOLD, HOLD + 1, 115 * 60 * 60 * 1000];

function at(ms) {
  return new Date(NOW - ms).toISOString();
}

function freshStamp(task, agent, routine) {
  const stamps = [];
  const push = (iso) => {
    const t = Date.parse(iso || '');
    if (Number.isFinite(t)) stamps.push(t);
  };
  if (task) {
    const status = task.orderStatus || 'sent';
    if (status === 'accepted' || status === 'in_progress') push(task.createdAt);
    for (const entry of task.history || []) {
      if (entry && (entry.status === 'accepted' || entry.status === 'in_progress')) push(entry.at);
    }
  }
  if (agent) {
    push(agent.lastSeenAt);
    push(agent.doingSince);
    push(agent.lastStatusAt);
    push(agent.lastDashboardAt);
    if (agent.live && agent.live.status === 'working') {
      const until = Date.parse(agent.live.until || '');
      if (Number.isFinite(until) && until > NOW) stamps.push(NOW);
    }
  }
  if (routine) push(routine.startedAt);
  if (!stamps.length) return NaN;
  return Math.max(...stamps);
}

function isFinal(task, messages) {
  if (!task) return true;
  const status = task.orderStatus || 'sent';
  if (status === 'done' || status === 'cancelled' || status === 'failed') return true;
  if (task.status === 'выполнена' || task.status === 'отменён') return true;
  if (task.answered === true || task.answerStatus === 'answered') return true;
  if ((messages || []).some((message) => message && message.role === 'agent' && message.taskId === task.id)) return true;
  const code = Number(task.forwardStatus);
  const delivered = task.outboxStatus === 'delivered' || (Number.isInteger(code) && code >= 200 && code < 300);
  return delivered && status !== 'accepted' && status !== 'in_progress';
}

function assertPanel(tasks, routines, agents, messages) {
  const panel = Feed.processPanel(tasks, routines, NOW, { agents, messages });
  assert.equal(panel.total, panel.entries.length);
  assert.equal(panel.total, panel.live.length + panel.pulses.length);
  const shown = new Set(panel.entries.map((entry) => entry.id));
  for (const task of tasks) {
    if (!isFinal(task, messages)) continue;
    assert.equal(shown.has(task.id), false, task.id);
    assert.equal(panel.undelivered.some((entry) => entry.id === task.id), false, task.id);
  }
  for (const entry of panel.entries) {
    const task = tasks.find((item) => item.id === entry.id) || null;
    const routine = routines.find((item) => item.id === entry.id) || null;
    const agentId = (task && (task.agentId || task.agent)) || (routine && routine.agentId);
    const agent = agents.find((item) => item.id === agentId) || null;
    const stamp = freshStamp(task, agent, routine);
    assert.equal(Number.isFinite(stamp), true, entry.id);
    assert.equal(NOW - stamp < HOLD, true, entry.id);
    if (agent) assert.equal(NOW - stamp < HOLD, true);
  }
  return panel;
}

test('инвариант: финальный приказ не попадает в процессы', () => {
  const tasks = [];
  let n = 0;
  for (const orderStatus of ORDER_STATUSES) {
    for (const forwardStatus of FORWARD) {
      for (const outboxStatus of OUTBOX) {
        for (const answered of [false, true]) {
          for (const age of AGES) {
            n += 1;
            const id = `t-${n}`;
            tasks.push({
              id,
              orderStatus,
              forwardStatus,
              outboxStatus,
              answered,
              answerStatus: answered ? 'answered' : null,
              agentId: 'dev',
              text: answered ? 'Ответ владельца' : 'Приказ',
              createdAt: at(age),
              history: [{ status: orderStatus === 'sent' ? 'sent' : orderStatus, at: at(age) }],
            });
          }
        }
      }
    }
  }
  const messages = tasks.filter((task) => task.answered).map((task) => ({
    id: `m-${task.id}`,
    role: 'agent',
    taskId: task.id,
    text: 'ответ',
  }));
  const agents = [
    { id: 'dev', activity: 'working', lastSeenAt: at(0) },
    { id: 'social', activity: 'working', lastSeenAt: at(HOLD + 1) },
  ];
  const panel = assertPanel(tasks, [], agents, messages);
  assert.equal(panel.entries.some((entry) => isFinal(tasks.find((task) => task.id === entry.id), messages)), false);
  assert.ok(tasks.some((task) => isFinal(task, messages)));
  assert.equal(assertPanel([], [], [], []).total, 0);
});

test('инвариант: счётчик равен числу записей, включая ноль', () => {
  const worlds = [
    [[], []],
    [[{ id: 'done', orderStatus: 'done', forwardStatus: 200, agentId: 'dev', createdAt: at(0) }], []],
    [[{ id: 'sent', orderStatus: 'sent', forwardStatus: 200, outboxStatus: 'delivered', agentId: 'social', createdAt: at(0) }], []],
    [[
      { id: 'work', orderStatus: 'in_progress', agentId: 'dev', createdAt: at(1000), history: [{ status: 'in_progress', at: at(1000) }] },
      { id: 'old', orderStatus: 'accepted', agentId: 'qa', createdAt: at(HOLD), history: [{ status: 'accepted', at: at(HOLD) }] },
    ], [
      { id: 'hot', active: true, finishedAt: null, agentId: 'dev', startedAt: at(1000), name: 'Свежий' },
      { id: 'cold', active: true, finishedAt: null, agentId: 'qa', startedAt: at(HOLD + 1), name: 'Спит' },
    ]],
  ];
  for (const [tasks, routines] of worlds) {
    const panel = assertPanel(tasks, routines, [
      { id: 'dev', activity: 'working', lastSeenAt: at(1000) },
      { id: 'qa', activity: 'resting', lastSeenAt: at(HOLD + 1) },
      { id: 'social', activity: 'working', lastSeenAt: at(HOLD) },
    ], []);
    assert.equal(panel.total, panel.entries.length);
  }
  const source = fs.readFileSync(path.join(root, 'public/js/processes.js'), 'utf8');
  assert.match(source, /const total = panel\.total/);
  assert.match(source, /count\.textContent = String\(total\)/);
  assert.match(source, /badge\.textContent = String\(total\)/);
  assert.equal(Feed.processPanel([], [], NOW).total, 0);
});

test('инвариант: старше 15 минут нет ни записи, ни агента в работе', () => {
  assert.equal(Feed.PROCESS_HOLD_MS, HOLD);
  for (const age of [HOLD, HOLD + 1, 20 * 60 * 1000, 115 * 60 * 60 * 1000]) {
    for (const orderStatus of ['accepted', 'in_progress', 'sent']) {
      const task = {
        id: 'stale',
        orderStatus,
        forwardStatus: orderStatus === 'sent' ? 200 : null,
        outboxStatus: orderStatus === 'sent' ? 'delivered' : null,
        agentId: 'dev',
        createdAt: at(age),
        history: [{ status: orderStatus, at: at(age) }],
      };
      const agent = { id: 'dev', activity: 'working', lastSeenAt: at(age), doingSince: at(age) };
      const routine = { id: 'pulse', active: true, finishedAt: null, agentId: 'dev', startedAt: at(age), name: 'Старый' };
      const panel = assertPanel([task], [routine], [agent], []);
      assert.equal(panel.total, 0, `${orderStatus} ${age}`);
    }
  }
  const fresh = assertPanel([
    {
      id: 'fresh',
      orderStatus: 'in_progress',
      agentId: 'dev',
      createdAt: at(HOLD),
      history: [{ status: 'in_progress', at: at(HOLD) }],
    },
  ], [], [{ id: 'dev', activity: 'resting', lastSeenAt: at(HOLD), live: { status: 'working', until: new Date(NOW + 1000).toISOString() } }], []);
  assert.equal(fresh.entries.some((entry) => entry.id === 'fresh'), true);
});

test('инвариант: доставленный приказ везде подписан «Доставлено»', () => {
  const wrong = ['Отправлена', '', 'В очереди', null];
  for (let code = 200; code < 300; code += 1) {
    for (const deliveryLabel of wrong) {
      const task = {
        id: 't-3',
        orderStatus: 'sent',
        forwardStatus: code,
        outboxStatus: 'delivered',
        deliveryLabel,
        history: [{ status: 'sent', at: at(0) }],
      };
      const shown = [
        Feed.deliveryCaption(code, { outboxStatus: 'delivered', route: 'env' }),
        Feed.taskDeliveryLabel(task),
        Feed.taskBadge(task)[1],
        Feed.historyCaption(task, task.history[0]),
      ];
      for (const label of shown) assert.equal(label, 'Доставлено', String(code));
      assert.equal(new Set(shown).size, 1);
    }
  }
  for (const code of [199, 300, 500, null]) {
    const task = { id: 't-x', orderStatus: 'sent', forwardStatus: code, outboxStatus: 'delivered', history: [{ status: 'sent', at: at(0) }] };
    assert.notEqual(Feed.taskDeliveryLabel(task), 'Доставлено');
    assert.notEqual(Feed.taskBadge(task)[1], 'Доставлено');
    assert.notEqual(Feed.historyCaption(task, task.history[0]), 'Доставлено');
  }
  const queued = { id: 't-q', orderStatus: 'sent', forwardStatus: 200, outboxStatus: 'queued', history: [{ status: 'sent', at: at(0) }] };
  assert.equal(Feed.taskDeliveryLabel(queued), 'Отправлена');
  assert.equal(Feed.taskBadge(queued)[1], 'Отправлена');
  assert.equal(Feed.historyCaption(queued, queued.history[0]), 'Отправлена');
});
