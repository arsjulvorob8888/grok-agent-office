'use strict';

// Холодный старт не повторяет уже сохранённую проверку.
// Ping уходит только при смене адреса или ключа, по кнопке и если записи ещё нет.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const feed = require('../public/js/feed.js');
const linkCheck = require('../lib/link-check');

const KEY = 'fixture-no-restart-ping-key-QQQQ';
const KEY_NEXT = 'fixture-no-restart-ping-key-RRRR';
const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';

test('старый успешный ответ остаётся ok, пятиминутный таймаут только у незавершённой проверки', () => {
  const sentAt = 1_700_000_000_000;
  const agedOk = {
    taskId: 'ping-dev-1',
    sentAt: sentAt - 60 * 60 * 1000,
    http: 204,
    error: null,
    answeredAt: sentAt - 30 * 60 * 1000,
  };
  const shown = linkCheck.present(agedOk, sentAt + linkCheck.WAIT_MS, (iso) => `${iso} МСК`);
  assert.equal(shown.phase, 'ok');
  assert.equal(shown.answeredAt, new Date(agedOk.answeredAt).toISOString());
  assert.equal(feed.directCardTone({ id: 'dev', deliveryRoute: 'agent', linkCheck: shown }), 'ok');
  assert.match(feed.directCardSummary({ id: 'dev', deliveryRoute: 'agent', linkCheck: shown }), /^Прямая связь: работает ✓/);

  const pending = { taskId: 'ping-qa-1', sentAt, http: 204, error: null, answeredAt: null };
  assert.equal(linkCheck.phaseOf(pending, sentAt + linkCheck.WAIT_MS - 1), 'checking');
  const fresh = linkCheck.present(pending, sentAt + linkCheck.WAIT_MS - 1);
  assert.equal(feed.directCardSummary({ id: 'qa', deliveryRoute: 'agent', linkCheck: fresh }), 'Проверяю…');
  assert.equal(feed.directCardTone({ id: 'qa', deliveryRoute: 'agent', linkCheck: fresh }), 'pending');
  const late = linkCheck.present(pending, sentAt + linkCheck.WAIT_MS);
  assert.equal(late.phase, 'timeout');
  assert.equal(feed.directCardTone({ id: 'qa', deliveryRoute: 'agent', linkCheck: late }), 'bad');

  const down = linkCheck.present({ taskId: 'ping-social-1', sentAt, http: 500, error: null, answeredAt: null }, sentAt + 1000);
  assert.equal(down.phase, 'down');
  assert.equal(feed.directCardSummary({ id: 'social', deliveryRoute: 'agent', linkCheck: down }), 'Прямая связь не работает — проверьте адрес и ключ');
});

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
  env.AGENT_STATUS_TOKEN = 'status-link-no-ping';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  env.LINK_PING_STAGGER_MS = '50';
  env.WEBHOOK_PROBE_TIMEOUT_MS = '8000';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-nop-'));
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

function pingHits(hits, url) {
  return hits.filter((hit) => hit.url === url && hit.body && hit.body.type === 'ping');
}

async function waitForPings(hits, url, count, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && pingHits(hits, url).length < count) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test('рестарт с сохранённым ok не шлёт ping и не двигает время проверки', {
  skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан',
  timeout: 60000,
}, async () => {
  const schema = `n_${crypto.randomBytes(4).toString('hex')}`;
  const secrets = crypto.randomBytes(32).toString('base64');
  const hits = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
      hits.push({ url: req.url || '', body: parsed });
      const down = (req.url || '').includes('/down');
      res.writeHead(down ? 500 : 204);
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
  try {
    first = await startOffice(env);
    const saved = await call(first.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/dev`, key: KEY }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.linkCheck.phase, 'checking');
    assert.equal(JSON.stringify(saved.body).includes(KEY), false);
    const ack = await call(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { authorization: 'Bearer status-link-no-ping' },
      body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: saved.body.linkCheck.taskId }),
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acknowledged, true);
    const failed = await call(first.base, '/api/agents/social/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/down`, key: KEY }),
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.linkCheck.phase, 'down');
    const pending = await call(first.base, '/api/agents/qa/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/qa`, key: KEY }),
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.linkCheck.phase, 'checking');
    const before = await call(first.base, '/api/state');
    const devBefore = before.body.agents.find((item) => item.id === 'dev');
    assert.equal(devBefore.linkCheck.phase, 'ok');
    const taskId = devBefore.linkCheck.taskId;
    await stopOffice(first);
    first = null;

    await pool.query(
      `UPDATE ${schema}.link_checks
       SET sent_at = now() - interval '10 minutes',
           answered_at = now() - interval '10 minutes',
           target_hash = NULL
       WHERE agent_id = 'dev'`,
    );
    await pool.query(
      `UPDATE ${schema}.link_checks SET target_hash = NULL WHERE agent_id IN ('social', 'qa')`,
    );
    const stored = await pool.query(
      `SELECT agent_id, task_id, http, error, sent_at, answered_at FROM ${schema}.link_checks WHERE agent_id = 'dev'`,
    );
    const checkedAt = new Date(stored.rows[0].answered_at).toISOString();
    assert.equal(stored.rows[0].task_id, taskId);
    assert.ok(Date.now() - Date.parse(checkedAt) >= 9 * 60 * 1000);
    const blob = JSON.stringify(stored.rows);
    assert.equal(blob.includes(KEY), false);
    assert.equal(blob.includes(origin), false);

    hits.length = 0;
    second = await startOffice(env);
    await waitForPings(hits, '/dev', 1, 1200);
    await waitForPings(hits, '/down', 1, 200);
    await waitForPings(hits, '/qa', 1, 200);
    assert.equal(pingHits(hits, '/dev').length, 0);
    assert.equal(pingHits(hits, '/down').length, 0);
    assert.equal(pingHits(hits, '/qa').length, 0);
    assert.equal(hits.length, 0);

    const state = await call(second.base, '/api/state');
    assert.equal(state.status, 200);
    assert.equal(JSON.stringify(state.body).includes(KEY), false);
    const dev = state.body.agents.find((item) => item.id === 'dev');
    const social = state.body.agents.find((item) => item.id === 'social');
    const qa = state.body.agents.find((item) => item.id === 'qa');
    assert.equal(dev.linkCheck.phase, 'ok');
    assert.equal(dev.linkCheck.answeredAt, checkedAt);
    assert.equal(dev.linkCheck.taskId, taskId);
    assert.equal(feed.directCardTone(dev), 'ok');
    assert.match(feed.directCardSummary(dev), /^Прямая связь: работает ✓/);
    assert.equal(social.linkCheck.phase, 'down');
    assert.equal(feed.directCardTone(social), 'bad');
    assert.equal(feed.directCardSummary(social), 'Прямая связь не работает — проверьте адрес и ключ');
    assert.equal(qa.linkCheck.phase, 'checking');
    assert.equal(feed.directCardSummary(qa), 'Проверяю…');
    assert.equal(feed.directCardTone(qa), 'pending');

    let stamped = null;
    const stampStarted = Date.now();
    while (Date.now() - stampStarted < 3000) {
      const again = await pool.query(
        `SELECT task_id, answered_at, target_hash FROM ${schema}.link_checks WHERE agent_id = 'dev'`,
      );
      stamped = again.rows[0];
      if (stamped && stamped.target_hash) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(stamped.task_id, taskId);
    assert.equal(new Date(stamped.answered_at).toISOString(), checkedAt);
    assert.match(stamped.target_hash, /^[a-f0-9]{64}$/);
    assert.equal(String(stamped.target_hash).includes(KEY), false);
    assert.equal(String(stamped.target_hash).includes(origin), false);
    assert.equal(second.text().includes(KEY), false);
    assert.equal(second.text().includes(origin), false);
  } finally {
    await stopOffice(first);
    await stopOffice(second);
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не создаться */ }
    await pool.end();
    await new Promise((resolve) => hook.close(resolve));
  }
});

test('смена адреса или ключа даёт ровно один ping, повтор того же адреса — ни одного', {
  skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан',
  timeout: 60000,
}, async () => {
  const schema = `c_${crypto.randomBytes(4).toString('hex')}`;
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
  const urlA = `${origin}/dev`;
  const urlB = `${origin}/dev-next`;
  let office;
  try {
    office = await startOffice({
      DATABASE_URL: savedDatabaseUrl,
      STORE_SCHEMA: schema,
      WEBHOOK_SECRETS_KEY: secrets,
    });
    const saved = await call(office.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: urlA, key: KEY }),
    });
    assert.equal(saved.status, 200);
    assert.equal(pingHits(hits, '/dev').length, 1);
    assert.equal(JSON.stringify(saved.body).includes(KEY), false);
    const ack = await call(office.base, '/api/agent-status', {
      method: 'POST',
      headers: { authorization: 'Bearer status-link-no-ping' },
      body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: saved.body.linkCheck.taskId }),
    });
    assert.equal(ack.body.acknowledged, true);
    const beforeSame = await call(office.base, '/api/state');
    const beforeDev = beforeSame.body.agents.find((item) => item.id === 'dev');
    const checkedAt = beforeDev.linkCheck.answeredAt;
    assert.equal(beforeDev.linkCheck.phase, 'ok');
    hits.length = 0;

    const same = await call(office.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: urlA, key: KEY }),
    });
    assert.equal(same.status, 200);
    await waitForPings(hits, '/dev', 1, 400);
    assert.equal(hits.length, 0);
    assert.equal(same.body.linkCheck.phase, 'ok');
    assert.equal(same.body.linkCheck.answeredAt, checkedAt);
    assert.equal(same.body.linkCheck.taskId, beforeDev.linkCheck.taskId);

    const moved = await call(office.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: urlB, key: KEY }),
    });
    assert.equal(moved.status, 200);
    await waitForPings(hits, '/dev-next', 1, 1500);
    assert.equal(pingHits(hits, '/dev-next').length, 1);
    assert.equal(pingHits(hits, '/dev').length, 0);
    assert.equal(hits.length, 1);
    assert.equal(moved.body.linkCheck.phase, 'checking');
    assert.notEqual(moved.body.linkCheck.taskId, beforeDev.linkCheck.taskId);
    assert.equal(JSON.stringify(moved.body).includes(KEY), false);
    hits.length = 0;

    const rekeyed = await call(office.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: urlB, key: KEY_NEXT }),
    });
    assert.equal(rekeyed.status, 200);
    await waitForPings(hits, '/dev-next', 1, 1500);
    assert.equal(pingHits(hits, '/dev-next').length, 1);
    assert.equal(hits.length, 1);
    assert.equal(rekeyed.body.linkCheck.phase, 'checking');
    assert.notEqual(rekeyed.body.linkCheck.taskId, moved.body.linkCheck.taskId);
    assert.equal(JSON.stringify(rekeyed.body).includes(KEY_NEXT), false);

    const button = await call(office.base, '/api/agents/dev/delivery/test', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({}),
    });
    assert.equal(button.status, 200);
    await waitForPings(hits, '/dev-next', 2, 1500);
    assert.equal(pingHits(hits, '/dev-next').length, 2);
    assert.equal(button.body.linkCheck.phase, 'checking');
    assert.equal(JSON.stringify(button.body).includes(KEY_NEXT), false);
    assert.equal(office.text().includes(KEY), false);
    assert.equal(office.text().includes(KEY_NEXT), false);
    assert.equal(office.text().includes(origin), false);
  } finally {
    await stopOffice(office);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не создаться */ }
    await pool.end();
    await new Promise((resolve) => hook.close(resolve));
  }
});

test('расхождение отпечатка адреса при старте даёт ровно один ping', {
  skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан',
  timeout: 60000,
}, async () => {
  const schema = `h_${crypto.randomBytes(4).toString('hex')}`;
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
  try {
    first = await startOffice(env);
    const saved = await call(first.base, '/api/agents/dev/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ url: `${origin}/dev`, key: KEY }),
    });
    assert.equal(saved.status, 200);
    const ack = await call(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { authorization: 'Bearer status-link-no-ping' },
      body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: saved.body.linkCheck.taskId }),
    });
    assert.equal(ack.body.acknowledged, true);
    await stopOffice(first);
    first = null;
    await pool.query(
      `UPDATE ${schema}.link_checks SET target_hash = $1 WHERE agent_id = 'dev'`,
      ['0'.repeat(64)],
    );
    hits.length = 0;
    second = await startOffice(env);
    await waitForPings(hits, '/dev', 1, 2000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pingHits(hits, '/dev').length, 1);
    assert.equal(hits.length, 1);
    const state = await call(second.base, '/api/state');
    const dev = state.body.agents.find((item) => item.id === 'dev');
    assert.equal(dev.linkCheck.phase, 'checking');
    assert.notEqual(dev.linkCheck.taskId, saved.body.linkCheck.taskId);
    assert.equal(JSON.stringify(state.body).includes(KEY), false);
    const stored = await pool.query(`SELECT target_hash FROM ${schema}.link_checks WHERE agent_id = 'dev'`);
    assert.match(stored.rows[0].target_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.rows[0].target_hash, '0'.repeat(64));
    assert.equal(String(stored.rows[0].target_hash).includes(KEY), false);
    assert.equal(second.text().includes(KEY), false);
    assert.equal(second.text().includes(origin), false);
  } finally {
    await stopOffice(first);
    await stopOffice(second);
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не создаться */ }
    await pool.end();
    await new Promise((resolve) => hook.close(resolve));
  }
});
