'use strict';

// Рестарт не красит связь в красный: последний результат лежит в Postgres.
// Без записи карточка говорит «Проверяю…» и адрес пингуется.
// Сохранённый ok и зависшая проверка при старте заново не пингуются.
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

const WARN = 'Прямая связь не работает — проверьте адрес и ключ';
const PENDING = 'Проверяю…';
const KEY = 'fixture-link-restart-key-ZZZZ';
const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';

test('карточка: красное только при сбое или пустом адресе, иначе «Проверяю…»', () => {
  const pending = { id: 'dev', deliveryRoute: 'agent', linkCheck: null };
  assert.equal(feed.directCardSummary(pending), PENDING);
  assert.equal(feed.directCardTone(pending), 'pending');
  const checking = { id: 'dev', deliveryRoute: 'agent', linkCheck: { phase: 'checking', taskId: 'ping-dev-1' } };
  assert.equal(feed.directCardSummary(checking), PENDING);
  assert.equal(feed.directCardTone(checking), 'pending');
  const ready = { id: 'qa', deliveryRoute: 'agent' };
  assert.equal(feed.directCardSummary(ready), PENDING);
  assert.equal(feed.directCardTone(ready), 'pending');

  for (const phase of ['key', 'timeout', 'down']) {
    const agent = { id: 'social', deliveryRoute: 'agent', linkCheck: { phase, taskId: 'ping-social-1' } };
    assert.equal(feed.directCardSummary(agent), WARN, phase);
    assert.equal(feed.directCardTone(agent), 'bad', phase);
  }
  for (const route of ['none', 'env', 'putin']) {
    const agent = { id: 'army', deliveryRoute: route, linkCheck: null };
    assert.equal(feed.directCardSummary(agent), WARN, route);
    assert.equal(feed.directCardTone(agent), 'bad', route);
  }
  const grok = { id: 'grok', deliveryRoute: 'none', linkCheck: null };
  assert.equal(feed.directCardSummary(grok), WARN);
  assert.equal(feed.directCardTone(grok), 'bad');

  const sentAt = 1_700_000_000_000;
  const hung = { taskId: 'ping-dev-9', sentAt, http: 204, error: null, answeredAt: null };
  assert.equal(linkCheck.phaseOf(hung, sentAt + linkCheck.WAIT_MS - 1), 'checking');
  const fresh = linkCheck.present(hung, sentAt + linkCheck.WAIT_MS - 1);
  assert.equal(feed.directCardSummary({ id: 'dev', deliveryRoute: 'agent', linkCheck: fresh }), PENDING);
  const late = linkCheck.present(hung, sentAt + linkCheck.WAIT_MS);
  assert.equal(late.phase, 'timeout');
  assert.equal(feed.directCardSummary({ id: 'dev', deliveryRoute: 'agent', linkCheck: late }), WARN);
  assert.equal(feed.directCardTone({ id: 'dev', deliveryRoute: 'agent', linkCheck: late }), 'bad');

  const ok = linkCheck.present({ ...hung, answeredAt: sentAt + 1000 }, sentAt + 2000, (iso) => `${iso} МСК`);
  assert.equal(ok.phase, 'ok');
  assert.match(feed.directCardSummary({ id: 'dev', deliveryRoute: 'agent', linkCheck: ok }), /^Прямая связь: работает ✓/);
  assert.equal(feed.directCardTone({ id: 'dev', deliveryRoute: 'agent', linkCheck: ok }), 'ok');
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
  env.AGENT_STATUS_TOKEN = 'status-link-restart';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  env.LINK_PING_STAGGER_MS = '200';
  env.WEBHOOK_PROBE_TIMEOUT_MS = '8000';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-link-'));
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
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) { up = true; break; }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return { base, child, logs, text() { return `${this.logs.out}\n${this.logs.err}`; } };
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

test('рестарт восстанавливает проверку: ok остаётся, без записи пингует, зависшая становится timeout', {
  skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан',
  timeout: 60000,
}, async () => {
  const schema = `l_${crypto.randomBytes(4).toString('hex')}`;
  const secrets = crypto.randomBytes(32).toString('base64');
  const hits = [];
  const waiting = [];
  let hold = false;
  const hook = http.createServer((req, res) => {
    let body = '';
    const at = Date.now();
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
      hits.push({ url: req.url || '', at, body: parsed, headers: req.headers });
      if (!hold) {
        res.writeHead(204);
        res.end();
        return;
      }
      waiting.push(res);
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
    async function save(id, suffix) {
      const saved = await call(first.base, `/api/agents/${id}/delivery`, {
        method: 'PUT',
        headers: { 'x-app-password': 'pw-test' },
        body: JSON.stringify({ url: `${origin}/${suffix}`, key: KEY }),
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(JSON.stringify(saved.body).includes(KEY), false);
      return saved.body;
    }
    const dev = await save('dev', 'dev');
    const ack = await call(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { authorization: 'Bearer status-link-restart' },
      body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: dev.linkCheck.taskId }),
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.acknowledged, true);
    await save('army', 'army');
    await save('social', 'social');
    await save('qa', 'qa');
    const beforeStop = await call(first.base, '/api/state');
    const savedDev = beforeStop.body.agents.find((item) => item.id === 'dev');
    assert.equal(savedDev.linkCheck.phase, 'ok');
    assert.equal(JSON.stringify(beforeStop.body).includes(KEY), false);
    await stopOffice(first);
    first = null;

    const stored = await pool.query(
      `SELECT agent_id, task_id, http, error, sent_at, answered_at FROM ${schema}.link_checks`,
    );
    const blob = JSON.stringify(stored.rows);
    assert.equal(blob.includes(KEY), false);
    assert.equal(blob.includes(origin), false);
    assert.ok(stored.rows.some((row) => row.agent_id === 'dev' && row.answered_at));
    await pool.query(`DELETE FROM ${schema}.link_checks WHERE agent_id IN ('army', 'social')`);
    await pool.query(
      `UPDATE ${schema}.link_checks
       SET sent_at = now() - interval '10 minutes', answered_at = NULL
       WHERE agent_id = 'qa'`,
    );

    hits.length = 0;
    hold = true;
    second = await startOffice(env);
    const state = await call(second.base, '/api/state');
    assert.equal(state.status, 200);
    assert.equal(JSON.stringify(state.body).includes(KEY), false);
    const agents = Object.fromEntries(state.body.agents.map((item) => [item.id, item]));
    assert.equal(agents.dev.deliveryRoute, 'agent');
    assert.equal(agents.dev.linkCheck.phase, 'ok');
    assert.equal(agents.dev.linkCheck.taskId, dev.linkCheck.taskId);
    assert.equal(feed.directCardSummary(agents.dev), feed.directCardSummary({
      id: 'dev',
      deliveryRoute: 'agent',
      linkCheck: agents.dev.linkCheck,
    }));
    assert.match(feed.directCardSummary(agents.dev), /^Прямая связь: работает ✓/);
    assert.equal(feed.directCardTone(agents.dev), 'ok');

    assert.equal(agents.army.deliveryRoute, 'agent');
    assert.equal(agents.army.linkCheck, null);
    assert.equal(feed.directCardSummary(agents.army), PENDING);
    assert.equal(feed.directCardTone(agents.army), 'pending');

    assert.equal(agents.qa.deliveryRoute, 'agent');
    assert.equal(agents.qa.linkCheck.phase, 'timeout');
    assert.equal(feed.directCardSummary(agents.qa), WARN);
    assert.equal(feed.directCardTone(agents.qa), 'bad');

    assert.notEqual(agents.health.deliveryRoute, 'agent');
    assert.equal(feed.directCardSummary(agents.health), WARN);

    const started = Date.now();
    while (Date.now() - started < 5000 && hits.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const startup = hits.filter((hit) => ['/dev', '/army', '/social', '/qa'].includes(hit.url));
    assert.deepEqual(startup.map((hit) => hit.url).sort(), ['/army', '/social']);
    for (const hit of startup) {
      assert.equal(hit.body.type, 'ping');
      assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'ownerText'), false);
      assert.equal(hit.body.text, 'Проверка связи');
      assert.equal(JSON.stringify(hit.body).includes(KEY), false);
      assert.equal(JSON.stringify(hit.headers).includes(KEY) === false || hit.headers['x-webhook-key'] === KEY, true);
    }
    const times = startup.map((hit) => hit.at).sort((a, b) => a - b);
    assert.ok(times[1] - times[0] >= 80, `разнесение ${times[1] - times[0]}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hits.filter((hit) => ['/dev', '/army', '/social', '/qa'].includes(hit.url)).length, 2);
    assert.equal(hits.some((hit) => hit.url === '/health'), false);
    const tasks = state.body.tasks || [];
    assert.equal(tasks.some((item) => item && String(item.text || '').includes('Проверка связи')), false);
    assert.equal(second.text().includes(KEY), false);
    assert.equal(second.text().includes(origin), false);
  } finally {
    hold = false;
    for (const res of waiting.splice(0)) {
      try { res.writeHead(204); res.end(); } catch (_) { /* сокет уже закрыт */ }
    }
    await stopOffice(first);
    await stopOffice(second);
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не создаться */ }
    await pool.end();
    await new Promise((resolve) => hook.close(resolve));
  }
});
