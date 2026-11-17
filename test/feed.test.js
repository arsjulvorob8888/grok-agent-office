'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Feed = require('../public/js/feed.js');

const now = Date.parse('2026-11-17T12:00:00.000Z');

function fixture() {
  const tasks = [
    { id: 'p', agent: 'devops', agentId: 'devops', fromAgentId: 'grok', parentOrderId: null, text: 'родитель' },
    { id: 'c', agent: 'qa', agentId: 'qa', fromAgentId: 'devops', parentOrderId: 'p', text: 'потомок' },
    { id: 'o', agent: 'poker', agentId: 'poker', fromAgentId: 'owner', parentOrderId: null, text: 'чужой' },
  ];
  const messages = [
    { id: 'm1', agentId: 'devops', role: 'owner', text: 'приказ', taskId: 'p', source: 'app' },
    { id: 'm2', agentId: 'qa', role: 'agent', fromAgentId: 'devops', text: 'взял', taskId: 'c' },
    { id: 'm3', agentId: 'poker', role: 'agent', text: 'стол' },
    { id: 'm4', agentId: 'dev', role: 'agent', toAgentId: 'qa', text: 'глянь' },
  ];
  const needs = [
    { id: 'need-finance', fromAgentId: 'finance', what: 'вопросы', closedAt: null, stale: false },
    { id: 'need-render-api', fromAgentId: 'devops', what: 'ключ', closedAt: '2026-11-17T11:00:00.000Z' },
    { id: 'old', fromAgentId: 'army', what: 'давно', closedAt: '2000-01-01T00:00:00.000Z' },
    { id: 'need-academy', fromAgentId: 'grok', what: 'академия', closedAt: null, stale: true, urgency: 'high' },
  ];
  return { tasks, messages, needs };
}

test('приказ виден отправителю, исполнителю и цепочке, чужой агент его не видит', () => {
  const { tasks } = fixture();
  const ids = (agentId) => Feed.ordersForAgent(tasks, agentId).map((t) => t.id);
  assert.deepEqual(ids('grok'), ['p', 'c']);
  assert.deepEqual(ids('devops'), ['p', 'c']);
  assert.deepEqual(ids('qa'), ['p', 'c']);
  assert.deepEqual(ids('poker'), ['o']);
  assert.deepEqual(ids('army'), []);
  assert.equal(Feed.seesOrder(tasks[0], tasks, 'poker'), false);
  assert.equal(Feed.orderDirection(tasks[0], 'grok', tasks), 'out');
  assert.equal(Feed.orderDirection(tasks[0], 'devops', tasks), 'in');
  assert.equal(Feed.orderDirection(tasks[1], 'devops', tasks), 'out');
  assert.equal(Feed.orderDirection(tasks[1], 'qa', tasks), 'in');
  assert.equal(Feed.orderDirection(tasks[0], 'qa', tasks), 'in');
  assert.equal(Feed.orderDirection(tasks[1], 'grok', tasks), 'out');
});

test('сообщение видят отправитель и адресат, посторонний — нет', () => {
  const { tasks, messages } = fixture();
  const ids = (agentId) => Feed.messagesForAgent(messages, tasks, agentId).map((m) => m.id);
  assert.deepEqual(ids('grok'), ['m1']);
  assert.deepEqual(ids('devops'), ['m1', 'm2']);
  assert.deepEqual(ids('qa'), ['m2', 'm4']);
  assert.deepEqual(ids('dev'), ['m4']);
  assert.deepEqual(ids('poker'), ['m3']);
  assert.deepEqual(ids('army'), []);
  assert.equal(Feed.seesMessage(messages[2], tasks, 'devops'), false);
});

test('пункт «нужно» видит автор, недавнее закрытое тоже, чужой и давнее — нет', () => {
  const { needs } = fixture();
  const ids = (agentId) => Feed.needsForAgent(needs, agentId, now).map((n) => n.id);
  assert.deepEqual(ids('finance'), ['need-finance']);
  assert.deepEqual(ids('devops'), ['need-render-api']);
  assert.deepEqual(ids('grok'), ['need-academy']);
  assert.deepEqual(ids('army'), []);
  assert.deepEqual(ids('poker'), []);
  assert.deepEqual(Feed.needsForGeneral(needs).map((n) => n.id), ['need-finance', 'need-academy']);
  assert.equal(Feed.openNeedCount(needs, 'devops'), 0);
  assert.equal(Feed.openNeedCount(needs, 'finance'), 1);
  assert.equal(Feed.openNeedCount(needs, 'grok'), 1);
});

test('число в общем виде и в панели совпадает', () => {
  const state = fixture();
  for (const agentId of ['grok', 'devops', 'qa', 'dev', 'poker', 'finance', 'army']) {
    assert.equal(Feed.countsMatch(state, agentId, now), true, agentId);
    assert.equal(
      Feed.ordersForAgent(state.tasks, agentId).length,
      Feed.ordersForGeneral(state.tasks).filter((task) => Feed.seesOrder(task, state.tasks, agentId)).length,
    );
    assert.equal(
      Feed.messagesForAgent(state.messages, state.tasks, agentId).length,
      Feed.messagesForGeneral(state.messages).filter((message) => Feed.seesMessage(message, state.tasks, agentId)).length,
    );
  }
});

test('просроченный пункт не красится как срочный, но остаётся в счётчике', () => {
  const need = { id: 'n', fromAgentId: 'devops', closedAt: null, stale: true, urgency: 'high' };
  assert.equal(Feed.needUrgencyView(need), 'stale');
  assert.equal(Feed.needUrgencyView({ ...need, stale: false }), 'high');
  assert.equal(Feed.needUrgencyView({ ...need, closedAt: '2026-11-17T11:00:00.000Z' }), 'closed');
  assert.equal(Feed.openNeedCount([need], 'devops'), 1);
  assert.equal(Feed.openNeedCount([{ ...need, closedAt: '2026-11-17T11:00:00.000Z' }], 'devops'), 0);
});
