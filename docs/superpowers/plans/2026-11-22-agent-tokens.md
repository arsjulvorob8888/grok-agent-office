# Личные токены агентов — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У каждого агента свой токен в заголовке `x-agent-token`. В базе только SHA-256, общий `AGENT_TOKEN` работает лишь пока свой токен не выпущен.

**Architecture:** Правила выпуска и сверки живут в `lib/agent-tokens.js` (`timingSafeEqual`, без хранения сырого токена). Postgres — миграция 9 в `lib/store.js`. `server.js` подключает проверку к уже существующим маршрутам агентов и добавляет выпуск/отзыв по паролю штаба. Окно — `public/js/agent-tokens.js`, наблюдатель панели, как блок доставки.

**Tech Stack:** Node.js 18, Express 4, `node:crypto`, `pg`, `node --test`, Puppeteer.

## Global Constraints

- Сырой токен не пишется в базу, в `GET /api/state`, в лог и в репозиторий.
- Сравнение секрета и хеша — за постоянное время.
- Чужой `agentId` с чужим живым токеном — `403`. Неизвестный и отозванный — `401`.
- Общий `AGENT_TOKEN` принимается, только если у этого агента нет живого личного токена.
- Выпуск и отзыв — только с `x-app-password`. Без пароля — `401`.
- Не менять `lib/poryadok-sync.js`, `test/poryadok-sync.test.js` и вызовы синхронизации с «Порядком».
- В `main` не вливать: черновой PR.

---

### Task 1: Падающие тесты

**Files:**
- Create: `docs/specs/agent-tokens.md`
- Test: `test/agent-tokens.test.js`

- [ ] **Step 1:** Спека: хеш, 403, 401, отзыв, переходный режим, тишина в `/api/state` и в логах.
- [ ] **Step 2:** Тесты на эти случаи. `POST /api/agent-tokens` ещё нет — прогон красный.

### Task 2: Хеш и миграция 9

**Files:**
- Create: `lib/agent-tokens.js`
- Modify: `lib/store.js`

- [ ] **Step 1:** `issue` кладёт в память только `tokenHash`, сырой токен возвращает один раз.
- [ ] **Step 2:** Таблица `agent_tokens` после миграций 7 и 8. Запись и чтение без колонки токена.

### Task 3: Проверка заголовка и админка

**Files:**
- Modify: `server.js`
- Modify: `public/js/agent-tokens.js`, `public/css/agent-tokens.css`, `public/index.html`
- Test: `test/agent-tokens-browser.test.js`

- [ ] **Step 1:** `requireAgentToken` и совместный пароль/токен сверяют личный токен с агентом запроса.
- [ ] **Step 2:** `POST /api/agent-tokens` и `POST /api/agent-tokens/:agentId/revoke`.
- [ ] **Step 3:** В панели после входа — «Выпустить токены», копирование, «Отозвать».

### Task 4: Документы

**Files:**
- Modify: `docs/agent-reply-api.md`, `docs/specs/postgres-store.md`, `README.md`

- [ ] **Step 1:** Откуда агент берёт токен и как общий секрет уступает личному.
- [ ] **Step 2:** `npm test` зелёный. Черновой PR, дождаться CI, в `main` не вливать.
