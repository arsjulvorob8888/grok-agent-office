'use strict';

// Личные токены: выпуск, хеш в базе, свой токен, чужой agentId, отзыв, общий AGENT_TOKEN.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WARNING = 'Токен показывается один раз. Повторно его не увидеть. Старые токены этого агента отозваны.';

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
  env.APP_PASSWORD = extra.APP_PASSWORD || 'pw-tokens';
  env.AGENT_TOKEN = extra.AGENT_TOKEN || 'tok-shared';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = '';
  env.KREMLIN_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tokens-'));
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
      if (res.status === 200 && (await res.text()) === 'ok') return { base, child, logs };
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
  }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
    text: '',
  }));
}

function sha256(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function owner(headers = {}) {
  return { 'x-app-password': 'pw-tokens', ...headers };
}

async function issue(base, body) {
  return json(base, '/api/agent-tokens', {
    method: 'POST',
    headers: owner(),
    body: JSON.stringify(body || {}),
  });
}

async function statusOf(base, agent, token) {
  return json(base, '/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': token },
    body: JSON.stringify({ agent, status: 'idle', now: `метка ${agent}` }),
  });
}

test('без пароля владельца токены не выпускаются', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const missing = await json(office.base, '/api/agent-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'dev' }),
    });
    assert.equal(missing.status, 401);
    const wrong = await json(office.base, '/api/agent-tokens', {
      method: 'POST',
      headers: { 'x-app-password': 'nope' },
      body: JSON.stringify({ agentId: 'dev' }),
    });
    assert.equal(wrong.status, 401);
    const revoke = await json(office.base, '/api/agent-tokens/dev/revoke', { method: 'POST', body: '{}' });
    assert.equal(revoke.status, 401);
  } finally {
    await stopOffice(office);
  }
});

test('выпуск показывает токен один раз, хеш не попадает в /api/state и в логи', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const created = await issue(office.base, { agentId: 'dev' });
    assert.equal(created.status, 201);
    assert.equal(created.body.warning, WARNING);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(created.body.tokens.length, 1);
    const row = created.body.tokens[0];
    assert.equal(row.agentId, 'dev');
    assert.equal(row.name, 'Программирование');
    assert.equal(typeof row.token, 'string');
    assert.ok(row.token.length >= 32);
    assert.equal(row.tokenHash, undefined);
    assert.equal(JSON.stringify(created.body).includes(sha256(row.token)), false);

    const state = await json(office.base, '/api/state');
    const raw = JSON.stringify(state.body);
    assert.equal(raw.includes(row.token), false);
    assert.equal(raw.includes(sha256(row.token)), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.body, 'agentTokens'), false);
    const dev = state.body.agents.find((agent) => agent.id === 'dev');
    assert.equal(dev.token, undefined);
    assert.equal(dev.tokenHash, undefined);

    assert.equal(office.logs.out.includes(row.token), false);
    assert.equal(office.logs.err.includes(row.token), false);
    assert.equal(office.logs.out.includes(sha256(row.token)), false);
    assert.equal(office.logs.err.includes(sha256(row.token)), false);
  } finally {
    await stopOffice(office);
  }
});

test('свой токен принимается, чужой agentId — 403, неизвестный — 401', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const task = await json(office.base, '/api/task', {
      method: 'POST',
      headers: owner(),
      body: JSON.stringify({ agent: 'dev', text: 'Ответь в ленту' }),
    });
    assert.equal(task.status, 201);
    const socialTask = await json(office.base, '/api/task', {
      method: 'POST',
      headers: owner(),
      body: JSON.stringify({ agent: 'social', text: 'Чужой приказ' }),
    });
    assert.equal(socialTask.status, 201);

    const issued = await issue(office.base, { agentId: 'dev' });
    const token = issued.body.tokens[0].token;
    const socialIssued = await issue(office.base, { agentId: 'social' });
    const socialToken = socialIssued.body.tokens[0].token;

    const ownStatus = await statusOf(office.base, 'dev', token);
    assert.equal(ownStatus.status, 200);
    assert.equal(ownStatus.body.agent.id, 'dev');

    const ownMessage = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': token },
      body: JSON.stringify({ agentId: 'dev', role: 'agent', taskId: task.body.id, text: 'Готово' }),
    });
    assert.equal(ownMessage.status, 201);

    const foreignStatus = await statusOf(office.base, 'social', token);
    assert.equal(foreignStatus.status, 403);
    assert.equal(foreignStatus.body.error, 'Токен другого агента');

    const foreignMessage = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': token },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: socialTask.body.id, text: 'нет' }),
    });
    assert.equal(foreignMessage.status, 403);

    const foreignPath = await json(office.base, '/api/agents/social/tasks', {
      headers: { 'x-agent-token': token },
    });
    assert.equal(foreignPath.status, 403);

    const ownPath = await json(office.base, '/api/agents/dev/tasks', {
      headers: { 'x-agent-token': token },
    });
    assert.equal(ownPath.status, 200);

    const foreignBeat = await json(office.base, '/api/agents/social/heartbeat', {
      method: 'POST',
      headers: { 'x-agent-token': token },
      body: '{}',
    });
    assert.equal(foreignBeat.status, 403);

    const foreignOrder = await json(office.base, `/api/orders/${socialTask.body.id}`, {
      method: 'POST',
      headers: { 'x-agent-token': token },
      body: JSON.stringify({ status: 'accepted' }),
    });
    assert.equal(foreignOrder.status, 403);
    const socialOrder = await json(office.base, `/api/orders/${socialTask.body.id}`, {
      method: 'POST',
      headers: { 'x-agent-token': socialToken },
      body: JSON.stringify({ status: 'accepted' }),
    });
    assert.equal(socialOrder.status, 200);

    const batch = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': token },
      body: JSON.stringify({
        messages: [
          { agentId: 'dev', role: 'agent', taskId: task.body.id, text: 'ещё' },
          { agentId: 'social', role: 'agent', taskId: socialTask.body.id, text: 'чужое' },
        ],
      }),
    });
    assert.equal(batch.status, 403);

    const unknown = await statusOf(office.base, 'dev', 'not-a-real-token');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, 'Неверный токен агента');
  } finally {
    await stopOffice(office);
  }
});

test('общий AGENT_TOKEN работает, пока свой не выпущен, и молчит после выпуска', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const before = await statusOf(office.base, 'dev', 'tok-shared');
    assert.equal(before.status, 200);

    const issued = await issue(office.base, { agentId: 'dev' });
    const token = issued.body.tokens[0].token;

    const blocked = await json(office.base, '/api/status', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-shared' },
      body: JSON.stringify({ agent: 'dev', status: 'idle', now: 'не должно записаться' }),
    });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.error, 'Для этого агента нужен личный токен');
    const dev = (await json(office.base, '/api/state')).body.agents.find((agent) => agent.id === 'dev');
    assert.equal(dev.now, 'метка dev');

    const other = await statusOf(office.base, 'social', 'tok-shared');
    assert.equal(other.status, 200);

    const personal = await statusOf(office.base, 'dev', token);
    assert.equal(personal.status, 200);

    const revoked = await json(office.base, '/api/agent-tokens/dev/revoke', {
      method: 'POST',
      headers: owner(),
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, 1);
    assert.equal(JSON.stringify(revoked.body).includes(token), false);

    const dead = await statusOf(office.base, 'dev', token);
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error, 'Неверный токен агента');

    const sharedAgain = await statusOf(office.base, 'dev', 'tok-shared');
    assert.equal(sharedAgain.status, 200);

    assert.equal(office.logs.out.includes(token), false);
    assert.equal(office.logs.err.includes(token), false);
  } finally {
    await stopOffice(office);
  }
});

test('повторный выпуск отзывает старый токен, весь ростер без архива', async () => {
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const all = await issue(office.base, {});
    assert.equal(all.status, 201);
    const ids = all.body.tokens.map((row) => row.agentId);
    assert.ok(ids.includes('dev'));
    assert.ok(ids.includes('social'));
    assert.equal(ids.includes('trading'), false);
    assert.equal(ids.includes('lang'), false);
    assert.equal(ids.includes('biz'), false);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(all.body.tokens.map((row) => row.token)).size, ids.length);

    const first = all.body.tokens.find((row) => row.agentId === 'dev').token;
    const again = await issue(office.base, { agentId: 'dev' });
    assert.equal(again.status, 201);
    const second = again.body.tokens[0].token;
    assert.notEqual(first, second);
    assert.equal((await statusOf(office.base, 'dev', first)).status, 401);
    assert.equal((await statusOf(office.base, 'dev', second)).status, 200);

    const social = all.body.tokens.find((row) => row.agentId === 'social').token;
    assert.equal((await statusOf(office.base, 'social', social)).status, 200);
    assert.equal(office.logs.out.includes(first), false);
    assert.equal(office.logs.out.includes(second), false);
    assert.equal(office.logs.err.includes(first), false);
    assert.equal(office.logs.err.includes(second), false);
  } finally {
    await stopOffice(office);
  }
});

test('в Postgres лежит только хеш, и он переживает новый процесс', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `t_tokens_${crypto.randomBytes(4).toString('hex')}`;
  const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const office = await startOffice(env);
  let token = '';
  try {
    const created = await issue(office.base, { agentId: 'dev' });
    assert.equal(created.status, 201);
    token = created.body.tokens[0].token;
    const hash = sha256(token);
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'agent_tokens' ORDER BY column_name`,
      [schema],
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'agent_id', 'created_at', 'id', 'revoked_at', 'token_hash',
    ]);
    const stored = await pool.query(`SELECT id, agent_id, token_hash, created_at, revoked_at FROM ${schema}.agent_tokens`);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].agent_id, 'dev');
    assert.equal(stored.rows[0].token_hash, hash);
    assert.equal(stored.rows[0].revoked_at, null);
    const dumped = JSON.stringify(stored.rows);
    assert.equal(dumped.includes(token), false);
    const versions = await pool.query(`SELECT version FROM ${schema}.schema_version ORDER BY version`);
    assert.ok(versions.rows.some((row) => row.version === 9));

    await stopOffice(office);
    const next = await startOffice(env);
    try {
      assert.equal((await statusOf(next.base, 'dev', token)).status, 200);
      assert.equal((await statusOf(next.base, 'dev', 'tok-shared')).status, 401);
      const state = await json(next.base, '/api/state');
      assert.equal(JSON.stringify(state.body).includes(token), false);
      assert.equal(JSON.stringify(state.body).includes(hash), false);
      const rotated = await issue(next.base, { agentId: 'dev' });
      const fresh = rotated.body.tokens[0].token;
      const after = await pool.query(
        `SELECT token_hash, revoked_at IS NOT NULL AS revoked FROM ${schema}.agent_tokens ORDER BY created_at`,
      );
      assert.equal(after.rowCount, 2);
      assert.equal(after.rows[0].token_hash, hash);
      assert.equal(after.rows[0].revoked, true);
      assert.equal(after.rows[1].token_hash, sha256(fresh));
      assert.equal(after.rows[1].revoked, false);
      assert.equal(JSON.stringify(after.rows).includes(token), false);
      assert.equal(JSON.stringify(after.rows).includes(fresh), false);
      assert.equal(next.logs.out.includes(token), false);
      assert.equal(next.logs.err.includes(token), false);
      assert.equal(next.logs.out.includes(fresh), false);
      assert.equal(next.logs.err.includes(fresh), false);
    } finally {
      await stopOffice(next);
    }
  } finally {
    await stopOffice(office);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
