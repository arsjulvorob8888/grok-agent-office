'use strict';

// Память и Postgres: node --test. Сервер каждый раз в отдельном процессе,
// чтобы перезапуск читал состояние заново. DATABASE_URL в окружении CI включает режим базы.
const { describe, test } = require('node:test');
const { missingSeeds } = require('../lib/store');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const TXT = Buffer.from('заметка для базы');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-test';
  env.AGENT_TOKEN = 'tok-test';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  env.PUBLIC_URL = 'https://example.test';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-store-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) {
      throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        up = true;
        break;
      }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return {
    base,
    child,
    logs,
    uploadDir,
    text() { return `${this.logs.out}\n${this.logs.err}`; },
  };
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      office.child.kill('SIGKILL');
      resolve();
    }, 3000);
    office.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(base, pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = text; }
  }
  return { status: res.status, body, headers: res.headers };
}

function json(base, pathname, opts = {}) {
  return api(base, pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

async function seedOffice(base) {
  const pngForm = new FormData();
  pngForm.append('files', new Blob([PNG], { type: 'image/png' }), 'экран.png');
  const png = await api(base, '/api/upload', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: pngForm,
  });
  assert.equal(png.status, 201);
  const txtForm = new FormData();
  txtForm.append('files', new Blob([TXT], { type: 'text/plain' }), 'заметка.txt');
  const txt = await api(base, '/api/upload', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: txtForm,
  });
  assert.equal(txt.status, 201);

  const parent = await json(base, '/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({
      agent: 'dev',
      text: 'Сохранить приказ',
      fromAgentId: 'owner',
      attachmentIds: [png.body.attachments[0].id],
    }),
  });
  assert.equal(parent.status, 201);

  const child = await json(base, '/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({
      agent: 'qa',
      text: 'Проверь сохранение',
      fromAgentId: 'dev',
      parentOrderId: parent.body.id,
    }),
  });
  assert.equal(child.status, 201);

  const accepted = await json(base, `/api/orders/${parent.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ status: 'accepted', note: 'Беру' }),
  });
  assert.equal(accepted.status, 200);
  const progress = await json(base, `/api/orders/${parent.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ status: 'in_progress', progress: 40, note: 'Смотрю код' }),
  });
  assert.equal(progress.status, 200);
  const done = await json(base, `/api/orders/${parent.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ status: 'done', result: 'Сохранено' }),
  });
  assert.equal(done.status, 200);

  const message = await json(base, '/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({
      id: 'relay-store-1',
      agentId: 'dev',
      role: 'agent',
      text: 'Строка из чата',
      timestamp: '2026-11-17T12:00:00.000Z',
    }),
  });
  assert.equal(message.status, 201);
  const auto = await json(base, '/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ agentId: 'qa', role: 'agent', taskId: child.body.id, text: 'Без своего id' }),
  });
  assert.equal(auto.status, 201);

  const need = await json(base, '/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({
      what: 'Подтвердить черновик',
      where: 'Чат Темщика',
      fromAgentId: 'temshik',
      urgency: 'low',
      kind: 'approval',
      docUrl: 'https://example.com/doc',
      participants: ['dev', 'temshik'],
    }),
  });
  assert.equal(need.status, 201);
  const scout = await json(base, '/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ agent: 'scout', name: 'Разведка', status: 'idle', now: 'Жду задач' }),
  });
  assert.equal(scout.status, 200);
  assert.equal(scout.body.agent.id, 'scout');

  const closed = await json(base, `/api/needs/${need.body.id}/close`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ agentId: 'dev' }),
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.closedBy, 'dev');
  const answer = await json(base, '/api/needs/need-finance/answer', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-test' },
    body: JSON.stringify({ text: 'Ответ на финансы', partial: true }),
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.body.answerStatus, 'answered');
  assert.equal(answer.body.closedAt, null);
  assert.equal(answer.body.answerMode, 'text');
  assert.equal(answer.body.answers[0].text, 'Ответ на финансы');
  assert.equal(answer.body.answers[0].by, 'owner');
  assert.ok(answer.body.answers[0].at);
  assert.ok(answer.body.updatedAt);
  const closedTest = await json(base, '/api/needs/need-test-qa/answer', {
    method: 'POST',
    body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(closedTest.status, 201);
  assert.ok(closedTest.body.closedAt);
  const marked = await json(base, '/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-test' },
    body: JSON.stringify({ agent: 'dev', status: 'idle', now: 'Жду следующую', done: 'Сохранил опыт' }),
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.agent.completed, 2);

  return {
    png: png.body.attachments[0],
    txt: txt.body.attachments[0],
    parent: parent.body,
    child: child.body,
    need: need.body,
    closed,
    autoId: auto.body.message.id,
    done: done.body.task,
  };
}

describe('хранилище', { concurrency: 1 }, () => {
  test('посев не возвращает пункт, которого нет в списке', () => {
    const seeds = [
      { id: 'need-academy', what: 'Академия' },
      { id: 'need-finance', what: 'Финансы' },
    ];
    assert.deepEqual(missingSeeds(['need-academy', 'need-render-api'], seeds).map((item) => item.id), ['need-finance']);
    assert.equal(missingSeeds([], seeds).some((item) => item.id === 'need-render-api'), false);
    assert.deepEqual(missingSeeds(['need-academy', 'need-finance'], seeds), []);
  });

  test('без DATABASE_URL данные не переживают перезапуск', async () => {
    const first = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
    try {
      assert.match(first.text(), /DATABASE_URL не задан/);
      assert.equal(first.text().includes('postgres://'), false);
      const made = await seedOffice(first.base);
      assert.equal(made.parent.orderStatus, 'sent');
      const file = await fetch(first.base + made.png.url);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'image/png');
    } finally {
      await stopOffice(first);
    }

    const second = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
    try {
      const state = await json(second.base, '/api/state');
      assert.equal(state.body.tasks.length, 0);
      assert.equal(state.body.messages.length, 0);
      assert.equal(state.body.agents.some((agent) => agent.id === 'scout'), false);
      assert.equal(state.body.agents.find((agent) => agent.id === 'trading').archived, true);
      const needs = await json(second.base, '/api/needs');
      assert.equal(needs.body.needs.length, 4);
      assert.ok(needs.body.needs.find((item) => item.id === 'need-test-qa'));
      assert.ok(needs.body.needs.find((item) => item.id === 'need-test-question'));
      assert.equal(needs.body.needs.find((item) => item.id === 'need-render-api'), undefined);
      assert.ok(needs.body.needs.find((item) => item.id === 'need-finance'));
      const missing = await fetch(second.base + '/api/files/' + 'a'.repeat(32));
      assert.equal(missing.status, 404);
    } finally {
      await stopOffice(second);
    }
  });

  test('недоступная база не роняет процесс и не пишет строку подключения', async () => {
    const secret = 's3cret-db-pass';
    const url = `postgres://office:${secret}@127.0.0.1:1/office?sslmode=disable`;
    const office = await startOffice({ DATABASE_URL: url, STORE_SCHEMA: '' });
    try {
      const logs = office.text();
      const lines = logs.split('\n').map((line) => line.trim()).filter(Boolean);
      assert.equal(lines.filter((line) => line.includes('Postgres недоступен')).length, 1);
      assert.equal(logs.includes(secret), false);
      assert.equal(logs.includes('postgres://'), false);
      assert.equal(logs.includes('SECURITY WARNING'), false);
      const task = await json(office.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ agent: 'dev', text: 'Только в памяти' }),
      });
      assert.equal(task.status, 201);
      assert.equal(office.child.exitCode, null);
    } finally {
      await stopOffice(office);
    }
  });

  test('sslmode=require не пишет строку подключения', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('sslmode', 'require');
    const schema = `s_${crypto.randomBytes(4).toString('hex')}`;
    const office = await startOffice({ DATABASE_URL: url.toString(), STORE_SCHEMA: schema });
    try {
      const logs = office.text();
      assert.equal(logs.includes('postgres://'), false);
      assert.equal(logs.includes('SECURITY WARNING'), false);
      assert.equal(logs.includes(url.password || '___'), false);
      const connected = logs.includes('Postgres подключен');
      const fallback = logs.includes('Postgres недоступен');
      assert.equal(connected || fallback, true);
      assert.equal(connected && fallback, false);
    } finally {
      await stopOffice(office);
      await dropSchema(schema);
    }
  });

  test('созданная задача остаётся в /api/state после нового процесса', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const schema = `r_${crypto.randomBytes(4).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    let taskId;
    const first = await startOffice(env);
    try {
      const created = await json(first.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ agent: 'dev', text: 'Пережить перезапуск' }),
      });
      assert.equal(created.status, 201);
      taskId = created.body.id;
    } finally {
      await stopOffice(first);
    }
    const second = await startOffice(env);
    try {
      const state = await json(second.base, '/api/state');
      const saved = state.body.tasks.find((task) => task.id === taskId);
      assert.ok(saved);
      assert.equal(saved.text, 'Пережить перезапуск');
      assert.equal(saved.agentId, 'dev');
      assert.equal(state.body.needs.find((item) => item.id === 'need-render-api'), undefined);
    } finally {
      await stopOffice(second);
      await dropSchema(schema);
    }
  });

  test('запись одного процесса видна свежему процессу', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const schema = `v_${crypto.randomBytes(4).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    let taskId;
    const first = await startOffice(env);
    try {
      const created = await json(first.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ agent: 'qa', text: 'Нейтральная запись между процессами', fromAgentId: 'owner' }),
      });
      assert.equal(created.status, 201);
      taskId = created.body.id;
      const accepted = await json(first.base, `/api/orders/${taskId}`, {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-test' },
        body: JSON.stringify({ status: 'accepted', note: 'Владелец ждёт' }),
      });
      assert.equal(accepted.status, 200);
    } finally {
      await stopOffice(first);
    }

    const second = await startOffice(env);
    try {
      const state = await json(second.base, '/api/state');
      const saved = state.body.tasks.find((task) => task.id === taskId);
      assert.ok(saved);
      assert.equal(saved.text, 'Нейтральная запись между процессами');
      assert.equal(saved.agentId, 'qa');
      assert.equal(saved.fromAgentId, 'owner');
      assert.equal(saved.orderStatus, 'accepted');
      assert.equal(saved.note, 'Владелец ждёт');
      const line = state.body.messages.find((item) => item.taskId === taskId && String(item.text).startsWith('Принял заказ'));
      assert.ok(line);
      assert.equal(line.text, 'Принял заказ · Владелец ждёт');
    } finally {
      await stopOffice(second);
      await dropSchema(schema);
    }
  });

  test('Postgres сохраняет приказ, пункт, сообщение и файл после перезапуска', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const schema = `p_${crypto.randomBytes(6).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    let made;
    let financeCreatedAt;
    const first = await startOffice(env);
    try {
      assert.match(first.text(), /Postgres подключен/);
      assert.equal(first.text().includes('postgres://'), false);
      made = await seedOffice(first.base);
      const open = await json(first.base, '/api/needs');
      financeCreatedAt = open.body.needs.find((item) => item.id === 'need-finance').createdAt;
      assert.ok(financeCreatedAt);
    } finally {
      await stopOffice(first);
    }

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const version = await pool.query(`SELECT version FROM ${schema}.schema_version ORDER BY version`);
      assert.deepEqual(version.rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7]);
      await pool.query(`UPDATE ${schema}.needs SET what = $1 WHERE id = $2`, ['Отредактировано вручную', 'need-finance']);
      await pool.query(`DELETE FROM ${schema}.needs WHERE id = $1`, ['need-social']);
      await pool.query(`DELETE FROM ${schema}.needs WHERE id = $1`, ['need-academy']);
      await pool.query(
        `UPDATE ${schema}.needs SET extra = COALESCE(extra, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        ['need-finance', JSON.stringify({ answer: 'краткий ответ', answeredAt: '2026-11-17T12:30:00.000Z', updatedAt: '2026-11-17T12:31:00.000Z' })],
      );
      await pool.query(
        `UPDATE ${schema}.agent_state SET payload = COALESCE(payload, '{}'::jsonb) || '{"analysis":"смотрит риски"}'::jsonb WHERE id = 'advisor'`,
      );
      await pool.query(
        `UPDATE ${schema}.orders SET extra = $2::jsonb WHERE id = $1`,
        [made.parent.id, JSON.stringify({ deadline: '2031-11-17', priority: 'Срочно' })],
      );
      const flags = await pool.query(`SELECT id, archived FROM ${schema}.agent_state WHERE id IN ('trading', 'biz', 'grok') ORDER BY id`);
      assert.deepEqual(flags.rows.map((row) => [row.id, row.archived]), [['biz', true], ['grok', false], ['trading', true]]);
    } finally {
      await pool.end();
    }

    const second = await startOffice(env);
    try {
      assert.match(second.text(), /Postgres подключен/);
      const state = await json(second.base, '/api/state');
      const parent = state.body.tasks.find((task) => task.id === made.parent.id);
      const child = state.body.tasks.find((task) => task.id === made.child.id);
      assert.ok(parent);
      assert.equal(parent.agentId, 'dev');
      assert.equal(parent.fromAgentId, 'owner');
      assert.equal(parent.parentOrderId, null);
      assert.equal(parent.orderStatus, 'done');
      assert.equal(parent.status, 'выполнена');
      assert.equal(parent.result, 'Сохранено');
      assert.equal(parent.progress, null);
      assert.deepEqual(parent.history.map((entry) => entry.status), ['sent', 'accepted', 'in_progress', 'done']);
      assert.equal(parent.history[2].progress, 40);
      assert.equal(parent.history[2].note, 'Смотрю код');
      assert.equal(parent.history.at(-1).result, 'Сохранено');
      assert.equal(parent.attachments[0].id, made.png.id);
      assert.equal(parent.attachments[0].name, 'экран.png');
      assert.equal(parent.deadline, '2031-11-17');
      assert.equal(parent.priority, 'Срочно');
      const trading = state.body.agents.find((agent) => agent.id === 'trading');
      const biz = state.body.agents.find((agent) => agent.id === 'biz');
      const grok = state.body.agents.find((agent) => agent.id === 'grok');
      assert.equal(trading.archived, true);
      assert.equal(trading.number, '');
      assert.equal(biz.archived, true);
      assert.equal(grok.archived, false);
      assert.equal(state.body.agents.find((agent) => agent.id === 'finance').number, '7');
      const scout = state.body.agents.find((agent) => agent.id === 'scout');
      assert.ok(scout);
      assert.equal(scout.name, 'Разведка');
      assert.equal(scout.archived, false);
      assert.ok(state.body.agents.find((agent) => agent.id === 'grok').links.includes('scout'));
      const blocked = await json(second.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ agent: 'trading', text: 'После перезапуска' }),
      });
      assert.equal(blocked.status, 409);
      assert.ok(child);
      assert.equal(child.agentId, 'qa');
      assert.equal(child.fromAgentId, 'dev');
      assert.equal(child.parentOrderId, made.parent.id);
      assert.equal(child.orderStatus, 'sent');

      const system = state.body.messages.filter((message) => message.role === 'system' && message.taskId === parent.id);
      assert.equal(system.length, parent.history.length);
      assert.equal(system.filter((message) => message.text.startsWith('Выполнено:')).length, 1);
      const relay = state.body.messages.find((message) => message.id === 'relay-store-1');
      assert.equal(relay.text, 'Строка из чата');
      assert.equal(relay.role, 'agent');
      assert.equal(relay.timestamp, '2026-11-17T12:00:00.000Z');

      const needs = await json(second.base, '/api/needs');
      const ids = needs.body.needs.map((item) => item.id);
      assert.equal(ids.includes(made.need.id), false);
      assert.equal(ids.includes('need-social'), false);
      assert.equal(ids.includes('need-academy'), false);
      assert.equal(ids.includes('need-render-api'), false);
      assert.equal(state.body.needs.some((item) => item.id === 'need-academy' || item.id === 'need-render-api'), false);
      assert.equal(state.body.agents.find((agent) => agent.id === 'advisor').analysis, 'смотрит риски');
      const dev = state.body.agents.find((agent) => agent.id === 'dev');
      assert.equal(dev.completed, 2);
      assert.equal(dev.status, 'idle');
      assert.equal(dev.now, 'Жду следующую');
      assert.equal(dev.done[0], 'Сохранил опыт');
      assert.ok(ids.includes('need-finance'));
      const finance = needs.body.needs.find((item) => item.id === 'need-finance');
      assert.equal(finance.what, 'Отредактировано вручную');
      assert.equal(finance.createdAt, financeCreatedAt);
      assert.equal(finance.answer, 'краткий ответ');
      assert.equal(finance.answeredAt, '2026-11-17T12:30:00.000Z');
      assert.equal(finance.updatedAt, '2026-11-17T12:31:00.000Z');
      assert.equal(finance.kind, 'money');
      assert.equal(finance.answerMode, 'text');
      assert.equal(finance.closedAt, null);
      assert.ok(finance.docUrl);
      const reopened = needs.body.needs.find((item) => item.id === 'need-test-qa');
      assert.ok(reopened);
      assert.equal(reopened.closedAt, null);
      assert.equal(reopened.answerMode, 'yesno');
      assert.deepEqual(reopened.answers, []);
      const question = needs.body.needs.find((item) => item.id === 'need-test-question');
      assert.ok(question);
      assert.equal(question.closedAt, null);
      assert.equal(question.answerMode, 'text');
      assert.equal(finance.updatedAt, '2026-11-17T12:31:00.000Z');
      const savedNeed = await json(second.base, `/api/needs/${made.need.id}`, {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.equal(savedNeed.status, 200);
      assert.equal(savedNeed.body.closedBy, 'dev');
      assert.ok(savedNeed.body.closedAt);
      assert.equal(savedNeed.body.kind, 'approval');
      assert.equal(savedNeed.body.docUrl, 'https://example.com/doc');
      assert.deepEqual(savedNeed.body.participants, ['dev', 'temshik']);
      assert.ok(savedNeed.body.updatedAt);
      const savedFinance = await json(second.base, '/api/needs/need-finance', {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.equal(savedFinance.body.answerStatus, 'answered');
      assert.equal(savedFinance.body.closedAt, null);
      assert.equal(savedFinance.body.answerMode, 'text');
      assert.equal(savedFinance.body.answers[0].text, 'Ответ на финансы');
      assert.equal(savedFinance.body.answers[0].by, 'owner');
      assert.ok(savedFinance.body.answers[0].at);
      assert.equal(savedFinance.body.updatedAt, '2026-11-17T12:31:00.000Z');
      const render = await json(second.base, '/api/needs/need-render-api');
      assert.equal(render.status, 404);

      const png = await fetch(second.base + made.png.url);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');
      assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
      const txt = await fetch(second.base + made.txt.url);
      assert.equal(txt.status, 200);
      assert.equal(txt.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(Buffer.from(await txt.arrayBuffer()), TXT);

      const third = await json(second.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ agent: 'dev', text: 'Следующий номер' }),
      });
      assert.equal(third.status, 201);
      assert.notEqual(third.body.id, made.parent.id);
      assert.notEqual(third.body.id, made.child.id);
      const nums = [made.parent.id, made.child.id, third.body.id].map((id) => Number(id.slice(2)));
      assert.deepEqual(nums, [1, 2, 5]);
      assert.equal(made.autoId, 'm-1');
      const nextMessage = await json(second.base, '/api/messages', {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-test' },
        body: JSON.stringify({ agentId: 'qa', role: 'agent', taskId: made.child.id, text: 'Следующий номер сообщения' }),
      });
      assert.equal(nextMessage.status, 201);
      assert.equal(nextMessage.body.message.id, 'm-2');
    } finally {
      await stopOffice(second);
      await dropSchema(schema);
    }
  });

  test('financeTextReopen один раз и не повторяется после рестарта', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const schema = `m_${crypto.randomBytes(4).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    const first = await startOffice(env);
    await stopOffice(first);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await pool.query(
        `UPDATE ${schema}.needs SET closed_at = now(), extra = COALESCE(extra, '{}'::jsonb) || $1::jsonb WHERE id = 'need-finance'`,
        [JSON.stringify({
          answer: 'yes',
          answers: [{ text: 'Да', at: '2026-11-17T12:00:00.000Z', by: 'owner' }],
          closedBy: 'owner',
          answerMode: 'text',
        })],
      );
      await pool.query(
        `INSERT INTO ${schema}.app_state (key, value) VALUES ('migrations', '{"financeTextReopen":false}'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    } finally {
      await pool.end();
    }

    const second = await startOffice(env);
    try {
      const finance = await json(second.base, '/api/needs/need-finance', {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.equal(finance.status, 200);
      assert.equal(finance.body.closedAt, null);
      assert.equal(finance.body.answerMode, 'text');
      assert.equal((finance.body.answers || []).some((entry) => entry.note === 'до текстового поля'), true);
      const closed = await json(second.base, '/api/needs/need-finance/close', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-test' },
        body: '{}',
      });
      assert.equal(closed.status, 200);
      assert.ok(closed.body.closedAt);
    } finally {
      await stopOffice(second);
    }

    const third = await startOffice(env);
    try {
      const finance = await json(third.base, '/api/needs/need-finance', {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.ok(finance.body.closedAt);
    } finally {
      await stopOffice(third);
      await dropSchema(schema);
    }
  });

  test('grokAgentId посевного агента берётся из кода и обновляется после рестарта', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const expected = {
      grok: '8b9d4ad0-4222-49a8-84b4-b125d3b7ec01',
      army: 'b174ea11-d3ab-4ad7-ab65-8feacca27cf4',
      poker: 'e15adfa3-6299-4980-a224-1b7adea71c45',
      devops: 'd2ed048e-12e7-4b0e-b42c-36225ed71745',
      dev: '8117cf6a-c57d-42cc-ba6f-2421fe7af6ad',
      temshik: '6a1deccc-2411-4fd1-8da7-e7ba9fce6df2',
      finance: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
      invest: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
      analyst: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
      qa: '892a92c9-8133-48d2-b22d-c77e653309af',
      blog: '118a97ac-2030-4f25-b684-ac19252fb4aa',
      advisor: '961b2d3d-5f80-4891-b87a-c6913bbf2971',
      social: 'a1bd53f2-5655-446b-8207-393e61fc20e1',
      routines: 'd6b45571-e211-4218-a1e2-1c0918973ddc',
      trading: '504035c8-ccd8-467b-9e34-f16305493533',
      biz: 'a64c9436-36bc-4122-af1b-89d56950b0c1',
      lang: '5f09e2b6-ec92-44ef-bcbd-b1f848daed18',
    };
    const stale = '11111111-1111-4111-8111-111111111111';
    const schema = `g_${crypto.randomBytes(4).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    const ids = Object.keys(expected);
    const first = await startOffice(env);
    try {
      assert.match(first.text(), /Postgres подключен/);
      const state = await json(first.base, '/api/state');
      assert.equal(state.body.agents.find((agent) => agent.id === 'finance').name, 'Финансы');
    } finally {
      await stopOffice(first);
    }

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const planted = await pool.query(
        `UPDATE ${schema}.agent_state
         SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
         WHERE id = ANY($1::text[])`,
        [ids, JSON.stringify({
          grokAgentId: stale,
          name: 'Чужое имя',
          district: 'Чужой район',
          now: 'Строка из базы',
          status: 'waiting',
        })],
      );
      assert.equal(planted.rowCount, ids.length);
    } finally {
      await pool.end();
    }

    const second = await startOffice(env);
    const check = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      assert.match(second.text(), /Postgres подключен/);
      const state = await json(second.base, '/api/state');
      for (const [id, grokAgentId] of Object.entries(expected)) {
        const agent = state.body.agents.find((item) => item.id === id);
        assert.ok(agent, id);
        assert.equal(agent.grokAgentId, grokAgentId, id);
        assert.notEqual(agent.name, 'Чужое имя', id);
        assert.notEqual(agent.district, 'Чужой район', id);
        assert.equal(agent.now, 'Строка из базы', id);
        assert.equal(agent.status, 'waiting', id);
      }
      const finance = state.body.agents.find((agent) => agent.id === 'finance');
      const invest = state.body.agents.find((agent) => agent.id === 'invest');
      const analyst = state.body.agents.find((agent) => agent.id === 'analyst');
      assert.equal(finance.name, 'Финансы');
      assert.equal(finance.district, 'Китай-город · Ильинка');
      assert.equal(invest.number, '7.1');
      assert.equal(analyst.number, '7.2');
      assert.equal(invest.parentId, 'finance');
      assert.equal(analyst.parentId, 'finance');
      const saved = await check.query(
        `SELECT id, payload->>'grokAgentId' AS grok_agent_id FROM ${schema}.agent_state WHERE id = ANY($1::text[])`,
        [ids],
      );
      assert.equal(saved.rows.length, ids.length);
      for (const row of saved.rows) {
        assert.notEqual(row.grok_agent_id, stale, row.id);
        if (row.grok_agent_id != null) assert.equal(row.grok_agent_id, expected[row.id], row.id);
      }
    } finally {
      await check.end();
      await stopOffice(second);
      await dropSchema(schema);
    }
  });
});

async function dropSchema(schema) {
  if (!process.env.DATABASE_URL) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch (_) { /* схема могла не создаться */ } finally {
    await pool.end();
  }
}
