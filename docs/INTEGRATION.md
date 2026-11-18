# Интеграция на целевой машине: GigaCode, onework, sourcecontrol

Всё остальное (UI, оркестрация, доска, git, терминалы) уже работает и покрыто тестами на моках
(`npm test`). Факты о GigaCode и MCP-серверах уже реализованы по `docs/GIGACODE-FACTS.md`.
Осталось **проверить их вживую** и заполнить локальную конфигурацию. У каждой части свой шов:

| Что | Код (если что-то нужно поправить) | Конфиг | Как проверить |
|---|---|---|---|
| GigaCode CLI | `server/launchers.js` (лаунчер `gigacode`) | `agents.gigacode.*` | `--print-config`, чат в UI |
| Задачи из onework | `server/integrations/tasks.js` (`format: "onework-markdown"`) | `integrations.tasks.*` | "Sync" на доске |
| PR в sourcecontrol | `server/integrations/pr.js` | `integrations.pr.*` | "Create PR" на панели Changes |

Правила: не редактируйте `harness.config.json`; настройки конкретной машины кладите в `harness.config.local.json` (в gitignore)
или правьте их на экране "Settings". Секреты — только в файле секретов (`CONSOLE_MCP_SECRETS` / `HARNESS_MCP_SECRETS`;
формат: строки `server/Name=value` или одно голое значение = `onework/Authorization`). Внутренние имена хостов и коды проектов
— только в локальном конфиге, не в репозитории.

## 0. Подготовка

```powershell
node -v                      # >= 22
npm install                  # through the internal npm mirror
npm test; npm run build      # everything green
node server/index.js --print-config
```
`--print-config` показывает найденные `node.exe` / `cli-entry.js` GigaCode, MCP-серверы (из `~/.gigacode/settings.json`)
и какие секреты есть (только имена).

## 1. Фикстуры: замените реконструкции настоящими образцами

`test/fixtures/gigacode.*`, `onework.*`, `sourcecontrol.*` реконструированы по фактам (см. `test/fixtures/README.md`).
Если у вас есть папка с сырыми образцами (`…\IdeaProjects\.gigacode-facts\`), скопируйте подходящие файлы в `test/fixtures/`
(замаскировав внутренние хосты, логины и коды проектов) и запустите `npm test`. Если тест падает, реальный формат отличается от
реконструкции: исправляйте нормализатор в `server/launchers.js` (поток) или парсеры в `server/integrations/tasks.js`
(markdown из onework), пока тесты не позеленеют. Ожидаемые значения в тестах можно менять только под реальные данные.

## 2. GigaCode

0. **Авторизация.** При первом запуске GigaCode просит войти через браузер/по ссылке. Settings → "Sign in to
   GigaCode" открывает интерактивный GigaCode во вкладке терминала (ссылки кликабельны). Проверьте и запишите в `docs/GIGACODE-FACTS.md`:
   что печатает headless `-p` без входа (stdout или stderr, формат ссылки/кода, ждёт ли входа
   или завершается) и где хранится вход. Харнес находит ссылку в потоке (`phase: 'auth'`, карточка со
   ссылкой в чате, таймаут приостанавливается до `authTimeoutMs`); если реальный формат не распознаётся, исправьте
   регулярное выражение в `server/runner.js` / `launchers.js` и тест с моком `#auth`.
1. `agents.gigacode.command` = `C:/Program Files/.gigacode/bin/gigacode.cmd` (по умолчанию). Харнес читает `ROOT=%~dp0..`
   и identity из shim и запускает `ROOT\runtime\node\node.exe --max-old-space-size=6144 ROOT\lib\cli-entry.js …`
   без оболочки. Если структура другая, задайте явную пару `agents.gigacode.node` + `agents.gigacode.cliEntry`.
2. Модели: каталог берётся из самого GigaCode (`-p "/models"`, кнопка "Refresh model list" в выборе
   и в Settings). Проверьте, что поиск нашёл все модели (сравните с `/models` в интерактивном режиме); если
   формат вывода не распознан, задайте регулярное выражение `agents.gigacode.modelsDiscovery.pattern` в локальном конфиге
   (без изменений кода) или исправьте парсер и его тест. Выберите грейды (`default/fast/review/explore`) в Settings,
   как в старой консоли. При переименовании моделей ничего переписывать не нужно: старые становятся "unavailable", грейды
   без модели откатываются к значению CLI по умолчанию, а Settings показывает предупреждение.
3. Проверьте в UI: New chat → GigaCode → "Hi, which MCP tools do you have?". Ожидается:
   - пока CLI запускается (30–60 с), чат показывает "Starting… waiting for MCP";
   - строка "MCP: …" со статусами серверов;
   - инструменты `harness` (`task_list`, `worker_start`, …) входят в инструменты агента;
   - второе сообщение продолжает ту же сессию (`--resume`): агент помнит контекст.
4. **Слияние `mcpServers`** (не подтверждено): если агент видит `harness`, но НЕ видит onework/sourcecontrol (или наоборот),
   CLI заменяет `mcpServers` из файла запуска. Включите `agents.gigacode.inheritUserMcp: true` (он копирует серверы пользователя
   в файл запуска рядом с `harness`) и проверьте снова.
5. Команда задачи: по умолчанию не задана — агент получает задачу текстом. Своя команда (например `/full-task`,
   `~/.gigacode/commands/full-task.md`) задаётся в мастере первого запуска («Есть ли у вас своя команда для задач?» → «Есть»)
   и попадает в `harness.config.local.json`. Если нужен `/full-task-ui` из старой консоли, скопируйте её
   `commands/full-task-ui.md` в `~/.gigacode/commands/` и измените шаблон. Слеш-команда всегда идёт
   первым словом промпта, а преамбула харнеса следует за ней (в команду она попадает как часть `$ARGUMENTS`).
6. Проверки ошибок: несуществующая модель в настройках сессии должна давать красную ошибку с текстом из stderr; неверный путь
   к shim должен давать понятную ошибку запуска, а не зависание.

## 3. Задачи из onework

1. Сервер `onework` берётся из `~/.gigacode/settings.json` (`mcpServersFrom`); секрет `Authorization` берётся
   из файла секретов. Проверка: `node scripts/mcp-call.js onework --list`.
2. Локально: `integrations.tasks.enabled: true`, `space` = код пространства (например, то, что стоит до `-` в ключах задач),
   `urlTemplate` = `https://<tracker-host>/swtr/units/all/unit/{key}`, при необходимости `refreshSec` (≥ 10) и `statusMap`.
3. Сырой ответ вручную: `node scripts/mcp-call.js onework sbertrack_findIssues '{"space_code":"<SPACE>","assignee":"me","page_size":5}'`.
4. UI: "Sync" на доске → появляются назначенные вам задачи, без закрытых. Панель задачи загружает
   описание (`getIssue`) и список переходов трекера (`getIssueMeta`). Меняйте статус в трекере только на тестовой
   задаче: это запись в трекере.
5. Подзадачи по связям `decomposition` (`sbertrack_listLinks`) пока не импортируются автоматически; если они нужны, добавьте
   их в `importTasks()` (parentId) с тестом.

## 4. PR в sourcecontrol

1. `node scripts/mcp-call.js sourcecontrol --list`; секрет `SC_TOKEN` лежит в файле секретов или в env сервера.
2. `integrations.pr.enabled: true`. `project/repository` выводятся из `git remote get-url origin` (последние два сегмента).
3. В тестовой ветке: Changes → Push → "Create PR". Ожидается: диалог с предзаполненными заголовком/описанием (со счётчиками
   байт 100/512), ссылка на `html_url`. Повторное "Create PR" для той же ветки возвращает существующий PR и
   не создаёт второй (второй закрыл бы первый).

## 5. Ветки и релизы (сверьте с соглашениями команды)

- `git.defaultBase = develop`, ветка `feature/{key}`, заголовок коммита и PR `{key} {title}` (без двоеточия).
- Исправление в релизе: целевые ветки задачи — `["develop", "release/1.54.0"]` → работа делается в `feature/<KEY>`, а
  "Port to release/1.54.0" создаёт `feature/<KEY>-rel154` из ветки релиза и cherry-pick'ает только недостающие коммиты;
  конфликт разбирает отдельный агент. Один PR на каждую целевую ветку.
- Микросервисы: одна задача = один репозиторий; подзадачи с `workspaceId` для каждого репозитория; один ключ и одна ветка во всех.
  `workspaces.root` = папка с репозиториями (например, `C:/Users/<you>/IdeaProjects`), `repos` = список имён
  (пусто = все git-репозитории в папке).

## 6. Субагенты, вопросы, разрешения, ACP (построено на предположениях; проверить и исправить)

Ответьте вживую на "Open questions" в `docs/GIGACODE-FACTS.md` (сырые образцы — в `docs/target-machine/` или в
фикстуры) и исправляйте только швы:
- **Субагенты как чаты.** При значении по умолчанию `orchestration.subagents: "harness"` попросите GigaCode в чате: "start the
  repository-explorer sub-agent and find pom.xml". Ожидается: агент вызывает `mcp__harness__agent` и появляется отдельный дочерний чат.
  Если модель всё же вызывает встроенный `agent`, показывается чат субагента только для чтения (для этого нужен
  `parent_tool_use_id` в потоке; если его нет, исправьте нормализатор в `server/launchers.js`). Установите скилл
  `harness-orchestration` в Settings (с согласия пользователя). Если GigaCode поддерживает хуки, заполните
  `agents.gigacode.agentToolHook` (формат в `docs/ARCHITECTURE.md` → "Automatic: …"), чтобы встроенный `agent` надёжно блокировался.
- **Таймаут MCP.** Субагент `worker_run` может работать долго: проверьте, что вызов инструмента `harness` не падает по
  таймауту GigaCode (файл запуска задаёт `mcpServers.harness.timeout`; проверьте единицы измерения и учитывается ли `progress`).
- **Вопросы.** Найдите имя встроенного инструмента вопросов GigaCode → `agents.gigacode.questionTools`. Проверьте, что карточка с вариантами появляется.
- **Разрешения (headless).** В режиме "With confirmation" попросите команду, требующую разрешения → реальный текст отказа
  → `agents.gigacode.denialPattern`; карточка "Allow once" должна позволить агенту продолжить.
- **ACP.** Попробуйте `transport: "acp"` (Settings → GigaCode → Transport) в тестовом чате: потоковый вывод, запрос разрешения с
  ожидающим агентом, Stop, продолжение после перезапуска харнеса. Если `--acp` в GigaCode отличается от протокола, исправьте
  `server/acp.js` (тесты: `test/acp.test.js` + `scripts/mock-acp-agent.js`). Если ACP работает, решите вместе с пользователем, стоит ли
  сделать его режимом по умолчанию.
- **Восстановление.** Перезагрузите ПК (или убейте `node`, пока работает агент): после запуска появляется окно "Session recovery";
  "Continue selected" продолжает сессии с контекстом.
- **Linux** (если актуально): реальная структура установки GigaCode в Linux (`docs/ARCHITECTURE.md` → "Cross-platform").

## Готово, когда

- [ ] `npm test` и `npm run build` проходят; фикстуры заменены настоящими (или расхождения исправлены в парсерах).
- [ ] Чат с GigaCode отвечает, показывает инструменты и "MCP: …", а второе сообщение продолжает контекст.
- [ ] Чат с ролью "coordinator" создаёт задачи и запускает исполнителей (workers) через `worker_start`; у каждого исполнителя свой чат в
      боковой панели; отчёты (`worker_done`) будят координатора.
- [ ] "Take into work" на карточке задачи запускает `/full-task <url>` в новом рабочем дереве (worktree) `<repo>-worktrees/<KEY>`.
- [ ] "Sync" подтягивает ваши задачи из onework; описание и переходы загружаются в панели задачи.
- [ ] "Create PR" создаёт пулл-реквест (PR) в sourcecontrol и показывает ссылку; повтор не создаёт дубликат.
- [ ] Субагенты `/full-task` видны как отдельные чаты (харнес или только для чтения); на вопрос и разрешение можно ответить из UI.
- [ ] После перезапуска харнеса запущенные агенты продолжают работать; после перезагрузки ПК окно "Session recovery" их продолжает.
- [ ] Открытые вопросы в `docs/GIGACODE-FACTS.md` закрыты, а факты/фикстуры обновлены.
- [ ] Секреты лежат только в файле секретов; `git status` чист от локальных конфигов и `data/`.
