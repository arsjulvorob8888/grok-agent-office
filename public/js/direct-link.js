/* «Служебное» под кнопкой ключа: адрес и ключ каждого агента.
   Ключ в поле не возвращается. После сохранения видно только «ключ сохранён». */
(function () {
  'use strict';

  let generation = 0;
  let loaded = false;

  function password() {
    try { return localStorage.getItem('appPassword') || ''; } catch (_) { return ''; }
  }

  function lineOf(agent) {
    if (window.OfficeFeed && typeof OfficeFeed.directLinkLine === 'function') {
      return OfficeFeed.directLinkLine(agent);
    }
    return '';
  }

  function titleOf(agent) {
    const name = agent.name || agent.id;
    if (!agent.number) return name;
    const num = String(agent.number).includes('.') ? String(agent.number) : `${agent.number}.`;
    return `${num} ${name}`;
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

  function panel() {
    return document.getElementById('serviceDelivery');
  }

  function body() {
    return document.getElementById('serviceDelivery');
  }

  function shown() {
    const pop = document.getElementById('servicePop');
    const fold = document.getElementById('serviceFold');
    return !!(pop && !pop.hidden && fold && fold.open && panel());
  }

  function lockForm() {
    const form = document.createElement('form');
    form.className = 'service-lock';
    form.id = 'servicePw';
    const label = document.createElement('label');
    label.htmlFor = 'servicePwInput';
    label.textContent = 'Пароль';
    const input = document.createElement('input');
    input.id = 'servicePwInput';
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Пароль';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn gold';
    submit.textContent = 'Войти';
    form.append(label, input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      try { localStorage.setItem('appPassword', value); } catch (_) { return; }
      loaded = false;
      load();
    });
    return form;
  }

  function showLock(error) {
    loaded = false;
    const root = body();
    if (!root) return;
    root.replaceChildren();
    if (error) {
      const msg = document.createElement('p');
      msg.className = 'direct-msg err';
      msg.textContent = error;
      root.append(msg);
    }
    root.append(lockForm());
  }

  function noteOf(row, text, tone) {
    const msg = row.querySelector('[data-direct-msg]');
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = `direct-msg${tone ? ` ${tone}` : ''}`;
  }

  function applyView(row, data) {
    const agentId = row.dataset.agent;
    const status = row.querySelector('[data-direct-status]');
    const agent = { id: agentId, deliveryRoute: data && data.route, linkCheck: data && data.linkCheck };
    if (status) {
      status.textContent = lineOf(agent);
      status.dataset.phase = window.OfficeFeed && OfficeFeed.directLinkPhase ? OfficeFeed.directLinkPhase(agent) : '';
    }
    const url = row.querySelector('[data-direct-url]');
    if (url && document.activeElement !== url) url.value = (data && data.url) || '';
    const key = row.querySelector('[data-direct-key]');
    if (key) key.value = '';
    const saved = row.querySelector('[data-direct-saved]');
    if (saved) saved.textContent = data && data.keySet ? 'ключ сохранён' : '';
  }

  function rowOf(agent, data) {
    const row = document.createElement('section');
    row.className = 'direct-row';
    row.dataset.directRow = '';
    row.dataset.agent = agent.id;
    const heading = document.createElement('h4');
    heading.textContent = titleOf(agent);
    const status = document.createElement('p');
    status.className = 'direct-note';
    status.dataset.directStatus = '';
    const urlLabel = document.createElement('label');
    urlLabel.textContent = 'Адрес';
    const url = document.createElement('input');
    url.type = 'url';
    url.autocomplete = 'off';
    url.spellcheck = false;
    url.dataset.directUrl = '';
    urlLabel.append(url);
    const keyLabel = document.createElement('label');
    keyLabel.textContent = 'Ключ';
    const key = document.createElement('input');
    key.type = 'password';
    key.autocomplete = 'new-password';
    key.spellcheck = false;
    key.dataset.directKey = '';
    keyLabel.append(key);
    const saved = document.createElement('p');
    saved.className = 'direct-note';
    saved.dataset.directSaved = '';
    const actions = document.createElement('div');
    actions.className = 'direct-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn gold';
    saveBtn.dataset.directSave = '';
    saveBtn.textContent = 'Сохранить';
    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'btn ghost';
    checkBtn.dataset.directCheck = '';
    checkBtn.textContent = 'Проверить ещё раз';
    actions.append(saveBtn, checkBtn);
    const msg = document.createElement('p');
    msg.className = 'direct-msg';
    msg.dataset.directMsg = '';
    msg.setAttribute('aria-live', 'polite');
    row.append(heading, status, urlLabel, url, keyLabel, key, saved, actions, msg);
    applyView(row, data);
    return row;
  }

  async function save(row) {
    const url = row.querySelector('[data-direct-url]');
    const key = row.querySelector('[data-direct-key]');
    const payload = { url: url ? url.value.trim() : '' };
    if (key && key.value) payload.key = key.value;
    noteOf(row, 'Сохраняю…', '');
    const res = await api('PUT', `/api/agents/${encodeURIComponent(row.dataset.agent)}/delivery`, payload);
    if (res.status === 401) {
      showLock('Неверный пароль');
      return;
    }
    if (res.status !== 200) {
      noteOf(row, (res.data && res.data.error) || 'Не удалось сохранить', 'err');
      return;
    }
    applyView(row, res.data);
    noteOf(row, 'Сохранено', 'ok');
  }

  async function check(row) {
    const url = row.querySelector('[data-direct-url]');
    const key = row.querySelector('[data-direct-key]');
    const payload = {};
    if (url && url.value.trim()) payload.url = url.value.trim();
    if (key && key.value) payload.key = key.value;
    noteOf(row, 'Проверяю…', '');
    const res = await api('POST', `/api/agents/${encodeURIComponent(row.dataset.agent)}/delivery/test`, payload);
    if (res.status === 401) {
      showLock('Неверный пароль');
      return;
    }
    if (res.status === 200) {
      applyView(row, res.data || {});
      noteOf(row, '', '');
      return;
    }
    noteOf(row, (res.data && res.data.error) || 'адрес не отвечает', 'err');
  }

  function render(views) {
    const root = body();
    if (!root) return;
    root.replaceChildren();
    for (const view of views) {
      const data = view.res.status === 200 ? view.res.data : { route: view.agent.deliveryRoute, url: '', keySet: false };
      const row = rowOf(view.agent, data);
      if (view.res.status !== 200) noteOf(row, (view.res.data && view.res.data.error) || 'Не удалось прочитать', 'err');
      root.append(row);
    }
  }

  function onClick(event) {
    const saveBtn = event.target.closest('[data-direct-save]');
    const checkBtn = event.target.closest('[data-direct-check]');
    const row = event.target.closest('[data-direct-row]');
    if (!row) return;
    if (saveBtn) save(row);
    else if (checkBtn) check(row);
  }

  async function load() {
    const gen = ++generation;
    const root = body();
    if (!root) return;
    if (!password()) {
      showLock('');
      return;
    }
    root.textContent = 'Загружаю…';
    const stateRes = await fetch('/api/state', { cache: 'no-store' });
    if (gen !== generation || !shown()) return;
    if (!stateRes.ok) {
      root.textContent = 'Не удалось прочитать агентов';
      return;
    }
    const state = await stateRes.json();
    const agents = window.OfficeFeed && typeof OfficeFeed.serviceAgents === 'function'
      ? OfficeFeed.serviceAgents(state.agents)
      : (state.agents || []).filter((agent) => agent && !agent.archived && !agent.vacant);
    const views = await Promise.all(agents.map(async (agent) => ({
      agent,
      res: await api('GET', `/api/agents/${encodeURIComponent(agent.id)}/delivery`),
    })));
    if (gen !== generation || !shown()) return;
    if (views.some((view) => view.res.status === 401)) {
      try { localStorage.removeItem('appPassword'); } catch (_) { /* уже стёрт */ }
      showLock('Неверный пароль');
      return;
    }
    render(views);
    loaded = true;
  }

  function refresh() {
    if (!shown()) return;
    if (!password()) {
      showLock('');
      return;
    }
    if (!loaded) load();
  }

  function mount() {
    const list = panel();
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
    list.addEventListener('click', onClick);
    const fold = document.getElementById('serviceFold');
    if (fold) fold.addEventListener('toggle', () => refresh());
    document.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('#btnKey, #serviceFold summary, #servicePassword')) {
        setTimeout(refresh, 0);
      }
    });
    document.addEventListener('submit', (event) => {
      if (event.target && event.target.id === 'pwForm') setTimeout(() => { loaded = false; refresh(); }, 30);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.DirectLink = { refresh };
})();
