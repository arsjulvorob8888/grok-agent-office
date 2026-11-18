'use strict';

// Ответ агента: POST /api/messages, taskId, токен, лимит и экран ленты.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';
const XSS = '<img src=x onerror=alert(1)>';

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
  env.APP_PASSWORD = extra.APP_PASSWORD || 'pw-reply';
  env.AGENT_TOKEN = extra.AGENT_TOKEN || 'tok-reply';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-reply-'));
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
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        return { base, child, logs };
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

function json(base, urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers }));
}

test('ответ агента привязан к задаче, чужой токен и пустой taskId отвергаются', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const task = await json(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-reply' },
      body: JSON.stringify({ agent: 'social', text: 'Напиши пост' }),
    });
    assert.equal(task.status, 201);
    const stranger = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'wrong' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: task.body.id, text: 'нет' }),
    });
    assert.equal(stranger.status, 401);
    const missing = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', text: 'без задачи' }),
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /taskId/);
    const unknown = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: 't-missing', text: 'нет такой' }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, 'Неизвестная задача');
    const reply = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: task.body.id, text: 'Пост опубликован' }),
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.message.taskId, task.body.id);
    assert.equal(reply.body.message.agentId, 'social');
    assert.equal(reply.body.message.role, 'agent');
    const state = await json(office.base, '/api/state');
    const saved = state.body.messages.find((item) => item.id === reply.body.message.id);
    assert.ok(saved);
    assert.equal(saved.taskId, task.body.id);
    assert.equal(saved.text, 'Пост опубликован');
    const longText = 'я'.repeat(4001);
    const long = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: task.body.id, text: longText }),
    });
    assert.equal(long.status, 400);
  } finally {
    await stopOffice(office);
  }
});

test('лента экранирует HTML в ответе агента', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  const puppeteer = require('puppeteer-core');
  const chrome = ['/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(chrome, 'Chrome не найден');
  let browser;
  try {
    const task = await json(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-reply' },
      body: JSON.stringify({ agent: 'advisor', text: 'Разбери отчёт' }),
    });
    assert.equal(task.status, 201);
    const reply = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'advisor', role: 'agent', taskId: task.body.id, text: XSS }),
    });
    assert.equal(reply.status, 201);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.emulateTimezone('UTC');
    await page.goto(`${office.base}/?agent=advisor`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((needle) => {
      const chat = document.querySelector('#panel.open .chat-log, #panel.open [data-anchor="chat"]');
      return chat && chat.textContent.includes(needle);
    }, { timeout: 8000 }, XSS);
    const view = await page.evaluate((needle) => {
      const chat = document.querySelector('#panel.open [data-anchor="chat"]');
      const img = chat ? chat.querySelector('img') : document.querySelector('#panel img[onerror]');
      const time = chat ? (chat.querySelector('time, .msg-meta span') || {}).textContent || '' : '';
      return {
        text: chat ? chat.textContent : '',
        html: chat ? chat.innerHTML : '',
        hasImg: !!img,
        time,
      };
    }, XSS);
    assert.equal(view.text.includes(XSS), true);
    assert.equal(view.hasImg, false);
    assert.match(view.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(view.time, /МСК/);
  } finally {
    if (browser) await browser.close();
    await stopOffice(office);
  }
});

test('слишком частые ответы получают 429', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const task = await json(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-reply' },
      body: JSON.stringify({ agent: 'blog', text: 'Серия' }),
    });
    assert.equal(task.status, 201);
    let blocked = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await json(office.base, '/api/messages', {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-reply' },
        body: JSON.stringify({ agentId: 'blog', role: 'agent', taskId: task.body.id, text: `реплика ${i}` }),
      });
      if (res.status === 429) {
        blocked = res;
        break;
      }
    }
    assert.ok(blocked);
    assert.equal(blocked.headers.get('retry-after'), '60');
    assert.equal(blocked.body.error, 'Слишком часто');
  } finally {
    await stopOffice(office);
  }
});

test('Postgres хранит ответ агента между процессами', { skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `a_${crypto.randomBytes(4).toString('hex')}`;
  const env = { DATABASE_URL: savedDatabaseUrl, STORE_SCHEMA: schema };
  let taskId;
  let messageId;
  const first = await startOffice(env);
  try {
    const task = await json(first.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-reply' },
      body: JSON.stringify({ agent: 'finance', text: 'Шесть вопросов' }),
    });
    assert.equal(task.status, 201);
    taskId = task.body.id;
    const reply = await json(first.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-reply' },
      body: JSON.stringify({ agentId: 'finance', role: 'agent', taskId, text: 'Ответ сохранён' }),
    });
    assert.equal(reply.status, 201);
    messageId = reply.body.message.id;
  } finally {
    await stopOffice(first);
  }
  const second = await startOffice(env);
  try {
    const state = await json(second.base, '/api/state');
    const message = state.body.messages.find((item) => item.id === messageId);
    assert.ok(message);
    assert.equal(message.taskId, taskId);
    assert.equal(message.text, 'Ответ сохранён');
    assert.equal(message.agentId, 'finance');
  } finally {
    await stopOffice(second);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не появиться */ }
    await pool.end();
  }
});
