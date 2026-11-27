# AGENTS.md: инструкции для кодовых агентов, работающих с этим репозиторием

Локальная лёгкая IDE для кодовых агентов и задач: чаты с агентами, оркестрация (координатор запускает
исполнителей (workers), и у каждого исполнителя свой чат), канбан-доска, доска агентов, терминалы (PowerShell / интерактивный
CLI) с историей, файлы, диффы, коммиты и пулл-реквесты (PR). Всё работает локально на `127.0.0.1`, без CDN и телеметрии.

## Команды

```bash
npm install          # dependencies
npm run build        # build the UI into web/dist
npm start            # server + UI at http://127.0.0.1:4777
npm run desktop      # the same UI in a window of its own (Electron): no browser tab
npm run dev          # same, with Vite hot reload of the UI
npm test             # node:test, all tests must stay green
npm run test:web     # UI logic tests (web/src/**/*.test.ts; --experimental-strip-types for Node 22)
npm run typecheck    # UI types
```

Демо без GigaCode: в UI создайте чат с агентом `mock` (см. `scripts/mock-agent.js`;
директивы `#spawn`, `#done`, `#ask` в сообщении запускают оркестрацию).

Ярлык `start-harness.cmd` открывает окно приложения. Работающий на 4777 харнес не останавливается: окно берёт первый
свободный порт и, если каталог данных занят, свой (`data/<slug>-<port>`). Подробности — `README.md`, раздел «Окно вместо браузера».

**Начните с [`docs/HANDOFF.md`](docs/HANDOFF.md)**: что сделано, как работают ключевые сценарии, что
проверено, а что нет.

## Где что лежит

| Что | Где |
|---|---|
| Контракт: формы данных, REST, WS, инструменты агентов | `docs/ARCHITECTURE.md` (держите в синхроне при изменении форм). Руководство пользователя (на русском): `docs/GUIDE.md` |
| **Всё, что специфично для CLI агента** (argv, env, настройки, разбор stream-json) | `server/launchers.js`. Это единственный такой файл |
| Выполнение одного хода агента (запуск без оболочки, NDJSON, таймауты, остановка) | `server/runner.js` |
| Сессии, очередь сообщений, пробуждение агентов, терминалы | `server/sessions.js` |
| Оркестрация (инструменты для агентов, преамбулы, worker_done) | `server/orchestration.js`, `mcp/harness-mcp.js` |
| Задачи, порядок, зависимости | `server/tasks.js` |
| **Импорт задач из внешнего трекера** | `server/integrations/tasks.js` + `integrations.tasks` в конфиге |
| **Создание PR во внешнем хостинге кода** | `server/integrations/pr.js` + `integrations.pr` в конфиге |
| MCP-клиент, используемый самим харнесом (stdio/http, таймауты, секреты) | `server/mcp-client.js` |
| Git / файлы | `server/git.js`, `server/fs.js` |
| UI | `web/src/` (React + Vite + TS) |
| Окно приложения вместо браузера (`npm run desktop`) | `scripts/desktop.js` (запуск: сервер под Node либо окно Electron), `scripts/desktop-app.js` (порт, каталог данных, старт сервера, окно) |
| Протокол оркестрации для агентов | `skills/harness-orchestration/SKILL.md` |
| Моки для GigaCode и MCP | `scripts/mock-agent.js`, `scripts/mock-mcp.js` |
| Ручной вызов MCP-сервера (инструменты, сырые ответы) | `node scripts/mcp-call.js <server> --list` / `<tool> '<json>'` |
| Проверка запуска GigaCode в ACP без харнеса (время initialize / session/new / хода) | `node scripts/acp-probe.js [--cwd <dir>] [--settings data/runs/<id>/settings.json] [--prompt "…"]` |
| Факты о GigaCode/onework/sourcecontrol на целевой машине | `docs/GIGACODE-FACTS.md`, фикстуры `test/fixtures/` |

## Правила

1. Интеграция GigaCode и внешних MCP-сервисов: следуйте **`docs/INTEGRATION.md`** шаг за шагом.
   Код, специфичный для CLI, — только в `server/launchers.js`, код, специфичный для сервиса, — только в `server/integrations/`.
2. Не редактируйте `harness.config.json` ради настроек конкретной машины: используйте `harness.config.local.json`
   (в gitignore). Секреты — только в файле секретов (`CONSOLE_MCP_SECRETS` / `HARNESS_MCP_SECRETS` / `mcpSecretsFile`),
   никогда в репозитории. Внутренние имена хостов и коды проектов — тоже только в локальном конфиге.
3. CLI агентов запускаются без оболочки (`shell: false`), а промпт передаётся отдельным элементом argv.
4. Сам харнес ничего не отправляет в сеть: никаких CDN, шрифтов, аналитики и проверок обновлений.
5. Субагенты создаются только через оркестрацию харнеса (`worker_start`), никогда через встроенные субагенты CLI.
6. Любое изменение разбора потока поставляется с фикстурой реального вывода в `test/fixtures/` и тестом.
7. Перед коммитом: `npm test` и `npm run build` должны проходить.
8. Ручной вызов API харнеса в Windows: отправляйте UTF-8. `Invoke-RestMethod` в Windows PowerShell 5.1 со строковым телом
   превращает кириллицу в «?» (сервер отклоняет такой текст с 400): используйте `-ContentType "application/json; charset=utf-8"
   -Body ([Text.Encoding]::UTF8.GetBytes($json))` или `node mcp/harness-mcp.js call ...`.
9. Документация проекта — на русском.
