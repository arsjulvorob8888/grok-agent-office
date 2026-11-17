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
    body: JSON.stringify({ agentId: 'qa', role: 'agent', text: 'Без своего id' }),
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
    body: JSON.stringify({ text: 'Ответ на финансы' }),
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.body.answerStatus, 'answered');
  assert.equal(answer.body.answers[0].text, 'Ответ на финансы');

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
      assert.equal(needs.body.needs.length, 3);
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
      assert.deepEqual(version.rows.map((row) => row.version), [1, 2]);
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
      assert.ok(ids.includes('need-finance'));
      const finance = needs.body.needs.find((item) => item.id === 'need-finance');
      assert.equal(finance.what, 'Отредактировано вручную');
      assert.equal(finance.createdAt, financeCreatedAt);
      assert.equal(finance.answer, 'краткий ответ');
      assert.equal(finance.answeredAt, '2026-11-17T12:30:00.000Z');
      assert.equal(finance.updatedAt, '2026-11-17T12:31:00.000Z');
      const savedNeed = await json(second.base, `/api/needs/${made.need.id}`, {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.equal(savedNeed.status, 200);
      assert.equal(savedNeed.body.closedBy, 'dev');
      assert.ok(savedNeed.body.closedAt);
      const savedFinance = await json(second.base, '/api/needs/need-finance', {
        headers: { 'x-app-password': 'pw-test' },
      });
      assert.equal(savedFinance.body.answerStatus, 'answered');
      assert.equal(savedFinance.body.answers[0].text, 'Ответ на финансы');
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
      assert.deepEqual(nums, [1, 2, 4]);
      assert.equal(made.autoId, 'm-1');
      const nextMessage = await json(second.base, '/api/messages', {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-test' },
        body: JSON.stringify({ agentId: 'qa', role: 'agent', text: 'Следующий номер сообщения' }),
      });
      assert.equal(nextMessage.status, 201);
      assert.equal(nextMessage.body.message.id, 'm-2');
    } finally {
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
