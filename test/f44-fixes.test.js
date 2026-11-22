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

test('инвариант: числа обзора равны видимым карточкам, слово склоняется', () => {
  assert.equal(Feed.ruCount(1, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(Feed.ruCount(2, 'задача', 'задачи', 'задач'), 'задачи');
  assert.equal(Feed.ruCount(5, 'задача', 'задачи', 'задач'), 'задач');
  assert.equal(Feed.ruCount(11, 'задача', 'задачи', 'задач'), 'задач');
  assert.equal(Feed.ruCount(21, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(Feed.ruCount(0, 'задача', 'задачи', 'задач'), 'задач');

  const tasks = [
    {
      id: 't-3',
      agent: 'finance',
      agentId: 'finance',
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      text: 'Ответ Арсения на «Финансовая сводка»: цифры',
      createdAt: '2026-11-17T14:05:00.000Z',
      status: 'отправлена Путину',
    },
    {
      id: 't-live',
      agent: 'finance',
      agentId: 'finance',
      orderStatus: 'in_progress',
      forwardStatus: 200,
      text: 'Сверяю отчёт',
      createdAt: '2026-11-22T10:00:00.000Z',
      status: 'в работе',
    },
    {
      id: 't-cancel',
      agent: 'finance',
      agentId: 'finance',
      orderStatus: 'cancelled',
      status: 'отменён',
      text: 'тест',
      createdAt: '2026-11-22T09:00:00.000Z',
    },
  ];
  const view = buildDashboard({
    agent: { id: 'finance', name: 'Финансы', completed: 0 },
    tasks,
    messages: [],
    activity: { activity: 'resting' },
    now: NOW,
  });
  const visible = view.tasks.filter((task) => task.column === 'new' || task.column === 'work' || task.column === 'done');
  assert.equal(view.tasks.find((task) => task.id === 't-3').column, 'delivered');
  assert.equal(columnOf(tasks[2]), 'cancelled');
  assert.equal(isDone(tasks[2]), false);
  assert.equal(view.metrics.total, visible.length);
  assert.equal(view.metrics.total, 1);
  assert.equal(Feed.ruCount(view.metrics.total, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(view.metrics.inProgress, visible.filter((task) => task.column === 'work').length);
  assert.equal(view.metrics.done, visible.filter((task) => task.orderStatus === 'done').length);
  assert.equal(view.analytics.byStatus.in_progress, 1);
  assert.equal(view.analytics.byStatus.sent, 0);
  assert.equal(view.analytics.byStatus.done, 0);
  const daySum = view.analytics.days.reduce((sum, day) => sum + day.count, 0);
  assert.equal(daySum, visible.length);
});
