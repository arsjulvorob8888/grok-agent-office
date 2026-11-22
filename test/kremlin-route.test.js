'use strict';

// Ответы, закрытия и задачи из панели не ходят на GROK_WEBHOOK_URL.
// Очередь агента — основной канал. KREMLIN_WEBHOOK_URL только будит Путина.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grokHits = [];
const kremlinHits = [];

function collect(bucket) {
  return (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = { raw: body }; }
      bucket.push({ headers: req.headers, body: parsed, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  };
}

const grok = http.createServer(collect(grokHits));
const kremlin = http.createServer(collect(kremlinHits));

let base;
let server;
let office;
let kremlinUrl;

before(async () => {
  await new Promise((resolve) => grok.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => kremlin.listen(0, '127.0.0.1', resolve));
  kremlinUrl = `http://127.0.0.1:${kremlin.address().port}/kremlin`;
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-route-'));
  process.env.APP_PASSWORD = 'pw-route';
  process.env.AGENT_TOKEN = 'tok-route';
  process.env.PUBLIC_URL = 'https://example.test';
  process.env.GROK_WEBHOOK_URL = `http://127.0.0.1:${grok.address().port}/old-grok`;
  process.env.GROK_WEBHOOK_KEY = 'grok-secret-must-not-log';
  process.env.GROK_WEBHOOK_HEADER = 'Authorization';
  process.env.KREMLIN_WEBHOOK_URL = kremlinUrl;
  process.env.KREMLIN_WEBHOOK_KEY = 'plain-secret';
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  delete process.env.PORYADOK_INGEST_TOKEN;
  delete process.env.NEEDS_DETAILS_JSON;
  office = require('../server.js');
  server = await new Promise((resolve) => {
    const listening = office.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  grok.close();
  kremlin.close();
});

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

const pw = { 'x-app-password': 'pw-route' };
const tok = { 'x-agent-token': 'tok-route' };

function hitFor(needId, type) {
  return kremlinHits.find((hit) => hit.body && hit.body.needId === needId && hit.body.type === type);
}

test('заголовок ключа: голый ключ, схема и Authorization', () => {
  assert.deepEqual(office.parseKremlinKey('plain-secret'), {
    authorization: 'Bearer plain-secret',
    bare: 'plain-secret',
  });
  assert.deepEqual(office.parseKremlinKey('Bearer already-set'), {
    authorization: 'Bearer already-set',
    bare: 'already-set',
  });
  assert.deepEqual(office.parseKremlinKey('basic lower-secret'), {
    authorization: 'basic lower-secret',
    bare: 'lower-secret',
  });
  assert.deepEqual(office.parseKremlinKey('Authorization: Basic zzz'), {
    authorization: 'Basic zzz',
    bare: 'zzz',
  });
  assert.deepEqual(office.parseKremlinKey('authorization:   bearer mixed-case'), {
    authorization: 'bearer mixed-case',
    bare: 'mixed-case',
  });
  const msk = office.formatAtMsk('2026-11-17T15:47:00.000Z');
  assert.equal(msk, '17.11 18:47 МСК');
});

test('ответы, закрытия, панель и приказы не зовут GROK_WEBHOOK_URL', async () => {
  assert.equal(grokHits.length, 0);

  const yesNo = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({
      what: 'Одобрить маршрут', where: 'Сайт', fromAgentId: 'blog', urgency: 'low', kind: 'approval',
    }),
  });
  assert.equal(yesNo.status, 201);
  const yes = await json(`/api/needs/${yesNo.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(yes.status, 201);
  assert.equal(yes.body.answer, 'yes');
  assert.equal(yes.body.closedBy, 'owner-answer');
  assert.equal(yes.body.answers[0].text, 'Да');
  const yesHit = hitFor(yesNo.body.id, 'answer');
  assert.ok(yesHit);
  assert.equal(yesHit.body.agentId, 'blog');
  assert.equal(yesHit.body.text, 'Ответ Арсения на «Одобрить маршрут»: Да');
  assert.equal(yesHit.body.taskId, undefined);
  assert.equal(yesHit.body.appUrl, 'https://example.test');
  assert.match(yesHit.body.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(yesHit.body.atMsk, /^\d{2}\.\d{2} \d{2}:\d{2} МСК$/);
  assert.equal(yesHit.headers.authorization, 'Bearer plain-secret');
  assert.equal(yesHit.headers['x-webhook-key'], 'plain-secret');
  assert.equal(JSON.stringify(yesHit.body).includes('plain-secret'), false);
  const yesTask = (await json('/api/state')).body.tasks.find((task) => task.text.includes('Одобрить маршрут'));
  assert.ok(yesTask);
  assert.equal(yesTask.agent, 'blog');
  assert.equal(yesTask.delivery, 'queue');
  assert.equal(yesTask.status, 'отправлена Путину');
  assert.equal(yesTask.fromAgentId, 'owner');

  const textNeed = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({
      what: 'Сумма на неделю', where: 'Чат', fromAgentId: 'finance', urgency: 'normal', kind: 'money', answerable: true,
    }),
  });
  const partial = await json(`/api/needs/${textNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'черновик суммы', partial: true }),
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.closedAt, null);
  assert.equal(partial.body.answers[0].text, 'черновик суммы');
  const partialHit = hitFor(textNeed.body.id, 'answer');
  assert.equal(partialHit.body.text, 'Ответ Арсения на «Сумма на неделю»: черновик суммы');
  assert.equal(partialHit.body.agentId, 'finance');
  const full = await json(`/api/needs/${textNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'итого 10' }),
  });
  assert.equal(full.status, 201);
  assert.ok(full.body.closedAt);
  assert.equal(full.body.answers.length, 2);
  const again = await json(`/api/needs/${textNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'поздно' }),
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'Пункт уже закрыт');

  const toClose = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Закрыть кнопкой', where: 'Панель', fromAgentId: 'dev', urgency: 'low', kind: 'delete' }),
  });
  const closed = await json(`/api/needs/${toClose.body.id}/close`, {
    method: 'POST', headers: pw, body: JSON.stringify({}),
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.closedBy, 'user');
  const closeHit = hitFor(toClose.body.id, 'close');
  assert.equal(closeHit.body.text, 'Пункт «Закрыть кнопкой» закрыт');
  assert.equal(closeHit.body.agentId, 'dev');
  assert.equal(closeHit.body.needId, toClose.body.id);

  const toPatch = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Закрыть патчем', where: 'Панель', fromAgentId: 'qa', urgency: 'low', kind: 'delete' }),
  });
  const quietPatch = kremlinHits.length;
  const edited = await json(`/api/needs/${toPatch.body.id}`, {
    method: 'PATCH', headers: pw, body: JSON.stringify({ what: 'Закрыть патчем сегодня' }),
  });
  assert.equal(edited.status, 200);
  assert.equal(kremlinHits.length, quietPatch);
  const patched = await json(`/api/needs/${toPatch.body.id}`, {
    method: 'PATCH', headers: tok, body: JSON.stringify({ closed: true, agentId: 'qa' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.closedBy, 'qa');
  const patchHit = hitFor(toPatch.body.id, 'close');
  assert.equal(patchHit.body.text, 'Пункт «Закрыть патчем сегодня» закрыт');
  assert.equal(patchHit.body.agentId, 'qa');

  const beforeOrder = kremlinHits.length;
  const panel = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'army', text: 'Задача из панели', fromAgentId: 'owner' }),
  });
  assert.equal(panel.status, 201);
  assert.equal(panel.body.status, 'отправлена Путину');
  assert.equal(panel.body.delivery, 'queue');
  const panelHit = kremlinHits.find((hit) => hit.body && hit.body.taskId === panel.body.id);
  assert.ok(panelHit);
  assert.equal(panelHit.body.type, 'owner_task');
  assert.equal(panelHit.body.agentId, 'army');
  assert.equal(panelHit.body.text, 'Задача из панели');
  assert.equal(panelHit.body.needId, undefined);
  assert.equal(panelHit.headers.authorization, 'Bearer plain-secret');
  assert.equal(panelHit.headers['x-webhook-key'], 'plain-secret');

  const afterPanel = kremlinHits.length;
  const accepted = await json(`/api/orders/${panel.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(kremlinHits.length, afterPanel);
  assert.ok(afterPanel > beforeOrder);

  const open = await json('/api/agents/army/tasks?status=open', { headers: tok });
  assert.equal(open.status, 200);
  assert.equal(open.body.agentId, 'army');
  assert.ok(open.body.tasks.some((task) => task.id === panel.body.id && task.delivery === 'queue'));
  assert.equal((await json('/api/agents/army/tasks?status=open')).status, 401);
  assert.equal((await json('/api/agents/missing/tasks?status=open', { headers: tok })).status, 404);
  assert.equal((await json('/api/agents/army/tasks?status=later', { headers: tok })).status, 400);

  const progressed = await json(`/api/orders/${panel.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'in_progress', progress: 10 }),
  });
  assert.equal(progressed.status, 200);
  const finished = await json(`/api/orders/${panel.body.id}`, {
    method: 'POST', headers: tok, body: JSON.stringify({ status: 'done', result: 'готово' }),
  });
  assert.equal(finished.status, 200);
  assert.equal(kremlinHits.length, afterPanel);
  const stillOpen = await json('/api/agents/army/tasks?status=open', { headers: tok });
  assert.equal(stillOpen.body.tasks.some((task) => task.id === panel.body.id), false);
  const all = await json('/api/agents/army/tasks?status=all', { headers: tok });
  assert.ok(all.body.tasks.some((task) => task.id === panel.body.id));

  const financeOpen = await json('/api/agents/finance/tasks?status=open', { headers: tok });
  assert.ok(financeOpen.body.tasks.some((task) => task.text.includes('черновик суммы')));
  assert.ok(financeOpen.body.tasks.some((task) => task.text.includes('итого 10')));

  const testsBefore = kremlinHits.length;
  const questionOpen = office.state.needs.find((n) => n.id === 'need-test-question');
  questionOpen.closedAt = null;
  questionOpen.closedBy = null;
  questionOpen.answerStatus = null;
  const testAnswer = await json('/api/needs/need-test-question/answer', {
    method: 'POST', body: JSON.stringify({ text: 'пробный без очереди', partial: true }),
  });
  assert.equal(testAnswer.status, 201);
  assert.equal(kremlinHits.length, testsBefore);
  assert.equal((await json('/api/state')).body.tasks.some((task) => String(task.text || '').includes('пробный без очереди')), false);

  const grokNeed = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Вопрос Путину', where: 'Кремль', fromAgentId: 'grok', urgency: 'low', kind: 'secret', answerable: true }),
  });
  const grokAnswer = await json(`/api/needs/${grokNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'сам разберусь', partial: true }),
  });
  assert.equal(grokAnswer.status, 201);
  const putin = (await json('/api/state')).body.tasks.find((task) => task.text.includes('сам разберусь'));
  assert.equal(putin.agent, 'grok');
  assert.equal(putin.delivery, 'queue');
  assert.equal(hitFor(grokNeed.body.id, 'answer').body.agentId, 'grok');

  const archived = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({ what: 'Архивный вопрос', where: 'МГУ', fromAgentId: 'lang', urgency: 'low', answerable: true }),
  });
  const archivedAnswer = await json(`/api/needs/${archived.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'ответ в очередь Путина' }),
  });
  assert.equal(archivedAnswer.status, 201);
  const archivedTask = (await json('/api/state')).body.tasks.find((task) => task.text.includes('ответ в очередь Путина'));
  assert.equal(archivedTask.agent, 'grok');
  assert.equal(archivedTask.agentId, 'grok');
  assert.equal((await json('/api/state')).body.tasks.some((task) => task.agent === 'lang' && task.text.includes('ответ в очередь Путина')), false);

  office.state.needs.find((item) => item.id === grokNeed.body.id).fromAgentId = 'nobody';
  const unknown = await json(`/api/needs/${grokNeed.body.id}/answer`, {
    method: 'POST', headers: pw, body: JSON.stringify({ text: 'некому отдать' }),
  });
  assert.equal(unknown.status, 201);
  const unknownTask = (await json('/api/state')).body.tasks.find((task) => task.text.includes('некому отдать'));
  assert.equal(unknownTask.agentId, 'grok');

  const envName = 'KREMLIN_ROUTE_RESOLVE_OK';
  const envNeed = await json('/api/needs', {
    method: 'POST', headers: tok,
    body: JSON.stringify({
      what: 'Само закроется', where: 'Фон', fromAgentId: 'routines', urgency: 'low', kind: 'secret', resolvesWhenEnv: envName,
    }),
  });
  process.env[envName] = 'set';
  try {
    assert.ok(office.resolveNeedsByEnv() >= 1);
  } finally {
    delete process.env[envName];
  }
  const started = Date.now();
  let envHit = null;
  while (Date.now() - started < 2000) {
    envHit = hitFor(envNeed.body.id, 'close');
    if (envHit) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(envHit);
  assert.equal(envHit.body.text, 'Пункт «Само закроется» закрыт');
  assert.equal(envHit.body.agentId, 'routines');

  const { buildPayload } = require('../lib/poryadok-sync');
  const beforeRetire = grokHits.length;
  buildPayload(office.state, []);
  assert.equal(grokHits.length, beforeRetire);
  assert.equal(grokHits.length, 0);
});

test('живой вебхук принимает оба вида ключа и не пишет ключ в лог', async () => {
  process.env.KREMLIN_WEBHOOK_URL = kremlinUrl;
  delete process.env.KREMLIN_WEBHOOK_HEADER;

  process.env.KREMLIN_WEBHOOK_KEY = 'Bearer already-set';
  const bearer = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'qa', text: 'Ключ со схемой Bearer' }),
  });
  assert.equal(bearer.status, 201);
  const bearerHit = kremlinHits.find((hit) => hit.body && hit.body.taskId === bearer.body.id);
  assert.equal(bearerHit.headers.authorization, 'Bearer already-set');
  assert.equal(bearerHit.headers['x-webhook-key'], 'already-set');

  process.env.KREMLIN_WEBHOOK_KEY = 'Authorization: Basic zzz';
  const basic = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'qa', text: 'Ключ Authorization Basic' }),
  });
  const basicHit = kremlinHits.find((hit) => hit.body && hit.body.taskId === basic.body.id);
  assert.equal(basicHit.headers.authorization, 'Basic zzz');
  assert.equal(basicHit.headers['x-webhook-key'], 'zzz');

  process.env.KREMLIN_WEBHOOK_HEADER = 'X-Extra';
  process.env.KREMLIN_WEBHOOK_KEY = 'plain-secret';
  const extra = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'qa', text: 'Дополнительный заголовок' }),
  });
  const extraHit = kremlinHits.find((hit) => hit.body && hit.body.taskId === extra.body.id);
  assert.equal(extraHit.headers.authorization, 'Bearer plain-secret');
  assert.equal(extraHit.headers['x-webhook-key'], 'plain-secret');
  assert.equal(extraHit.headers['x-extra'], 'Bearer plain-secret');
  delete process.env.KREMLIN_WEBHOOK_HEADER;

  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${deadPort}/down`;
  process.env.KREMLIN_WEBHOOK_KEY = 'SentinelKey-42';
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const failed = await json('/api/task', {
      method: 'POST', headers: pw,
      body: JSON.stringify({ agent: 'temshik', text: 'Вебхук молчит, задача жива' }),
    });
    assert.equal(failed.status, 201);
    assert.equal(failed.body.status, 'в очереди агента');
    assert.equal(failed.body.delivery, 'queue');
    const queued = await json('/api/agents/temshik/tasks?status=open', { headers: tok });
    assert.ok(queued.body.tasks.some((task) => task.id === failed.body.id));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(logs.some((line) => line.includes('SentinelKey-42')), false);
  assert.equal(logs.some((line) => line.includes('Вебхук Кремля не доставлен')), true);
  assert.equal(grokHits.length, 0);
});

test('без KREMLIN_WEBHOOK_URL задача остаётся в очереди', async () => {
  delete process.env.KREMLIN_WEBHOOK_URL;
  const before = kremlinHits.length;
  const created = await json('/api/task', {
    method: 'POST', headers: pw,
    body: JSON.stringify({ agent: 'social', text: 'Только очередь' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'в очереди агента');
  assert.equal(created.body.delivery, 'queue');
  assert.equal(created.body.forwardStatus, null);
  assert.equal(kremlinHits.length, before);
  const open = await json('/api/agents/social/tasks?status=open', { headers: tok });
  assert.ok(open.body.tasks.some((task) => task.id === created.body.id && task.status === 'в очереди агента'));
  assert.equal(grokHits.length, 0);
  process.env.KREMLIN_WEBHOOK_URL = kremlinUrl;
  process.env.KREMLIN_WEBHOOK_KEY = 'plain-secret';
});

test('financeTextReopen открывает need-finance без текстового ответа один раз', () => {
  const closedAt = '2026-11-01T09:00:00.000Z';
  const list = [
    {
      id: 'need-finance',
      what: 'Нейтральный пункт',
      closedAt,
      closedBy: 'owner',
      answerMode: 'yesno',
      answer: 'yes',
      answeredAt: closedAt,
      answerStatus: 'answered',
      answers: [{ text: 'Да', at: closedAt, by: 'owner' }],
    },
    {
      id: 'need-social',
      what: 'Нейтральный соседний пункт',
      closedAt,
      closedBy: 'owner',
      answer: 'yes',
      answers: [{ text: 'Да', at: closedAt, by: 'owner' }],
    },
  ];
  list.migrationFlags = { financeTextReopen: false };

  office.migrateOwnerNeeds(list);
  const finance = list.find((item) => item.id === 'need-finance');
  const social = list.find((item) => item.id === 'need-social');
  assert.equal(finance.closedAt, null);
  assert.equal(finance.closedBy, null);
  assert.equal(finance.answerMode, 'text');
  assert.equal(finance.answer, null);
  assert.equal(finance.answers[0].text, 'Да');
  assert.equal(finance.answers[0].note, 'до текстового поля');
  assert.equal(list.migrationFlags.financeTextReopen, true);
  assert.equal(social.closedAt, closedAt);
  assert.equal(social.answers[0].note, undefined);

  finance.closedAt = '2026-11-02T09:00:00.000Z';
  finance.closedBy = 'owner';
  finance.answers = [{ text: 'Да', at: finance.closedAt, by: 'owner' }];
  office.migrateOwnerNeeds(list);
  assert.equal(finance.closedAt, '2026-11-02T09:00:00.000Z');
  assert.equal(list.migrationFlags.financeTextReopen, true);
  assert.equal(social.closedAt, closedAt);
});

test('need-finance без текстового ответа открывается один раз, need-social нет', () => {
  const { buildPayload } = require('../lib/poryadok-sync');
  const finance = office.state.needs.find((item) => item.id === 'need-finance');
  const social = office.state.needs.find((item) => item.id === 'need-social');
  const socialClosedAt = social.closedAt;
  const socialAnswers = JSON.parse(JSON.stringify(social.answers || []));

  office.state.migrations.financeTextReopen = false;
  const closedAt = '2026-11-01T09:00:00.000Z';
  finance.closedAt = closedAt;
  finance.closedBy = 'owner';
  finance.answerMode = 'yesno';
  finance.answer = 'yes';
  finance.answeredAt = closedAt;
  finance.answerStatus = 'answered';
  finance.answers = [{ text: 'Да', at: closedAt, by: 'owner' }];
  social.closedAt = closedAt;
  social.closedBy = 'owner';
  social.answer = 'yes';
  social.answers = [{ text: 'Да', at: closedAt, by: 'owner' }];

  office.migrateOwnerNeeds();
  assert.equal(finance.closedAt, null);
  assert.equal(finance.closedBy, null);
  assert.equal(finance.answerMode, 'text');
  assert.equal(finance.answer, null);
  assert.equal(finance.answers.length, 1);
  assert.equal(finance.answers[0].text, 'Да');
  assert.equal(finance.answers[0].note, 'до текстового поля');
  assert.equal(office.state.migrations.financeTextReopen, true);
  assert.equal(social.closedAt, closedAt);
  assert.equal(social.answers[0].note, undefined);
  const opened = buildPayload({ needs: office.state.needs, tasks: [], agents: office.state.agents }, []);
  assert.equal(opened.tasks.find((task) => task.externalId === 'kremlin-need-need-finance').status, 'В ожидании');
  assert.equal(opened.tasks.find((task) => task.externalId === 'kremlin-need-need-social').status, 'Выполнено');

  finance.closedAt = '2026-11-02T09:00:00.000Z';
  finance.closedBy = 'user';
  finance.answers = [{ text: 'Да', at: finance.closedAt, by: 'owner' }];
  office.migrateOwnerNeeds();
  assert.equal(finance.closedAt, '2026-11-02T09:00:00.000Z');
  assert.equal(social.closedAt, closedAt);

  office.state.migrations.financeTextReopen = false;
  finance.closedAt = '2026-11-03T09:00:00.000Z';
  finance.closedBy = 'owner';
  finance.answerMode = 'yesno';
  finance.answers = [
    { text: 'Да', at: finance.closedAt, by: 'owner' },
    { text: 'триста тысяч', at: finance.closedAt, by: 'owner' },
  ];
  office.migrateOwnerNeeds();
  assert.equal(finance.closedAt, '2026-11-03T09:00:00.000Z');
  assert.equal(finance.answers[1].note, undefined);
  assert.equal(office.state.migrations.financeTextReopen, true);

  office.state.migrations.financeTextReopen = false;
  finance.closedAt = '2026-11-04T09:00:00.000Z';
  finance.closedBy = 'owner';
  finance.answer = 'no';
  finance.answeredAt = finance.closedAt;
  finance.answers = [];
  office.migrateOwnerNeeds();
  assert.equal(finance.closedAt, null);
  assert.equal(finance.answerMode, 'text');
  assert.equal(finance.answers[0].text, 'Нет');
  assert.equal(finance.answers[0].note, 'до текстового поля');

  office.state.migrations.financeTextReopen = false;
  finance.closedAt = '2026-11-05T09:00:00.000Z';
  finance.closedBy = 'owner';
  finance.answer = null;
  finance.answers = [];
  office.migrateOwnerNeeds();
  assert.equal(finance.closedAt, null);
  assert.equal(finance.answers.length, 0);
  assert.equal(finance.answerMode, 'text');
  assert.equal(social.closedAt, closedAt);

  social.closedAt = socialClosedAt;
  social.closedBy = null;
  social.answer = null;
  social.answers = socialAnswers;
  assert.equal(grokHits.length, 0);
});
