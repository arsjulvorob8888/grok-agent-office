/* Блок «Доставка» в окне агента. Пароль — тот же, что у остальных действий штаба.
   Ключ в поле не возвращается: только флаг и последние 4 символа. */
(function () {
  'use strict';

  const drafts = {};

  function password() {
    try { return localStorage.getItem('appPassword') || ''; } catch (_) { return ''; }
  }

  function draftId(agentId, kind) {
    return `${agentId}:${kind}`;
  }

  function routeText(kind, route) {
    if (kind === 'putin') {
      if (route === 'putin') return 'Общий вебхук задан. Агенты без своего адреса идут сюда.';
      if (route === 'env') return 'Общий вебхук не задан. События идут на запасной адрес из окружения.';
      return 'Общий вебхук не задан.';
    }
    if (route === 'agent') return 'События этого агента идут на его вебхук.';
    if (route === 'putin') return 'Своего вебхука нет. События идут на общий вебхук Путина.';
    if (route === 'env') return 'Своего вебхука нет. События идут на запасной адрес из окружения.';
    return 'Доставка не настроена.';
  }

  function keyHint(data) {
    if (data && data.keySet) {
      return `Ключ задан, последние символы ${data.keyTail}. Пустое поле сохранит прежний ключ.`;
    }
    return 'Ключ не задан.';
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-app-password': password(),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  function setMsg(root, kind, text, tone) {
    const msg = root.querySelector(`[data-delivery-msg="${kind}"]`);
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = `delivery-msg${tone ? ` ${tone}` : ''}`;
  }

  function remember(root, kind) {
    const url = root.querySelector(`[data-delivery-url="${kind}"]`);
    if (!url) return;
    const key = root.querySelector(`[data-delivery-key="${kind}"]`);
    const clear = root.querySelector(`[data-delivery-clear="${kind}"]`);
    const active = document.activeElement;
    drafts[draftId(root.dataset.agent, kind)] = {
      dirty: true,
      url: url.value,
      key: key ? key.value : '',
      clear: !!(clear && clear.checked),
      focused: active && active.dataset ? active.dataset.deliveryFocus || '' : '',
    };
  }

  function apply(root, kind, data) {
    const route = root.querySelector(`[data-delivery-route="${kind}"]`);
    if (route) route.textContent = routeText(kind, data && data.route);
    const hint = root.querySelector(`[data-delivery-hint="${kind}"]`);
    if (hint) hint.textContent = keyHint(data);
    const clearWrap = root.querySelector(`[data-delivery-clear-wrap="${kind}"]`);
    if (clearWrap) clearWrap.hidden = !(data && data.keySet);
    const url = root.querySelector(`[data-delivery-url="${kind}"]`);
    const key = root.querySelector(`[data-delivery-key="${kind}"]`);
    const clear = root.querySelector(`[data-delivery-clear="${kind}"]`);
    const draft = drafts[draftId(root.dataset.agent, kind)];
    if (draft && draft.dirty) {
      if (url) url.value = draft.url;
      if (key) key.value = draft.key;
      if (clear) clear.checked = draft.clear;
      const active = document.activeElement;
      if (draft.focused && (!active || (active.id !== 'taskText' && active.id !== 'taskTarget' && active.id !== 'pwInput'))) {
        const field = draft.focused.endsWith('-key') ? key : url;
        if (field && document.activeElement !== field) field.focus({ preventScroll: true });
      }
      return;
    }
    if (url) url.value = (data && data.url) || '';
    if (key) key.value = '';
    if (clear) clear.checked = false;
  }

  function field(kind, title) {
    const sec = document.createElement('section');
    sec.className = 'sec delivery-block';
    sec.dataset.deliveryKind = kind;
    const heading = document.createElement('h4');
    heading.textContent = title;
    const route = document.createElement('p');
    route.className = 'delivery-note';
    route.dataset.deliveryRoute = kind;
    const urlLabel = document.createElement('label');
    urlLabel.textContent = 'URL вебхука';
    urlLabel.htmlFor = `delivery-url-${kind}`;
    const url = document.createElement('input');
    url.id = `delivery-url-${kind}`;
    url.type = 'url';
    url.autocomplete = 'off';
    url.spellcheck = false;
    url.dataset.deliveryUrl = kind;
    url.dataset.deliveryFocus = `${kind}-url`;
    const keyLabel = document.createElement('label');
    keyLabel.textContent = 'Ключ';
    keyLabel.htmlFor = `delivery-key-${kind}`;
    const key = document.createElement('input');
    key.id = `delivery-key-${kind}`;
    key.type = 'password';
    key.autocomplete = 'new-password';
    key.spellcheck = false;
    key.dataset.deliveryKey = kind;
    key.dataset.deliveryFocus = `${kind}-key`;
    const hint = document.createElement('p');
    hint.className = 'delivery-note';
    hint.dataset.deliveryHint = kind;
    hint.textContent = 'Ключ не задан.';
    const clearWrap = document.createElement('label');
    clearWrap.className = 'delivery-check';
    clearWrap.dataset.deliveryClearWrap = kind;
    clearWrap.hidden = true;
    const clear = document.createElement('input');
    clear.type = 'checkbox';
    clear.dataset.deliveryClear = kind;
    clearWrap.append(clear, document.createTextNode('Сбросить ключ'));
    const actions = document.createElement('div');
    actions.className = 'delivery-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn gold';
    saveBtn.textContent = 'Сохранить';
    saveBtn.dataset.deliverySave = kind;
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn ghost';
    testBtn.textContent = 'Проверить';
    testBtn.dataset.deliveryTest = kind;
    actions.append(saveBtn, testBtn);
    const msg = document.createElement('p');
    msg.className = 'delivery-msg';
    msg.dataset.deliveryMsg = kind;
    msg.setAttribute('aria-live', 'polite');
    sec.append(heading, route, urlLabel, url, keyLabel, key, hint, clearWrap, actions, msg);
    return sec;
  }

  function lockedView() {
    const root = document.createElement('div');
    root.className = 'delivery-root';
    const sec = document.createElement('section');
    sec.className = 'sec delivery-block';
    const heading = document.createElement('h4');
    heading.textContent = 'Доставка';
    const note = document.createElement('p');
    note.className = 'delivery-note';
    note.textContent = 'Нужен пароль персонала.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost';
    button.textContent = 'Ввести пароль';
    button.addEventListener('click', () => {
      const key = document.getElementById('btnKey');
      if (key) key.click();
    });
    sec.append(heading, note, button);
    root.append(sec);
    return root;
  }

  function openView(agentId) {
    const root = document.createElement('div');
    root.className = 'delivery-root';
    if (agentId === 'grok') root.append(field('putin', 'Общий вебхук'));
    root.append(field('agent', 'Доставка'));
    const noteField = (event) => {
      const target = event.target;
      const kind = target && target.dataset && (target.dataset.deliveryUrl || target.dataset.deliveryKey || target.dataset.deliveryClear);
      if (kind) remember(root, kind);
    };
    root.addEventListener('input', noteField);
    root.addEventListener('change', noteField);
    root.addEventListener('click', (event) => {
      const saveBtn = event.target.closest('[data-delivery-save]');
      const testBtn = event.target.closest('[data-delivery-test]');
      const kind = (saveBtn && saveBtn.dataset.deliverySave) || (testBtn && testBtn.dataset.deliveryTest);
      if (!kind) return;
      if (saveBtn) save(root, root.dataset.agent, kind);
      else probe(root, root.dataset.agent, kind);
    });
    return root;
  }

  async function save(root, agentId, kind) {
    const url = root.querySelector(`[data-delivery-url="${kind}"]`);
    const key = root.querySelector(`[data-delivery-key="${kind}"]`);
    const clear = root.querySelector(`[data-delivery-clear="${kind}"]`);
    const payload = { url: url ? url.value.trim() : '' };
    if (key && key.value) payload.key = key.value;
    if (clear && clear.checked) payload.clearKey = true;
    setMsg(root, kind, 'Сохраняю…', '');
    const path = kind === 'putin' ? '/api/delivery/putin' : `/api/agents/${encodeURIComponent(agentId)}/delivery`;
    const res = await api('PUT', path, payload);
    if (res.status === 401) {
      localStorage.removeItem('appPassword');
      paint();
      return;
    }
    if (res.status !== 200) {
      setMsg(root, kind, (res.data && res.data.error) || 'Не удалось сохранить', 'err');
      return;
    }
    delete drafts[draftId(agentId, kind)];
    if (key) key.value = '';
    if (clear) clear.checked = false;
    apply(root, kind, res.data);
    setMsg(root, kind, 'Сохранено', 'ok');
  }

  async function probe(root, agentId, kind) {
    const url = root.querySelector(`[data-delivery-url="${kind}"]`);
    const key = root.querySelector(`[data-delivery-key="${kind}"]`);
    const payload = {};
    if (url && url.value.trim()) payload.url = url.value.trim();
    if (key && key.value) payload.key = key.value;
    setMsg(root, kind, 'Проверяю…', '');
    const path = kind === 'putin' ? '/api/delivery/putin/test' : `/api/agents/${encodeURIComponent(agentId)}/delivery/test`;
    const res = await api('POST', path, payload);
    if (res.status === 401) {
      localStorage.removeItem('appPassword');
      paint();
      return;
    }
    if (res.status !== 200) {
      setMsg(root, kind, (res.data && res.data.error) || 'Не удалось проверить', 'err');
      return;
    }
    const data = res.data || {};
    if (data.error === 'timeout') setMsg(root, kind, 'Таймаут', 'err');
    else if (data.error === 'network_error') setMsg(root, kind, 'Нет связи', 'err');
    else setMsg(root, kind, `Ответ ${data.status}`, data.ok ? 'ok' : 'err');
  }

  let generation = 0;

  async function load(root, agentId, gen) {
    const agentRes = await api('GET', `/api/agents/${encodeURIComponent(agentId)}/delivery`);
    if (gen !== generation || !root.isConnected) return;
    if (agentRes.status === 401) {
      localStorage.removeItem('appPassword');
      paint();
      return;
    }
    let putinRes = null;
    if (agentId === 'grok') {
      putinRes = await api('GET', '/api/delivery/putin');
      if (gen !== generation || !root.isConnected) return;
    }
    if (agentRes.status !== 200) {
      setMsg(root, 'agent', (agentRes.data && agentRes.data.error) || 'Не удалось прочитать доставку', 'err');
      return;
    }
    apply(root, 'agent', agentRes.data);
    if (!putinRes) return;
    if (putinRes.status !== 200) {
      setMsg(root, 'putin', (putinRes.data && putinRes.data.error) || 'Не удалось прочитать общий вебхук', 'err');
      return;
    }
    apply(root, 'putin', putinRes.data);
  }

  function paint() {
    const panel = document.getElementById('panel');
    if (!panel || !panel.classList.contains('open')) return;
    const agentId = panel.dataset.agent;
    const body = panel.querySelector('.p-body');
    if (!agentId || !body) return;
    const locked = password() ? '0' : '1';
    const existing = panel.querySelector('[data-delivery-root]');
    if (existing && existing.dataset.agent === agentId && existing.dataset.locked === locked) return;
    if (existing) existing.remove();
    const root = locked === '1' ? lockedView() : openView(agentId);
    root.dataset.deliveryRoot = '';
    root.dataset.agent = agentId;
    root.dataset.locked = locked;
    const status = body.querySelector('[data-anchor="status"]');
    if (status) status.insertAdjacentElement('afterend', root);
    else body.insertBefore(root, body.firstChild);
    if (locked === '0') {
      generation += 1;
      load(root, agentId, generation);
    }
  }

  function mount() {
    const panel = document.getElementById('panel');
    if (!panel || panel.dataset.deliveryBound) return;
    panel.dataset.deliveryBound = '1';
    let scheduled = false;
    const kick = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        paint();
      });
    };
    const observer = new MutationObserver(kick);
    observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-agent'] });
    document.addEventListener('submit', (event) => {
      if (event.target && event.target.id === 'pwForm') setTimeout(kick, 30);
    });
    kick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
