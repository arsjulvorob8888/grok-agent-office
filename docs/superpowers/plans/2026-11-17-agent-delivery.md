# Доставка вебхука агента — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В окне агента сотрудник с паролем штаба задаёт URL и ключ вебхука; очередь outbox шлёт событие сначала туда, иначе на общий вебхук Путина, иначе в `KREMLIN_WEBHOOK_URL`.

**Architecture:** Шифрование живёт в `lib/webhook-crypto.js` (AES-256-GCM, один IV на запись). Правила адреса и HTTP API — в `lib/delivery.js`. Postgres — миграция 6 в `lib/store.js`, в строке только base64 шифротекста. `server.js` только подключает маршруты и берёт адрес в `sendOutboxItem`. Окно рисует `public/js/delivery-panel.js`, не `app.js`.

**Tech Stack:** Node.js 18, Express 4, `node:crypto`, `pg`, существующий `node --test` и Puppeteer.

## Global Constraints

- Пароль персонала — заголовок `x-app-password` и `APP_PASSWORD`.
- Ключ API не возвращает: только `keySet` и `keyTail` (последние 4 символа).
- `WEBHOOK_SECRETS_KEY` — 32 байта base64. Нет ключа — сохранение не пишет ничего, ответ «Не задан WEBHOOK_SECRETS_KEY, вебхук не сохранён».
- Неверный ключ — «Ключ WEBHOOK_SECRETS_KEY не подходит, вебхук не прочитан». На запасной URL не переходим.
- Маршрут: агент → `putin` → `KREMLIN_WEBHOOK_URL` / `KREMLIN_WEBHOOK_KEY`. JSON в env не добавлять.
- Подписи только через `deliveryLabel` / `deliveryCaption`.
- В логах, `GET /api/state`, HTML и тестах нет боевых секретов. В тестах только фикстуры `fixture-*`.
- Не трогать `public/js/map.js`, `lib/activity.js`, `public/js/agent-dashboard.js`.
- В `main` не вливать.

---

### Task 1: Шифрование

**Files:**
- Create: `lib/webhook-crypto.js`
- Test: `test/delivery.test.js`

**Interfaces:**
- Produces: `seal(id, { url, key }, env) -> { iv, tag, ciphertext }`, `open(id, record, env) -> { url, key }`, `publicDelivery({ url, key }) -> { url, keySet, keyTail }`. Ошибки с `code`: `NO_SECRETS_KEY`, `BAD_KEY_LENGTH`, `BAD_SECRETS_KEY`.

- [ ] **Step 1:** Тест туда-обратно, разный IV, чужой ключ, короткая строка base64, отсутствие переменной, AAD другого id. В сообщении ошибки нет фикстуры.
- [ ] **Step 2:** `node --test test/delivery.test.js` падает, модуля нет.
- [ ] **Step 3:** Реализовать AES-256-GCM, IV 12 байт, тег 16 байт, AAD = id.
- [ ] **Step 4:** Тесты шифра зелёные.

### Task 2: Выбор адреса

**Files:**
- Create: `lib/delivery.js`
- Test: `test/delivery.test.js`

**Interfaces:**
- Consumes: `seal` / `open`.
- Produces: `resolveDestination(agentId, state, env) -> { url, key, via } | null`, `routeFor`, `saveDelivery`, `anyConfigured`. `PUTIN_ID = 'putin'`.

- [ ] **Step 1:** Тест агент → Путин → env → null. Битая запись не отдаёт env.
- [ ] **Step 2:** `saveDelivery` без ключа не вызывает `noteWebhookTarget` и не заполняет `state.webhookTargets`.
- [ ] **Step 3:** Прогнать тест, убедиться, что падает на отсутствии функций.
- [ ] **Step 4:** Реализовать и снова прогнать.

### Task 3: API, очередь и Postgres

**Files:**
- Modify: `server.js` (state.webhookTargets, register, sendOutboxItem, drainOutbox, retry)
- Modify: `lib/store.js` (миграция 6, note/load)
- Modify: `package.json` (скрипт test)
- Test: `test/delivery.test.js`

**Interfaces:**
- Consumes: `register(app, deps)`, `resolveDestination`, `anyConfigured`.
- Produces: `GET/PUT /api/agents/:id/delivery`, `POST .../test`, `GET/PUT /api/delivery/putin`, `POST /api/delivery/putin/test`.

- [ ] **Step 1:** Тесты HTTP: 401, ответ без ключа, проверка на локальном сервере (`type=test`), маршрут задачи агент → Путин → env, 503 без ключа шифра, подпись `deliveryLabel`.
- [ ] **Step 2:** Прогнать и увидеть 404.
- [ ] **Step 3:** Подключить маршруты и адрес в outbox. Таблица `webhook_targets`.
- [ ] **Step 4:** Тест с `DATABASE_URL` пропускается, если переменной нет. С переменной — шифротекст в SQL и чтение после нового процесса.
- [ ] **Step 5:** `node --test test/delivery.test.js` зелёный.

### Task 4: Окно

**Files:**
- Create: `public/js/delivery-panel.js`, `public/css/delivery.css`
- Modify: `public/index.html` (css и script после `app.js`)
- Test: `test/delivery-browser.test.js`

- [ ] **Step 1:** Браузерный тест: без пароля нет URL в HTML; с паролем поле ключа `type=password` и пустое; «Проверить» показывает «Ответ 200»; у Путина два заголовка.
- [ ] **Step 2:** Убедиться, что селектор блока отсутствует.
- [ ] **Step 3:** Нарисовать блок наблюдателем `#panel`.
- [ ] **Step 4:** Скриншоты 1280 и 390 в `/opt/cursor/artifacts`.

### Task 5: Документы и полный прогон

**Files:**
- Modify: `README.md`, `render.yaml`, `docs/specs/postgres-store.md`, `docs/specs/webhook-outbox.md`

- [ ] **Step 1:** Описать переменную, маршруты и порядок адреса.
- [ ] **Step 2:** `npm test` без падений.
- [ ] **Step 3:** Черновой PR, в `main` не вливать.
