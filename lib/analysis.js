'use strict';

// Текст «Анализ и прогноз» направления. Одна текущая запись на агента, в памяти.
// Денежных сумм сюда не кладём: это короткий комментарий агента.

const MAX_TEXT = 4000;

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.expose = error;
  return err;
}

function parseAnalysis(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Тело должно быть JSON-объектом');
  }
  if (typeof body.text !== 'string') throw httpError(400, 'text должен быть строкой');
  const text = body.text.trim();
  if (!text) throw httpError(400, 'Нужно поле text');
  if (text.length > MAX_TEXT) throw httpError(400, `text слишком длинный (максимум ${MAX_TEXT} символов)`);
  let updatedAt;
  if (body.updatedAt == null || body.updatedAt === '') {
    updatedAt = new Date().toISOString();
  } else if (typeof body.updatedAt !== 'string') {
    throw httpError(400, 'updatedAt должен быть строкой ISO');
  } else {
    const t = Date.parse(body.updatedAt);
    if (Number.isNaN(t)) throw httpError(400, 'Некорректный updatedAt');
    if (t > Date.now() + 864e5) throw httpError(400, 'updatedAt слишком далеко в будущем');
    updatedAt = new Date(t).toISOString();
  }
  return { text, updatedAt };
}

function createAnalysisStore() {
  const rows = new Map();
  return {
    maxText: MAX_TEXT,
    parse: parseAnalysis,
    get(agentId) {
      return rows.get(agentId) || null;
    },
    set(agentId, row) {
      rows.set(agentId, row);
      return row;
    },
  };
}

module.exports = { MAX_TEXT, parseAnalysis, createAnalysisStore };
