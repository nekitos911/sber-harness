# GigaCode и MCP: факты с целевой машины

Собраны живыми запусками на целевой машине (GigaCode 26.10.x). Сырые образцы лежат в `test/fixtures/` (реконструированы и
обезличены: коды проектов, имена хостов, логины и секреты заменены). Если у вас есть сырая папка `.gigacode-facts/`,
замените реконструированные фикстуры ею и держите тесты зелёными.

## 1. Запуск

- Корень установки `ROOT = C:\Program Files\.gigacode`: `bin\gigacode.cmd` (shim), `runtime\node\node.exe` (встроенный Node 26.x —
  системный Node 22 НЕЛЬЗЯ использовать для запуска cli-entry), `lib\cli-entry.js`.
- Текст shim (identity замаскирована):
  ```bat
  @echo off
  setlocal
  set "ROOT=%~dp0.."
  set "GIGACODE_PACKAGE_IDENTITY=<64 hex>"
  set "GIGACODE_PACKAGE_LAUNCHER=%~f0"
  "%ROOT%\runtime\node\node.exe" --max-old-space-size=6144 "%ROOT%\lib\cli-entry.js" %*
  exit /b %ERRORLEVEL%
  ```
  Итак, node.exe/cli-entry.js отсчитываются от `%~dp0..` (РОДИТЕЛЬСКОЙ папки shim), а не от папки shim.
- `.cmd` нельзя использовать как процесс: `shell:false` → EINVAL; `shell:true` → `'C:\Program' is not recognized`;
  `cmd.exe` + `%ERRORLEVEL%` после `.cmd` → всегда 0. Только `node.exe cli-entry.js` + identity env дают честные коды выхода.
- Без identity env: stderr `GigaCode launcher error: the public launcher and standalone payload identities do not match`,
  **0 байт stdout и exit 0** — тихий сбой; его нужно определять по stderr / отсутствию событий.
- argv: `[--max-old-space-size=6144, cli-entry.js, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]`.
  Режимы одобрения: `plan | default | auto-edit | auto`. Другие полезные флаги из `--help`: `-c/--continue`, `--fallback-model`,
  `--acp`, `--safe-mode` (отключает файлы контекста, хуки, расширения, скиллы, MCP — не для запусков задач), `--worktree` (собственное
  рабочее дерево (worktree) в `<repo>/.gigacode/worktrees` — мы его НЕ используем, рабочими деревьями управляет харнес).
- Холодный старт: событие `system/init` может занимать 30–60 с (сотни инструментов, ~9 MCP-серверов). Таймаут первого события должен быть ≥ 120 с,
  а UI должен показывать "starting / waiting for MCP".
- stderr при exit 0 может содержать предупреждения, например `Warning: MCP server(s) failed to start: java-lsp. Continuing with built-in tools…`
  → показывать как предупреждение в ленте, а не как ошибку.

## 2. stream-json (в стиле Qwen-Code / Claude)

Один JSON-объект на строку. У каждого события есть `session_id` (равен `uuid` из init при первом запуске; не меняется при `--resume`).

| type | значение |
|---|---|
| `system` + `subtype:"init"` | первое событие: `session_id`, `cwd`, `tools[]`, `mcp_servers[{name,status}]`, `model` (без суффикса `-262k`), `permission_mode`, `qwen_code_version`, `agents[]`, `slash_commands[]` |
| `stream_event` | обёртка; наблюдался только `event.type:"goal_state"` (`{v, goal, activity}`). ВИДЕЛИ 2026-11-18 с `--include-partial-messages`: 2 из 3 параллельных вызовов инструментов остались без аргументов (read_file, run_shell_command) — флаг включается по желанию, пока сырой захват не покажет форму |
| `assistant` | `message.content[]`: `{type:"text",text}` и/или `{type:"tool_use",id,name,input}`; `message.usage` на шаг |
| `user` | результаты инструментов: `message.content[{type:"tool_result",tool_use_id,is_error,content}]` (это не сообщение человека) |
| `result` | конец запуска: `subtype:"success"`, `is_error`, `duration_ms`, `num_turns`, `result` (итоговый текст), `usage{input_tokens,output_tokens,cache_read_input_tokens,total_tokens}` |

- Каждое событие несёт `parent_tool_use_id` (null для основного агента). Не null = событие встроенного субагента, запущенного этим
  вызовом инструмента; его нельзя сливать в основное сообщение assistant.
- Токены: считать по `result.usage` (накопительно за запуск). `assistant.message.usage` — на шаг и НЕ складывается в него.
- Фатальная ошибка (например, неизвестная модель): **stdout пуст, exit 1**, полный текст в stderr
  (`An unexpected critical error occurred:\nError: The selected model 'x' is not present in the current backend catalogue …`).
  → пустой stdout + exit ≠ 0 → сразу ошибка из stderr; не ждать `result`.

## 3. Настройки на запуск settings.json (`GIGACODE_SYSTEM_SETTINGS_PATH`)

```json
{ "agents": { "modelGrades": { "default": "<model>", "fast": "<model>", "review": "<model>", "explore": "<model>" },
              "allowedGrades": ["default", "fast", "review", "explore"] },
  "chatRecording": true }
```
- `agents.modelGrades`: объект, `mergeStrategy: shallow_merge`, любые строковые ключи (названия грейдов — соглашение команды, их использует
  встроенный инструмент `agent` как `{model: "<grade>"}`); `agents.allowedGrades`: белый список для инструмента `agent` (`[]` = субагенты
  не могут выбирать модель). `chatRecording` обязателен для `--resume`. Никогда не записывать `permissions`.
- Идентификаторы моделей берутся из `/models` на машине (5 моделей, контекст 128k–262k); `modelGrades` может использовать идентификаторы с суффиксом
  `-262k` и без него. Запасные модели существуют (`--fallback-model`).
- СЛИВАЮТСЯ ли `mcpServers` из этого файла с `~/.gigacode/settings.json` или ЗАМЕНЯЮТ его — **не подтверждено**. Без файла
  загружаются все серверы пользователя. Не полагаться на слияние: флаг конфига `agents.gigacode.inheritUserMcp` копирует
  `mcpServers` пользователя в файл запуска рядом с `harness` (включите, если тест слияния покажет замену).
- ПОДТВЕРЖДЕНО на целевой машине: headless `--approval-mode auto` падает с "Error: Auto approval is allowed only under an
  active action sandbox; enable it via settings.tools.sandbox = 'workspace' or 'workspace-offline'." (exit 1,
  `Config.assertAutoApprovalAvailable`). Харнес отображает `auto` → `auto-edit` (`agents.<id>.approvalModeMap`), если не задан
  `agents.<id>.autoSandbox`, который записывает `{ "tools": { "sandbox": "<value>" } }` в настройки запуска и оставляет
  `auto`. ПРОВЕРИТЬ: песочница ограничивает файловые/shell-инструменты рабочим пространством, так что `--include-directories` и рабочие деревья
  вне cwd могут блокироваться.
- ПОДТВЕРЖДЕНО: грейд, указывающий на идентификатор, неизвестный бэкенду, роняет CLI ("modelGrades.default is not present in
  the current backend catalogue") — в закоммиченном конфиге нет грейдов по умолчанию; они задаются в Settings из
  найденного каталога.
- ПОДТВЕРЖДЕНО: `/models` перечисляет идентификаторы С суффиксом контекста (`DeepSeek-V4.1-Flash-1017-262k`), тогда как CLI и конфиги используют
  их без него (`DeepSeek-V4.1-Flash-1017`): харнес сравнивает модели по базовому идентификатору (суффикс `-<n>k|m` отбрасывается).
  ПОДТВЕРЖДЕНО ещё раз (чат ACP, 2026-11-18): `--model DeepSeek-V4.1-Flash-1017-262k` убивает CLI при старте («not present in
  the current backend catalogue»). Лаунчер gigacode (`stripModelSuffix`) передаёт `--model` и `modelGrades` из настроек запуска
  без суффикса, какой бы идентификатор ни держали выбор модели или грейд.

## 4. Пользовательские команды и встроенные субагенты

- Пользовательские команды: `~/.gigacode/commands/<name>.md` (frontmatter + тело). `/full-task` лежит там (75 КБ). `/full-task-ui` — это
  тонкая обёртка, которая существовала только как проектная команда репозитория старой консоли (`commands/full-task-ui.md`).
- Слеш-команды работают в headless-режиме, **только как первое слово промпта**: `-p "/full-task <url><notes>"`; остаток
  промпта становится `$ARGUMENTS`. Команда разворачивается в инструмент `skill` (`{"skill":"full-task","args":"<url>"}`).
  ВИДЕЛИ (2026-11-19): первое сообщение чата `/full-task …` со справкой харнеса за ним — модель выполнила справку
  (tool_search «harness», whoami) и `skill full-task` не вызвала, команда не загрузилась. Теперь между командой и справкой
  стоит строка лаунчера «первый шаг — загрузить команду инструментом skill». ПРОВЕРИТЬ в ACP-чате: upstream Qwen Code в ACP
  сам подставляет тело команды-навыка в запрос (без шага `skill`); если GigaCode делает так же, шага `skill` там не будет.
  ВИДЕЛИ (2026-11-19): проектный скилл `IdeaProjects\.gigacode\skills\full-task` (маршрутизатор: «прочитай commands\full-task.md
  целиком») перекрывает одноимённую команду — `skill full-task` загрузил его, и модель дочитала 400 строк команды тремя
  `read_file`. Интерактивный CLI подставляет в сообщение сам текст команды с `{{args}}`. Теперь так же делает харнес
  (ARCHITECTURE: `expandCommand`). ПРОВЕРИТЬ: что CLI делает с командой без `{{args}}` (харнес добавляет вызов после текста,
  как gemini-cli).
- `{taskUrl}` = полная ссылка трекера (`https://<tracker>/swtr/units/all/unit/<KEY>` и варианты) или просто ключ; `{notes}` =
  добавляется после ссылки с ведущим пробелом/переводом строки, обычно пусто.
- Тело `/full-task` (пользовательский уровень, ~370 строк): "Ты — оркестратор"; текст задачи приходит как `{{args}}`. §0 жёсткие правила (git
  только для чтения, без записей в трекер/CI, минимальный diff, секреты); §1 домен по маркерам репозитория (pom.xml/build.gradle → Java-
  субагенты; package.json → TS-поток; pyproject → Python; YAML → поток конфигов); §2 режим контекста NORMAL / SDD_EXISTING /
  SDD_NEW / FOLLOW_UP; §4 собственное рабочее дерево `..\<repo>-worktrees\<task-id>` (переиспользовать, если оно есть в `git worktree list`; ветка по
  соглашению репозитория), работа остаётся незакоммиченной; §5 риск FAST / STANDARD / STRICT; §6 Java-субагенты java-fast-engineer /
  backend-engineer / sdd-engineer / repository-explorer / Explore; §8 кросс-модельное ревью: первый проход `java-reviewer`
  (GLM), второй проход `java-reviewer-qwen` (Qwen) с явными моделями для каждого семейства исполнителей; §9 скиллы OpenSpec
  (`openspec-*`), изменения в отдельном хранилище; §11 скиллы superpowers по триггеру; §13 проверка субагента с файлом вердикта
  `<worktree>\.superpowers\sdd\<plan>\verdicts\task-<N>.md` (`status: PASS|FAIL|ESCALATION_REQUIRED|INDEPENDENT_VERIFICATION_REQUIRED`,
  `files_changed`, `commands`, `open_questions`, `implementer_model`, `reviewer_model`, `second_review_model`, `notes`)
  + журнал `progress.md`; `.superpowers/` никогда не коммитится; §14 барьер DONE со свежими доказательствами, финальное сообщение перечисляет
  модели исполнителя/ревьюера; описание PR ≤ 300 символов; §15 циклы отделены от full-task.
- Правила `/full-task`: никаких commit/push/merge/PR/записей в трекер без явной просьбы; рабочее дерево на задачу; режимы
  NORMAL/SDD_EXISTING/SDD_NEW/FOLLOW_UP; объём FAST/STANDARD/STRICT; кросс-модельное ревью субагентом из другого семейства моделей;
  DONE требует свежих доказательств; только циклы "наблюдать и предлагать".
- Встроенные субагенты: инструмент `agent` (также `fork` через `subagent_type:"fork"`), определения в `~/.gigacode/agents/<name>.md`
  (например, java-reviewer, repository-explorer, sdd-engineer…). **Их нельзя отключить настройкой** — только ограничить:
  `agents.allowedGrades: []`, `agents.maxParallelAgents`, `agents.maxParallelAgentsByModel` или запретом `permissions` на `agent`
  (permissions мы никогда не пишем). `/full-task` опирается на них для ревью, поэтому харнес допускает их как внутренних помощников и показывает
  только для чтения (реестр / `parent_tool_use_id`); исполнители (workers) харнеса (свои чаты) запускаются только через `worker_start`.
- Встроенный `agent` с `run_in_background: true` (подтверждено вживую, 2026-11-19) сразу отвечает текстом «Background agent
  launched successfully. task_id: Explore-1e07b28f (internal ID …) The agent is working in the background. You will be notified
  automatically when it completes. … output_file: C:\Users\<user>\.gigacode\projects\<project-slug>\subagents\<session-uuid>\agent-<task_id>.jsonl
  If asked, you can check progress … tail on the output file.» Сам ход субагента идёт вне потока родителя: харнес его не видит
  (карточка помечается «в фоне», `backgroundRun` в `web/src/lib/toolRun.ts`). Харнес просит агентов так не запускать. Открыто:
  формат `agent-<id>.jsonl` и чем приходит «notified when it completes» (событием потока или сообщением следующего хода).
- Реестр, который пишет оркестрирующий агент: `<registryDir>/<agentId>/agent.json` с временными метками ISO-8601
  (`startedAt`, `lastActivity`, `settledAt`, `activity.since`), например
  `{"id":"java-reviewer-1","name":"java-reviewer","role":"review","model":"…","parentId":null,"worktree":"…","state":"working","startedAt":"2026-11-17T16:02:11.000Z","lastActivity":"2026-11-17T16:07:43.000Z","settledAt":null,"activity":{"tool":"grep_search","since":"…"},"tokensIn":184320,"tokensOut":2411}`;
  `log.jsonl`: `{"ts":"…","event":"queued|spawned|activity|done","state":"…","note"?,"sessionId"?,"tool"?,"settledAt"?}`.

## 5. MCP onework (трекер задач) — инструменты возвращают MARKDOWN, а не JSON

- Сервер: `onework` (HTTP, заголовок `Authorization`). Отдельный сервер `sbertrack` отвечает 403 на чтение задач — никогда не использовать.
- Конверт: `content: [{ type: "text", text: "<markdown>" }]`. Ошибки инструментов тоже приходят текстом:
  `MCP tool 'sbertrack_getIssue' reported tool error for function call: {…} with response: [{"functionResponse":{…,"response":{"error":"…"}}}]`
  → определять `reported tool error` / `"error":"` и считать ошибкой.
- `sbertrack_findIssues` — плоские аргументы (без обёртки `filters`; неизвестные ключи молча отбрасываются; нужен хотя бы один фильтр):
  `space_code, text, statuses, exclude_statuses, assignee, reporter, priorities, suit, labels, created_after/before,
  updated_after/before, page_size (1–100, default 100), page_number (0-based)`.
  "Мои, не закрытые": `{ space_code: "<SPACE>", assignee: "me", page_size: 100 }` — `assignee:"me"` сочетается только с
  `space_code`; закрытые статусы фильтровать на стороне харнеса.
  Ответ:
  ```
  Found 5 issues on this page (page 0, 5 per page, has_next: True, more pages available)

  1. **<KEY>** — <summary> [<status> | <priority>] @<assignee>
  ```
  В результатах поиска нет описания и нет связей.
- `sbertrack_getIssue {key}` — markdown: список полей `- **Space**`, `- **Type**`, `- **Status**`, `- **Priority**`,
  `- **Labels**`, `- **Assignee**`, `- **Reporter**`, `- **Created**`, `- **Updated**`, затем описание (markdown), затем
  `### Attributes` (~90 пользовательских полей).
- `sbertrack_getIssueMeta {key, include_fields, include_transitions}`:
  ```
  ## Current Status: development (`development`)

  ## Available Transitions

  - `to_code_review` → to_code_review (`to_code_review`)
  ```
- `sbertrack_updateIssueStatus {key, transition, assignee?, comment?}` — `transition` — идентификатор действия из getIssueMeta.
- `sbertrack_getUser {login} | {self:true}` (ровно один). `sbertrack_listLinks {key, page_size, page_number}`:
  `<SRC> **<link_type>** -> <DST>`; встречавшиеся типы: `wiki_page_mention`, `decomposition` (родитель→потомок), `plain_connection`.
- Ключ = `<space_code>-<number>`. Встречавшиеся статусы: `todo, development, qa, done, cancelled`; переходы также
  `to_code_review, ready_for_uat, ready_for_ift, ift, stop_progress, discover_issue`. Закрытые: `done, cancelled, declined`.
  Встречавшиеся приоритеты: `low, mid` (+ high). Глобального словаря статусов через инструменты получить нельзя.

## 6. MCP sourcecontrol (хостинг кода) — настоящий JSON

- stdio-сервер (`node …/mcp-sourcecontrol/dist/index.js`, env `SC_TOKEN`); 36 инструментов: `git_ping, git_list_repositories,
  git_list_branches, git_create_branch, git_get_branch, git_delete_branch, git_list_commits, git_list_pull_requests,
  git_create_pull_request, git_get_pull_request, git_merge_pull_request, git_decline_pull_request, git_update_pull_request,
  git_get_pull_request_diff, git_list_pull_request_files, git_list_pull_request_commits, git_list_pull_request_comments,
  git_add_pull_request_comment, git_get_file_content, git_list_files, …review/webhook/sonar settings…, git_get_user`.
- У всех схем `additionalProperties: false`; пагинация — `page` (с 1) + `limit` (не page_size).
- `git_create_pull_request {project, repository, head, base, title, body?}` (обязательны: project, repository, head, base, title).
  Лимиты (из живых 400): `title` ≤ 100 БАЙТ UTF-8 (~50 символов кириллицы), `body` ≤ 512 байт (`invalid_pr_title_length` /
  `invalid_pr_body_length`); пустой PR (без diff) отклоняется; **второй PR из той же head автоматически закрывает предыдущий**.
- Человеческая ссылка = `html_url` (`url` — внутренняя конечная точка API, никогда её не показывать).
- `git_list_pull_requests {project, repository, state: OPEN|MERGED|DECLINED, targetBranch?, author?, page, limit}` →
  `{ pagination, pulls: [{ index, title, body, state, head:{name}, base:{name, protected}, mergeable, reviewers[{status}], html_url }] }`.
- `project/repository` из `git remote get-url origin`: последние два сегмента пути без `.git`
  (`ssh://host:7998/PROJ/repo.git`, `https://host/PROJ/repo.git`, `git@host:PROJ/repo.git` → `PROJ`, `repo`).
- Инструмента статуса CI нет (CI — отдельная система).
- **НЕ ПРОВЕРЕНО (VERIFY):** аргументы и форма ответа `git_merge_pull_request`, `git_get_pull_request_diff`,
  `git_list_pull_request_comments`. Харнес по умолчанию шлёт им те же аргументы, что и decline
  (`{project, repository, pullRequestIndex}`), дифф ждёт строкой (или `{diff|content}`), комментарии — списком или
  `{comments|items|values|data}` с полями author/text|body/created_at/path/line. Проверить:
  `node scripts/mcp-call.js sourcecontrol --list`, затем по одному вызову на реальном PR, ответы — в `test/fixtures/`;
  если аргументы другие — `integrations.pr.mergeArgs` / `detailArgs` в локальном конфиге.

## 7. Файл секретов (`CONSOLE_MCP_SECRETS`)

Текст, один секрет на строку, комментарии `#`: либо одно голое значение (= `onework/Authorization`), либо `server/Name=value`
(разделение по первому `=`). HTTP-серверы получают `headers[Name]`, stdio-серверы получают `env[Name]`. Ссылки в конфиге `${env:NAME}` и
`$secret:server/Name`; обе передаются дочерним процессам как `MCP_SECRET_<NAME>`. Отсутствующий секрет → этот сервер получает `problem`,
остальные работают. Транспорт на каждый вызов. Собственное зашифрованное хранилище GigaCode (`~/.gigacode/mcp-secrets-v1.json`) прочитать нельзя.

## 8. Соглашения команды по git

- Базовая ветка `develop` везде. Релизы: `release/x.y.z` (например, `release/1.54.0`).
- Ветки: `feature/<KEY>` или `feature/<KEY>-<slug>`; `bugfix/…`, `hotfix/…` в той же форме. Релизная копия исправления:
  `feature/<KEY>-rel<major><minor>` (например, `feature/PROJ-14822-rel154`) → PR в `release/1.54.0`.
- Сообщение коммита: `<KEY> <summary from the tracker>` — сначала ключ, затем пробел (без двоеточия), без префиксов `feat:`/`fix:`,
  без `Co-authored-by`, без упоминаний AI/GigaCode; необязательное тело в свободной форме.
- Заголовок PR: `<KEY> <summary>`.
- Перенос: по коммитам, только недостающие (`git log --cherry-pick --right-only <target>...<branch>`), делает автор,
  отдельный PR на каждую релизную ветку. Автоматического слияния develop→release нет. Локальных хуков нет; соглашения CI не проверяет.

## Подтверждено на целевой машине (вживую)

- Текст отказа в headless (ошибка tool_result): `GigaCode requires permission to use "run_shell_command", but that permission was
  declined (non-interactive mode cannot prompt for confirmation).` — к моменту сообщения вызов уже отклонён; агент
  продолжает ход.
- `--approval-mode auto` в headless падает, если не включён `tools.sandbox` (`Auto approval is allowed only under an active
  action sandbox; enable it via settings.tools.sandbox = 'workspace' or 'workspace-offline'.`) → харнес отображает auto → auto-edit.
- `auto-edit` НЕ разрешает `run_shell_command` в headless → для shell-команд нужен явный список разрешённых
  (`--allowed-tools`, ПРОВЕРИТЬ точный флаг и синтаксис шаблона, например `run_shell_command(git)`), песочница или ACP.
- `Warning: MCP server(s) failed to start: java-lsp. …` печатается в stderr при КАЖДОМ headless-запуске (каждый запуск перезапускает MCP).

## Открытые вопросы (проверить на целевой машине; каждый меняет реализацию)

0000. **«Внешние ссылки» в onework — ПОДТВЕРЖДЕНО (2026-11-19): своего инструмента нет.** В списке MCP-сервера onework
   (204 инструмента, `node scripts/mcp-call.js onework --list`) нет ничего под `*external*links*`, `*remote*links*`,
   `*web*links*`, поэтому харнесс больше не угадывает имя инструмента: адреса берутся из ответа `sbertrack_getIssue`
   (`{key}`), где «Внешние ссылки» — атрибут `external_link` (тип `external_link`) в секции `### Attributes`; пустой печатается
   как `—`. Адреса спецификаций чаще лежат и в ТЕКСТОВЫХ атрибутах (`br_st`, `fr_st`, `arch_st`, `br_jira`, `fr_jira`,
   `arch_jira` — формат `Статус;https://…`, несколько через `;`) и в описании задачи. Всё это берёт `fieldLinks`
   (`server/integrations/tasks.js`). Свой инструмент, если появится, — `integrations.tasks.tools.externalLinks` (аргумент
   `{ key }`, из ответа берутся все адреса). Ссылка на репозиторий со спецификацией (SDD, `bpmnt-sdd`) → локальная копия через
   `hints.localCopyOf` (…/browse/<path>, …/blob/<ref>/<path>, …/-/blob/<ref>/<path>) и уходит агенту строкой «Ссылки из полей
   задачи». Кэш — `task.externalLinks`: запуск задачи со ссылкой второй раз трекер не опрашивает (`server/index.js`).

0000. **Хуки и перегрузка при параллельных стартах.** ВИДЕЛИ (ACP, v26.10.109, 2026-11-24): `session/prompt` раз за разом
   отвечает `-32603 Internal error` с `data.details: "Request timed out waiting for hook-execution-response"`; в stderr —
   `[perf] acp agent event loop stall: max=11173ms` и «MCP server(s) failed to start: confluence, …, harness, sprut»,
   следующий `initialize` не ответил за 120 с. В Qwen Code хуки задаются ключом `hooks`, выключаются `disableAllHooks: true`
   (и `--safe-mode`/`--bare`); `UserPromptSubmit` срабатывает на каждый промпт. Харнес теперь: ограничивает одновременные
   старты (`maxStarting`), ждёт живой процесс дольше, пишет в чат о зависшем хуке и повторяет ход один раз; отключить хуки
   в запусках харнеса можно только явно (`agents.<id>.userHooks: false` → `disableAllHooks`).
   ПРОВЕРИТЬ: принимает ли GigaCode `disableAllHooks` в файле настроек запуска (`GIGACODE_SYSTEM_SETTINGS_PATH`), и чьи
   хуки висели — пользовательские из `~/.gigacode/settings.json` или встроенные.

000. **Мост вызовов инструментов.** ВИДЕЛИ (ACP, DeepSeek-V4.1-Flash, 2026-11-18): четыре параллельных запуска субагентов
   пришли как вызовы `tool` без аргументов и отклонены «[tool_call bridge refused] params must have required property
   'name'» — модель не назвала инструмент; ничего не выполнилось. В UI такой шаг подписан «Вызов без имени инструмента».
   Повторилось (ACP, DeepSeek-V4.1-Flash, 2026-11-21): два параллельных `mcp__harness__agent` → оба отклонены, после этого
   модель закончила ход без текста. Преамбула и `commands/full-task-harness.md` теперь просят по одному вызову на шаг с
   `run_in_background: true`. ПРОВЕРИТЬ: то же в headless-чате и на другой модели.

00. **Одновременный запуск нескольких процессов GigaCode.** ВИДЕЛИ (ACP, 2026-11-18): субагент упал на старте с
   `ExtensionStoreBusyError: Extension store is busy at ~/.gigacode/extension-store` (код 1). Теперь харнесс разносит запуски
   одного агента на `agents.<id>.spawnGapMs` (по умолчанию 1200 мс) и при такой ошибке сам повторяет запуск (до 4 раз, пауза
   2–5 с + 2 с на попытку). ПРОВЕРИТЬ: три субагента разом — все стартуют.
   ВИДЕЛИ (ACP, 2026-11-21): тот же сценарий другой ошибкой — процесс ~40 с ждал MCP и упал с кодом 1:
   `Error: Unable to update lock within the stale threshold` (файловая блокировка GigaCode). Харнесс повторяет и её.

0. **ACP и гейт «сначала прочитай, потом правь».** ВИДЕЛИ на целевой машине (чат ACP, 2026-11-18): `edit` трижды
   отклонён «File … has not been read in this session. Use the read_file tool first…» сразу после успешного `read_file`
   того же файла; перезапись через `write_file` — тоже. Харнесс объявлял себя файловой системой агента
   (`clientCapabilities.fs`), и чтения шли через него — гейт GigaCode их, по всей видимости, не видел. Теперь по умолчанию
   не объявляет (`agents.<id>.acpClientFs: true` возвращает). ПРОВЕРИТЬ: в ACP-чате прочитать файл и сразу `edit` — проходит.

1. `mcpServers` в файле настроек запуска: сливаются с `~/.gigacode/settings.json` или заменяют его? (→ `inheritUserMcp`)
    ВИДЕЛИ на целевой машине (чат ACP, 2026-11-18): агент искал `mcp__harness__agent` и нашёл только встроенные
    (`create_sub_session`, `send_message`, `task_stop`, `cron_create`, `loop_wakeup`) — сервера harness не было в его
    реестре. Проверьте то же в headless-чате; если там он тоже отсутствует, файл настроек запуска не читается или ничего
    не заменяет — выяснить, что именно.
2. Хуки в настройках (вроде PreToolUse): ключ, события, формат, может ли отклонить инструмент с сообщением? (→ `agentToolHook`, чтобы заставить
   использовать `mcp__harness__agent` вместо встроенного `agent`)
3. Точная inputSchema встроенных `agent` / `fork`; появляются ли события субагентов в stream-json с ненулевым
   `parent_tool_use_id`? (→ схема алиаса `agent` харнеса; уровень 1, виртуальные чаты)
4. Таймаут вызова MCP-инструмента по умолчанию; единицы `mcpServers.<name>.timeout`; сбрасывает ли его `notifications/progress`? (→ длинные
   ожидания `worker_run`)
5. Параллельные вызовы инструментов за один ход — выполняются конкурентно? (→ параллельные субагенты харнеса)
6. Headless `-p` без авторизации: вывод, формат ссылки, ждёт или завершается, код выхода; где хранится вход.
7. Сырой вывод `-p "/models"` (→ парсер поиска моделей).
8. Порядок stdin + `-p` со слеш-командами; максимальная длина argv в Windows (40K символов?) (→ длинные промпты через stdin).
9. Режим одобрения `auto` в headless, когда классификатор хочет подтверждения: событие? отказ/пропуск/остановка? Точный текст отказа
   (→ `denialPattern`).
10. Встроенный структурированный инструмент вопросов (вопрос человеку с вариантами): точное имя и inputSchema; что
    возвращает headless для него (→ `questionTools`).
12. Где `chatRecording` хранит сессии (шаблон пути, например `~/.gigacode/tmp/<hash>/chats/`), формат файла (один
    образец, секреты замаскированы), как `<hash>` выводится из пути проекта, и `gigacode sessions --help` (подкоманды
    list/show, вывод JSON?) (→ `agents.gigacode.history`, панель "GigaCode history").
    ПРОВЕРИТЬ — сейчас харнес предполагает записи Gemini/Qwen: `~/.gigacode/tmp/<sha256(project path)>/chats/*.json`
    с `{ sessionId, projectHash, startTime, lastUpdated, messages: [{ type: user|gemini, content, thoughts, toolCalls }] }`;
    всё остальное показывается как сырое.
13. Флаг и синтаксис шаблона списка разрешённых в headless: это `--allowed-tools`, повторяемый или через запятую, и совпадает ли
    `run_shell_command(git)` с `git status`? (→ `allowedToolsFlag`, `allowedToolsJoin`, шаблоны разрешений)
14. Ключ, исключающий MCP-серверы на один запуск (в настройках на запуск): `mcp.excluded` или в стиле Gemini
    `excludeMCPServers`? (→ `mcpExcludeKey`)
11. Режим `--acp`: работает ли он с identity env + настройками на сессию; возможности `initialize` (loadSession?),
    `session/request_permission` для подтверждений инструментов, MCP-серверы, передаваемые в `session/new`, поведение авторизации
    (→ `transport: "acp"` для настоящих интерактивных разрешений).
15. Команды контекста в headless-режиме: сжимает ли `--resume <id> -p "/compress"` эту сессию (и что
    показывает stream-json: текст результата, новый usage?), и печатает ли `-p "/context"` разбивку токенов БЕЗ добавления
    хода в историю чата? (→ `agents.gigacode.compressCommand` / `contextCommand`, действия кольца контекста.)
    Также: является ли `assistant.message.usage.input_tokens` всем промптом, включая кешированную часть (кольцо использует
    input + output на шаг), и несёт ли результат ACP `session/prompt` поле `usage`?

## 9. Подводные камни машины

Порядок установки с нуля — `docs/INSTALL.md`; ниже только то, на чём чистый клон на другой машине спотыкается.

- Установка GigaCode лежит в папке с пробелом (`C:\Program Files\.gigacode`). Пути к `node.exe` / `cli-entry.js` отсюда
  передаются без оболочки, поэтому пробел не ломает запуск; `.cmd` как процесс запускать нельзя (см. §1).
- `~/.gigacode/settings.json` есть только у того, кто уже запускал GigaCode. Ключ `mcpServersFrom` ссылается на него;
  файла нет — MCP будут только свои (`mcpServers` в конфиге), это нормально, `npm run check` пишет об этом строкой
  «user MCP settings».
- Модели и грейды (`agents.<id>.settings.agents.modelGrades`) у каждого свои: закоммиченных грейдов нет, модель берётся из
  `/models` на машине. Грейд с неизвестным бэкенду идентификатором роняет CLI (§3).
- Пользовательские MCP-серверы из общего файла настроек часто машинно-зависимы (путь к `python.exe` venv, `jdtls`, `npx`).
  Их место — `harness.config.local.json`; `mcpDisabled` в общем конфиге отключает чужие серверы по имени.
- Вывод консоли в CP866 (кириллица искажена) — никогда не полагаться на текст консоли; читать байты, писать файлы с явным UTF-8.
- Антивирус/индексатор удерживает файлы: `rmSync` → ENOTEMPTY/EBUSY; `rmdir /s /q` падает даже на ASCII-путях. Удалять, сначала переименовав в
  `<dir>.stale-<ts>` (работает, даже пока файлы удерживаются), затем удалять поэлементно; чистить `.stale-*` при запуске.
- MAX_PATH 260: держите рабочие деревья короткими — `<parent>\<repo>-worktrees\<KEY>`, а не в `~/.gigacode/worktrees/<hash>`.
- Порт уже занят старым процессом (`EADDRINUSE`): напечатать порт и как найти PID (`netstat -ano | findstr :<port>`).
- Два процесса харнеса на одной `data/`: отказаться запускаться (блокировка единственного экземпляра на папку данных).
- Реестр npm — внутреннее зеркало (на машине нет Docker). Системный Node 22.16, встроенный Node GigaCode 26.4.
