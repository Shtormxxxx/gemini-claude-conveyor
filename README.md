# Конвейер задач: Gemini Pro + Claude Pro

Один запрос в **Google Antigravity** запускает весь цикл разработки:
**план** (Claude) → **код** (вкладки Gemini в Chrome) → **сборка и проверки** → **ревью** (Claude) → **выкладка**.
Ты пишешь задачу одной строкой. Конвейер останавливается и спрашивает тебя, только когда без твоего решения нельзя.

> **English.** A task conveyor for Google Antigravity: one `/conveyor <task>` runs plan (Claude Code,
> headless) → code (Gemini tabs in Chrome, driven by Antigravity's browser agent) → checks → review
> (Claude) → commit, push and deploy. A small Node.js program does every exact step and enforces the
> guards: a clean start, protected paths, a secret scan, review-before-ship of the exact diff, and a
> quota guard for the Gemini tabs. Installs into any git project with `init`; also installs
> [ECC](https://github.com/affaan-m/ECC) for Antigravity. No dependencies; Node 20+.

---

## Как это устроено

```
        ты: /conveyor Добавь на главную блок с тарифами
                              │
1. ПЛАН          Claude (Claude Code в фоне) читает нужные файлы, пишет план и задания
                              │
2. КОД           Antigravity через @browser отправляет задания во вкладки Gemini в Chrome,
                 забирает ответы; программа раскладывает файлы по проекту
                              │
3. СБОРКА        Antigravity связывает импорты; программа гоняет проверки (lint, test, build)
                              │
4. РЕВЬЮ         Claude читает только дифф, точечно чинит, выносит вердикт
                 APPROVE / REWORK / ESCALATE
                              │
5. ВЫКЛАДКА      проверки ещё раз → коммит → push → твои команды деплоя → проверка в браузере
```

| Роль | Кто | Что делает |
|---|---|---|
| Архитектор | Claude Pro (Claude Code, в фоне) | план и задания для вкладок; длинный код не пишет, экономит лимит |
| Кодеры | Gemini во вкладках Chrome (по умолчанию две: `/u/1/` и `/u/2/`) | пишут файлы целиком по готовым заданиям |
| Дирижёр | Antigravity (Gemini Flash) + @browser | носит задания и ответы, запускает команды, чинит мелочи |
| Ревьюер | Claude Pro (Claude Code, в фоне) | проверяет дифф, правит, решает, можно ли выкладывать |
| Программа | `node conveyor/bin/conveyor.mjs` | всё точное: копирует, считает, проверяет, не пускает лишнее |

---

## Что нужно

- **Git** и **Node.js 20+** — https://nodejs.org
- **Claude Pro** и **Claude Code**:
  ```
  npm install -g @anthropic-ai/claude-code
  ```
  Если после установки `claude --version` пишет «не является командой», поставь официальным установщиком
  (PowerShell): `irm https://claude.ai/install.ps1 | iex`
- **Google Antigravity** с подпиской Google AI Pro. Браузерный агент (`@browser`) должен быть подключён к Chrome.
- Во вкладках Chrome — аккаунты Gemini для кодеров. Вкладок может быть одна, две или больше, это настраивается.

---

## Установка в свой проект

Проект должен быть git-репозиторием (`git init`, если ещё нет).

**1. Скачай конвейер** (один раз, в любую папку):
```
git clone https://github.com/Shtormxxxx/gemini-claude-conveyor
```

**2. Поставь его в проект** (Windows, cmd; путь в кавычках, если в нём пробелы):
```
node "C:\путь\к\gemini-claude-conveyor\bin\conveyor.mjs" init "C:\путь\к\твоему\проекту"
```
Что появится в проекте:

| Путь | Что это |
|---|---|
| `conveyor/` | программа, шаблоны, `conveyor.config.json`, инструкция |
| `.agents/workflows/conveyor.md` | команда `/conveyor` для Antigravity |
| `AGENTS.md`, `CLAUDE.md` | правила для агентов (отдельный размеченный раздел, остальное не трогается) |
| `.gitignore` | файлы прогонов и локальные файлы ECC не попадают в Git |

Заодно поставится **ECC** для Antigravity (см. ниже). Если он не нужен, добавь `--no-ecc`.

**3. Открой `conveyor/conveyor.config.json`** и проверь:
- `project` — одна строка о проекте: стек, язык, что важно. Её видят кодеры, у которых нет доступа к файлам;
- `checks` — команды проверки (для Node-проекта подставляются из `package.json` сами);
- `deploy` — команды выкладки (можно оставить пустым, тогда будут только коммит и push);
- `tabs` — адреса вкладок Gemini.

**4. Сохрани в Git:**
```
git add -A
git commit -m "Конвейер"
```

**5. Один раз запусти Claude Code в папке проекта:**
```
claude
```
1. Войди аккаунтом Claude Pro.
2. На «Do you trust the files in this folder?» ответь **Yes**.
3. На вопросы про MCP-серверы ответь **Continue without**.
4. Выйди: `/exit`.

**6. Проверь готовность:**
```
node conveyor/bin/conveyor.mjs doctor
```
Должно появиться `CONVEYOR: READY`. Если нет — в каждой строке с `✗` написано, что сделать.

**7. В Antigravity:**
1. **File → Open Folder** → папка проекта, режим **Local**.
2. Нажми **New Conversation**.
3. Набери:
```
/conveyor Добавь кнопку «Наверх» в подвал сайта
```

---

## Защита (гарды)

Агент может ошибиться или поддаться странному тексту из ответа модели. Поэтому всё важное проверяет программа:

| Гард | Что делает |
|---|---|
| **Чистый старт** | прогон начинается только с сохранённой папки, поэтому дифф — ровно работа прогона |
| **План без правок** | если Claude при планировании изменил файлы проекта, прогон останавливается |
| **Никаких секретов в чатах** | `.env`, ключи, `*.pem`, `credentials*.json` и подобное никогда не вставляются во вкладки |
| **Запретные пути для ответов** | ответы из вкладок не пишут в секреты, `.git`, `node_modules`, сборку, lock-файлы, сам конвейер и правила агентов (даже в файлы прогона: вердикт подделать нельзя) |
| **Оборванный ответ** | файл, на котором ответ оборвался, не записывается наполовину. Конвейер просит прислать его заново |
| **Ревью точного диффа** | выкладка идёт только после `APPROVE`, и только того диффа, который проверил Claude; любая правка после ревью её блокирует |
| **Только с твоего слова** | зависимости, CI, `.gitignore`, файлы секретов, сам конвейер, правила агентов и твои пути из `ownerOnly` выкладываются только командой `ship --owner-ok`, которую набираешь ты |
| **Поиск ключей в диффе** | строки, похожие на ключи Google/OpenAI/Anthropic/GitHub/AWS/Stripe/Slack или приватные ключи, держат выкладку до твоего слова |
| **Слишком большой прогон** | больше `limits.maxChangedFiles` файлов (по умолчанию 60) — только с твоего слова |
| **Отмена без потерь** | `abort` убирает изменения прогона в `git stash`, их можно вернуть |

---

## Квоты (Quota Guard)

Мощная модель во вкладке тратит пятичасовой лимит намного быстрее быстрой. Узнать остаток у Google
программа не может, поэтому считает сама: каждое задание, отправленное во вкладку, — один «тяжёлый
запрос» в скользящем окне.

- Каждой вкладке положено `quota.budget` запросов за `quota.windowHours` часов. По умолчанию 12 за 5 часов,
  это примерно 70–75% лимита, остальное остаётся в запасе.
- Вкладка на пределе пропускает ход до освобождения окна. Её обычные задания делает быстрая модель
  Antigravity, а помеченные в плане как `WEIGHT: heavy` — модель Claude в Antigravity: у неё отдельный лимит.
- Сам дирижёр: если в **View Usage** Antigravity осталось 30% или меньше лимита Gemini, он на весь прогон
  переключается на Claude.
- Ручные запросы во вкладках конвейер не видит. Если Gemini пишет про лимит, отметь вкладку:
  `node conveyor/bin/conveyor.mjs status --block ARGON_1`. Снять — `--unblock`, обнулить — `--reset`.

---

## ECC для Antigravity

[ECC](https://github.com/affaan-m/ECC) от affaan-m (MIT) добавляет в Antigravity правила, навыки,
агентов и воркфлоу.

- **Ставится сам:** при `init` и перед каждым прогоном, если его нет. Ставится в `.agents/` проекта командой
  `npx ecc-universal@<версия> install --profile minimal --target antigravity`.
- **Версия закреплена** в `conveyor.config.json` (`ecc.version`). Чужие обновления сами не прилетают.
  Обновить — поменяй версию и запусти `node conveyor/bin/conveyor.mjs setup`.
- **Профиль `minimal`** — без хуков, только файлы.
- **Файлы ECC не попадают в Git:** ECC записывает абсолютные пути машины, поэтому у каждого он ставится
  свой. В Git идёт только `.agents/workflows/conveyor.md`.
- **Выключить:** `"ecc": { "enabled": false }`.

---

## Настройки: `conveyor/conveyor.config.json`

| Ключ | По умолчанию | Что значит |
|---|---|---|
| `project` | из `package.json` | одна строка о проекте для кодеров |
| `reportLanguage` | `Russian` | язык отчётов Antigravity тебе |
| `checks` | из `package.json` | команды проверки, по порядку |
| `deploy` | `[]` | команды выкладки: строка — всегда; `{ "run": "...", "when": "^api/" }` — только если менялись такие пути |
| `push` | `true` | делать `git push` после коммита |
| `claude.model` | `opus` | модель Claude для плана и ревью (`sonnet` экономнее). Разово: `set CONVEYOR_MODEL=sonnet` |
| `tabs` | две вкладки Gemini | `{ "id": "ARGON_1", "url": "https://gemini.google.com/u/1/app", "model": "Gemini 4 Argon" }` |
| `quota` | `12` за `5` ч | бюджет каждой вкладки |
| `limits` | `60` файлов, `150000` символов диффа | порог «слишком большого» прогона и сколько диффа видит ревьюер |
| `secrets`, `neverWrite`, `ownerOnly` | `[]` | твои добавки к встроенной защите. Убрать встроенную нельзя |
| `ecc` | `2.2.3`, `minimal` | ECC для Antigravity |

Пример для сайта на Firebase с отдельным сервером на Cloudflare:
```json
{
  "project": "A React 19 + Vite site in JavaScript, with Firebase (Firestore, Google sign-in) and a Cloudflare Worker in worker/.",
  "checks": ["npm run lint", "npm test", "npm run build"],
  "deploy": [
    "firebase deploy --only firestore,hosting",
    { "run": "npm run examiner:deploy", "when": "^(worker|functions)/" }
  ],
  "ownerOnly": [
    { "pattern": "^firestore\\.rules$", "reason": "кто может читать и писать базу" },
    { "pattern": "^firebase\\.json$", "reason": "заголовки безопасности и CSP" }
  ]
}
```

---

## Команды

Все команды — из корня проекта: `node conveyor/bin/conveyor.mjs <команда>`.

| Команда | Что делает |
|---|---|
| `doctor` | что готово, а что нет |
| `status` | квоты вкладок и последние прогоны; `--block` / `--unblock` / `--reset <TAB>` |
| `setup` | поставить ECC вручную |
| `abort` | бросить прогон: изменения в `git stash` |
| `plan`, `apply`, `diff`, `review`, `ship` | шаги прогона, их запускает Antigravity |
| `ship --owner-ok` | выложить то, что ждёт твоего слова. Только ты |

Каждая команда заканчивается строкой `CONVEYOR: …`: что случилось и что дальше.

---

## Обновление

Скачай свежую версию (`git pull` в папке конвейера) и снова выполни `init` для проекта. Программа и
воркфлоу обновятся, твой `conveyor.config.json` останется как был.

---

## Частые проблемы

| Что видишь | Что делать |
|---|---|
| `claude` «не является командой» | новый npm не запустил установочный скрипт. Поставь через PowerShell: `irm https://claude.ai/install.ps1 \| iex`, потом открой новое окно терминала |
| `STOP — the folder has changes from before this run` | закоммить свои изменения (`git add -A`, `git commit -m "..."`) и запусти заново |
| `Claude stopped … usage limit` | закончился лимит Claude Pro: подожди до сброса или поставь `CONVEYOR_MODEL=sonnet` |
| Antigravity не видит `/conveyor` | новый разговор (**New Conversation**). Проверь, что есть файл `.agents/workflows/conveyor.md` |
| `git pull` ругается на локальные изменения | `git status`, сохрани или верни свои изменения, повтори |
| Файл создался как `имя.js.txt` | в Проводнике включи **Вид → Расширения имён файлов** и переименуй |
| `LF will be replaced by CRLF` | безвредное предупреждение Git в Windows |

---

## Честно об ограничениях

- **Браузер — самое хрупкое звено.** Если интерфейс Gemini поменяется, @browser может не найти кнопку.
  Тогда Antigravity сам пишет эту часть по тому же заданию, а прогон продолжается.
- **Квоты — оценка.** Настоящий остаток знает только Google. Подгони `quota.budget` под свои наблюдения.
- **Условия сервисов.** Автоматизация веб-интерфейса Gemini и работа с несколькими аккаунтами ради лимитов
  могут противоречить условиям Google. Решай сам. Конвейер работает и с одной вкладкой, и вообще без вкладок
  (тогда задания делает Antigravity).
- **Лимиты Claude Pro** тратятся на план и ревью. Для экономии поставь `claude.model: "sonnet"`.
- Тесты гоняются на Linux и Windows (`npm test`): полный прогон с заглушкой вместо Claude.

---

## Лицензия

MIT. ECC — отдельный проект со своей лицензией (MIT), ставится из npm, а не копируется сюда.
