'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render, isFinance, stats } = require('../public/js/desk.js');

function tags(html) {
  return html.match(/<[^>]+>/g) || [];
}

test('анализ экранируется, графики — svg', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const html = render({
    agent: { id: 'army', name: 'Военная служба', number: '2' },
    now,
    tasks: [{
      id: 't-1',
      agent: 'army',
      agentId: 'army',
      fromAgentId: 'grok',
      text: 'Проверить <script>alert(1)</script>',
      orderStatus: 'done',
      createdAt: '2026-11-17T08:00:00.000Z',
      history: [{ status: 'done', at: '2026-11-17T10:00:00.000Z', note: 'готово' }],
    }],
    analysis: { text: '<img src=x onerror=alert(1)>', updatedAt: '2026-11-17T11:00:00.000Z' },
    nameOf: (id) => (id === 'grok' ? 'Путин' : id),
  });
  assert.match(html, /<svg/);
  assert.match(html, /Выполнено по дням/);
  assert.match(html, /Время выполнения/);
  assert.match(html, /Путин → army/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const tagText = tags(html).join('\n');
  assert.doesNotMatch(tagText, /<script/i);
  assert.doesNotMatch(tagText, /<img/i);
  assert.doesNotMatch(tagText, /\son\w+\s*=/i);
  assert.equal(isFinance({ id: 'invest', parentId: 'finance' }), true);
  assert.equal(isFinance({ id: 'army' }), false);
});

test('финансы показывают только проценты', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const tasks = [
    { id: 'a', agent: 'finance', orderStatus: 'done', progress: 100, createdAt: '2026-11-17T08:00:00.000Z', history: [{ status: 'done', at: '2026-11-17T09:00:00.000Z' }] },
    { id: 'b', agent: 'finance', orderStatus: 'in_progress', progress: 40, createdAt: '2026-11-17T08:00:00.000Z', history: [] },
  ];
  const html = render({
    agent: { id: 'finance', name: 'Финансы' },
    tasks,
    now,
    analysis: { text: 'Только доля.' },
    nameOf: (id) => id,
  });
  assert.match(html, /Выполнено<\/div><div class="desk-kpi-value">50%/);
  assert.match(html, /Прогресс<\/div><div class="desk-kpi-value">/);
  assert.match(html, /Доля выполненного по дням/);
  assert.match(html, /Прогресс по дням/);
  assert.doesNotMatch(html, /₽|руб|Всего<\/div>|Время выполнения|задач</);
  const locked = render({ agent: { id: 'analyst', parentId: 'finance' }, tasks, now, locked: true });
  assert.match(locked, /desk-lock/);
  assert.doesNotMatch(locked, /desk-kpi|desk-chart|<svg/);
  const view = stats(tasks, now, true);
  assert.equal(view.donePct, 50);
  assert.ok(view.progSeries.every((n) => n >= 0 && n <= 100));
});
