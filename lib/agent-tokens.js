'use strict';

// Личный токен агента. Сырая строка живёт только в ответе выпуска.
// В память и в базу попадает SHA-256. Сравнение — timingSafeEqual.

const crypto = require('crypto');

const WARNING = 'Токен показывается один раз. Повторно его не увидеть. Старые токены этого агента отозваны.';
const DUMMY = crypto.createHash('sha256').update('kremlin-agent-token-dummy', 'utf8').digest();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function digestEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    const size = Buffer.isBuffer(left) && left.length ? left.length : 32;
    crypto.timingSafeEqual(Buffer.alloc(size), Buffer.alloc(size));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function activeRows(records) {
  return (Array.isArray(records) ? records : []).filter((row) => row && !row.revokedAt && row.tokenHash);
}

function matchToken(records, presented) {
  const digest = crypto.createHash('sha256').update(String(presented || ''), 'utf8').digest();
  const rows = activeRows(records);
  let found = null;
  if (!rows.length) {
    digestEqual(digest, DUMMY);
    return null;
  }
  for (const row of rows) {
    const stored = Buffer.from(String(row.tokenHash || ''), 'hex');
    if (digestEqual(digest, stored.length === digest.length ? stored : DUMMY)) {
      if (stored.length === digest.length) found = row;
    }
  }
  return found;
}

function authorize({ presented, claimedIds, records, sharedSecret }) {
  const token = typeof presented === 'string' ? presented : '';
  const claimed = (Array.isArray(claimedIds) ? claimedIds : [])
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  const shared = typeof sharedSecret === 'string' ? sharedSecret : '';
  const found = matchToken(records, token);
  const sharedOk = token.length > 0 && shared.length > 0 && safeEqual(token, shared);
  const active = activeRows(records);
  if (!token) {
    if (!shared && active.length === 0) {
      return { ok: false, status: 503, error: 'Токен агентов не настроен (AGENT_TOKEN)' };
    }
    return { ok: false, status: 401, error: 'Неверный токен агента' };
  }
  if (found) {
    if (claimed.some((id) => id !== found.agentId)) {
      return { ok: false, status: 403, error: 'Токен другого агента' };
    }
    return { ok: true, via: 'personal', agentId: found.agentId };
  }
  if (sharedOk) {
    if (claimed.some((id) => active.some((row) => row.agentId === id))) {
      return { ok: false, status: 401, error: 'Для этого агента нужен личный токен' };
    }
    return { ok: true, via: 'shared', agentId: claimed.length === 1 ? claimed[0] : null };
  }
  if (!shared && active.length === 0) {
    return { ok: false, status: 503, error: 'Токен агентов не настроен (AGENT_TOKEN)' };
  }
  return { ok: false, status: 401, error: 'Неверный токен агента' };
}

function issue(records, agents, nowIso) {
  const list = Array.isArray(records) ? records : [];
  const touched = [];
  const issued = [];
  const now = nowIso || new Date().toISOString();
  for (const agent of agents || []) {
    if (!agent || !agent.id) continue;
    for (const row of list) {
      if (row && row.agentId === agent.id && !row.revokedAt) {
        row.revokedAt = now;
        touched.push(row);
      }
    }
    const token = generateToken();
    const row = {
      id: crypto.randomBytes(16).toString('hex'),
      agentId: agent.id,
      tokenHash: hashToken(token),
      createdAt: now,
      revokedAt: null,
    };
    list.push(row);
    touched.push(row);
    issued.push({ agentId: agent.id, name: agent.name || agent.id, token });
  }
  return { issued, touched };
}

function revoke(records, agentId, nowIso) {
  const now = nowIso || new Date().toISOString();
  const touched = [];
  for (const row of Array.isArray(records) ? records : []) {
    if (row && row.agentId === agentId && !row.revokedAt) {
      row.revokedAt = now;
      touched.push(row);
    }
  }
  return { revoked: touched.length, touched };
}

module.exports = {
  WARNING,
  hashToken,
  authorize,
  issue,
  revoke,
};
