'use strict';

// Короткий поток «состояние изменилось». Внутри нет снимка офиса и секретов:
// клиент сам перечитывает публичный /api/state.

const KEEPALIVE_MS = 25000;
const MAX_CLIENTS = 40;
const DEBOUNCE_MS = 40;

function createHub(opts = {}) {
  const keepaliveMs = opts.keepaliveMs || KEEPALIVE_MS;
  const maxClients = opts.maxClients || MAX_CLIENTS;
  const debounceMs = opts.debounceMs == null ? DEBOUNCE_MS : opts.debounceMs;
  const clients = new Set();
  const beats = new Map();
  let timer = null;
  let dirty = false;

  function write(res, chunk) {
    try {
      return res.write(chunk);
    } catch (_) {
      drop(res);
      return false;
    }
  }

  function drop(res) {
    clients.delete(res);
    const beat = beats.get(res);
    if (beat) {
      clearInterval(beat);
      beats.delete(res);
    }
  }

  function broadcast() {
    dirty = false;
    const payload = 'event: state\ndata: {}\n\n';
    for (const res of clients) write(res, payload);
  }

  function publish() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) broadcast();
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function attach(req, res) {
    if (clients.size >= maxClients) return false;
    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    };
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, headers);
    } else {
      res.status(200);
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }
    clients.add(res);
    write(res, ': stream\n\n');
    const beat = setInterval(() => write(res, ': keepalive\n\n'), keepaliveMs);
    if (typeof beat.unref === 'function') beat.unref();
    beats.set(res, beat);
    const gone = () => drop(res);
    if (req && typeof req.on === 'function') req.on('close', gone);
    if (typeof res.on === 'function') {
      res.on('close', gone);
      res.on('error', gone);
    }
    return true;
  }

  function closeSockets() {
    for (const res of [...clients]) {
      const socket = res.socket;
      drop(res);
      try { res.end(); } catch (_) { /* сокет уже закрыт */ }
      try { if (socket && !socket.destroyed) socket.destroy(); } catch (_) { /* сокет уже закрыт */ }
    }
  }

  function close() {
    if (timer) clearTimeout(timer);
    timer = null;
    closeSockets();
  }

  return {
    publish,
    attach,
    close,
    closeSockets,
    clientCount: () => clients.size,
  };
}

function registerStream(app, hub) {
  app.get('/api/stream', (req, res) => {
    if (!hub.attach(req, res)) {
      res.status(503).json({ error: 'Слишком много подписчиков' });
    }
  });
}

module.exports = {
  KEEPALIVE_MS,
  MAX_CLIENTS,
  createHub,
  registerStream,
};
