'use strict';

// Стрелка только у открытого поручения: доставленное и отвеченное закрыто
// одним предикатом isOpenOrder. Прямое сообщение владельца — не приказ Путина.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Feed = require('../public/js/feed');
const { orderRoute } = require('../lib/activity');
const retry = require('../lib/outbox-retry');

const NOW = Date.parse('2026-11-22T20:00:00.000Z');

function task(id, extra) {
  return {
    id,
    agent: 'poker',
    agentId: 'poker',
    fromAgentId: 'owner',
    orderStatus: 'sent',
    text: `текст ${id}`,
    createdAt: new Date(NOW - 60 * 1000).toISOString(),
    ...extra,
  };
}

function delivered(extra) {
  return {
    forwardStatus: 200,
    outboxStatus: 'delivered',
    deliveryLabel: 'Доставлено',
    ...extra,
  };
}

test('доставленное и отвеченное не открыто ни через Путина, ни напрямую', () => {
  const viaPutin = task('putin-done', delivered({
    sentRoute: 'putin',
    agent: 'qa',
    agentId: 'qa',
    answeredAt: new Date(NOW - 1000).toISOString(),
  }));
  const viaAgent = task('agent-done', delivered({
    sentRoute: 'agent',
    answeredAt: new Date(NOW - 1000).toISOString(),
  }));
  assert.equal(Feed.isOpenOrder(viaPutin, NOW), false);
  assert.equal(Feed.isOpenOrder(viaAgent, NOW), false);
  assert.equal(Feed.journalSplit([viaPutin, viaAgent], NOW).badge, 0);
});

test('доставленное без ответа сразу не открыто, недоставленное с ответом остаётся', () => {
  const waiting = task('wait', delivered({ sentRoute: 'putin', answeredAt: null }));
  const flying = task('fly', {
    sentRoute: 'agent',
    forwardStatus: null,
    outboxStatus: 'queued',
    answeredAt: new Date(NOW - 1000).toISOString(),
  });
  assert.equal(Feed.isOpenOrder(waiting, NOW), false);
  assert.equal(Feed.journalSplit([waiting], NOW).delivered.some((item) => item.id === 'wait'), true);
  assert.equal(Feed.isOpenOrder(flying, NOW), true);
});

test('прямое сообщение владельца подписывается «Вы →», приказ Путина — «Путин →»', () => {
  const names = (id) => (id === 'poker' ? 'Покер' : id === 'qa' ? 'Тестировщик' : id);
  const direct = orderRoute({
    fromAgentId: 'owner',
    agentId: 'poker',
    sentRoute: 'agent',
  }, names);
  assert.equal(direct, 'Вы → Покер');
  assert.equal(direct.includes('Путин'), false);
  const putin = orderRoute({
    fromAgentId: 'owner',
    agentId: 'qa',
    sentRoute: 'putin',
  }, names);
  assert.equal(putin, 'Путин → Тестировщик');
  const staff = orderRoute({
    fromAgentId: 'grok',
    agentId: 'poker',
    sentRoute: 'agent',
  }, (id) => (id === 'grok' ? 'Путин' : 'Покер'));
  assert.equal(staff, 'Путин → Покер');
  const legacy = orderRoute({ fromAgentId: 'owner', agentId: 'poker' }, names);
  assert.equal(legacy, 'Путин → Покер');
});

test('стрелка смотрит в isOpenOrder и не проверяет доставку отдельно', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/delegation.js'), 'utf8');
  assert.match(source, /isOpenOrder/);
  assert.match(source, /isDirectOwnerMessage/);
  assert.equal(source.includes('answeredAt'), false);
  assert.equal(source.includes('outboxStatus'), false);
});

test('миграция прямого маршрута меняет только признак источника и ничего не удаляет', () => {
  assert.equal(typeof retry.retargetDirectOwnerSource, 'function');
  const tasks = [
    task('t-direct', { sentRoute: 'agent', status: 'отправлена Путину', text: 'прямо с сайта' }),
    task('t-putin', { agent: 'qa', agentId: 'qa', sentRoute: 'putin', status: 'отправлена Путину', text: 'через Путина' }),
    task('t-grok', { fromAgentId: 'grok', sentRoute: 'agent', status: 'отправлена Путину', text: 'настоящий приказ' }),
    task('t-env', { agent: 'dev', agentId: 'dev', sentRoute: 'env', status: 'отправлена Путину', text: 'из окружения' }),
    task('t-box', { status: 'отправлена Путину', text: 'маршрут только в очереди' }),
  ];
  const outbox = [
    { id: 'ob-direct', taskId: 't-direct', status: 'delivered', route: 'agent' },
    { id: 'ob-putin', taskId: 't-putin', status: 'delivered', route: 'putin' },
    { id: 'ob-box', taskId: 't-box', status: 'delivered', route: 'agent' },
  ];
  const ids = tasks.map((item) => item.id).join(',');
  const first = retry.retargetDirectOwnerSource(tasks, outbox);
  assert.equal(tasks.map((item) => item.id).join(','), ids);
  assert.equal(tasks.length, 5);
  assert.equal(outbox.length, 3);
  assert.equal(tasks.find((item) => item.id === 't-direct').status, 'отправлена агенту');
  assert.equal(tasks.find((item) => item.id === 't-direct').text, 'прямо с сайта');
  assert.equal(tasks.find((item) => item.id === 't-direct').fromAgentId, 'owner');
  assert.equal(tasks.find((item) => item.id === 't-putin').status, 'отправлена Путину');
  assert.equal(tasks.find((item) => item.id === 't-grok').status, 'отправлена Путину');
  assert.equal(tasks.find((item) => item.id === 't-env').status, 'отправлена Путину');
  const boxed = tasks.find((item) => item.id === 't-box');
  assert.equal(boxed.status, 'отправлена агенту');
  assert.equal(boxed.sentRoute, 'agent');
  assert.equal(boxed.text, 'маршрут только в очереди');
  assert.equal(first.map((item) => item.id).sort().join(','), 't-box,t-direct');
  const second = retry.retargetDirectOwnerSource(tasks, outbox);
  assert.equal(second.length, 0);
  assert.equal(tasks.length, 5);
  assert.equal(outbox.length, 3);
  assert.equal(boxed.status, 'отправлена агенту');
});
