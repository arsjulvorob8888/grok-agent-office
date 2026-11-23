'use strict';

// Холодный старт на том же хранилище не повторяет уже успешную проверку.
// Настройки между остановкой и новым процессом не меняются.
// Смена ключа и следующий старт дают ровно один ping.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEY = 'fixture-cold-keep-key-ZZZZ';
const KEY_NEXT = 'fixture-cold-keep-key-RRRR';
const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';

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
  env.APP_PASSWORD = 'pw-test';
  env.AGENT_TOKEN = 'tok-test';
  env.AGENT_STATUS_TOKEN = 'status-cold-keep';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  env.LINK_PING_STAGGER_MS = '0';
  env.WEBHOOK_PROBE_TIMEOUT_MS = '8000';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cold-'));
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
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) { up = true; break; }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!up) throw new Error('healthz не ответил');
  return {
    base,
    child,
    logs,
    text() { return `${this.logs.out}\n${this.logs.err}`; },
  };
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function call(base, urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}

function pingHits(hits) {
  return hits.filter((hit) => hit.body && hit.body.type === 'ping');
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label || 'событие не наступило');
}

test('рестарт без смены настроек не шлёт ping, смена ключа и рестарт — ровно один', {
  skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан',
  timeout: 60000,
}, async () => {
  const schema = `k_${crypto.randomBytes(4).toString('hex')}`;
  const secrets = crypto.randomBytes(32).toString('base64');
  const hits = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
      hits.push({ url: req.url || '', body: parsed });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${hook.address().port}`;
  const env = {
    DATABASE_URL: savedDatabaseUrl,
    STORE_SCHEMA: schema,
    WEBHOOK_SECRETS_KEY: secrets,
  };
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
  let first;
  let second;
  let third;
  try {
    first = await startOffice(env);
    const saved = await call(first.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/dev`, key: KEY }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.stringify(saved.body).includes(KEY), false);
    await waitFor(() => pingHits(hits).length >= 1, 4000, 'первый ping не дошёл');
    const ack = await call(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { authorization: 'Bearer status-cold-keep' },
      body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: saved.body.linkCheck.taskId }),
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acknowledged, true);
    const before = await call(first.base, '/api/state');
    const prior = before.body.agents.find((item) => item.id === 'dev').linkCheck;
    assert.equal(prior.phase, 'ok');
    assert.ok(prior.taskId);
    assert.ok(prior.sentAt);
    assert.ok(prior.answeredAt);
    const seen = pingHits(hits).length;
    await stopOffice(first);
    first = null;

    hits.length = 0;
    second = await startOffice(env);
    await waitFor(() => /link startup ping=0/.test(second.text()), 8000, 'старт не сообщил, что ping не нужен');
    assert.equal(pingHits(hits).length, 0);
    assert.equal(hits.length, 0);
    const again = await call(second.base, '/api/state');
    const kept = again.body.agents.find((item) => item.id === 'dev').linkCheck;
    assert.equal(kept.phase, 'ok');
    assert.equal(kept.taskId, prior.taskId);
    assert.equal(kept.sentAt, prior.sentAt);
    assert.equal(kept.answeredAt, prior.answeredAt);
    assert.equal(JSON.stringify(again.body).includes(KEY), false);
    assert.equal(second.text().includes(KEY), false);
    assert.equal(second.text().includes(origin), false);
    assert.equal(seen >= 1, true);

    const changed = await call(second.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/dev`, key: KEY_NEXT }),
    });
    assert.equal(changed.status, 200);
    assert.equal(JSON.stringify(changed.body).includes(KEY_NEXT), false);
    await waitFor(() => pingHits(hits).length === 1, 4000, 'ping после смены ключа не дошёл');
    await stopOffice(second);
    second = null;

    third = await startOffice(env);
    await waitFor(() => /link startup ping=0/.test(third.text()), 8000, 'старт после смены ключа не завершился');
    await waitFor(() => pingHits(hits).length >= 1, 500, 'ожидание уже пришедшего ping');
    assert.equal(pingHits(hits).length, 1);
    assert.equal(hits.length, 1);
    assert.equal(third.text().includes(KEY), false);
    assert.equal(third.text().includes(KEY_NEXT), false);
    assert.equal(third.text().includes(origin), false);
  } finally {
    await stopOffice(first);
    await stopOffice(second);
    await stopOffice(third);
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не создаться */ }
    await pool.end();
    await new Promise((resolve) => hook.close(resolve));
  }
});
