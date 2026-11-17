'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, renderDashboard, safeHttp } = require('../public/js/dashboard.js');

function tags(html) {
  return html.match(/<[^>]+>/g) || [];
}

function assertNeutral(html) {
  const tagText = tags(html).join('\n');
  assert.doesNotMatch(tagText, /<script/i);
  assert.doesNotMatch(tagText, /<img/i);
  assert.doesNotMatch(tagText, /<iframe/i);
  assert.doesNotMatch(tagText, /\son\w+\s*=/i);
  assert.doesNotMatch(tagText, /javascript:/i);
  for (const tag of tags(html)) {
    const href = /href="([^"]*)"/.exec(tag);
    if (!href) continue;
    assert.match(href[1], /^https?:\/\//i);
  }
}

test('markdown оставляет разметку и гасит HTML', () => {
  const html = renderMarkdown([
    '# Заголовок',
    '',
    'Текст **жирный** и *курсив*.',
    '',
    '- первый',
    '- второй',
    '',
    '1. раз',
    '2. два',
    '',
    'Код `const x = 1` и ссылка [отчёт](https://example.com/a?b=1&c=2).',
    '',
    '```',
    '<script>alert(1)</script>',
    '```',
    '',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[плохо](javascript:alert(1))',
    '[ещё](JavaScript:alert(1))',
    '[данные](data:text/html,<script>alert(1)</script>)',
    '[ок](http://example.com/ok)',
  ].join('\n'));

  assert.match(html, /<h1 class="md-h">Заголовок<\/h1>/);
  assert.match(html, /<strong>жирный<\/strong>/);
  assert.match(html, /<em>курсив<\/em>/);
  assert.match(html, /<li>первый<\/li>/);
  assert.match(html, /<ol><li>раз<\/li><li>два<\/li><\/ol>/);
  assert.match(html, /<code>const x = 1<\/code>/);
  assert.match(html, /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(html, /href="http:\/\/example\.com\/ok"/);
  assert.match(html, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /javascript:alert\(1\)/);
  assertNeutral(html);
});

test('дашборд не исполняет блоки и рисует SVG', () => {
  const html = renderDashboard({
    title: 'Сводка <script>',
    updatedAt: '2026-11-17T12:00:00.000Z',
    blocks: [
      { type: 'kpi', label: '<b>P&L</b>', value: '12', unit: '%', trend: 'up', delta: '+1', target: 10 },
      { type: 'chart', title: 'Дни', kind: 'bar', labels: ['Пн', 'Вт'], series: [{ name: 'A', data: [1, 2] }] },
      { type: 'chart', title: 'Линия', kind: 'line', labels: ['Пн', 'Вт'], series: [{ name: 'B', data: [2, 1] }] },
      { type: 'forecast', label: 'Срок', value: 5, horizon: 'день', confidence: 0.5 },
      { type: 'markdown', text: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' },
      { type: 'links', items: [{ label: 'доска', url: 'https://example.com' }, { label: 'xss', url: 'javascript:alert(1)' }] },
    ],
  });
  assert.match(html, /Сводка &lt;script&gt;/);
  assert.match(html, /&lt;b&gt;P&amp;L&lt;\/b&gt;/);
  assert.match(html, /<svg/);
  assert.match(html, /<rect /);
  assert.match(html, /<polyline /);
  assert.match(html, /уверенность 50%/);
  assert.match(html, /href="https:\/\/example\.com\/"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assertNeutral(html);
  assert.match(renderDashboard(null), /Агент ещё не опубликовал дашборд/);
  assert.match(renderDashboard(null), /<details class="dash-example">/);
  assert.match(renderDashboard(null), /Пример шаблона/);
});

test('safeHttp пускает только http и https', () => {
  assert.equal(safeHttp('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHttp('http://example.com'), 'http://example.com/');
  assert.equal(safeHttp('javascript:alert(1)'), '');
  assert.equal(safeHttp('data:text/html,hi'), '');
  assert.equal(safeHttp('//example.com'), '');
  assert.equal(safeHttp('https://user:pass@example.com'), '');
});
