'use strict';

// Инварианты качества от 22.11, которых не закрывали сетки журнала,
// живые имена и один статус. Глубокие сетки остаются в своих файлах.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Feed = require('../public/js/feed');
const Status = require('../public/js/agent-status');
const Rules = require('../public/js/task-rules');
const Usage = require('../public/js/usage-widget');
const { renderSafeMarkdown } = require('../public/js/markdown');
const { buildDashboard } = require('../lib/agent-dashboard');
const { STATUS_HOLD_MS } = require('../lib/activity');

const root = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-22T15:00:00.000Z');
const HOLD = STATUS_HOLD_MS;

function at(ms) {
  return new Date(NOW - ms).toISOString();
}

test('инвариант: карта, полоса и помещение берут один статус, работающий не тусклый', () => {
  const modes = ['working', 'coordinating', 'waiting', 'resting'];
  for (const mode of modes) {
    const agent = {
      id: mode === 'working' ? 'health' : 'social',
      activity: mode,
      status: 'working',
      now: 'старая отметка',
      deliveryLabel: 'Отправлена',
    };
    const labels = Status.viewLabels(agent);
    assert.equal(labels.map, labels.roster, mode);
    assert.equal(labels.roster, labels.room, mode);
    assert.equal(new Set([labels.map, labels.roster, labels.room, labels.card, labels.dashboard]).size, 1, mode);
    const look = Status.presence(agent);
    const tone = Status.viewStatus(agent);
    assert.equal(look.mode, mode, mode);
    assert.equal(tone.map, look.dot, mode);
    assert.equal(tone.sidebar, look.dot, mode);
    assert.equal(tone.panel, labels.room, mode);
    if (mode === 'working') {
      assert.equal(labels.map, 'Работает');
      assert.equal(look.dot, 'working');
      assert.equal(look.opacity, 1);
      assert.equal(look.filter, 'none');
      assert.equal(look.bright, true);
      assert.notEqual(look.mode, 'resting');
    }
    if (mode === 'resting') {
      assert.equal(look.dot, 'idle');
      assert.ok(look.opacity < 1);
      assert.match(look.filter, /grayscale/);
    }
  }

  const css = fs.readFileSync(path.join(root, 'public/css/activity.css'), 'utf8');
  const bright = css.match(/\.agent\.act-working \.bld,\.agent\.act-working \.fig-wrap,\.agent\.act-working \.fig-body,[\s\S]*?\.agent\.st-working \.bld,\.agent\.st-working \.fig-wrap,\.agent\.st-working \.fig-body\{[^}]+\}/);
  assert.ok(bright, 'у работающего здание и фигурка в одном правиле');
  assert.match(bright[0], /opacity:\s*1/);
  assert.match(bright[0], /filter:\s*none/);
  const idleAt = css.indexOf('.agent.act-idle .bld');
  const workAt = css.indexOf('.agent.act-working .bld');
  assert.ok(idleAt >= 0 && workAt > idleAt, 'яркость работающего идёт после приглушения простоя');
  assert.equal(/\.agent\.act-working[^{]*\{[^}]*opacity:\s*0?\.55/.test(css), false);
});

test('инвариант: тестовый приказ не в процессах, даже если он свежий и in_progress', () => {
  assert.equal(Feed.PROCESS_HOLD_MS, HOLD);
  const fresh = at(1000);
  const stale = at(HOLD);
  const tasks = [
    { id: 'test-work', orderStatus: 'in_progress', text: ' тест ', agentId: 'dev', createdAt: fresh, history: [{ status: 'in_progress', at: fresh }] },
    { id: 'test-upper', orderStatus: 'accepted', text: 'ТЕСТ', agentId: 'dev', createdAt: fresh, history: [{ status: 'accepted', at: fresh }] },
    { id: 'live', orderStatus: 'in_progress', text: 'Сводка', agentId: 'dev', createdAt: fresh, history: [{ status: 'in_progress', at: fresh }] },
    { id: 'old', orderStatus: 'accepted', text: 'Сводка', agentId: 'qa', createdAt: stale, history: [{ status: 'accepted', at: stale }] },
  ];
  const agents = [
    { id: 'dev', activity: 'working', lastSeenAt: fresh },
    { id: 'qa', activity: 'working', lastSeenAt: stale, doingSince: stale },
  ];
  const panel = Feed.processPanel(tasks, [], NOW, { agents, messages: [] });
  assert.deepEqual(panel.entries.map((entry) => entry.id), ['live']);
  assert.equal(panel.total, panel.entries.length);
  assert.equal(panel.entries.some((entry) => /тест/i.test(entry.text || '')), false);
  assert.equal(panel.undelivered.some((entry) => entry.id === 'old' || /тест/i.test(entry.text || '')), false);
});

test('инвариант: тестовые не в активном журнале, счётчик равен карточкам, доставленное — «Доставлено»', () => {
  const tasks = [
    { id: 'live', orderStatus: 'sent', text: 'Сводка', forwardStatus: null },
    { id: 'test-work', orderStatus: 'in_progress', text: ' тест ' },
    { id: 'test-done', orderStatus: 'done', text: 'Тест' },
    { id: 'cancel', orderStatus: 'cancelled', text: 'тест', status: 'отменён' },
    { id: 'done', orderStatus: 'done', text: 'Готово' },
    { id: 'sent', orderStatus: 'sent', text: 'Письмо', forwardStatus: 200, outboxStatus: 'delivered', deliveryLabel: 'Отправлена' },
  ];
  const view = Feed.visibleJournal(tasks);
  assert.deepEqual(view.active.map((task) => task.id), ['live', 'done', 'sent']);
  assert.equal(view.total, view.active.length);
  assert.equal(view.active.some((task) => Rules.isSilentTask(task)), false);
  assert.deepEqual(view.cancelled.map((task) => task.id), ['cancel']);
  assert.equal(view.total === view.cancelled.length, false);

  const delivered = tasks.find((task) => task.id === 'sent');
  assert.equal(Feed.taskDeliveryLabel(delivered), 'Доставлено');
  assert.notEqual(Feed.taskDeliveryLabel(delivered), 'Отправлена');
  assert.equal(Feed.taskBadge(delivered)[1], 'Доставлено');

  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const journal = app.slice(app.indexOf('function renderJournal'), app.indexOf('function taskWord'));
  assert.match(journal, /Feed\.visibleJournal\(/);
  assert.match(journal, /const badge = view\.total/);
  assert.match(journal, /view\.active\.slice\(0,\s*60\)/);
  assert.equal(journal.includes('split.active.slice'), false);
  const panel = app.slice(app.indexOf('function renderPanel'), app.indexOf('function scrollPanelAnchor'));
  assert.match(panel, /TaskRules\.isSilentTask\(t\)/);
});

test('инвариант: счётчик «Ждёт от вас» и активных задач равен числу видимых записей', () => {
  const needs = [];
  const kinds = ['money', 'approval', 'test', null];
  const authors = ['finance', 'invest', 'trading', 'biz', 'qa'];
  let n = 0;
  for (const kind of kinds) {
    for (const fromAgentId of authors) {
      for (const closed of [false, true]) {
        n += 1;
        needs.push({
          id: `need-${n}`,
          kind,
          fromAgentId,
          what: kind === 'test' ? 'ТЕСТ: кнопки' : `вопрос ${n}`,
          closedAt: closed ? at(1000) : null,
          participants: fromAgentId === 'invest' ? ['finance'] : [],
        });
      }
    }
  }
  needs.push({ id: 'need-dup', fromAgentId: 'finance', what: 'один', closedAt: null, participants: ['invest'] });

  const general = Feed.needsForGeneral(needs);
  assert.equal(general.length, general.filter((need) => !need.closedAt && !Feed.isTestNeed(need)).length);
  assert.equal(general.some((need) => Feed.isTestNeed(need) || need.closedAt), false);

  const financeIds = ['finance', 'invest', 'trading', 'biz'];
  const shown = Feed.needsForIds(needs, financeIds);
  const again = Feed.needsForIds(needs, financeIds);
  assert.equal(shown.length, again.length);
  assert.equal(new Set(shown.map((need) => need.id)).size, shown.length);
  assert.equal(shown.some((need) => Feed.isTestNeed(need) || need.closedAt), false);
  const expectIds = needs.filter((need) => {
    if (need.closedAt || Feed.isTestNeed(need)) return false;
    const audience = new Set([need.fromAgentId, ...(need.participants || [])]);
    return financeIds.some((id) => audience.has(id));
  }).map((need) => need.id);
  assert.deepEqual(shown.map((need) => need.id).sort(), [...new Set(expectIds)].sort());

  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const awaits = app.slice(app.indexOf('function panelNeedsHTML'), app.indexOf('function needSolveHref'));
  const badge = app.slice(app.indexOf('function needsOnBadge'), app.indexOf('function paintAwaitBadge'));
  assert.match(awaits, /Feed\.needsForIds\(S\.needs, awaitAgentIds\(agent\.id\)\)/);
  assert.match(badge, /Feed\.needsForIds\(S\.needs, ids\)/);
  const renderNeeds = app.slice(app.indexOf('function renderNeeds'), app.indexOf('function notifyNeed'));
  assert.match(renderNeeds, /const list = Feed\.needsForGeneral/);
  assert.match(renderNeeds, /badge\.textContent = String\(list\.length\)/);
  assert.match(renderNeeds, /pill\.textContent = String\(list\.length\)/);
  assert.match(renderNeeds, /list\.map\(\(n\) => needCardHTML/);

  const texts = ['тест', ' ТЕСТ ', 'Тест', 'Сводка', 'живой приказ'];
  const statuses = ['sent', 'accepted', 'in_progress', 'done', 'cancelled', 'failed'];
  const forwards = [null, 200, 500];
  let visible = 0;
  let counted = 0;
  for (const text of texts) {
    for (const orderStatus of statuses) {
      for (const forwardStatus of forwards) {
        const task = {
          id: `${text}-${orderStatus}-${forwardStatus}`,
          text,
          orderStatus,
          status: orderStatus === 'cancelled' ? 'отменён' : '',
          forwardStatus,
          outboxStatus: forwardStatus === 200 ? 'delivered' : null,
          agentId: 'finance',
        };
        const code = Number(task.forwardStatus);
        const delivered = task.outboxStatus === 'delivered' || (Number.isInteger(code) && code >= 200 && code < 300);
        const status = task.orderStatus || 'sent';
        const final = status === 'done' || status === 'cancelled' || status === 'failed'
          || task.status === 'выполнена' || task.status === 'отменён'
          || (delivered && status !== 'accepted' && status !== 'in_progress');
        const show = !Rules.isSilentTask(task) && !final && (status === 'sent' || status === 'accepted' || status === 'in_progress');
        const got = Feed.countsAsActiveTask(task);
        assert.equal(got, show, task.id);
        if (show) visible += 1;
        if (got) counted += 1;
      }
    }
  }
  assert.equal(counted, visible);
  assert.ok(visible > 0);
});

test('инвариант: отданные тексты без Grok и grokbot, часы в МСК через полночь UTC', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  assert.equal(/\bGrok\b/.test(visible), false);
  assert.equal(visible.includes('grokbot://'), false);

  const labels = [];
  for (const mode of ['working', 'coordinating', 'waiting', 'resting']) {
    labels.push(...Object.values(Status.viewLabels({ activity: mode })));
  }
  for (const code of [null, 200, 204, 500]) {
    labels.push(Feed.deliveryCaption(code));
    labels.push(Feed.deliveryCaption(code, { route: 'env', outboxStatus: code === 200 || code === 204 ? 'delivered' : 'queued' }));
  }
  labels.push(Feed.taskDeliveryLabel({
    orderStatus: 'sent',
    forwardStatus: 200,
    outboxStatus: 'delivered',
    deliveryLabel: 'Отправлена',
  }));
  const usage = Usage.present({
    latest: { usedPct: 96, plan: 'Super', resetsAt: '2026-11-22T21:05:00.000Z', updatedAt: '2026-11-22T20:00:00.000Z' },
  });
  labels.push(usage.label, usage.banner, usage.resetText, usage.updatedText, usage.splitText, usage.plan);
  const markdown = renderSafeMarkdown('Чат grokbot://app/v1/agent?id=1');
  labels.push(markdown);
  const blob = labels.join('\n');
  assert.equal(/\bGrok\b/.test(blob), false, blob);
  assert.equal(blob.includes('grokbot://'), false, markdown);
  assert.match(markdown, /чат агента/);

  const night = '2026-11-22T21:05:00.000Z';
  const before = '2026-11-22T20:59:00.000Z';
  assert.equal(Feed.moscowClock(night), '00:05');
  assert.equal(Feed.formatClockMsk(night, Date.parse(night) + 1000), '00:05 МСК');
  assert.equal(Feed.moscowClock(before), '23:59');
  assert.match(Feed.formatDateTimeMsk(night), /00:05 МСК$/);
  assert.equal(Usage.formatMsk(night), '23.11 00:05 МСК');
  assert.equal(Usage.formatMsk(before), '22.11 23:59 МСК');
  assert.match(Feed.formatProcessStamp(night, Date.parse('2026-11-23T00:05:00.000Z')), /^с 00:05 МСК · /);
  assert.equal(Feed.formatProcessStamp(night, Date.parse('2026-11-23T00:05:00.000Z')).includes('21:05'), false);

  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const dash = buildDashboard({
    agent: { id: 'dev', completed: 0 },
    tasks: [
      { id: 'after', agentId: 'dev', text: 'после полуночи', orderStatus: 'sent', createdAt: night },
      { id: 'before', agentId: 'dev', text: 'до полуночи', orderStatus: 'sent', createdAt: before },
    ],
    messages: [],
    activity: { activity: 'resting' },
    now,
  });
  const byDate = new Map((dash.analytics.days || []).map((row) => [row.date, row.count]));
  assert.equal(byDate.get('2026-11-23'), 1);
  assert.equal(byDate.get('2026-11-22'), 1);
});
