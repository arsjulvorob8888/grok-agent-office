# Дашборд агента — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Раскрыть панель агента в полноэкранный дашборд со ссылкой в hash, задачами, честной аналитикой и перепиской.

**Architecture:** Расчёт ответа живёт в `lib/agent-dashboard.js` и не ходит в сеть. `server.js` отдаёт `GET /api/agents/:id/dashboard` и принимает смену статуса тем же паролем, что `POST /api/task`. Экран — `public/js/agent-dashboard.js` и `public/css/agent-dashboard.css`, панель карты не переписывается: кнопка «Развернуть» добавляется наблюдателем.

**Tech Stack:** Node.js, Express, существующий `node --test`, Puppeteer, inline SVG. Без новых npm-зависимостей и без миграции Postgres.

## Global Constraints

- Идентификатор `fromAgentId: "owner"` не переименовывать.
- Не менять карту, ленту аватарок и текущие тесты.
- Не писать секреты в код и логи.
- Не трогать outbox. Подпись доставки: `OfficeFeed.deliveryCaption`, если функция есть, иначе те же слова в `deliveryLabel`.
- Пустые метрики — пустое состояние, не выдуманные нули и проценты.
- Анимация разворота 250 мс, при `prefers-reduced-motion` без перехода.
- Телефон: 390px, вкладки снизу, без горизонтальной прокрутки.

---

### Task 1: Расчёт дашборда

**Files:**
- Create: `lib/agent-dashboard.js`
- Test: `test/agent-dashboard.test.js`

**Interfaces:**
- Produces: `deliveryLabel(forwardStatus) -> string`
- Produces: `buildDashboard({ agent, tasks, messages, activity, now }) -> object` с полями `agent`, `metrics`, `tasks`, `activityLog`, `analytics`, `messages`

- [ ] Написать тест на пустой ответ, 14 дней по Москве, среднее время, долю доставки и уровень.
- [ ] Убедиться, что тест падает: модуля нет.
- [ ] Реализовать функции.
- [ ] Прогнать `node --test test/agent-dashboard.test.js`.

### Task 2: Маршруты

**Files:**
- Modify: `server.js` (два маршрута рядом с `/api/agents/:id/tasks`)
- Test: `test/agent-dashboard.test.js`

**Interfaces:**
- `GET /api/agents/:id/dashboard` — 200 или 404
- `POST /api/agents/:id/orders/:orderId` — пароль штаба, тело как у `POST /api/orders/:id`

- [ ] Тест: неизвестный агент 404, задача после `POST /api/task` в колонке `new`, смена статуса без пароля 401, `sent` → `accepted` с паролем, `sent` → `in_progress` 400.
- [ ] Убедиться, что маршрутов ещё нет (404 на GET).
- [ ] Подключить `buildDashboard` и `requireAppPassword`.

### Task 3: Экран

**Files:**
- Create: `public/js/agent-dashboard.js`
- Create: `public/css/agent-dashboard.css`
- Modify: `public/index.html` (css, `#agentDash`, script)
- Modify: `package.json` (скрипт `test`)
- Test: `test/agent-dashboard-browser.test.js`

- [ ] Кнопка «Развернуть», hash, вкладки, Esc, «Свернуть», Enter в чате, канбан.
- [ ] Браузерный тест на 390px: нет горизонтальной прокрутки, `aria-selected`, история «Назад».

### Task 4: Проверка

- [ ] `npm test`
- [ ] Скриншоты вкладок на 1280 и 390 в артефакты.
- [ ] Черновой PR, без вливания в `main`.
