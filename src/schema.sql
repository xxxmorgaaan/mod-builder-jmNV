-- schema.sql
-- Модерация: и mods.status, и bundles.status идут через 'pending' → 'approved'
-- (или 'rejected'), плюс отдельное 'hidden' — админ/автор снял уже одобренную
-- запись с витрины, не удаляя её. Публично видно только status = 'approved'.

CREATE TABLE IF NOT EXISTS games (
  id   TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mods (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id),
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  summary            TEXT,
  description        TEXT,
  cover_path         TEXT,
  control_code_hash  TEXT NOT NULL,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | hidden
  moderation_note    TEXT,
  downloads          INTEGER NOT NULL DEFAULT 0,
  likes              INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mods_game_slug ON mods(game_id, slug);
CREATE INDEX IF NOT EXISTS idx_mods_status ON mods(status);
CREATE INDEX IF NOT EXISTS idx_mods_user_id ON mods(user_id);

CREATE TABLE IF NOT EXISTS mod_tags (
  mod_id TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  tag    TEXT NOT NULL,
  PRIMARY KEY (mod_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_mod_tags_tag ON mod_tags(tag);

CREATE TABLE IF NOT EXISTS mod_screenshots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  mod_id   TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mod_screenshots_mod_id ON mod_screenshots(mod_id);

CREATE TABLE IF NOT EXISTS mod_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mod_id       TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  version_label TEXT NOT NULL,
  changelog    TEXT,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending', -- новая версия тоже ждёт проверки
  scan_note    TEXT, -- результат автопроверки файла (эвристика + ClamAV, если подключён) — см. src/scan.js
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_versions_mod_id ON mod_versions(mod_id);
CREATE INDEX IF NOT EXISTS idx_mod_versions_status ON mod_versions(status);

CREATE TABLE IF NOT EXISTS mod_likes (
  mod_id      TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  voter_token TEXT NOT NULL,
  PRIMARY KEY (mod_id, voter_token)
);

CREATE TABLE IF NOT EXISTS mod_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mod_id      TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = комментарий гостя
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_comments_mod_id ON mod_comments(mod_id);

CREATE TABLE IF NOT EXISTS bundles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT UNIQUE NOT NULL,
  game_id           TEXT NOT NULL REFERENCES games(id),
  slug              TEXT NOT NULL,
  name              TEXT NOT NULL,
  summary           TEXT,
  description       TEXT,
  cover_path        TEXT,
  control_code_hash TEXT NOT NULL,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  moderation_note   TEXT,
  likes             INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundles_game_slug ON bundles(game_id, slug);

CREATE TABLE IF NOT EXISTS bundle_mods (
  bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  mod_id    TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  PRIMARY KEY (bundle_id, mod_id)
);

CREATE TABLE IF NOT EXISTS bundle_likes (
  bundle_id   INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  voter_token TEXT NOT NULL,
  PRIMARY KEY (bundle_id, voter_token)
);

CREATE TABLE IF NOT EXISTS complaints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type  TEXT NOT NULL, -- 'mod' | 'bundle'
  target_id    TEXT NOT NULL,
  reporter_note TEXT,
  token_hash   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open', -- open | resolved
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);

CREATE TABLE IF NOT EXISTS complaint_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  sender       TEXT NOT NULL, -- 'user' | 'admin'
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_complaint_messages_complaint_id ON complaint_messages(complaint_id);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'moderator', -- 'owner' | 'moderator'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------- аккаунты разработчиков
-- Необязательная альтернатива коду управления: кто не хочет хранить код,
-- может завести логин/пароль — тогда все его моды и сборки видно и можно
-- редактировать из личного кабинета без кода вообще. Код при этом всё
-- равно выдаётся (для запасного доступа), просто можно не запоминать.

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,
  avatar_path        TEXT,
  telegram_id        INTEGER UNIQUE,
  telegram_username  TEXT,
  is_banned          INTEGER NOT NULL DEFAULT 0,
  last_ip            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- баны по IP
-- Отдельно от users.is_banned: можно забанить IP, за которым вообще нет
-- аккаунта (гость), и один и тот же IP автоматически подхватывает бан
-- пользователя, у которого он был последним известным (last_ip).
CREATE TABLE IF NOT EXISTS banned_ips (
  ip         TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- счётчик посещений
-- Один ряд на день, число — просто счётчик просмотров страниц (не уникальных
-- посетителей). Для «за месяц» в админке суммируются все дни с тем же
-- префиксом YYYY-MM — отдельная таблица не нужна.
CREATE TABLE IF NOT EXISTS visit_counters (
  day   TEXT PRIMARY KEY, -- 'YYYY-MM-DD'
  count INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------- баг-репорты
-- Публичный трекер багов: без модерации (сразу видно всем, как в обычном
-- форуме), с картинками, голосами и обсуждением в комментариях.

CREATE TABLE IF NOT EXISTS bug_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT,
  reporter_name TEXT NOT NULL DEFAULT 'Гость',
  status        TEXT NOT NULL DEFAULT 'open', -- open | in_progress | resolved | wontfix
  votes         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);

CREATE TABLE IF NOT EXISTS bug_screenshots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id   INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bug_screenshots_bug_id ON bug_screenshots(bug_id);

CREATE TABLE IF NOT EXISTS bug_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bug_comments_bug_id ON bug_comments(bug_id);

CREATE TABLE IF NOT EXISTS bug_votes (
  bug_id      INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  voter_token TEXT NOT NULL,
  PRIMARY KEY (bug_id, voter_token)
);

-- ------------------------------------------------------------- журнал действий модераторов
-- Кто, что и когда одобрил/отклонил/удалил/забанил — видно в /admin/log.
CREATE TABLE IF NOT EXISTS admin_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_name TEXT NOT NULL,       -- логин админа, либо "Telegram-бот"
  action     TEXT NOT NULL,       -- 'approve_mod', 'reject_mod', 'ban_user' и т.п.
  target     TEXT,                -- человекочитаемое имя объекта (название мода и т.п.)
  details    TEXT,                -- доп. инфо (причина отклонения и т.п.)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at);

-- ------------------------------------------------------------- скачивания по дням
-- Для графика «Статистика по своим модам» в личном кабинете — отдельно от
-- mods.downloads (общий счётчик), тут разбивка по дням.
CREATE TABLE IF NOT EXISTS mod_download_log (
  mod_id TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  day    TEXT NOT NULL, -- 'YYYY-MM-DD' по московскому времени
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mod_id, day)
);
