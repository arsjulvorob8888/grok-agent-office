/* Личные токены в окне агента. Пароль — тот же, что у штаба.
   Сырой токен остаётся только на этой странице, пока её не перезагрузят. */
(function () {
  'use strict';

  const WARNING = 'Токен показывается один раз. Повторно его не увидеть. Старые токены этого агента отозваны.';
  const revealed = [];
  let notice = '';

  function password() {
    try { return localStorage.getItem('appPassword') || ''; } catch (_) { return ''; }
  }

  async function copyToken(button, token) {
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(token);
        copied = true;
      }
    } catch (_) { copied = false; }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = token;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
      area.remove();
    }
    button.textContent = copied ? 'Скопировано' : 'Не скопировано';
  }

  function renderRevealed(list) {
    list.replaceChildren();
    for (const item of revealed) {
      const row = document.createElement('li');
      row.className = 'agent-token-row';
      const name = document.createElement('span');
      name.className = 'agent-token-name';
      name.textContent = item.name || item.agentId;
      const input = document.createElement('textarea');
      input.readOnly = true;
      input.rows = 2;
      input.className = 'agent-token-value';
      input.dataset.tokenValue = '';
      input.value = item.token;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `Токен ${item.name || item.agentId}`);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn ghost';
      copy.dataset.tokenCopy = '';
      copy.textContent = 'Копировать';
      copy.addEventListener('click', () => copyToken(copy, item.token));
      const top = document.createElement('div');
      top.className = 'agent-token-top';
      top.append(name, copy);
      row.append(top, input);
      list.append(row);
    }
  }

  function paintRoot(root) {
    const warn = root.querySelector('[data-token-warn]');
    const list = root.querySelector('[data-token-list]');
    const msg = root.querySelector('[data-token-msg]');
    if (revealed.length) {
      warn.hidden = false;
      warn.textContent = WARNING;
      renderRevealed(list);
    } else {
      warn.hidden = true;
      list.replaceChildren();
    }
    if (msg) msg.textContent = notice;
  }

  function openView(agentId) {
    const root = document.createElement('section');
    root.className = 'sec agent-tokens';
    root.dataset.agentTokens = '';
    root.dataset.agent = agentId;
    root.dataset.locked = '0';
    const title = document.createElement('h4');
    title.textContent = 'Токены агентов';
    const hint = document.createElement('p');
    hint.className = 'agent-token-hint';
    hint.textContent = 'Передайте токен агенту сами. В репозиторий и в логи он не попадает.';
    const actions = document.createElement('div');
    actions.className = 'agent-token-actions';
    const scope = document.createElement('select');
    scope.dataset.tokenScope = '';
    scope.setAttribute('aria-label', 'Кому выпустить токены');
    const one = document.createElement('option');
    one.value = 'one';
    one.textContent = 'Только выбранный агент';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'Все агенты ростера';
    scope.append(one, all);
    const issue = document.createElement('button');
    issue.type = 'button';
    issue.className = 'btn gold';
    issue.dataset.tokenIssue = '';
    issue.textContent = 'Выпустить токены';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn ghost';
    revoke.dataset.tokenRevoke = '';
    revoke.textContent = 'Отозвать';
    actions.append(scope, issue, revoke);
    const warn = document.createElement('p');
    warn.className = 'agent-token-warn';
    warn.dataset.tokenWarn = '';
    warn.hidden = true;
    const list = document.createElement('ul');
    list.className = 'agent-token-list';
    list.dataset.tokenList = '';
    const msg = document.createElement('p');
    msg.className = 'agent-token-hint';
    msg.dataset.tokenMsg = '';
    root.append(title, hint, actions, warn, list, msg);
    issue.addEventListener('click', () => issueTokens(root, agentId));
    revoke.addEventListener('click', () => revokeToken(root, agentId));
    paintRoot(root);
    return root;
  }

  async function issueTokens(root, agentId) {
    const scope = root.querySelector('[data-token-scope]');
    const msg = root.querySelector('[data-token-msg]');
    const all = scope && scope.value === 'all';
    if (all && !window.confirm('Выпустить новые токены всем агентам ростера? Прежние личные токены этих агентов перестанут работать.')) {
      return;
    }
    notice = '';
    msg.textContent = '';
    const res = await fetch('/api/agent-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password() },
      body: JSON.stringify(all ? {} : { agentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      try { localStorage.removeItem('appPassword'); } catch (_) { /* уже пусто */ }
      paint();
      return;
    }
    if (!res.ok || !Array.isArray(data.tokens)) {
      msg.textContent = (data && data.error) || 'Не удалось выпустить токены';
      return;
    }
    const freshIds = new Set(data.tokens.map((item) => item.agentId));
    for (let i = revealed.length - 1; i >= 0; i -= 1) {
      if (freshIds.has(revealed[i].agentId)) revealed.splice(i, 1);
    }
    revealed.push(...data.tokens);
    notice = '';
    paintRoot(root);
  }

  async function revokeToken(root, agentId) {
    const msg = root.querySelector('[data-token-msg]');
    const res = await fetch(`/api/agent-tokens/${encodeURIComponent(agentId)}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password() },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      try { localStorage.removeItem('appPassword'); } catch (_) { /* уже пусто */ }
      paint();
      return;
    }
    if (!res.ok) {
      notice = (data && data.error) || 'Не удалось отозвать токен';
      if (msg) msg.textContent = notice;
      return;
    }
    for (let i = revealed.length - 1; i >= 0; i -= 1) {
      if (revealed[i].agentId === agentId) revealed.splice(i, 1);
    }
    notice = 'Токен отозван';
    paintRoot(root);
  }

  let painting = false;

  function paint() {
    if (painting) return;
    const panel = document.getElementById('panel');
    if (!panel || !panel.classList.contains('open')) return;
    const agentId = panel.dataset.agent;
    const body = panel.querySelector('.p-body');
    if (!agentId || !body) return;
    const locked = password() ? '0' : '1';
    const existing = panel.querySelector('[data-agent-tokens]');
    if (locked === '1') {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.dataset.agent === agentId && existing.dataset.locked === '0') return;
    painting = true;
    try {
      if (existing) existing.remove();
      const root = openView(agentId);
      body.insertBefore(root, body.firstChild);
    } finally {
      painting = false;
    }
  }

  function mount() {
    const panel = document.getElementById('panel');
    if (!panel || panel.dataset.tokensBound) return;
    panel.dataset.tokensBound = '1';
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
