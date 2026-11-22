'use strict';

// Инварианты: один статус, свой doing на чипе, тихие задачи, опыт, пароль, закрытые тестовые пункты.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Status = require('../public/js/agent-status');
const Rules = require('../public/js/task-rules');
const { activityFor, STATUS_HOLD_MS } = require('../lib/activity');

const VIEWS = ['hierarchy', 'room', 'dashboard', 'card', 'roster', 'map'];
const MODES = ['working', 'coordinating', 'waiting', 'resting'];
const STATUSES = ['working', 'idle', 'waiting', '', null];
const NOWS = ['', 'Жду задач', 'тест', 'Старая отметка', 'Свободен'];
const DELIVERIES = ['', 'В очереди, доставка не подключена', 'Отправлена', 'нет маршрута доставки'];
const DOINGS = ['', 'Пишу модуль', 'сводка советника', 'чужое дело'];

function mix(seed) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n;
  };
}

function pick(rand, list) {
  return list[rand() % list.length];
}

test('все виды показывают одну подпись статуса для любого живого снимка', () => {
  assert.equal(STATUS_HOLD_MS, 15 * 60 * 1000);
  const rand = mix(20261122);
  const expected = {
    working: 'Работает',
    coordinating: 'Координирует',
    waiting: 'Ждёт',
    resting: 'Спит',
  };
  for (let i = 0; i < 64; i += 1) {
    const mode = pick(rand, MODES);
    const agent = {
      id: `a${i}`,
      activity: mode,
      status: pick(rand, STATUSES),
      now: pick(rand, NOWS),
      doing: pick(rand, DOINGS),
      currentTask: pick(rand, DOINGS),
      deliveryLabel: pick(rand, DELIVERIES),
    };
    const labels = Status.viewLabels(agent);
    const values = VIEWS.map((view) => labels[view]);
    assert.equal(new Set(values).size, 1, JSON.stringify(labels));
    assert.equal(values[0], expected[mode], JSON.stringify(agent));
    for (const stale of [agent.now, agent.deliveryLabel, agent.status === 'idle' ? 'Свободен' : '', agent.status === 'waiting' ? 'Ждёт тебя' : '']) {
      if (!stale || stale === values[0]) continue;
      assert.equal(values.includes(stale), false, `${stale} попало в статус ${JSON.stringify(labels)}`);
    }
  }
});

test('чип показывает только собственный doing агента', () => {
  const rand = mix(77);
  const words = ['альфа', 'бета', 'гамма', 'дельта', 'эпсилон', 'дзета'];
  for (let n = 1; n <= 6; n += 1) {
    const agents = [];
    for (let i = 0; i < n; i += 1) {
      const doing = `${words[i]}-${rand() % 1000}`;
      agents.push({
        id: i === 0 ? 'grok' : `agent-${i}`,
        name: i === 0 ? 'Путин' : `Агент ${i}`,
        doing,
        currentTask: i === 0 ? `${agents[0] ? '' : ''}${words[(i + 1) % words.length]}: чужая работа` : doing,
        now: 'тест',
        live: { doing: `live-${words[(i + 2) % words.length]}` },
      });
    }
    agents[0].currentTask = `${agents[1] ? agents[1].doing : 'советник'}: сводка`;
    const captions = agents.map((agent) => Status.chipCaption(agent));
    agents.forEach((agent, index) => {
      assert.equal(captions[index], agent.doing, agent.id);
      for (const other of agents) {
        if (other.id === agent.id) continue;
        assert.equal(captions[index].includes(other.doing), false, `${agent.id} показывает ${other.id}`);
      }
      assert.equal(captions[index].includes('тест'), false, agent.id);
      assert.equal(captions[index].includes('чужая'), false, agent.id);
    });
  }
  assert.equal(Status.chipCaption({ id: 'advisor', doing: '  записка  ', currentTask: 'Путин: записка' }), 'записка');
  assert.equal(Status.chipCaption({ id: 'grok', doing: null, currentTask: 'Советник Путина: записка', now: 'записка' }), '');
});

test('советник есть в нижней панели, замы Финансов и репетитор — нет', () => {
  const roomOf = { advisor: 'grok' };
  const roster = [
    { id: 'grok', name: 'Путин' },
    { id: 'advisor', name: 'Советник Путина' },
    { id: 'finance', name: 'Финансы' },
    { id: 'invest', name: 'Инвестиции', parentId: 'finance' },
    { id: 'trading', name: 'Трейдинг', parentId: 'finance', archived: true },
    { id: 'biz', name: 'Business Adviser', parentId: 'finance', archived: true },
    { id: 'lang', name: 'Language Coach', archived: true },
    { id: 'blog', name: 'Technology Blog' },
    { id: 'devops', name: 'DevOps' },
  ];
  const ids = roster.filter((agent) => Status.inBottomRoster(agent, roomOf)).map((agent) => agent.id);
  assert.equal(ids.includes('advisor'), true);
  assert.equal(ids.includes('grok'), true);
  assert.equal(ids.includes('finance'), true);
  assert.equal(ids.includes('blog'), true);
  assert.equal(ids.includes('devops'), true);
  assert.equal(ids.includes('invest'), false);
  assert.equal(ids.includes('trading'), false);
  assert.equal(ids.includes('biz'), false);
  assert.equal(ids.includes('lang'), false);
});

test('отменённые и тестовые задачи не дают метку, бейдж и счётчик', () => {
  const rand = mix(11);
  const samples = [
    { id: 't-1', text: 'тест', orderStatus: 'cancelled', status: 'отменён' },
    { id: 't-2', text: ' тест ', orderStatus: 'sent', status: 'в очереди агента' },
    { id: 't-3', text: 'ТЕСТ', orderStatus: 'done', status: 'выполнена' },
    { id: 't-4', text: 'живой приказ', orderStatus: 'cancelled', status: 'в очереди агента' },
    { id: 't-5', text: 'живой приказ', orderStatus: 'in_progress', status: 'в работе' },
    { id: 't-6', text: '  Тест  ', orderStatus: 'accepted' },
  ];
  for (let i = 0; i < 20; i += 1) {
    const text = pick(rand, ['тест', ' тест ', 'ТЕСТ', 'Тест', 'обычная задача', 'сводка']);
    const orderStatus = pick(rand, ['sent', 'accepted', 'in_progress', 'done', 'cancelled', 'failed']);
    samples.push({ id: `g-${i}`, text, orderStatus, status: orderStatus === 'cancelled' ? 'отменён' : 'в очереди агента' });
  }
  let counted = 0;
  for (const task of samples) {
    const mark = Rules.taskSurface(task);
    const silent = Rules.isSilentTask(task);
    if (silent) {
      assert.equal(mark.tag, '', task.id);
      assert.equal(mark.badge, '', task.id);
      assert.equal(mark.count, 0, task.id);
      assert.equal(String(mark.tag + mark.badge).toLowerCase().includes('тест'), false, task.id);
    } else {
      assert.equal(mark.count, 1, task.id);
      counted += 1;
    }
  }
  assert.ok(counted > 0);
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  const fresh = new Date(now - 60 * 1000).toISOString();
  const quietOrders = [
    { id: 't-1', agentId: 'dev', agent: 'dev', text: 'тест', orderStatus: 'cancelled', status: 'отменён', forwardStatus: 200, createdAt: fresh, history: [{ at: fresh, status: 'sent' }] },
    { id: 't-2', agentId: 'dev', agent: 'dev', text: ' тест ', orderStatus: 'sent', status: 'в очереди агента', forwardStatus: 200, createdAt: fresh, history: [{ at: fresh, status: 'sent' }] },
  ];
  const view = activityFor({ id: 'dev', status: 'idle' }, quietOrders, now, 30 * 60 * 1000);
  assert.equal(view.currentTask, null);
  assert.equal(String(view.currentTask || '').toLowerCase().includes('тест'), false);
});

test('опыт не начисляется за тестовые и отменённые задачи и пересчитывается', () => {
  const rand = mix(5);
  for (let round = 0; round < 30; round += 1) {
    const tasks = [];
    let goodDone = 0;
    let goodSent = 0;
    let badDone = 0;
    for (let i = 0; i < 8; i += 1) {
      const silent = rand() % 3 === 0;
      const done = rand() % 2 === 0;
      const text = silent ? pick(rand, ['тест', ' ТЕСТ ', 'обычный']) : 'обычный';
      const orderStatus = text.trim().toLowerCase() === 'тест'
        ? pick(rand, ['cancelled', 'done', 'sent'])
        : (silent ? 'cancelled' : (done ? 'done' : 'sent'));
      const task = {
        id: `t-${round}-${i}`,
        agent: 'dev',
        agentId: 'dev',
        text: text.trim().toLowerCase() === 'тест' && silent ? text : (silent ? 'живой' : text),
        orderStatus,
        status: orderStatus === 'done' ? 'выполнена' : (orderStatus === 'cancelled' ? 'отменён' : 'в очереди агента'),
      };
      if (silent && text.trim().toLowerCase() !== 'тест') task.text = 'живой';
      tasks.push(task);
      const quiet = Rules.isSilentTask(task);
      if (!quiet) goodSent += 1;
      if (Rules.isDoneTask(task) && !quiet) goodDone += 1;
      if (Rules.isDoneTask(task) && quiet) badDone += 1;
    }
    const extras = rand() % 3;
    const agent = { id: 'dev', completed: goodDone + badDone + extras };
    const score = Rules.xpOf(agent, tasks);
    const clean = tasks.filter((task) => !Rules.isSilentTask(task));
    const again = Rules.xpOf(agent, clean.concat(tasks.filter((task) => Rules.isSilentTask(task))));
    assert.equal(score.completed, goodDone + extras, JSON.stringify({ score, goodDone, badDone, extras }));
    assert.equal(score.sent, goodSent);
    assert.equal(score.xp, (goodDone + extras) * 100 + goodSent * 10);
    assert.equal(again.xp, score.xp);
    const withExtraSilent = tasks.concat([{ id: 't-x', agentId: 'dev', text: 'тест', orderStatus: 'done', status: 'выполнена' }]);
    assert.equal(Rules.xpOf({ ...agent, completed: agent.completed + 1 }, withExtraSilent).xp, score.xp);
  }
});

test('пароль без подсказки, где лежит секрет, тестовые пункты закрыты миграцией', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /Введите пароль доступа/);
  assert.equal(html.includes('APP_PASSWORD'), false);
  assert.equal(html.includes('Render'), false);
  assert.equal(app.includes('APP_PASSWORD'), false);
  assert.match(app, /Введите пароль доступа/);
  assert.match(server, /closeFixtureTestNeeds/);
  assert.equal(server.includes('reopenSeededTestNeed(item)'), false);
});
