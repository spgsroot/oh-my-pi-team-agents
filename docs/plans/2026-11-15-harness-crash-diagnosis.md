# Диагностика сбоя харнесса (2026-11-15) и план внедрения фиксов/фич

## Сводка

Два симптома, показанные пользователем, — независимы:

1. `⚠ Wait — No service finished within 5.0s/10s/30s/1m/5m` — **штатное поведение** wait-инструмента (idle-лестница `WAIT_LADDER_MS`), не сбой. Подтверждено на сессиях `FoundT7`, `TeamsT1/T10`, `gigahlp-15525`.
2. `[Uncaught Exception] Error: Native shell returned an invalid execution trace at poll (cli-*.js)` — **фатальный баг форка**, убивший сессию `01a1df90-2760-73e4-bcc3-ea522856b63b` (ревью LLMBench) в 17:26:57, pid терминала 26945. **Воспроизведён изолированно за одну попытку.**

---

## 1. Fatal: `Native shell returned an invalid execution trace`

### Цепочка (доказана логами и репро)

```
bash tool (UI-фрейм подключён)                       packages/coding-agent/src/tools/bash.ts:1074 / :1819
  → executeBash({ onTrace })                          packages/coding-agent/src/exec/bash-executor.ts:797
  → pollRunTrace() setInterval(80ms)                  bash-executor.ts:167-188
  → const snapshot = JSON.parse(trace.snapshot())     bash-executor.ts:173
  → if (!isShellTrace(snapshot)) throw                 bash-executor.ts:174   ← throw внутри setInterval-callback
  → nobody catches → uncaught → session_exit(uncaught_exception, fatal, pendingToolCalls: 1)
```

- `session_exit`-запись: `~/.omp/agent/sessions/-orca-workspaces-LLMBench-review/…01a1df90-2760….jsonl`, последний ряд — с `pendingToolCalls` (bash grep по backlog.md).
- Лог терминала: `~/.omp/logs/omp.2026-11-15.26945.log`, строки 9–11: `reason=uncaught_exception`, stack `at poll (…/cli-d70dpjsq.js:58:22)`.
- Бинарь: `omp 18.16.0` (форк), `/Users/sstovpeko/.local/lib/omp-fork/omp` — единый bun-compile, отсюда минифицированный `cli-d70dpjsq.js` в стектрейсе.

### Первопричина — воспроизведена (`/tmp/repro-node.cjs`, addon `~/.omp/natives/18.16.0`)

Команда, убившая сессию (полный текст в `session_exit`), прогнана под нативным `Shell` + `RunTrace` с поллингом снапшота каждые 10 мс. Первый же poll вернул снапшот, который `isShellTrace` отклоняет:

```
history[120] kind="Assign" name="file"
value = [45, 32, 118, 101, 114, 100, 105, 99, 116, …]      ← массив байтов, НЕ строка
```

- Сериализатор: `crates/pi-shell/src/bash/text.rs:12-24` — `Text<'a>` в human-readable JSON даёт **строку, только если байты валидный UTF-8; иначе массив байтов** (`serialize_bytes`). Так задумано: `BString` в trace-модели — сырые байты, граница UTF-8 не гарантирована.
- Усечения это ломают регулярно: `cut()` (`trace.rs:1147-1153`) и `bounded()` (`history.rs:62-70`) режут по `ARG_BYTES` и только **если весь исходный буфер валиден**, откатываются к char boundary. Усечённая посреди многобайтового символа (русский текст в `backlog.md`) строка становится невалидным UTF-8 → JSON-массив байтов.
- Гард: `packages/wire/src/shell-trace.ts:427-445` — `historyEntry` требует `string(value.value)` (`value` в списке строковых полей, строки 405-407) и для `kind==="Assign"` — `string(value.name) && string(value.value)` (строки 419-420). Массив байтов → guard=false → throw.

Т.е. **рассинхрон контрактов**: Rust-сторона легально эмитит `bytes`-форму `text-or-bytes` (то же самое поле — `script` top-level, `name`, `text` в Output, `argv` и `assigns` в CmdExpanded — все через `text::Text`), а TS-гард на той же границе требует только `string`. Достаточно любому `BString`-полю в history-журнале оказаться не-UTF-8 — и сессия гибнет. Русский текст в выводе `sed -n` по русскоязычному `backlog.md` — гарантированный триггер (значение переменной `file` после `sed -n "${ln}p"` содержит кириллицу, усечённую посреди байта).

Поля в зоне риска (сериализуются через `text::bytes`/`text::list`/`text::pairs` и проверяются как `string`/`string[]`/`[string,string][]`):

| Событие | Поле | Путь сериализации |
|---|---|---|
| `Assign` | `name`, `value` | `history.rs:186-192` `text::bytes` |
| `IterStart` | `name`, `value` | `history.rs:161-167` `text::bytes` |
| `FuncEnter/FuncExit` | `name`, `argv` | `history.rs:173-183` `text::bytes`/`text::list` |
| `Spawn` | `argv` | `history.rs:212-216` `text::list` |
| `Output` | `text` | `history.rs:195-200` `text::bytes` |
| `Diag` | `text` | `history.rs:203-206` `text::bytes` |
| `CmdExpanded` | `argv`, `assigns`, `redirs[].target` | `history.rs:146-153` `text::list`/`text::pairs` |
| Node | `argv`, `env`, `redirs` | `trace.rs` Node serde |
| Top-level | `script`, unit `source`, diag `message` | `SnapshotJson` `text::Text` |

Дополнительно: у натива те же правила для **postcard/бинарных** кадров (frames blob) — там всегда сырые байты, и гард их не видит. Проблема только JSON-границы.

### Почему это P0 для форка

- **Любая сессия** с включённым trace-превью (по умолчанию включено: `onTrace` подключается всегда, когда есть UI-фрейм/async-джоба) умирает без сохранения при первом не-UTF-8 значении переменной в history. Русский вывод `sed`/`grep` по кириллическому контенту — обычный кейс в наших workflow.
- Утечка секретов: `~/.config/omp/secret-scan.py` не при чём, но в репро-транспорте сессии виден `GITLAB_TOKEN=glpat-…` в командной строке другого терминала (gigahlp-15525) — **отдельно от этого бага, рекомендую ротацию токена** (примечание, не часть фикса).
- `setInterval`-callback без try/catch: даже корректная ошибка десериализации не должна ронять процесс — это второй, независимый слой защиты, которого нет.

---

## 2. Wait «No service finished within …» — не баг

`packages/coding-agent/src/tools/wait.ts`:

- Лестница `WAIT_LADDER_MS = [5s, 10s, 30s, 1m, 5m]` (`wait.ts:31`), сброс через 60 c работы (`WAIT_LADDER_RESET_MS`).
- С 1-й ступени добавляется `<system-notice>` «Waiting is not progress…».
- Тексты «No service finished within …»/«A service finished…» — это idle-возвраты лестницы, когда ни один owned-сервис не завершился в окне. В сессиях-примерах агент корректно чередовал `wait` → `bash tail` для проверки прогресса — дизайн работает как задумано.

Единственная реальная проблема рядом — **тот самый фатал в 14:26:57**, прервавший финальную фазу ревью (последний bash так и не вернул результат; `pendingToolCalls: 1`).

---

## 3. План внедрения (приоритезированный)

### P0 — стабильность харнесса (блокер всего остального)

**F1. try/catch вокруг poll-коллбэка `pollRunTrace`** (`bash-executor.ts:167-188`)
- Перехват исключения `JSON.parse`/`isShellTrace` внутри `poll()`: логировать через `logger.error("native shell trace poll failed", { err })`, пропустить этот тик, не убивать процесс.
- `stop()` аналогично: финальный `poll()` (строка 184) обёрнуть тем же способом; при провале возвращать последний валидный `latest`.
- Эффект: даже при рассинхрон контрактов деградация = потеря trace-превью одного вызова, не потеря сессии.
- Тест: unit — замоканный `RunTrace`, бросающий на 2-м poll → executeBash не reject; regression на реальный repro-команда с кириллицей (можно переиспользовать `/tmp/repro-node.cjs` команду, смонтированную как фикстуру).

**F2. Синхронизация wire-гарда с text-or-bytes контрактом** (`packages/wire/src/shell-trace.ts`)
- Ввести `textOrBytes(v) = string(v) || bytesArray(v)` (массив чисел 0-255).
- Принять `textOrBytes` во всех полях, которые Rust сериализует через `Text`/`text::bytes`/`list`/`pairs`: `value`/`name` в Assign/IterStart/FuncEnter/FuncExit, `text` в Output/Diag, `argv` (strings → string[] | number[][]), `assigns`/`env` (pairs → пары с textOrBytes), `redirs[].target`, top-level `script`, unit `source`, diag `message`.
- Интерфейс `ShellTraceHistoryEvent`/`ShellTraceNode`: расширить типы до `string | number[]` (или завести `type WireBytes = number[]`, в документации полей указать, что bytes-форма появляется при не-UTF-8).
- Потребители (`packages/tui/src/chat/tool-execution.ts` shell-viz replay, `packages/tui/test/shell-viz*.test.ts`): при чтении этих полей — `typeof x === "string" ? x : Buffer/Uint8Array → lossy decode` (тот же `String::from_utf8_lossy`-семантика, в TS: `new TextDecoder("utf-8", { fatal: false })`).
- Тест: golden-фикстура `/tmp/bad-trace.json` (уже сохранён) → `isShellTrace(fixture) === true`; и негативный кейс (массив с числом > 255) → false.

**F3. Rust: не-UTF-8 текст в history — lossy-подобная сериализация вместо bytes** (опционально к F2, но правильнее)
- `text.rs`: в human-readable ветке при невалидном UTF-8 сериализовать U+FFFD-замену (заменяя каждый невалидный байт replacement char, как `String::from_utf8_lossy`), а не массив байтов; форму байтов оставить только для бинарных postcard-кадров.
- Либо (мягче): в `cut()`/`bounded()` всегда резать до char boundary даже если буфер целиком не-UTF-8 (использовать `floor_char_boundary` от начала срезаемой области, а не от целого буфера) — это убирает главный источник невалидности (усечение), но не базовые не-UTF-8 данные (напр. latin-1 вывод внешних команд).
- Решение F2 остаётся нужным в любом случае: гард не должен падать от легитимных данных. F3 выбирает, показывать ли bytes или lossy-текст.
- Тест: `cargo nextest` в pi-shell: событие Assign с невалидным UTF-8 значением → снапшот парсится JS-гардом (round-trip через фикстуру из F2).

**F4. Сессия-резистентность: `omp --resume` после fatal** — уже реализовано (`session_exit` + Recovery-подсказка в UI, подтверждено в спеке). Ничего не делать; проверить только, что `--resume` реально подхватывает `pendingToolCalls` (manual smoke: убить процесс в середине bash-вызова, resume, убедиться что turn продолжается).

### P1 — качество работы агента (из наблюдений сессий)

**F5. Wait-инструмент: подавление бессмысленных idle-возвратов**
- Проблема: агент в ревью-сессиях тратил запросы на wait → «ничего» → tail лога. Лестница корректна, но текст возврата подталкивает к повторному wait.
- Фикс: в idle-возврате с rung>=1 добавлять в результат wait **прогресс-сводку owned-сервисов** (статус/uptime/последняя строка вывода из proc://), чтобы следующий шаг агента был информированным, а не слепым wait-повтором. Данные уже есть (`listServicesTolerant`, wait.ts:15).
- Тест: unit — сервис с мок-выводом → idle wait содержит имя сервиса и tail.

**F6. Trace-превью для больших выводов: бэкпрессура поллинга**
- `TRACE_POLL_MS = 80` при каждых 80 мс парсит весь snapshot (до 8 MiB retained). На длинных командах ревью (журналы на тысячи записей) это CPU-нагрузка и GC-давление.
- Фикс: пропускать poll, если `trace.version()` не менялся (уже есть, `last`), **и** ограничить частоту `onTrace`-коллбеков до ≤4 Гц (throttle внутри pollRunTrace), т.к. UI не чаще и рендерит.
- Тест: unit — 100 изменений version за 1 c → ≤5 вызовов onTrace.

### P2 — полировка форка (полезные фичи)

**F7. Crash-дамп diag: при invalid trace сохранять сырой снапшот в артефакт**
- Вместе с F1: при провале валидации писать `/native-shell-trace-invalid-<ts>.json` в `~/.omp/logs/` (или артефакт-менеджер сессии) с полным JSON — чтобы следующий рассинхрон диагностировался за минуты, а не воспроизведением.
- Тест: unit — мок RunTrace с битым снапшотом → файл создан, содержит исходные байты.

**F8. `value: [45, …]` bytes-форма в TUI-replay: лосевое отображение**
- Часть F2, выделяю отдельно, т.к. это UX: shell-viz replay должен показывать русские значения переменных из bytes-формы (lossy-decode), а не `[object Array]` или пустоту.

### Порядок внедрения и гейты

| # | Файл(ы) | Зависимости | Гейт |
|---|---|---|---|
| F1 | `bash-executor.ts` | — | `bun check` + regression-тест репро-команды |
| F2 | `shell-trace.ts` + tui-потребители | F1 (независимо, но тестировать вместе) | `bun check` + golden-тест `/tmp/bad-trace.json` |
| F3 | `crates/pi-shell/.../text.rs` или cut/bounded | F2 | `bun run test:rs` + round-trip фикс |
| F4 | — | F1 | manual smoke |
| F5 | `wait.ts` + `services.ts` | — | unit-тест idle-возврата с сервис-сводкой |
| F6 | `bash-executor.ts` (pollRunTrace) | F1 | unit-тест throttle |
| F7 | `bash-executor.ts` + logger | F1 | unit-тест дамп-файла |
| F8 | `tool-execution.ts` (tui) | F2 | golden render-тест bytes-значения |

Changelog: `packages/coding-agent/CHANGELOG.md` (F1,F4,F5,F6,F7), `packages/wire/CHANGELOG.md` (F2), `packages/tui/CHANGELOG.md` (F8), `packages/natives/CHANGELOG.md` (F3).

---

## 4. Сопутствующие замечания (вне плана фиксов)

- **Ротация `GITLAB_TOKEN`** (`glpat-H_35PZWBjEs2CG049y7IZW86MQp1OjJ5YjcK.01.1017wcrhs`): токен в открытом виде в зашифрованных-at-rest, но не secret-scan-нутых сессионных логах (`gigahlp-15525` jsonl, строки 714/720). Рекомендация — отозвать и выдать новый через `~/.config/omp/secrets.env`.
- Fork launcher (`~/.local/lib/omp-fork/omp-launcher.sh`) и бэкапы (`omp.bak-*`) — рабочие, rollback-путь целый.
- Кандидаты в upstream (can1357/oh-my-pi): F1-F3 — это общий баг, не специфика форка; после реализации стоит оформить PR наверх.