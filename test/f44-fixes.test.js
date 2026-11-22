'use strict';

// Прод-формы после #44: пустой answer у закрытой нужды и «1 Задач всего» на дашборде.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Feed = require('../public/js/feed');
const { buildDashboard, columnOf, isDone } = require('../lib/agent-dashboard');

const NOW = Date.parse('2026-11-22T16:00:00.000Z');

function prodNeed(id, what) {
  return {
    id,
    what,
    closedAt: '2026-11-17T14:00:00.000Z',
    answer: null,
    answeredAt: null,
    answerStatus: 'answered',
    answers: [],
    status: 'closed',
  };
}

function prodTask(id, need) {
  return {
    id,
    needId: need.id,
    agentId: need.id === 'need-finance' ? 'finance' : 'social',
    orderStatus: 'sent',
    forwardStatus: 200,
    outboxStatus: 'delivered',
    text: `Ответ Арсения на «${need.what}»: цифры с прода`,
    createdAt: '2026-11-17T14:05:00.000Z',
  };
}

test('инвариант: «Ответ получен» только при answer и 2xx, ответ в задаче подписан иначе', () => {
  const forms = [
    prodNeed('need-finance', 'Финансовая сводка'),
    prodNeed('need-social', 'Пост в соцсети'),
  ];
  for (const need of forms) {
    const task = prodTask(need.id === 'need-finance' ? 't-3' : 't-4', need);
    const outbox = [{
      id: `ob-${task.id}`,
      status: 'delivered',
      lastStatus: 200,
      taskId: task.id,
      payload: { needId: need.id, type: 'answer', text: task.text },
    }];
    const label = Feed.answerDeliveryCaption(need, [task], outbox);
    assert.notEqual(label, 'Ответ получен агентом', need.id);
    assert.equal(label, 'Ваш ответ доставлен агенту', need.id);
    assert.equal(Feed.taskAnswerText(need, task), 'цифры с прода');
    assert.equal(JSON.stringify({ answerDeliveryLabel: label, answer: need.answer }).includes('цифры с прода'), false);
    assert.equal(need.answer, null);
    assert.equal(need.answeredAt, null);

    const withAnswer = { ...need, answer: 'цифры с прода', answeredAt: need.closedAt };
    assert.equal(Feed.answerDeliveryCaption(withAnswer, [task], outbox), 'Ответ получен агентом');

    const quiet = Feed.answerDeliveryCaption({ ...need, answerStatus: null }, [], []);
    assert.equal(quiet, null, need.id);

    const replied = {
      ...task,
      answeredAt: '2026-11-17T15:00:00.000Z',
      orderStatus: 'in_progress',
    };
    assert.notEqual(Feed.answerDeliveryCaption(need, [replied], outbox), 'Ответ получен агентом');
    assert.equal(Feed.replyWaitCaption([replied], [], replied.agentId), '');
    assert.equal(Feed.countsAsActiveTask(replied), false);
  }

  const answers = [null, '', 'есть'];
  const codes = [null, 200, 500];
  for (const answer of answers) {
    for (const code of codes) {
      const need = { id: 'need-x', what: 'Вопрос', answer, answeredAt: answer ? NOW : null, closedAt: NOW };
      const task = {
        id: 't-x',
        needId: 'need-x',
        forwardStatus: code,
        outboxStatus: code === 200 ? 'delivered' : 'queued',
        text: `Ответ Арсения на «Вопрос»: ${answer || 'из задачи'}`,
      };
      const label = Feed.answerDeliveryCaption(need, [task], []);
      if (label === 'Ответ получен агентом') {
        assert.notEqual(answer, null);
        assert.notEqual(String(answer).trim(), '');
        assert.equal(code, 200);
      }
    }
  }
});

function noiseTasks(agentId) {
  return [
    {
      id: 't-2',
      agent: agentId,
      agentId,
      orderStatus: 'cancelled',
      status: 'в очереди агента',
      delivery: 'queue',
      text: 'отменённая t-2',
      createdAt: '2026-11-17T08:00:00.000Z',
    },
    {
      id: 't-2-status',
      agent: agentId,
      agentId,
      orderStatus: 'sent',
      status: 'отменён',
      text: 'отмена только в status',
      createdAt: '2026-11-17T08:10:00.000Z',
    },
    {
      id: 't-delivered',
      agent: agentId,
      agentId,
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      status: 'отправлена Путину',
      text: 'доставленная',
      createdAt: '2026-11-17T09:00:00.000Z',
    },
    {
      id: 't-delivered-label',
      agent: agentId,
      agentId,
      orderStatus: 'sent',
      deliveryLabel: 'Доставлено',
      text: 'подпись доставки',
      createdAt: '2026-11-17T09:10:00.000Z',
    },
    {
      id: 't-delivered-outbox',
      agent: agentId,
      agentId,
      orderStatus: 'sent',
      outboxStatus: 'delivered',
      forwardStatus: null,
      text: 'outbox delivered',
      createdAt: '2026-11-17T09:20:00.000Z',
    },
  ];
}

function liveTasks(agentId, count) {
  const tasks = [];
  for (let i = 0; i < count; i += 1) {
    tasks.push({
      id: `live-${agentId}-${i}`,
      agent: agentId,
      agentId,
      orderStatus: i % 2 === 0 ? 'in_progress' : 'accepted',
      text: `живая ${i}`,
      createdAt: '2026-11-22T10:00:00.000Z',
      status: 'в работе',
    });
  }
  return tasks;
}

test('инвариант: числа обзора равны видимым карточкам, слово склоняется', () => {
  assert.equal(Feed.ruCount(1, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(Feed.ruCount(2, 'задача', 'задачи', 'задач'), 'задачи');
  assert.equal(Feed.ruCount(5, 'задача', 'задачи', 'задач'), 'задач');
  assert.equal(Feed.ruCount(11, 'задача', 'задачи', 'задач'), 'задач');
  assert.equal(Feed.ruCount(21, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(Feed.ruCount(0, 'задача', 'задачи', 'задач'), 'задач');

  const agents = ['qa', 'finance', 'social', 'dev', 'advisor', 'health', 'army', 'routines'];
  const words = { 1: 'задача', 2: 'задачи', 5: 'задач' };
  for (const agentId of agents) {
    const onlyNoise = buildDashboard({
      agent: { id: agentId, name: agentId, completed: 0 },
      tasks: noiseTasks(agentId),
      messages: [],
      activity: { activity: 'resting' },
      now: NOW,
    });
    assert.equal(onlyNoise.metrics.total, 0, agentId);
    assert.equal(onlyNoise.metrics.done, 0, agentId);
    assert.equal(onlyNoise.metrics.inProgress, 0, agentId);
    assert.equal(onlyNoise.analytics.byStatus, null, agentId);
    assert.equal(onlyNoise.analytics.days, null, agentId);
    assert.equal(Feed.ruCount(onlyNoise.metrics.total, 'задача', 'задачи', 'задач'), 'задач', agentId);
    assert.equal(onlyNoise.tasks.find((task) => task.id === 't-2').column, 'cancelled', agentId);
    assert.equal(columnOf(noiseTasks(agentId)[0]), 'cancelled', agentId);
    assert.equal(isDone(noiseTasks(agentId)[0]), false, agentId);

    for (const count of [1, 2, 5]) {
      const tasks = liveTasks(agentId, count).concat(noiseTasks(agentId));
      const view = buildDashboard({
        agent: { id: agentId, name: agentId, completed: 0 },
        tasks,
        messages: [],
        activity: { activity: 'resting' },
        now: NOW,
      });
      const visible = view.tasks.filter((task) => task.column === 'new' || task.column === 'work' || task.column === 'done');
      const hidden = view.tasks.filter((task) => task.column === 'cancelled' || task.column === 'delivered');
      assert.equal(hidden.length, noiseTasks(agentId).length, `${agentId} ${count}`);
      assert.equal(view.metrics.total, visible.length, `${agentId} ${count}`);
      assert.equal(view.metrics.total, count, `${agentId} ${count}`);
      assert.equal(Feed.ruCount(view.metrics.total, 'задача', 'задачи', 'задач'), words[count], `${agentId} ${count}`);
      assert.equal(view.metrics.inProgress, visible.filter((task) => task.column === 'work').length, `${agentId} ${count}`);
      assert.equal(view.metrics.inProgress, count, `${agentId} ${count}`);
      assert.equal(view.metrics.done, 0, `${agentId} ${count}`);
      const statusSum = Object.values(view.analytics.byStatus).reduce((sum, value) => sum + value, 0);
      assert.equal(statusSum, visible.length, `${agentId} ${count}`);
      const daySum = view.analytics.days.reduce((sum, day) => sum + day.count, 0);
      assert.equal(daySum, visible.length, `${agentId} ${count}`);
      for (const task of noiseTasks(agentId)) {
        assert.equal(Feed.countsAsActiveTask(task), false, `${agentId} ${task.id}`);
        assert.equal(visible.some((row) => row.id === task.id), false, `${agentId} ${task.id}`);
      }
    }

    const withDone = buildDashboard({
      agent: { id: agentId, name: agentId, completed: 0 },
      tasks: liveTasks(agentId, 1).concat(noiseTasks(agentId), [{
        id: `done-${agentId}`,
        agent: agentId,
        agentId,
        orderStatus: 'done',
        status: 'выполнена',
        text: 'готово',
        createdAt: '2026-11-22T11:00:00.000Z',
      }]),
      messages: [],
      activity: {},
      now: NOW,
    });
    assert.equal(withDone.metrics.total, 2, agentId);
    assert.equal(withDone.metrics.done, 1, agentId);
    assert.equal(withDone.metrics.inProgress, 1, agentId);
    assert.equal(Feed.ruCount(withDone.metrics.total, 'задача', 'задачи', 'задач'), 'задачи', agentId);
  }
});
