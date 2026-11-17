'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const {
  START_DELAY_MS,
  DEBOUNCE_MS,
  loadFinanceGoals,
  buildPayload,
  mapNeed,
  mapOwnerOrder,
  createPoryadokSync,
} = require('../lib/poryadok-sync');

const GOALS_FILE = path.join(__dirname, '..', 'config', 'finance-goals.json');

const AGENTS = [
  { id: 'grok', name: 'Главный агент · GROK', order: 1 },
  { id: 'army', name: 'Военная служба', order: 2 },
  { id: 'poker', name: 'Покер', order: 3 },
  { id: 'trading', name: 'Трейдинг', order: 4, archived: true },
  { id: 'devops', name: 'DevOps', order: 5 },
  { id: 'dev', name: 'Программирование', order: 6 },
  { id: 'temshik', name: 'Темщик', order: 7 },
  { id: 'finance', name: 'Финансы', order: 8 },
  { id: 'qa', name: 'Тестировщик ПО', order: 9 },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn, ms = 4000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < ms) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(20);
  }
  throw lastErr || new Error('timeout');
}

function startReceiver(onRequest) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = null; }
      const hit = {
        url: req.url,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body: parsed,
      };
      hits.push(hit);
      const status = onRequest ? onRequest(hit, hits.length) : 200;
      res.writeHead(status || 200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hits, port: server.address().port });
    });
  });
}

function childEnv(extra) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    ...extra,
  };
}

function bootKremlin(env) {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const code = `
'use strict';
const { app } = require(${JSON.stringify(serverPath)});
const s = app.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT:' + s.address().port + '\\n');
});
`;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`сервер не поднялся\n${stderr}\n${stdout}`));
    }, 8000);
    child.stdout.on('data', (buf) => {
      stdout += buf;
      const match = stdout.match(/PORT:(\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.stderr.on('data', (buf) => { stderr += buf; });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`сервер завершился с кодом ${code}\n${stderr}`));
    });
  });
  return {
    child,
    ready,
    stderr: () => stderr,
  };
}

function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('пауза стартового снимка по умолчанию 15 секунд', () => {
  assert.equal(START_DELAY_MS, 15000);
  assert.equal(DEBOUNCE_MS, 5000);
});

test('файл целей и FINANCE_GOALS_JSON читаются', () => {
  const previous = process.env.FINANCE_GOALS_JSON;
  try {
    delete process.env.FINANCE_GOALS_JSON;
    const fromFile = loadFinanceGoals({ filePath: GOALS_FILE });
    assert.equal(fromFile.source, 'file');
    assert.equal(fromFile.envError, false);
    assert.equal(fromFile.goals.length, 2);
    assert.equal(fromFile.goals[0].externalId, 'kremlin-goal-income');
    assert.equal(fromFile.goals[0].title, 'Доход');
    assert.equal(fromFile.goals[0].description, 'Главная цель');
    assert.equal(fromFile.goals[0].deadline, null);
    assert.deepEqual(fromFile.goals[0].kpis[0], {
      name: 'Доход в месяц',
      current: null,
      target: null,
      unit: '₽/мес',
    });
    assert.equal(fromFile.goals[1].externalId, 'kremlin-goal-networth');
    assert.equal(fromFile.goals[1].title, 'Чистый капитал');
    assert.equal(fromFile.goals[1].deadline, '2031-11-17');
    assert.deepEqual(fromFile.goals[1].kpis[0], {
      name: 'Чистый капитал',
      current: null,
      target: null,
      unit: '₽',
    });

    process.env.FINANCE_GOALS_JSON = JSON.stringify([{
      externalId: 'kremlin-goal-custom',
      title: 'Тест',
      description: 'из env',
      deadline: '2030-05-01',
      kpis: [{ name: 'Метрика', current: 3, target: 9, unit: 'шт' }],
    }]);
    const fromEnv = loadFinanceGoals({ filePath: GOALS_FILE });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.goals.length, 1);
    assert.equal(fromEnv.goals[0].title, 'Тест');
    assert.equal(fromEnv.goals[0].deadline, '2030-05-01');
    assert.equal(fromEnv.goals[0].kpis[0].current, 3);
    assert.equal(fromEnv.goals[0].kpis[0].target, 9);

    process.env.FINANCE_GOALS_JSON = JSON.stringify([{
      externalId: 'kremlin-goal-empty',
      title: 'Пусто',
      kpis: [{ name: 'Метрика', current: null, target: null, unit: 'шт' }],
    }]);
    const emptyKpi = loadFinanceGoals({ filePath: GOALS_FILE });
    assert.equal(emptyKpi.goals[0].kpis.length, 1);
    assert.equal(emptyKpi.goals[0].kpis[0].current, null);
    assert.equal(emptyKpi.goals[0].kpis[0].target, null);
    const emptyPayload = buildPayload({ needs: [], tasks: [], agents: [] }, emptyKpi.goals, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(emptyPayload.goals[0].kpis[0], { name: 'Метрика', current: null, target: null, unit: 'шт' });

    process.env.FINANCE_GOALS_JSON = '{';
    const fallback = loadFinanceGoals({ filePath: GOALS_FILE });
    assert.equal(fallback.source, 'file');
    assert.equal(fallback.envError, true);
    assert.equal(fallback.goals[1].deadline, '2031-11-17');

    process.env.FINANCE_GOALS_JSON = '   ';
    const blank = loadFinanceGoals({ filePath: GOALS_FILE });
    assert.equal(blank.source, 'file');
    assert.equal(blank.goals[0].externalId, 'kremlin-goal-income');
  } finally {
    if (previous === undefined) delete process.env.FINANCE_GOALS_JSON;
    else process.env.FINANCE_GOALS_JSON = previous;
  }
});

test('пункты и приказы владельца складываются в тело для Порядка', () => {
  const previousUrl = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  const goals = loadFinanceGoals({ json: '', filePath: GOALS_FILE }).goals;
  const page = (id) => `https://grok-agent-office.onrender.com/needs/${id}`;
  const hint = 'Откроется страница вопроса на сайте Кремля';
  try {
  const open = mapNeed({
    id: 'n-1',
    what: 'Подписать акт',
    fromAgentId: 'finance',
    where: 'Ильинка',
    urgency: 'high',
    closedAt: null,
  }, AGENTS);
  assert.equal(open.externalId, 'kremlin-need-n-1');
  assert.equal(open.title, 'Подписать акт');
  assert.equal(open.priority, 'Срочно');
  assert.equal(open.status, 'В ожидании');
  assert.equal(open.deadline, null);
  assert.match(open.description, /От: 7\. Финансы/);
  assert.match(open.description, /Где: Ильинка/);
  assert.equal(open.actionUrl, page('n-1'));
  assert.equal(open.actionHint, hint);
  assert.match(open.description, /Решить: https:\/\/grok-agent-office\.onrender\.com\/needs\/n-1/);
  assert.match(open.description, /Откроется страница вопроса на сайте Кремля/);

  const linked = mapNeed({
    id: 'n-link',
    what: 'Открыть чат',
    fromAgentId: 'finance',
    where: 'Grok',
    urgency: 'normal',
    actionUrl: ' grokbot://app/v1/agent?id=8b9d4ad0-4222-49a8-84b4-b125d3b7ec01 ',
    actionHint: ' Откройте в Grok чат «Путин · Кремль» ',
    details: 'SECRET-DETAILS-TEXT',
    answers: [{ text: 'SECRET-ANSWER', at: '2026-01-01T00:00:00.000Z' }],
  }, AGENTS);
  assert.equal(linked.actionUrl, page('n-link'));
  assert.equal(linked.actionHint, hint);
  assert.match(linked.description, /Решить: https:\/\/grok-agent-office\.onrender\.com\/needs\/n-link/);
  assert.doesNotMatch(JSON.stringify(linked), /SECRET-DETAILS-TEXT|SECRET-ANSWER|grokbot:\/\/|Путин · Кремль/);
  assert.equal(mapNeed({
    id: 'n-bad',
    what: 'Плохая ссылка',
    actionUrl: 'javascript:alert(1)',
    actionHint: 'подсказка',
  }, AGENTS).actionUrl, page('n-bad'));

  const low = mapNeed({
    id: 'n-2',
    what: 'Позже',
    fromAgentId: 'dev',
    where: 'Тверская',
    urgency: 'low',
    closedAt: null,
  }, AGENTS);
  assert.equal(low.priority, 'Низкий');
  assert.equal(low.status, 'В ожидании');

  const closed = mapNeed({
    id: 'n-3',
    what: 'Уже закрыто',
    fromAgentId: 'devops',
    where: 'Таганка',
    urgency: 'normal',
    closedAt: '2026-11-17T12:00:00.000Z',
  }, AGENTS);
  assert.equal(closed.priority, 'Средний');
  assert.equal(closed.status, 'Выполнено');
  assert.match(closed.description, /4\. DevOps/);

  const archivedNeed = mapNeed({
    id: 'n-arch',
    what: 'Старое',
    fromAgentId: 'trading',
    where: 'Сити',
    urgency: 'low',
  }, AGENTS);
  assert.match(archivedNeed.description, /От: Трейдинг/);
  assert.doesNotMatch(archivedNeed.description, /От: \d/);

  const sent = mapOwnerOrder({
    id: 't-1',
    agent: 'dev',
    text: 'Поправь экран',
    fromAgentId: 'owner',
    orderStatus: 'sent',
  }, AGENTS);
  assert.equal(sent.externalId, 'kremlin-order-t-1');
  assert.equal(sent.priority, 'Средний');
  assert.equal(sent.status, 'В ожидании');
  assert.equal(sent.deadline, null);
  assert.match(sent.description, /Исполнитель: 5\. Программирование/);

  assert.equal(mapOwnerOrder({ id: 't-2', agent: 'dev', text: 'x', orderStatus: 'accepted' }, AGENTS).status, 'В ожидании');
  const progress = mapOwnerOrder({
    id: 't-3',
    agent: 'dev',
    text: 'x',
    orderStatus: 'in_progress',
    priority: 'Высокий',
    deadline: '2026-12-01',
  }, AGENTS);
  assert.equal(progress.status, 'В процессе');
  assert.equal(progress.priority, 'Высокий');
  assert.equal(progress.deadline, '2026-12-01');
  assert.equal(mapOwnerOrder({ id: 't-4', agent: 'dev', text: 'x', orderStatus: 'done', result: 'готово' }, AGENTS).status, 'Выполнено');

  const failed = mapOwnerOrder({
    id: 't-5',
    agent: 'qa',
    text: 'Проверь стенд',
    fromAgentId: 'owner',
    orderStatus: 'failed',
    result: 'стенд недоступен',
    priority: 'low',
  }, AGENTS);
  assert.equal(failed.status, 'В ожидании');
  assert.equal(failed.priority, 'Низкий');
  assert.match(failed.description, /Не выполнен/);
  assert.match(failed.description, /Тестировщик ПО/);
  assert.match(failed.description, /стенд недоступен/);

  const payload = buildPayload({
    agents: AGENTS,
    needs: [
      { id: 'n-1', what: 'Подписать акт', fromAgentId: 'finance', where: 'Ильинка', urgency: 'high', closedAt: null },
    ],
    tasks: [
      { id: 't-1', agent: 'dev', text: 'Поправь экран', fromAgentId: 'owner', orderStatus: 'sent' },
      { id: 't-9', agent: 'qa', text: 'Чужой приказ', fromAgentId: 'dev', orderStatus: 'sent' },
    ],
  }, goals, '2026-11-17T00:00:00.000Z');
  assert.equal(payload.source, 'kremlin');
  assert.equal(payload.sentAt, '2026-11-17T00:00:00.000Z');
  assert.deepEqual(payload.tasks.map((t) => t.externalId), [
    'kremlin-need-n-1',
    'kremlin-need-need-render-api',
    'kremlin-order-t-1',
  ]);
  const retired = payload.tasks.find((t) => t.externalId === 'kremlin-need-need-render-api');
  assert.equal(retired.status, 'Выполнено');
  assert.equal(retired.actionUrl, page('need-render-api'));
  assert.equal(retired.actionHint, hint);
  assert.doesNotMatch(retired.description, /SECRET/);
  assert.equal(retired.title, 'Ключ Render API — ввести через защищённую форму в чате DevOps');
  assert.match(retired.description, /4\. DevOps/);
  assert.equal(payload.goals[1].deadline, '2031-11-17');
  assert.equal(payload.goals[0].deadline, null);

  const stillThere = buildPayload({
    agents: AGENTS,
    needs: [
      { id: 'need-render-api', what: 'Ключ Render API — ввести через защищённую форму в чате DevOps', fromAgentId: 'devops', where: 'Защищённая форма в чате DevOps', urgency: 'high', closedAt: null },
    ],
    tasks: [],
  }, goals, '2026-11-17T00:00:00.000Z');
  const renderTasks = stillThere.tasks.filter((t) => t.externalId === 'kremlin-need-need-render-api');
  assert.equal(renderTasks.length, 1);
  assert.equal(renderTasks[0].status, 'Выполнено');

  const noNeeds = buildPayload({ tasks: [], agents: [] }, goals, '2026-11-17T00:00:00.000Z');
  assert.deepEqual(noNeeds.tasks.map((t) => t.externalId), ['kremlin-need-need-render-api']);
  assert.equal(noNeeds.tasks[0].status, 'Выполнено');
  assert.equal(noNeeds.goals.length, 2);
  } finally {
    if (previousUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousUrl;
  }
});

test('без токена запросы не уходят', async () => {
  const receiver = await startReceiver();
  const logs = [];
  const sync = createPoryadokSync({
    token: '   ',
    baseUrl: `http://127.0.0.1:${receiver.port}`,
    getState: () => ({ needs: [{ id: '1', what: 'x', urgency: 'high' }], tasks: [], agents: [] }),
    log: (msg) => logs.push(msg),
    startupDelayMs: 10,
    debounceMs: 10,
  });
  try {
    sync.start();
    sync.start();
    sync.onListening();
    sync.schedule();
    sync.noteRequestFinished();
    await delay(80);
    assert.equal(receiver.hits.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /PORYADOK_INGEST_TOKEN/);
    assert.equal(logs[0].includes('Bearer'), false);
    const status = sync.publicStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.lastOkAt, null);
    assert.equal(status.lastError, null);
    assert.equal(status.lastCounts, null);
  } finally {
    sync.stop();
    receiver.server.close();
  }
});

test('ошибка приёма повторяется, токен в лог не попадает', async () => {
  const errors = [];
  let calls = 0;
  const sync = createPoryadokSync({
    token: 'super-secret-token',
    baseUrl: 'http://127.0.0.1:9',
    getState: () => ({ needs: [], tasks: [], agents: [] }),
    debounceMs: 15,
    retryDelays: [20, 20],
    startupDelayMs: 60_000,
    intervalMs: 60_000,
    financeGoalsJson: '[]',
    logError: (msg) => errors.push(msg),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, arrayBuffer: async () => Buffer.alloc(0) };
      }
      if (calls === 2) throw new Error('down super-secret-token');
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) };
    },
  });
  try {
    sync.schedule();
    const status = await waitUntil(() => {
      const current = sync.publicStatus();
      return current.lastOkAt ? current : null;
    });
    assert.equal(calls, 3);
    assert.equal(status.lastError, null);
    assert.deepEqual(status.lastCounts, { needs: 1, orders: 0, goals: 0 });
    assert.ok(errors.length >= 1);
    assert.equal(errors.join('\n').includes('super-secret-token'), false);
    assert.equal(JSON.stringify(status).includes('super-secret-token'), false);
    assert.match(errors[0], /HTTP 500/);
  } finally {
    sync.stop();
  }
});

test('таймеры старта и часа не держат процесс', () => {
  const sync = createPoryadokSync({
    token: 'x',
    getState: () => ({}),
    startupDelayMs: 60_000,
    intervalMs: 60_000,
    debounceMs: 60_000,
    financeGoalsJson: '[]',
  });
  try {
    sync.onListening();
    const handles = sync.handles();
    assert.equal(handles.startup.hasRef(), false);
    assert.equal(handles.interval.hasRef(), false);
  } finally {
    sync.stop();
  }
});

test('стартовый снимок уходит на приёмник без отдельного события', async () => {
  const receiver = await startReceiver();
  const sync = createPoryadokSync({
    token: 'tok',
    baseUrl: `http://127.0.0.1:${receiver.port}`,
    startupDelayMs: 40,
    debounceMs: 5_000,
    intervalMs: 60 * 60 * 1000,
    financeGoalsJson: '',
    getState: () => ({
      agents: AGENTS,
      needs: [
        { id: 'n-1', what: 'Подписать', fromAgentId: 'finance', where: 'Ильинка', urgency: 'high', closedAt: null },
      ],
      tasks: [
        { id: 't-1', agent: 'dev', text: 'Сводка', fromAgentId: 'owner', orderStatus: 'accepted' },
      ],
    }),
  });
  try {
    sync.onListening();
    assert.equal(receiver.hits.length, 0);
    const hit = await waitUntil(() => receiver.hits[0]);
    assert.equal(hit.authorization, 'Bearer tok');
    assert.equal(hit.url, '/api/integrations/kremlin');
    assert.match(hit.contentType, /application\/json/);
    assert.equal(hit.body.source, 'kremlin');
    assert.deepEqual(hit.body.tasks.map((t) => t.externalId), [
      'kremlin-need-n-1',
      'kremlin-need-need-render-api',
      'kremlin-order-t-1',
    ]);
    assert.equal(hit.body.tasks[0].status, 'В ожидании');
    assert.equal(hit.body.tasks[0].priority, 'Срочно');
    assert.equal(hit.body.tasks[1].status, 'Выполнено');
    assert.equal(hit.body.goals.length, 2);
    await delay(80);
    assert.equal(receiver.hits.length, 1);
    assert.deepEqual(sync.publicStatus().lastCounts, { needs: 2, orders: 1, goals: 2 });
  } finally {
    sync.stop();
    receiver.server.close();
  }
});

test('после listen Кремль сам шлёт открытые пункты, приказы и цели', async () => {
  const receiver = await startReceiver();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-sync-'));
  const boot = bootKremlin(childEnv({
    APP_PASSWORD: 'pw-sync',
    AGENT_TOKEN: 'tok-sync',
    PORYADOK_INGEST_TOKEN: 'ingest-secret',
    PORYADOK_URL: `http://127.0.0.1:${receiver.port}`,
    PORYADOK_SYNC_START_MS: '700',
    PORYADOK_SYNC_DEBOUNCE_MS: '5000',
    UPLOAD_DIR: uploadDir,
    PUBLIC_URL: 'http://127.0.0.1',
  }));
  try {
    const port = await boot.ready;
    const base = `http://127.0.0.1:${port}`;
    const before = await (await fetch(`${base}/api/state`)).json();
    assert.equal(before.poryadokSync.enabled, true);
    assert.equal(before.poryadokSync.lastOkAt, null);
    assert.equal(before.poryadokSync.lastError, null);
    assert.equal(before.poryadokSync.lastCounts, null);
    assert.equal(JSON.stringify(before).includes('ingest-secret'), false);

    const hit = await waitUntil(() => receiver.hits[0], 4000);
    assert.equal(receiver.hits.length, 1);
    assert.equal(hit.authorization, 'Bearer ingest-secret');
    assert.equal(hit.url, '/api/integrations/kremlin');
    assert.equal(hit.body.source, 'kremlin');
    assert.match(hit.body.sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(hit.body).sort(), ['goals', 'sentAt', 'source', 'tasks']);

    const ids = hit.body.tasks.map((task) => task.externalId);
    for (const id of [
      'kremlin-need-need-academy',
      'kremlin-need-need-social',
      'kremlin-need-need-finance',
    ]) {
      assert.ok(ids.includes(id), id);
    }
    assert.ok(ids.includes('kremlin-need-need-render-api'));
    assert.equal(ids.filter((id) => id === 'kremlin-need-need-render-api').length, 1);
    assert.equal(ids.some((id) => id.startsWith('kremlin-order-')), false);

    const academy = hit.body.tasks.find((task) => task.externalId === 'kremlin-need-need-academy');
    assert.deepEqual(Object.keys(academy).sort(), ['actionHint', 'actionUrl', 'deadline', 'description', 'externalId', 'priority', 'status', 'title']);
    assert.equal(academy.title, 'Одобрить Академию агентов: нажать «Да» в чатах Программирования и Тестировщика');
    assert.equal(academy.priority, 'Средний');
    assert.equal(academy.status, 'В ожидании');
    assert.equal(academy.deadline, null);
    assert.equal(academy.actionUrl, 'http://127.0.0.1/needs/need-academy');
    assert.equal(academy.actionHint, 'Откроется страница вопроса на сайте Кремля');
    assert.match(academy.description, /От: 1\. Главный агент/);
    assert.match(academy.description, /Где: Чаты агентов в Grok/);
    assert.match(academy.description, /Решить: http:\/\/127\.0\.0\.1\/needs\/need-academy/);
    assert.doesNotMatch(academy.description, /cursor\.com/);
    const finance = hit.body.tasks.find((task) => task.externalId === 'kremlin-need-need-finance');
    const social = hit.body.tasks.find((task) => task.externalId === 'kremlin-need-need-social');
    assert.equal(finance.actionUrl, 'http://127.0.0.1/needs/need-finance');
    assert.equal(finance.actionHint, 'Откроется страница вопроса на сайте Кремля');
    assert.match(finance.description, /Где: Чат Путина или Финансов/);
    assert.match(finance.description, /Решить: http:\/\/127\.0\.0\.1\/needs\/need-finance/);
    assert.doesNotMatch(finance.description, /grokbot:\/\//);
    assert.equal(social.actionUrl, 'http://127.0.0.1/needs/need-social');
    assert.equal(social.actionHint, 'Откроется страница вопроса на сайте Кремля');
    const retired = hit.body.tasks.find((task) => task.externalId === 'kremlin-need-need-render-api');
    assert.equal(retired.status, 'Выполнено');
    for (const task of hit.body.tasks) {
      if (task.externalId === 'kremlin-need-need-render-api') continue;
      assert.equal(task.status, 'В ожидании');
    }

    const income = hit.body.goals.find((goal) => goal.externalId === 'kremlin-goal-income');
    const worth = hit.body.goals.find((goal) => goal.externalId === 'kremlin-goal-networth');
    assert.equal(income.title, 'Доход');
    assert.equal(income.deadline, null);
    assert.deepEqual(income.kpis[0], { name: 'Доход в месяц', current: null, target: null, unit: '₽/мес' });
    assert.equal(worth.title, 'Чистый капитал');
    assert.equal(worth.deadline, '2031-11-17');
    assert.deepEqual(worth.kpis[0], { name: 'Чистый капитал', current: null, target: null, unit: '₽' });

    const after = await waitUntil(async () => {
      const body = await (await fetch(`${base}/api/state`)).json();
      return body.poryadokSync && body.poryadokSync.lastOkAt ? body : null;
    });
    assert.equal(after.poryadokSync.enabled, true);
    assert.equal(after.poryadokSync.lastError, null);
    assert.deepEqual(after.poryadokSync.lastCounts, { needs: 4, orders: 0, goals: 2 });
    assert.equal(JSON.stringify(after).includes('ingest-secret'), false);
    assert.equal(boot.stderr().includes('ingest-secret'), false);
  } finally {
    await stopChild(boot.child);
    receiver.server.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('пункт и смена статуса приказа запускают отправку', async () => {
  const receiver = await startReceiver();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-sync-'));
  const boot = bootKremlin(childEnv({
    APP_PASSWORD: 'pw-sync',
    AGENT_TOKEN: 'tok-sync',
    PORYADOK_INGEST_TOKEN: 'ingest-secret',
    PORYADOK_URL: `http://127.0.0.1:${receiver.port}`,
    PORYADOK_SYNC_START_MS: '60000',
    PORYADOK_SYNC_DEBOUNCE_MS: '40',
    UPLOAD_DIR: uploadDir,
    PUBLIC_URL: 'http://127.0.0.1',
  }));
  const headers = {
    'Content-Type': 'application/json',
    'x-agent-token': 'tok-sync',
    'x-app-password': 'pw-sync',
  };
  try {
    const port = await boot.ready;
    const base = `http://127.0.0.1:${port}`;
    const post = (urlPath, body, extra = {}) => fetch(base + urlPath, {
      method: 'POST',
      headers: { ...headers, ...(extra.headers || {}) },
      body: JSON.stringify(body),
    });

    const created = await (await post('/api/needs', {
      what: 'Подписать платёж',
      where: 'Кабинет',
      fromAgentId: 'finance',
      urgency: 'high',
      actionUrl: 'https://example.com/pay',
      actionHint: 'если ссылка не открылась',
    })).json();
    const opened = await waitUntil(() => {
      const hit = receiver.hits.find((item) => item.body && item.body.tasks.some((task) => task.externalId === `kremlin-need-${created.id}`));
      return hit || null;
    });
    assert.equal(opened.authorization, 'Bearer ingest-secret');
    const need = opened.body.tasks.find((task) => task.externalId === `kremlin-need-${created.id}`);
    assert.equal(need.title, 'Подписать платёж');
    assert.equal(need.priority, 'Срочно');
    assert.equal(need.status, 'В ожидании');
    assert.match(need.description, /От: 7\. Финансы/);
    assert.match(need.description, /Где: Кабинет/);
    assert.equal(need.actionUrl, `http://127.0.0.1/needs/${created.id}`);
    assert.equal(need.actionHint, 'Откроется страница вопроса на сайте Кремля');
    assert.match(need.description, new RegExp(`Решить: http://127\\.0\\.0\\.1/needs/${created.id}`));
    assert.doesNotMatch(JSON.stringify(need), /example\.com\/pay|если ссылка не открылась/);
    const retiredLive = opened.body.tasks.filter((task) => task.externalId === 'kremlin-need-need-render-api');
    assert.equal(retiredLive.length, 1);
    assert.equal(retiredLive[0].status, 'Выполнено');
    assert.equal(opened.body.goals.length, 2);

    const beforeClose = receiver.hits.length;
    await post(`/api/needs/${created.id}/close`, {});
    const closedHit = await waitUntil(() => {
      const hit = receiver.hits.slice(beforeClose).find((item) => {
        const task = item.body && item.body.tasks.find((row) => row.externalId === `kremlin-need-${created.id}`);
        return task && task.status === 'Выполнено';
      });
      return hit || null;
    });
    assert.equal(
      closedHit.body.tasks.find((task) => task.externalId === `kremlin-need-${created.id}`).status,
      'Выполнено',
    );

    const orderRes = await post('/api/task', {
      agent: 'dev',
      text: 'Проверь синхронизацию',
      fromAgentId: 'owner',
    });
    const order = await orderRes.json();
    assert.equal(orderRes.status, 201);
    const ordered = await waitUntil(() => {
      const hit = receiver.hits.find((item) => item.body && item.body.tasks.some((task) => task.externalId === `kremlin-order-${order.id}` && task.status === 'В ожидании'));
      return hit || null;
    });
    const orderTask = ordered.body.tasks.find((task) => task.externalId === `kremlin-order-${order.id}`);
    assert.equal(orderTask.priority, 'Средний');
    assert.equal(orderTask.deadline, null);
    assert.match(orderTask.description, /Исполнитель: 5\. Программирование/);

    const quiet = receiver.hits.length;
    const delegated = await post('/api/task', {
      agent: 'qa',
      text: 'Это поручение агента',
      fromAgentId: 'dev',
      parentOrderId: order.id,
    });
    assert.equal(delegated.status, 201);
    await delay(180);
    assert.equal(receiver.hits.length, quiet);
    assert.equal(receiver.hits.some((item) => item.body.tasks.some((task) => String(task.title).includes('Это поручение агента'))), false);

    await post(`/api/orders/${order.id}`, { status: 'accepted' });
    await post(`/api/orders/${order.id}`, { status: 'in_progress', progress: 25, note: 'смотрю' });
    const moved = await waitUntil(() => {
      const hit = receiver.hits.find((item) => item.body && item.body.tasks.some((task) => task.externalId === `kremlin-order-${order.id}` && task.status === 'В процессе'));
      return hit || null;
    });
    assert.equal(moved.body.tasks.find((task) => task.externalId === `kremlin-order-${order.id}`).status, 'В процессе');
    assert.equal(boot.stderr().includes('ingest-secret'), false);
  } finally {
    await stopChild(boot.child);
    receiver.server.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});
