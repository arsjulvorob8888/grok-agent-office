'use strict';

// Инварианты журнала и «Процессов сейчас».
// Сетка статусов и возрастов фиксированная, не случайная: проверяется свойство, а не один пример.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Feed = require('../public/js/feed');
const { columnOf, isDone, buildDashboard } = require('../lib/agent-dashboard');
const { senderName, speakerLabel } = require('../public/js/sender-label');
const { STATUS_HOLD_MS, orderRoute } = require('../lib/activity');

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

test('инвариант: счётчик задач считает только активные', () => {
  const statuses = ['sent', 'accepted', 'in_progress', 'done', 'cancelled', 'failed'];
  const codes = [null, 200, 500];
  const tasks = [];
  for (const orderStatus of statuses) {
    for (const forwardStatus of codes) {
      for (const outboxStatus of [null, 'delivered', 'queued']) {
        tasks.push({
          id: `${orderStatus}-${forwardStatus}-${outboxStatus}`,
          agent: 'finance',
          agentId: 'finance',
          orderStatus,
          forwardStatus,
          outboxStatus,
          status: orderStatus === 'cancelled' ? 'отменён' : '',
          text: 'задача',
        });
      }
    }
  }
  const active = tasks.filter((task) => Feed.countsAsActiveTask(task));
  for (const task of tasks) {
    const code = Number(task.forwardStatus);
    const deliveredOnly = (task.orderStatus || 'sent') === 'sent'
      && (task.outboxStatus === 'delivered' || (Number.isInteger(code) && code >= 200 && code < 300));
    if (task.orderStatus === 'cancelled' || task.orderStatus === 'done' || task.orderStatus === 'failed' || deliveredOnly) {
      assert.equal(active.includes(task), false, task.id);
    }
  }
  assert.equal(active.some((task) => task.orderStatus === 'accepted'), true);
  const finance = active.filter((task) => (task.agentId || task.agent) === 'finance');
  assert.equal(finance.length, active.length);
  assert.equal(finance.some((task) => task.orderStatus === 'cancelled'), false);
});

test('инвариант: отменённые не в «Готово» и не в числе выполненных', () => {
  const tasks = [];
  for (const status of ['отменён', 'выполнена', 'в очереди агента', '']) {
    for (const forwardStatus of [null, 200, 500]) {
      tasks.push({
        id: `c-${status}-${forwardStatus}`,
        agentId: 'social',
        orderStatus: 'cancelled',
        status,
        forwardStatus,
        text: 'тест',
      });
    }
  }
  const doneTasks = tasks.filter((task) => task.orderStatus === 'done');
  const view = buildDashboard({
    agent: { id: 'social', completed: 0 },
    tasks: tasks.concat([{ id: 'ok', agentId: 'social', orderStatus: 'done', status: 'выполнена', text: 'готово' }]),
    messages: [],
    activity: {},
    now: NOW,
  });
  for (const task of tasks) {
    assert.notEqual(columnOf(task), 'done', task.id);
    assert.equal(isDone(task), false, task.id);
    assert.equal(view.tasks.find((row) => row.id === task.id).column === 'done', false, task.id);
  }
  assert.equal(view.metrics.done, 1);
  assert.equal(view.tasks.filter((row) => row.column === 'done').length, 1);
  assert.equal(doneTasks.length, 0);
});

test('инвариант: «Ответ получен» только при ответе и доставке 2xx', () => {
  const answers = [null, '', 'Цифры готовы'];
  const statuses = ['queued', 'delivered', 'cancelled'];
  const codes = [null, 199, 200, 204, 500];
  const types = ['answer', 'close', 'owner_task'];
  for (const answer of answers) {
    for (const status of statuses) {
      for (const code of codes) {
        for (const type of types) {
          const need = { id: 'need-finance', what: 'Сводка', answer, answers: answer ? [{ text: answer }] : [] };
          const task = {
            id: 't-answer',
            needId: 'need-finance',
            text: `Ответ Арсения на «Сводка»: ${answer || ''}`,
            forwardStatus: code,
            orderStatus: 'sent',
          };
          const outbox = [{
            id: 'ob-1',
            status,
            lastStatus: code,
            taskId: 't-answer',
            payload: { needId: 'need-finance', type },
          }];
          const label = Feed.answerDeliveryCaption(need, [task], outbox);
          if (label === 'Ответ получен агентом') {
            assert.equal(Boolean(answer && String(answer).trim()), true);
            const delivered = status === 'delivered' && type === 'answer' && Number.isInteger(code) && code >= 200 && code < 300
              || (Number.isInteger(code) && code >= 200 && code < 300);
            assert.equal(delivered, true, JSON.stringify({ answer, status, code, type }));
          }
          if (!answer) assert.notEqual(label, 'Ответ получен агентом');
        }
      }
    }
  }
});

test('инвариант: на экране только правда сейчас — старые «Доставлено» и «Выполнено» свёрнуты', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-11-22T16:00:00.000Z');
  const agents = ['social', 'finance', 'qa', 'dev'];
  const ages = [0, DAY - 1, DAY, DAY + 1, 5 * DAY];
  for (const agentId of agents) {
    for (const age of ages) {
      const createdAt = new Date(now - age).toISOString();
      const tasks = [
        {
          id: 'delivered',
          agent: agentId,
          agentId,
          orderStatus: 'sent',
          forwardStatus: 200,
          outboxStatus: 'delivered',
          deliveryLabel: 'Отправлена',
          text: 'Ответ Арсения на «сводку»',
          createdAt,
        },
        {
          id: 'done',
          agent: agentId,
          agentId,
          orderStatus: 'done',
          status: 'выполнена',
          text: 'Готово',
          createdAt,
        },
        {
          id: 'work',
          agent: agentId,
          agentId,
          orderStatus: 'in_progress',
          text: 'В работе',
          createdAt: new Date(now - 5 * DAY).toISOString(),
        },
        {
          id: 'wait',
          agent: agentId,
          agentId,
          orderStatus: 'sent',
          forwardStatus: null,
          outboxStatus: 'queued',
          text: 'Ждёт ответа',
          createdAt: new Date(now - 5 * DAY).toISOString(),
        },
      ];
      const before = tasks.map((task) => task.id).join(',');
      const view = Feed.journalSplit(tasks, now);
      const open = new Set((view.active || []).map((task) => task.id));
      const stale = age > DAY;
      assert.equal(open.has('delivered'), !stale, `${agentId} ${age} delivered`);
      assert.equal(open.has('done'), !stale, `${agentId} ${age} done`);
      assert.equal(open.has('work'), true, `${agentId} work`);
      assert.equal(open.has('wait'), true, `${agentId} wait`);
      assert.equal(view.badge, view.active.length, `${agentId} ${age}`);
      assert.equal(tasks.map((task) => task.id).join(','), before, `${agentId} ${age}`);
      if (stale) {
        const folded = (view.delivered || []).map((task) => task.id).sort();
        assert.deepEqual(folded, ['delivered', 'done'], `${agentId} ${age}`);
      }
    }
  }
  const quiet = Feed.journalSplit([
    {
      id: 't-3',
      agentId: 'finance',
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      text: 'Ответ финансам',
      createdAt: '2026-11-17T14:00:00.000Z',
    },
    {
      id: 't-4',
      agentId: 'social',
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      text: 'Ответ соцсетям',
      createdAt: '2026-11-17T14:00:00.000Z',
    },
    {
      id: 't-2',
      agentId: 'qa',
      orderStatus: 'cancelled',
      status: 'отменён',
      text: 'тест',
      createdAt: '2026-11-17T08:00:00.000Z',
    },
  ], now);
  assert.equal(quiet.active.length, 0);
  assert.equal(quiet.badge, 0);
  assert.equal(quiet.badge, quiet.active.length);
  assert.equal(quiet.empty, 'Активных заданий нет');
  assert.equal(quiet.delivered.length, 2);
  assert.equal(quiet.cancelled.length, 1);
});

test('инвариант: реплика Арсения подписана «Вы», маршрут приказа остаётся «Путин →»', () => {
  for (const id of ['owner', '', null]) {
    assert.equal(speakerLabel(id), 'Вы');
    assert.equal(senderName(id), 'Путин');
  }
  const route = orderRoute({ fromAgentId: 'owner', agentId: 'finance', agent: 'finance' }, () => 'Финансы');
  assert.match(route, /^Путин → /);
  assert.equal(route.includes('Вы →'), false);
  const roles = ['owner', 'agent', 'system'];
  for (const role of roles) {
    const who = role === 'owner' ? speakerLabel('owner') : role;
    if (role === 'owner') assert.equal(who, 'Вы');
  }
});
