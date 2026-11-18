'use strict';

// Снимок лимита Grok. Секретов здесь нет: только план, проценты и две даты.
// Пороги те же, что у виджета: от 80 жёлтый, от 95 красный.

const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const TEXT_MAX = 40;
const ALLOWED = new Set(['plan', 'usedPct', 'used', 'limit', 'resetsAt', 'source']);
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/;

let nowFn = () => Date.now();

function setNow(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function now() {
  return nowFn();
}

function levelOf(usedPct) {
  if (!Number.isFinite(usedPct)) return 'empty';
  if (usedPct >= 95) return 'critical';
  if (usedPct >= 80) return 'warn';
  return 'ok';
}

function roundPct(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = ISO_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  if (match[4] == null) return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const zone = match[8];
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function shortText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > TEXT_MAX) return null;
  if (/[<>]/.test(text) || /[\u0000-\u001f]/.test(text)) return null;
  return text;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Нужен JSON-объект' };
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return { error: 'Неизвестное поле' };
  }
  const plan = shortText(body.plan);
  if (!plan) return { error: 'plan должен быть строкой до 40 символов' };
  const source = shortText(body.source);
  if (!source) return { error: 'source должен быть строкой до 40 символов' };
  if (!isIsoDate(body.resetsAt)) return { error: 'resetsAt должен быть ISO-датой' };

  const hasPct = Object.prototype.hasOwnProperty.call(body, 'usedPct');
  const hasUsed = Object.prototype.hasOwnProperty.call(body, 'used');
  const hasLimit = Object.prototype.hasOwnProperty.call(body, 'limit');
  if (hasUsed !== hasLimit) return { error: 'used и limit должны быть числами, limit больше 0' };

  let used = null;
  let limit = null;
  if (hasUsed) {
    if (!finiteNumber(body.used) || body.used < 0 || !finiteNumber(body.limit) || body.limit <= 0) {
      return { error: 'used и limit должны быть числами, limit больше 0' };
    }
    used = body.used;
    limit = body.limit;
  }

  let usedPct;
  if (hasPct) {
    if (!finiteNumber(body.usedPct) || body.usedPct < 0 || body.usedPct > 100) {
      return { error: 'usedPct должен быть числом от 0 до 100' };
    }
    usedPct = roundPct(body.usedPct);
  } else if (used != null) {
    const raw = (used / limit) * 100;
    if (raw < 0 || raw > 100) return { error: 'usedPct должен быть числом от 0 до 100' };
    usedPct = roundPct(raw);
  } else {
    return { error: 'usedPct должен быть числом от 0 до 100' };
  }

  return {
    value: {
      plan,
      usedPct,
      used,
      limit,
      resetsAt: body.resetsAt,
      source,
    },
  };
}

function fresh(item, at) {
  const stamp = Date.parse(item && item.updatedAt);
  return Number.isFinite(stamp) && at - stamp <= HISTORY_MS;
}

function cleanStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usedPct = typeof raw.usedPct === 'number' ? raw.usedPct : Number.NaN;
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) return null;
  const plan = typeof raw.plan === 'string' ? raw.plan : '';
  const source = typeof raw.source === 'string' ? raw.source : '';
  const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt : '';
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  if (!plan || !source || !resetsAt || !updatedAt) return null;
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? raw.used : null;
  const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? raw.limit : null;
  return {
    plan,
    usedPct,
    used,
    limit,
    resetsAt,
    source,
    updatedAt,
    level: levelOf(usedPct),
  };
}

function publicView(state, at = now()) {
  const bag = state && state.grokUsage;
  const history = (Array.isArray(bag && bag.history) ? bag.history : [])
    .map(cleanStored)
    .filter(Boolean)
    .filter((item) => fresh(item, at));
  return {
    latest: cleanStored(bag && bag.latest),
    history,
  };
}

function record(state, value, at = now()) {
  const entry = {
    plan: value.plan,
    usedPct: value.usedPct,
    used: value.used,
    limit: value.limit,
    resetsAt: value.resetsAt,
    source: value.source,
    updatedAt: new Date(at).toISOString(),
  };
  const prev = Array.isArray(state.grokUsage && state.grokUsage.history) ? state.grokUsage.history : [];
  state.grokUsage = {
    latest: entry,
    history: prev.concat(entry).filter((item) => fresh(item, at)),
  };
  return publicView(state, at);
}

function prune(state, at = now()) {
  const bag = state && state.grokUsage;
  if (!bag || !Array.isArray(bag.history)) return false;
  const history = bag.history.filter((item) => fresh(item, at));
  if (history.length === bag.history.length) return false;
  state.grokUsage = { latest: bag.latest || null, history };
  return true;
}

module.exports = {
  HISTORY_MS,
  setNow,
  now,
  levelOf,
  parse,
  record,
  publicView,
  prune,
};
