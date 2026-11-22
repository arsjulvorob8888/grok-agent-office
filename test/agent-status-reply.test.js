'use strict';

// Инварианты ответа через POST /api/agent-status и запасной /api/messages.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Feed = require('../public/js/feed');
const { renderSafeMarkdown } = require('../public/js/markdown');

const root = path.join(__dirname, '..');
const XSS = '<img src=x onerror=alert(1)>';
const WAITING = 'Доставлено агенту, ответа пока нет';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-reply-status-'));
process.env.APP_PASSWORD = 'pw-status-reply';
process.env.AGENT_TOKEN = 'tok-status-reply';
process.env.AGENT_STATUS_TOKEN = 'status-reply';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.KREMLIN_WEBHOOK_KEY;
delete process.env.PORYADOK_INGEST_TOKEN;
delete process.env.ACTIVITY_WINDOW_MIN;

const live = require('../lib/live-status');
const { app, state } = require('../server.js');

let base;
let server;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (live.setNow) live.setNow(null);
  if (server) await new Promise((resolve) => server.close(resolve));
});

function json(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (res) => ({
    status: res.status,
    headers: res.headers,
    body: await res.json().catch(() => null),
  }));
}

function postStatus(body, headers = {}) {
  return json('/api/agent-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer status-reply', ...headers },
    body: JSON.stringify(body),
  });
}

function agentOf(body, id) {
  return (body.agents || []).find((agent) => agent.id === id);
}

function taskReplies(messages, taskId) {
  return (messages || []).filter((message) => message && message.role === 'agent' && message.taskId === taskId);
}

async function createTask(agent, text, fromAgentId) {
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-status-reply' },
    body: JSON.stringify({ agent, text, ...(fromAgentId ? { fromAgentId } : {}) }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

function deliver(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  assert.ok(task, taskId);
  task.forwardStatus = 200;
  return task;
}

describe('ответ агента через живой статус', { concurrency: 1 }, () => {
  test('принятый ответ один раз в ленте задачи, и задача больше не ждёт ответа', async () => {
    const task = await createTask('social', 'Напиши пост');
    deliver(task.id);
    const before = await json('/api/state');
    assert.equal(Feed.replyWaitCaption(before.body.tasks, before.body.messages, 'social'), WAITING);
    assert.equal(taskReplies(before.body.messages, task.id).length, 0);

    const reply = await postStatus({
      agentId: 'Соцсети · Кремль',
      status: 'idle',
      taskId: task.id,
      reply: 'Пост опубликован',
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.ok, true);
    assert.equal(reply.body.id, 'social');
    assert.equal(reply.body.duplicate, false);
    assert.equal(reply.body.message.role, 'agent');
    assert.equal(reply.body.message.agentId, 'social');
    assert.equal(reply.body.message.taskId, task.id);
    assert.equal(reply.body.message.text, 'Пост опубликован');

    const again = await postStatus({
      agentId: 'social',
      status: 'idle',
      taskId: task.id,
      reply: '  Пост опубликован  ',
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.message.id, reply.body.message.id);

    const after = await json('/api/state');
    const replies = taskReplies(after.body.messages, task.id);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, 'Пост опубликован');
    assert.equal(replies[0].source, 'relay');
    const inFeed = Feed.messagesForAgent(after.body.messages, after.body.tasks, 'social')
      .filter((message) => message.taskId === task.id && message.role === 'agent');
    assert.equal(inFeed.length, 1);
    assert.equal(Feed.replyWaitCaption(after.body.tasks, after.body.messages, 'social'), '');
    const saved = after.body.tasks.find((item) => item.id === task.id);
    assert.ok(saved.answeredAt);
    assert.equal(renderSafeMarkdown(replies[0].text).includes('<img'), false);
  });

  test('HTML в ответе остаётся текстом и экранируется так же, как в ленте', async () => {
    const task = await createTask('advisor', 'Разбери отчёт');
    const reply = await postStatus({
      agentId: 'advisor',
      status: 'working',
      doing: 'Пишу ответ',
      taskId: task.id,
      reply: XSS,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const stateBody = (await json('/api/state')).body;
    const replies = taskReplies(stateBody.messages, task.id);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, XSS);
    const html = renderSafeMarkdown(replies[0].text);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(html.includes('<img'), false);
  });

  test('ответ на чужую задачу отвергается, Путин отвечает только за переданные им', async () => {
    const own = await createTask('qa', 'Проверь сборку', 'grok');
    const stranger = await postStatus({
      agentId: 'dev',
      status: 'idle',
      taskId: own.id,
      reply: 'Это не моя задача',
    });
    assert.equal(stranger.status, 400, JSON.stringify(stranger.body));
    assert.equal(stranger.body.error, 'Задача другого агента');

    const putin = await postStatus({
      agentId: 'Путин',
      status: 'idle',
      taskId: own.id,
      reply: 'Перенёс ответ',
    });
    assert.equal(putin.status, 200, JSON.stringify(putin.body));
    assert.equal(putin.body.id, 'grok');
    assert.equal(putin.body.message.agentId, 'grok');
    assert.equal(putin.body.message.taskId, own.id);

    deliver(own.id);
    const after = await json('/api/state');
    assert.equal(taskReplies(after.body.messages, own.id).length, 1);
    assert.equal(Feed.replyWaitCaption(after.body.tasks, after.body.messages, 'qa'), '');
    const feed = Feed.messagesForAgent(after.body.messages, after.body.tasks, 'qa')
      .filter((message) => message.role === 'agent' && message.taskId === own.id);
    assert.equal(feed.length, 1);

    const ownerTask = await createTask('dev', 'Своя задача владельца', 'owner');
    const refused = await postStatus({
      agentId: 'grok',
      status: 'idle',
      taskId: ownerTask.id,
      reply: 'Не я передавал',
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'Задача другого агента');
    const missing = await postStatus({
      agentId: 'qa',
      status: 'idle',
      taskId: 't-no-such',
      reply: 'нет',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'Неизвестная задача');
    const quiet = await json('/api/state');
    assert.equal(taskReplies(quiet.body.messages, ownerTask.id).length, 0);
    assert.equal(taskReplies(quiet.body.messages, 't-no-such').length, 0);
  });

  test('пинг без ответа остаётся 200, lastSeenAt монотонный и равен последнему пингу', async () => {
    const t0 = Date.now();
    let clock = t0;
    live.setNow(() => clock);
    try {
      const first = await postStatus({ agentId: 'poker', status: 'working', doing: 'Сдаю' });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.deepEqual(Object.keys(first.body).sort(), ['activity', 'doing', 'forAgent', 'id', 'ok', 'since', 'status', 'until']);
      let poker = agentOf((await json('/api/state')).body, 'poker');
      assert.equal(poker.lastSeenAt, new Date(t0).toISOString());
      assert.equal(poker.doing, 'Сдаю');

      clock = t0 - 5000;
      const older = await postStatus({ agentId: 'Покер', status: 'working', doing: 'Старше' });
      assert.equal(older.status, 200, JSON.stringify(older.body));
      poker = agentOf((await json('/api/state')).body, 'poker');
      assert.equal(poker.lastSeenAt, new Date(t0).toISOString());

      clock = t0 + 15000;
      const newer = await postStatus({ agentId: 'poker', status: 'idle' });
      assert.equal(newer.status, 200, JSON.stringify(newer.body));
      poker = agentOf((await json('/api/state')).body, 'poker');
      assert.equal(poker.lastSeenAt, new Date(clock).toISOString());
      assert.ok(poker.lastSeenAt > new Date(t0).toISOString());
    } finally {
      live.setNow(null);
    }
  });

  test('тот же токен живого статуса принимается на POST /api/messages', async () => {
    const task = await createTask('blog', 'Черновик');
    const denied = await json('/api/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-status-reply' },
      body: JSON.stringify({ agentId: 'blog', role: 'agent', taskId: task.id, text: 'нет' }),
    });
    assert.equal(denied.status, 401);

    const reply = await json('/api/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-reply' },
      body: JSON.stringify({
        agentId: 'Technology Blog · Кремль',
        role: 'agent',
        taskId: task.id,
        text: 'Черновик готов',
      }),
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.message.agentId, 'blog');
    assert.equal(reply.body.message.taskId, task.id);

    const again = await json('/api/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-reply' },
      body: JSON.stringify({ agentId: 'blog', role: 'agent', taskId: task.id, text: 'Черновик готов' }),
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.duplicate, true);

    const stateBody = (await json('/api/state')).body;
    assert.equal(taskReplies(stateBody.messages, task.id).length, 1);
    deliver(task.id);
    assert.equal(Feed.replyWaitCaption(stateBody.tasks.map((item) => (
      item.id === task.id ? { ...item, forwardStatus: 200 } : item
    )), stateBody.messages, 'blog'), '');
  });

  test('ответ делит лимит с /api/messages, пинг без ответа — нет', async () => {
    const task = await createTask('army', 'Серия');
    let blocked = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await json('/api/messages', {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-status-reply' },
        body: JSON.stringify({ agentId: 'army', role: 'agent', taskId: task.id, text: `реплика ${i}` }),
      });
      if (res.status === 429) {
        blocked = res;
        break;
      }
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    assert.ok(blocked);
    assert.equal(blocked.headers.get('retry-after'), '60');
    assert.equal(blocked.body.error, 'Слишком часто');

    const viaStatus = await postStatus({
      agentId: 'Военная служба',
      status: 'idle',
      taskId: task.id,
      reply: 'ещё одна',
    });
    assert.equal(viaStatus.status, 429, JSON.stringify(viaStatus.body));
    assert.equal(viaStatus.headers.get('retry-after'), '60');
    assert.equal(viaStatus.body.error, 'Слишком часто');

    const ping = await postStatus({ agentId: 'army', status: 'working', doing: 'на линии' });
    assert.equal(ping.status, 200, JSON.stringify(ping.body));
    const army = agentOf((await json('/api/state')).body, 'army');
    assert.equal(army.doing, 'на линии');
    assert.ok(army.lastSeenAt);
  });

  test('поток state приходит после ответа и не содержит текст реплики', async () => {
    const task = await createTask('health', 'План');
    const sse = await openSse(base);
    try {
      const opened = await waitFor(() => sse.text().includes(': stream') || sse.text().includes(': keepalive'));
      assert.equal(opened, true, sse.text());
      const reply = await postStatus({
        agentId: 'health',
        status: 'idle',
        taskId: task.id,
        reply: 'СЕКРЕТ-ОТВЕТ-XYZ',
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const got = await waitFor(() => sse.text().includes('event: state') && sse.text().includes('data: {}'));
      assert.equal(got, true, sse.text());
      assert.equal(sse.text().includes('СЕКРЕТ-ОТВЕТ-XYZ'), false);
      assert.equal(sse.text().includes('status-reply'), false);
    } finally {
      sse.req.destroy();
    }
  });
});

function openSse(origin) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/stream`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      resolve({
        req,
        res,
        text: () => Buffer.concat(chunks).toString('utf8'),
      });
    });
    req.on('error', reject);
  });
}

function waitFor(fn, ms = 2000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fn() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve(fn());
      }
    }, 20);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-status-reply';
  env.AGENT_TOKEN = 'tok-status-reply';
  env.AGENT_STATUS_TOKEN = 'status-reply';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-status-reply-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        return {
          base: origin,
          child,
          logs,
          text() { return `${logs.out}\n${logs.err}`; },
        };
      }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function officeJson(origin, urlPath, opts = {}) {
  const res = await fetch(origin + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('без DATABASE_URL живой статус живёт в памяти и пропадает после нового процесса', async () => {
  const first = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    assert.match(first.text(), /DATABASE_URL не задан/);
    const posted = await officeJson(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-reply' },
      body: JSON.stringify({ agentId: 'devops', status: 'working', doing: 'только память' }),
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const seen = agentOf((await officeJson(first.base, '/api/state')).body, 'devops');
    assert.equal(seen.doing, 'только память');
    assert.equal(seen.live && seen.live.status, 'working');
    assert.ok(seen.lastSeenAt);
  } finally {
    await stopOffice(first);
  }
  const second = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const gone = agentOf((await officeJson(second.base, '/api/state')).body, 'devops');
    assert.equal(gone.doing, null);
    assert.equal(gone.live, null);
    assert.equal(gone.lastSeenAt, null);
  } finally {
    await stopOffice(second);
  }
});

test('статусы переживают перезапуск Postgres', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
  const { Pool } = require('pg');
  const schema = `s_${crypto.randomBytes(4).toString('hex')}`;
  const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  let seenAt;
  let updatedAt;
  const first = await startOffice(env);
  try {
    assert.match(first.text(), /Postgres подключен/);
    const posted = await officeJson(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-reply' },
      body: JSON.stringify({ agentId: 'Программирование · Кремль', status: 'working', doing: 'Держу ход' }),
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const dev = agentOf((await officeJson(first.base, '/api/state')).body, 'dev');
    seenAt = dev.lastSeenAt;
    assert.ok(seenAt);
    assert.equal(dev.doing, 'Держу ход');
    assert.equal(dev.live.status, 'working');
    const row = await pool.query(
      `SELECT status, doing, last_seen_at, updated_at FROM "${schema}".agent_live WHERE agent_id = 'dev'`,
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].status, 'working');
    assert.equal(row.rows[0].doing, 'Держу ход');
    assert.equal(new Date(row.rows[0].last_seen_at).toISOString(), seenAt);
    updatedAt = new Date(row.rows[0].updated_at).toISOString();
    assert.equal(updatedAt, seenAt);
    const card = await pool.query(`SELECT payload FROM "${schema}".agent_state WHERE id = 'dev'`);
    assert.equal(card.rows[0].payload.live, undefined);
    assert.equal(JSON.stringify(card.rows[0].payload).includes('Держу ход'), false);
  } finally {
    await stopOffice(first);
  }

  const second = await startOffice(env);
  try {
    assert.match(second.text(), /Postgres подключен/);
    const dev = agentOf((await officeJson(second.base, '/api/state')).body, 'dev');
    assert.equal(dev.live && dev.live.status, 'working');
    assert.equal(dev.doing, 'Держу ход');
    assert.equal(dev.lastSeenAt, seenAt);
    const row = await pool.query(
      `SELECT status, doing, last_seen_at, updated_at FROM "${schema}".agent_live WHERE agent_id = 'dev'`,
    );
    assert.equal(row.rows.length, 1);
    assert.equal(new Date(row.rows[0].updated_at).toISOString(), updatedAt);
    assert.equal(new Date(row.rows[0].last_seen_at).toISOString(), seenAt);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const later = await officeJson(second.base, '/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-reply' },
      body: JSON.stringify({ agentId: 'dev', status: 'working', doing: 'Держу ход' }),
    });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const next = agentOf((await officeJson(second.base, '/api/state')).body, 'dev');
    assert.ok(next.lastSeenAt > seenAt);
    assert.equal(next.doing, 'Держу ход');
    const saved = await pool.query(
      `SELECT last_seen_at, updated_at FROM "${schema}".agent_live WHERE agent_id = 'dev'`,
    );
    assert.equal(new Date(saved.rows[0].last_seen_at).toISOString(), next.lastSeenAt);
    assert.equal(new Date(saved.rows[0].updated_at).toISOString(), next.lastSeenAt);
  } finally {
    await stopOffice(second);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
