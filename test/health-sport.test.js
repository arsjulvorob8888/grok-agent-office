'use strict';

// «Здоровье и спорт · Кремль»: карточка в /api/state, место у Лужников
// без пересечения с чужими зданиями и GAP_ZONES, доставка по общим правилам.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const HEALTH_ID = '0ed66c28-6327-4768-8bf1-f2e06f72c2ac';
const POS = [556, 620];
const LUZHNIKI = [545, 775];
const databaseUrl = process.env.DATABASE_URL || '';

const GAP_ZONES = [
  { id: 'sadovoe-ne', x0: 1056, y0: 308, x1: 1094, y1: 348 },
  { id: 'yauza-bank', x0: 1094, y0: 438, x1: 1150, y1: 484 },
  { id: 'east-ring', x0: 1136, y0: 606, x1: 1198, y1: 632 },
  { id: 'south-east-lot', x0: 1172, y0: 698, x1: 1268, y1: 746 },
];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function mapPos() {
  const body = read('public/js/app.js').match(/const MAP_POS = \{([\s\S]*?)\};/);
  assert.ok(body, 'MAP_POS не найден');
  const pos = {};
  for (const item of body[1].matchAll(/(\w+):\s*\[(\d+),\s*(\d+)\]/g)) pos[item[1]] = [+item[2], +item[3]];
  return pos;
}

function seedBlock() {
  const src = read('server.js');
  const block = src.match(/id: 'health',[\s\S]*?responsibilities: \[[\s\S]*?\],\s*\}/);
  assert.ok(block, 'в SEED_AGENTS нет health');
  return block[0];
}

function loadMap() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/figures.js'), sandbox);
  vm.runInContext(read('public/js/map.js'), sandbox);
  return sandbox.window.MoscowMap;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test('посев и витрина ставят Здоровье и спорт у Лужников', () => {
  const block = seedBlock();
  assert.match(block, /name: 'Здоровье и спорт · Кремль'/);
  assert.match(block, new RegExp(`grokAgentId: '${HEALTH_ID}'`));
  assert.match(block, /kind: 'health'/);
  assert.match(block, /tier: 'dept'/);
  assert.match(block, /district: 'Лужники'/);
  assert.match(block, /order: 13/);
  assert.doesNotMatch(block, /archived:\s*true/);
  assert.match(block, /x: 556,\s*y: 620/);
  const pos = mapPos();
  assert.deepEqual(pos.health, POS);
  const server = read('server.js');
  assert.match(server, /links: \[[^\]]*health/);
});

test('точка не попадает в чужие здания, воду, стадион и GAP_ZONES', () => {
  const M = loadMap();
  const pos = mapPos();
  const [x, y] = pos.health;
  assert.ok(x < 800 && y > 540, 'юго-западнее Кремля');
  const dist = Math.hypot(x - LUZHNIKI[0], y - LUZHNIKI[1]);
  assert.ok(dist >= 110 && dist <= 190, `до Лужников ${Math.round(dist)}`);
  const onOval = ((x - LUZHNIKI[0]) / 70) ** 2 + ((y - LUZHNIKI[1]) / 50) ** 2 < 1;
  assert.equal(onOval, false);
  const footprint = { x: x - 62, y: y - 78, w: 124, h: 100 };
  for (const [id, point] of Object.entries(pos)) {
    if (id === 'health') continue;
    const other = { x: point[0] - 70, y: point[1] - 150, w: 140, h: 176 };
    assert.equal(rectsOverlap(footprint, other), false, id);
  }
  for (const zone of GAP_ZONES) {
    const zoneRect = { x: zone.x0, y: zone.y0, w: zone.x1 - zone.x0, h: zone.y1 - zone.y0 };
    assert.equal(rectsOverlap(footprint, zoneRect), false, zone.id);
  }
  const samples = [[x, y], [x - 50, y], [x + 50, y], [x, y - 36], [x, y + 12]];
  for (const [sx, sy] of samples) {
    assert.ok(M.distPoly(sx, sy, M.RIVER_LINE) >= 26, `вода ${sx},${sy}`);
  }
  assert.ok(M.ringDist(x, y, M.RINGS.garden) >= 20);
});

test('здание спокойное: поле и трибуна, без кричащих эффектов', () => {
  const src = read('public/js/map.js');
  const body = src.match(/case 'health': \{([\s\S]*?)\n      \}/);
  assert.ok(body, 'нет case health');
  assert.match(body[1], /ellipse/);
  assert.match(body[1], /#8fb57a|#7da56a|#6f9a62/);
  assert.doesNotMatch(body[1], /class="(blink|neon|marquee|led|onair|fan|bulb|ticker)"/);
  const fig = read('public/js/figures.js');
  assert.match(fig, /health:\s*\(\)\s*=>/);
  assert.match(read('public/js/app.js'), /health-sport-avatar\.svg/);
  assert.match(read('public/js/app.js'), /health-sport\.png/);
  const png = fs.readFileSync(path.join(root, 'public/img/health-sport.png'));
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.match(read('public/img/health-sport-avatar.svg'), /<svg/);
});

const hits = [];
const hook = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    hits.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
    const fail = (req.url || '').includes('/fail/');
    res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let base;
let server;

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-sport-'));
  process.env.APP_PASSWORD = 'pw-health';
  process.env.AGENT_TOKEN = 'tok-health';
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/env`;
  process.env.KREMLIN_WEBHOOK_KEY = 'env-key';
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  process.env.PUBLIC_URL = 'https://example.test';
  process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  delete process.env.PORYADOK_INGEST_TOKEN;
  delete process.env.DATABASE_URL;
  const office = require('../server.js');
  server = await new Promise((resolve) => {
    const s = office.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server && server.close();
  hook.close();
});

function json(pathname, opts = {}) {
  return fetch(base + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

test('агент есть в /api/state с grokAgentId и номером 13', async () => {
  const state = await json('/api/state');
  assert.equal(state.status, 200);
  const agent = state.body.agents.find((item) => item.id === 'health');
  assert.ok(agent);
  assert.equal(agent.name, 'Здоровье и спорт · Кремль');
  assert.equal(agent.grokAgentId, HEALTH_ID);
  assert.equal(agent.number, '13');
  assert.equal(agent.kind, 'health');
  assert.equal(agent.tier, 'dept');
  assert.equal(agent.district, 'Лужники');
  assert.equal(agent.archived, false);
  assert.equal(agent.parentId, null);
  assert.deepEqual([agent.x, agent.y], POS);
  const grok = state.body.agents.find((item) => item.id === 'grok');
  assert.ok(grok.links.includes('health'));
  const png = await fetch(base + '/img/health-sport.png');
  assert.equal(png.status, 200);
  assert.match(png.headers.get('content-type') || '', /image\/png/);
  const svg = await fetch(base + '/img/health-sport-avatar.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type') || '', /svg/);
});

test('приказ идёт своим вебхуком, иначе через resolveDestination: putin, затем строка grok, затем env', async () => {
  const own = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ agent: 'health', text: 'Утренняя пробежка' }),
  });
  assert.equal(own.status, 201);
  assert.equal(own.body.deliveryLabel, 'Отправлена');
  const envHit = hits.filter((hit) => hit.body && hit.body.taskId === own.body.id).pop();
  assert.equal(envHit.url, '/env');
  assert.equal(envHit.body.agentId, 'health');
  assert.equal(envHit.body.type, 'owner_task');
  assert.equal(envHit.body.text, 'Утренняя пробежка');
  const afterEnv = await json('/api/state');
  assert.equal(afterEnv.body.agents.find((item) => item.id === 'health').activity, 'working');

  const grokSaved = await json('/api/agents/grok/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ url: `http://127.0.0.1:${hook.address().port}/grok-shared`, key: 'grok-key' }),
  });
  assert.equal(grokSaved.status, 200);
  const viaGrok = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ agent: 'health', text: 'Через строку grok' }),
  });
  assert.equal(viaGrok.status, 201);
  assert.equal(viaGrok.body.deliveryLabel, 'Отправлена');
  const grokHit = hits.filter((hit) => hit.body && hit.body.taskId === viaGrok.body.id).pop();
  assert.equal(grokHit.url, '/grok-shared');
  assert.equal(grokHit.body.agentId, 'health');
  assert.equal(grokHit.headers['x-webhook-key'], 'grok-key');

  const putinSaved = await json('/api/delivery/putin', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ url: `http://127.0.0.1:${hook.address().port}/putin`, key: 'putin-key' }),
  });
  assert.equal(putinSaved.status, 200);
  const viaPutin = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ agent: 'health', text: 'Через Путина' }),
  });
  assert.equal(viaPutin.body.deliveryLabel, 'Отправлена');
  const putinHit = hits.filter((hit) => hit.body && hit.body.taskId === viaPutin.body.id).pop();
  assert.equal(putinHit.url, '/putin');
  assert.equal(putinHit.body.agentId, 'health');
  assert.equal(putinHit.headers['x-webhook-key'], 'putin-key');

  const ownSaved = await json('/api/agents/health/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ url: `http://127.0.0.1:${hook.address().port}/health`, key: 'health-key' }),
  });
  assert.equal(ownSaved.status, 200);
  assert.equal(ownSaved.body.agentId, 'health');
  assert.equal(ownSaved.body.route, 'agent');
  assert.equal(ownSaved.body.keyTail, 'h-key'.slice(-4));
  assert.equal(JSON.stringify(ownSaved.body).includes('health-key'), false);
  const viaOwn = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-health' },
    body: JSON.stringify({ agent: 'health', text: 'Свой вебхук' }),
  });
  assert.equal(viaOwn.body.deliveryLabel, 'Отправлена');
  const ownHit = hits.filter((hit) => hit.body && hit.body.taskId === viaOwn.body.id).pop();
  assert.equal(ownHit.url, '/health');
  assert.equal(ownHit.body.agentId, 'health');
  assert.equal(ownHit.headers['x-webhook-key'], 'health-key');

  const waiting = await json('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-health' },
    body: JSON.stringify({ agent: 'health', status: 'waiting', now: 'Жду план' }),
  });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.agent.status, 'waiting');
  const panel = await json('/api/agents/health/delivery', { headers: { 'x-app-password': 'pw-health' } });
  assert.equal(panel.status, 200);
  assert.equal(panel.body.url, `http://127.0.0.1:${hook.address().port}/health`);
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

async function startOffice(env) {
  const port = await freePort();
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      APP_PASSWORD: 'pw-health',
      AGENT_TOKEN: 'tok-health',
      PORYADOK_INGEST_TOKEN: '',
      UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'health-db-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const officeBase = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(logs.out + logs.err);
    try {
      const res = await fetch(`${officeBase}/healthz`);
      if (res.status === 200) break;
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return { base: officeBase, child, logs };
}

async function stopOffice(office) {
  if (!office || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('на уже заполненной базе агент появляется и чужие приказы остаются', { skip: databaseUrl ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `h_${crypto.randomBytes(4).toString('hex')}`;
  const env = { DATABASE_URL: databaseUrl, STORE_SCHEMA: schema };
  const first = await startOffice(env);
  let taskId;
  try {
    const task = await fetch(`${first.base}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-health' },
      body: JSON.stringify({ agent: 'army', text: 'Сводка, которую нельзя потерять' }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(task.status, 201);
    taskId = task.body.id;
    const marked = await fetch(`${first.base}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-health' },
      body: JSON.stringify({ agent: 'army', status: 'waiting', now: 'Жду цифры' }),
    });
    assert.equal(marked.status, 200);
  } finally {
    await stopOffice(first);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const removed = await pool.query(`DELETE FROM ${schema}.agent_state WHERE id = 'health'`);
    assert.equal(removed.rowCount, 1);
    const kept = await pool.query(`SELECT id FROM ${schema}.orders WHERE id = $1`, [taskId]);
    assert.equal(kept.rowCount, 1);
  } finally {
    await pool.end();
  }

  const second = await startOffice(env);
  const check = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const state = await fetch(`${second.base}/api/state`).then((res) => res.json());
    const health = state.agents.find((item) => item.id === 'health');
    assert.equal(health.grokAgentId, HEALTH_ID);
    assert.equal(health.name, 'Здоровье и спорт · Кремль');
    assert.deepEqual([health.x, health.y], POS);
    const army = state.agents.find((item) => item.id === 'army');
    assert.equal(army.status, 'waiting');
    assert.equal(army.now, 'Жду цифры');
    const task = state.tasks.find((item) => item.id === taskId);
    assert.equal(task.text, 'Сводка, которую нельзя потерять');
    assert.equal(task.agentId || task.agent, 'army');
    const row = await check.query(`SELECT id FROM ${schema}.agent_state WHERE id = 'health'`);
    assert.equal(row.rowCount, 1);
  } finally {
    await check.end();
    await stopOffice(second);
    const drop = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await drop.end(); }
  }
});
