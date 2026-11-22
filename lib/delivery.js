'use strict';

// Куда слать событие очереди и как сотрудник задаёт адрес.
// Сначала вебхук агента, иначе общий вебхук Путина (строка putin, иначе строка grok), иначе env.
// Личный адрес агента Путина (id grok) — тот же общий вебхук. Строки не переписываем.

const { seal, open, publicDelivery } = require('./webhook-crypto');
const linkCheck = require('./link-check');

const PUTIN_ID = 'putin';
const GROK_ID = 'grok';

function isSharedId(id) {
  return id === PUTIN_ID || id === GROK_ID;
}
const NO_KEY = 'Не задан WEBHOOK_SECRETS_KEY, вебхук не сохранён';
const BAD_LENGTH = 'WEBHOOK_SECRETS_KEY должен быть 32 байта в base64';

function fail(status, error, code) {
  const err = new Error(error);
  err.status = status;
  err.expose = error;
  if (code) err.code = code;
  return err;
}

function mapCrypto(err) {
  if (err && err.code === 'NO_SECRETS_KEY') throw fail(503, NO_KEY, err.code);
  if (err && err.code === 'BAD_KEY_LENGTH') throw fail(503, BAD_LENGTH, err.code);
  if (err && err.code === 'BAD_SECRETS_KEY') throw fail(503, err.message, err.code);
  throw err;
}

function targets(state) {
  if (!state.webhookTargets) state.webhookTargets = {};
  return state.webhookTargets;
}

function publicRoute(agentId, state, env) {
  try {
    const dest = resolveDestination(agentId, state, env);
    if (!dest) return 'none';
    if (dest.via === 'agent' || dest.via === 'putin' || dest.via === 'env') return dest.via;
    return 'none';
  } catch (_) {
    return 'none';
  }
}

function routeFor(agentId, state, env) {
  const map = (state && state.webhookTargets) || {};
  if (agentId && !isSharedId(agentId) && map[agentId]) return 'agent';
  if (map[PUTIN_ID] || map[GROK_ID]) return 'putin';
  if (String((env && env.KREMLIN_WEBHOOK_URL) || '').trim()) return 'env';
  return 'none';
}

function publicWebhookSummary(state) {
  const map = (state && state.webhookTargets) || {};
  let agentWebhooks = 0;
  for (const id of Object.keys(map)) {
    if (!map[id] || isSharedId(id)) continue;
    agentWebhooks += 1;
  }
  return { agentWebhooks, putinWebhookSet: Boolean(map[PUTIN_ID] || map[GROK_ID]) };
}

function anyConfigured(state, env) {
  if (String((env && env.KREMLIN_WEBHOOK_URL) || '').trim()) return true;
  const map = (state && state.webhookTargets) || {};
  return Object.keys(map).some((id) => map[id]);
}

function readUsable(id, state, env) {
  const record = (state.webhookTargets || {})[id];
  if (!record) return null;
  const secret = open(id, record, env);
  const url = String(secret.url || '').trim();
  if (!url) return null;
  return { url, key: String(secret.key || '') };
}

function resolveDestination(agentId, state, env) {
  if (agentId && !isSharedId(agentId)) {
    const own = readUsable(agentId, state, env);
    if (own) return { ...own, via: 'agent' };
  }
  const shared = readUsable(PUTIN_ID, state, env);
  if (shared) return { ...shared, via: 'putin' };
  const personal = readUsable(GROK_ID, state, env);
  if (personal) return { ...personal, via: 'putin' };
  const envUrl = String((env && env.KREMLIN_WEBHOOK_URL) || '').trim();
  if (envUrl) {
    return {
      url: envUrl,
      key: String((env && env.KREMLIN_WEBHOOK_KEY) || ''),
      via: 'env',
    };
  }
  return null;
}

function parseUrl(raw) {
  const url = String(raw == null ? '' : raw).trim();
  if (!url) return '';
  if (/[\r\n]/.test(url)) throw fail(400, 'URL вебхука не должен содержать переводы строки');
  if (url.length > 2000) throw fail(400, 'Слишком длинный URL вебхука');
  let parsed;
  try { parsed = new URL(url); } catch (_) {
    throw fail(400, 'URL вебхука должен начинаться с http:// или https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail(400, 'URL вебхука должен начинаться с http:// или https://');
  }
  if (parsed.username || parsed.password) throw fail(400, 'URL вебхука не должен содержать логин и пароль');
  return url;
}

function parseKey(raw) {
  if (typeof raw !== 'string') throw fail(400, 'Ключ вебхука должен быть строкой');
  if (/[\r\n]/.test(raw)) throw fail(400, 'Ключ вебхука не должен содержать переводы строки');
  if (raw.length > 500) throw fail(400, 'Слишком длинный ключ вебхука');
  return raw;
}

function viewFor(id, secret, state, env) {
  const pub = publicDelivery(secret);
  return { id, url: pub.url, keySet: pub.keySet, keyTail: pub.keyTail, route: routeFor(id, state, env) };
}

function saveDelivery(state, store, id, body, env) {
  if (!body || typeof body.url !== 'string') throw fail(400, 'Нужен URL вебхука');
  const url = parseUrl(body.url);
  const map = targets(state);
  if (!url) {
    delete map[id];
    if (store && store.noteWebhookTargetRemoved) store.noteWebhookTargetRemoved(id);
    return viewFor(id, { url: '', key: '' }, state, env);
  }
  if (body.key != null && body.key !== '' && typeof body.key !== 'string') {
    throw fail(400, 'Ключ вебхука должен быть строкой');
  }
  const existing = map[id];
  let previous = { url: '', key: '' };
  if (existing) {
    try { previous = open(id, existing, env); } catch (err) { mapCrypto(err); }
  }
  let hookKey = '';
  if (body.clearKey === true) hookKey = '';
  else if (typeof body.key === 'string' && body.key !== '') hookKey = parseKey(body.key);
  else hookKey = previous.key || '';
  let sealed;
  try { sealed = seal(id, { url, key: hookKey }, env); } catch (err) { mapCrypto(err); }
  map[id] = {
    id,
    iv: sealed.iv,
    tag: sealed.tag,
    ciphertext: sealed.ciphertext,
    updatedAt: new Date().toISOString(),
  };
  if (store && store.noteWebhookTarget) store.noteWebhookTarget(map[id]);
  return viewFor(id, { url, key: hookKey }, state, env);
}

function readView(state, id, env) {
  const record = (state.webhookTargets || {})[id];
  if (!record) return viewFor(id, { url: '', key: '' }, state, env);
  let secret;
  try { secret = open(id, record, env); } catch (err) { mapCrypto(err); }
  return viewFor(id, secret, state, env);
}

function shape(view, mode, check) {
  const body = {
    url: view.url,
    keySet: view.keySet,
    keyTail: view.keyTail,
    route: view.route,
    linkCheck: check || null,
  };
  if (mode === 'putin') body.id = PUTIN_ID;
  else body.agentId = view.id;
  return body;
}

function linkView(state, id, formatAtMsk) {
  const row = state.linkChecks && state.linkChecks[id];
  return linkCheck.present(row, linkCheck.now(), formatAtMsk);
}

function probeBody(state, view, id, formatAtMsk) {
  const body = shape(view, 'agent', linkView(state, id, formatAtMsk));
  const row = state.linkChecks && state.linkChecks[id];
  body.status = row ? Number(row.http) || 0 : 0;
  body.ok = !!(row && !row.error && body.status >= 200 && body.status < 300);
  return body;
}

async function refreshLink(state, id, env, deps) {
  const ping = await pingOwn(state, id, env, Object.assign({ now: linkCheck.now }, deps));
  return linkCheck.remember(state, id, ping);
}

async function probeDelivery(state, id, body, env, deps) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasTypedUrl = typeof source.url === 'string' && source.url.trim() !== '';
  const typedUrl = hasTypedUrl ? parseUrl(source.url) : '';
  const typedKey = typeof source.key === 'string' && source.key !== '' ? parseKey(source.key) : '';
  let url = typedUrl;
  let hookKey = typedKey;
  if (!url || !hookKey) {
    const existing = (state.webhookTargets || {})[id];
    if (existing) {
      let stored;
      try { stored = open(id, existing, env); } catch (err) { mapCrypto(err); }
      const storedUrl = String(stored.url || '').trim();
      if (!url) {
        url = storedUrl;
        if (!hookKey) hookKey = String(stored.key || '');
      } else if (!hookKey && storedUrl === url) {
        hookKey = String(stored.key || '');
      }
    }
  }
  if (!url) throw fail(409, 'Адрес не задан — сообщения идут через Путина');
  const at = new Date().toISOString();
  const payload = {
    type: 'ping',
    agentId: id,
    text: 'Проверка связи',
    at,
    atMsk: deps.formatAtMsk(at),
    appUrl: deps.publicUrl || '',
  };
  const started = Date.now();
  let result;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: deps.headersFor(hookKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    });
    if (response && typeof response.arrayBuffer === 'function') await response.arrayBuffer().catch(() => {});
    const status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
    result = { ok: !!(response && response.ok), status, ms: Date.now() - started };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    result = {
      ok: false,
      status: 0,
      error: timeout ? 'timeout' : 'network_error',
      ms: Date.now() - started,
    };
  }
  const safeId = String(id).replace(/[\r\n]/g, '');
  const label = result.error ? `error=${result.error}` : `http=${result.status}`;
  console.log(`webhook test target=${safeId} ${label} ms=${result.ms}`);
  const view = { ok: result.ok, status: result.status, phrase: phraseFor(result) };
  if (result.error) view.error = result.error;
  return view;
}

async function postHook(url, hookKey, payload, deps) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: deps.headersFor(hookKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    });
    if (response && typeof response.arrayBuffer === 'function') await response.arrayBuffer().catch(() => {});
    const status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
    return { ok: !!(response && response.ok), status, ms: Date.now() - started };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 0,
      error: timeout ? 'timeout' : 'network_error',
      ms: Date.now() - started,
    };
  }
}

// Служебный ping только на собственный адрес агента. Чужой URL из тела запроса не используется.
async function pingOwn(state, id, env, deps) {
  let own = null;
  try { own = readUsable(id, state, env); } catch (err) { mapCrypto(err); }
  if (!own || !own.url || !own.key) return { skipped: true };
  const sentAt = typeof deps.now === 'function' ? deps.now() : Date.now();
  const taskId = `ping-${id}-${sentAt}`;
  const at = new Date(sentAt).toISOString();
  const payload = {
    type: 'ping',
    agentId: id,
    taskId,
    text: 'Проверка связи',
    at,
    atMsk: deps.formatAtMsk(at),
    appUrl: deps.publicUrl || '',
  };
  const result = await postHook(own.url, own.key, payload, deps);
  const safeId = String(id).replace(/[\r\n]/g, '');
  const label = result.error ? `error=${result.error}` : `http=${result.status}`;
  console.log(`webhook test target=${safeId} ${label} ms=${result.ms}`);
  return { skipped: false, taskId, sentAt, http: result.status, error: result.error || null };
}

function probeTimeoutMs() {
  const raw = Number(process.env.WEBHOOK_PROBE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 50 && raw <= 10000) return raw;
  return 10000;
}

function phraseFor(result) {
  if (!result || result.error || !result.status) return 'Адрес не отвечает';
  const status = Number(result.status);
  if (status === 401 || status === 403) return 'Ключ не подошёл (401/403)';
  if (result.ok) return 'Доставлено';
  return 'Адрес не отвечает';
}

function sendError(res, err) {
  const status = err && err.status;
  if (!status) {
    console.error('Доставка: внутренняя ошибка');
    return res.status(500).json({ error: 'Не удалось сохранить вебхук' });
  }
  return res.status(status).json({ error: err.expose || 'Не удалось сохранить вебхук' });
}

function register(app, deps) {
  const { state, store, requireAppPassword, findAgent } = deps;

  function assertAgent(id) {
    if (!id || id === PUTIN_ID || !findAgent(id)) throw fail(404, 'Неизвестный агент');
  }

  app.get('/api/delivery/putin', requireAppPassword, (req, res) => {
    try { res.json(shape(readView(state, PUTIN_ID, process.env), 'putin')); }
    catch (err) { sendError(res, err); }
  });

  app.put('/api/delivery/putin', requireAppPassword, async (req, res) => {
    try {
      const view = saveDelivery(state, store, PUTIN_ID, req.body || {}, process.env);
      await store.flush();
      if (deps.onWebhookSaved) await deps.onWebhookSaved();
      res.json(shape(view, 'putin'));
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/delivery/putin/test', requireAppPassword, async (req, res) => {
    try { res.json(await probeDelivery(state, PUTIN_ID, req.body || {}, process.env, deps)); }
    catch (err) { sendError(res, err); }
  });

  app.get('/api/agents/:id/delivery', requireAppPassword, (req, res) => {
    try {
      assertAgent(req.params.id);
      const view = readView(state, req.params.id, process.env);
      res.json(shape(view, 'agent', linkView(state, req.params.id, deps.formatAtMsk)));
    } catch (err) { sendError(res, err); }
  });

  app.put('/api/agents/:id/delivery', requireAppPassword, async (req, res) => {
    try {
      assertAgent(req.params.id);
      const view = saveDelivery(state, store, req.params.id, req.body || {}, process.env);
      if (!view.url || !view.keySet) linkCheck.clear(state, req.params.id);
      else await refreshLink(state, req.params.id, process.env, deps);
      await store.flush();
      if (deps.onWebhookSaved) await deps.onWebhookSaved();
      res.json(shape(view, 'agent', linkView(state, req.params.id, deps.formatAtMsk)));
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/agents/:id/delivery/test', requireAppPassword, async (req, res) => {
    try {
      assertAgent(req.params.id);
      const view = readView(state, req.params.id, process.env);
      if (!view.url || !view.keySet) {
        linkCheck.clear(state, req.params.id);
        return res.json(Object.assign(shape(view, 'agent', null), { ok: false, status: 0 }));
      }
      await refreshLink(state, req.params.id, process.env, deps);
      res.json(probeBody(state, view, req.params.id, deps.formatAtMsk));
    } catch (err) { sendError(res, err); }
  });
}

module.exports = {
  PUTIN_ID,
  register,
  resolveDestination,
  publicRoute,
  saveDelivery,
  anyConfigured,
  publicWebhookSummary,
  routeFor,
  pingOwn,
};
