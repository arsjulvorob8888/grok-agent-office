'use strict';

// Поток узнаёт о принятом живом статусе и о границе окна.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activityFor, activeWindowMs, STATUS_HOLD_MS } = require('../lib/activity');
const live = require('../lib/live-status');
const stream = require('../lib/stream');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-push-'));
process.env.APP_PASSWORD = 'pw-push';
process.env.AGENT_TOKEN = 'tok-push';
process.env.AGENT_STATUS_TOKEN = 'status-push';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.PORYADOK_INGEST_TOKEN;
delete process.env.ACTIVITY_WINDOW_MIN;

const { app, state, runLiveSweep, liveSweepArmed } = require('../server.js');

let base;
let server;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (live && live.setNow) live.setNow(null);
  if (server) await new Promise((resolve) => server.close(resolve));
});

function fakeRes(chunks) {
  return {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    on() {},
    socket: { setNoDelay() {} },
  };
}

function agent(extra) {
  return {
    id: 'qa',
    name: 'Тестировщик ПО',
    status: 'idle',
    live: null,
    ...extra,
  };
}

function sweepOf(people, publish) {
  return live.createStatusSweep({
    agents: () => people,
    now: () => Date.now(),
    windowMs: () => activeWindowMs(),
    publish,
    activityOf: (item, at) => activityFor(item, [], at, activeWindowMs(), {
      agents: people,
      messages: [],
      routines: [],
    }),
  });
}

test('истечение живого окна шлёт событие, фейковые таймеры', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const chunks = [];
  const hub = stream.createHub({ debounceMs: 0, keepaliveMs: 60 * 60 * 1000 });
  try {
    hub.attach({ on() {} }, fakeRes(chunks));
    const start = Date.now();
    const person = agent({
      live: {
        status: 'working',
        doing: 'Проверяю',
        since: new Date(start).toISOString(),
        until: new Date(start + live.TTL_MS).toISOString(),
      },
    });
    const sweep = sweepOf([person], () => hub.publish());
    sweep.arm();
    t.mock.timers.tick(live.TTL_MS - 1);
    assert.equal(chunks.join('').includes('event: state'), false);
    assert.equal(person.live.status, 'working');
    t.mock.timers.tick(50);
    assert.equal(person.live.status, 'idle');
    assert.match(chunks.join(''), /event: state/);
    assert.equal(chunks.join('').includes('Проверяю'), false);
    sweep.stop();
  } finally {
    hub.close();
    t.mock.timers.reset();
  }
});

test('settleRawStatus на границе STATUS_HOLD_MS шлёт событие', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const chunks = [];
  const hub = stream.createHub({ debounceMs: 0, keepaliveMs: 60 * 60 * 1000 });
  try {
    hub.attach({ on() {} }, fakeRes(chunks));
    const start = Date.now();
    const person = agent({
      status: 'working',
      lastStatusAt: new Date(start).toISOString(),
    });
    const sweep = sweepOf([person], () => hub.publish());
    sweep.arm();
    t.mock.timers.tick(STATUS_HOLD_MS - 1);
    assert.equal(person.status, 'working');
    assert.equal(chunks.join('').includes('event: state'), false);
    t.mock.timers.tick(50);
    assert.equal(person.status, 'idle');
    assert.match(chunks.join(''), /event: state/);
    sweep.stop();
  } finally {
    hub.close();
    t.mock.timers.reset();
  }
});

test('истечение activeWindowMs у пульса шлёт событие', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const chunks = [];
  const hub = stream.createHub({ debounceMs: 0, keepaliveMs: 60 * 60 * 1000 });
  try {
    hub.attach({ on() {} }, fakeRes(chunks));
    const start = Date.now();
    const win = activeWindowMs();
    const person = agent({ lastSeenAt: new Date(start).toISOString() });
    const sweep = sweepOf([person], () => hub.publish());
    sweep.arm();
    t.mock.timers.tick(win);
    assert.equal(chunks.join('').includes('event: state'), false);
    const still = activityFor(person, [], Date.now(), win, { agents: [person] });
    assert.equal(still.activity, 'working');
    t.mock.timers.tick(5);
    const after = activityFor(person, [], Date.now(), win, { agents: [person] });
    assert.equal(after.activity, 'resting');
    assert.match(chunks.join(''), /event: state/);
    sweep.stop();
  } finally {
    hub.close();
    t.mock.timers.reset();
  }
});

function json(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null),
  }));
}

function postStatus(body, headers = {}) {
  return json('/api/agent-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer status-push', ...headers },
    body: JSON.stringify(body),
  });
}

function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/stream`, (res) => {
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

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('принятый POST, в том числе повторный, пишет event: state без секрета', async () => {
  const sse = await openSse();
  try {
    const opened = await waitFor(() => sse.text().includes(': stream'));
    assert.equal(opened, true, sse.text());
    const first = await postStatus({ agentId: 'army', status: 'working', doing: 'СЕКРЕТ-ХОД-XYZ' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const got = await waitFor(() => sse.text().includes('event: state'));
    assert.equal(got, true, sse.text());
    assert.equal(sse.text().includes('СЕКРЕТ-ХОД-XYZ'), false);
    assert.equal(sse.text().includes('status-push'), false);
    assert.equal(liveSweepArmed(), true);

    const marks = sse.text().split('event: state').length;
    const again = await postStatus({ agentId: 'army', status: 'working', doing: 'ещё ход' });
    assert.equal(again.status, 200);
    const more = await waitFor(() => sse.text().split('event: state').length > marks);
    assert.equal(more, true, sse.text());

    const before = sse.text().split('event: state').length;
    const denied = await postStatus({ agentId: 'army', status: 'idle' }, { Authorization: 'Bearer wrong-token' });
    assert.equal(denied.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(sse.text().split('event: state').length, before);
  } finally {
    sse.req.destroy();
  }
});

test('серверный проход окна снимает живой ход и пишет событие', async () => {
  const sse = await openSse();
  try {
    const posted = await postStatus({ agentId: 'qa', status: 'working', doing: 'окно' });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const seen = await waitFor(() => sse.text().includes('event: state'));
    assert.equal(seen, true);
    const marks = sse.text().split('event: state').length;
    const person = state.agents.find((item) => item.id === 'qa');
    person.live.until = new Date(Date.now() - 1000).toISOString();
    runLiveSweep();
    const got = await waitFor(() => sse.text().split('event: state').length > marks);
    assert.equal(got, true, sse.text());
    assert.equal(sse.text().includes('окно'), false);
    const view = (await json('/api/state')).body.agents.find((item) => item.id === 'qa');
    assert.equal(view.activity, 'resting');
    assert.equal(view.doing, null);
  } finally {
    sse.req.destroy();
  }
});
