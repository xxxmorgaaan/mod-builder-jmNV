// src/db.js
// Открывает (или создаёт) SQLite-базу, накатывает схему и один раз засевает
// игру Alem Colony и владельца админки — дальше всё живёт в data/modbuild.db.
//
// Экспортирует не сам объект better-sqlite3, а прокси поверх него. Нужно
// это для одной конкретной вещи: восстановления из резервной копии. Когда
// файл базы на диске подменяют (кнопка «Восстановить» или просто файл,
// закинутый в data/restore-inbox — см. src/restore-watcher.js), процесс
// сайта до этого момента продолжает работать со СТАРЫМ, уже открытым
// файловым дескриптором — подмена файла на диске сама по себе ничего не
// меняет, потому что коннекшен к базе открывается один раз при старте.
// Раньше это и было причиной, по которой «восстановление не работает»:
// файлы на диск записывались правильно, но сервер их просто не видел, пока
// кто-то вручную не перезапускал процесс.
// Прокси решает это иначе: `db.reload()` закрывает старое соединение и
// открывает новое на том же пути — а поскольку все файлы проекта держат
// один и тот же объект-прокси (Node кеширует require по модулю), после
// reload() они автоматически начинают работать с новыми данными, без
// перезапуска процесса.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'modbuild.db');

function openConnection() {
  const conn = new Database(DB_PATH);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  return conn;
}

function migrate(conn) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  conn.exec(schema);

  const modVersionCols = conn.prepare("PRAGMA table_info(mod_versions)").all().map(c => c.name);
  if (!modVersionCols.includes('scan_note')) {
    conn.exec('ALTER TABLE mod_versions ADD COLUMN scan_note TEXT');
    console.log('[db] Миграция: добавлена колонка mod_versions.scan_note');
  }

  const modCols = conn.prepare("PRAGMA table_info(mods)").all().map(c => c.name);
  if (!modCols.includes('user_id')) {
    conn.exec('ALTER TABLE mods ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    console.log('[db] Миграция: добавлена колонка mods.user_id');
  }
  const bundleCols = conn.prepare("PRAGMA table_info(bundles)").all().map(c => c.name);
  if (!bundleCols.includes('user_id')) {
    conn.exec('ALTER TABLE bundles ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    console.log('[db] Миграция: добавлена колонка bundles.user_id');
  }

  const userColsEarly = conn.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (userColsEarly.length && !userColsEarly.includes('avatar_path')) {
    conn.exec('ALTER TABLE users ADD COLUMN avatar_path TEXT');
    console.log('[db] Миграция: добавлена колонка users.avatar_path');
  }
  const commentCols = conn.prepare("PRAGMA table_info(mod_comments)").all().map(c => c.name);
  if (commentCols.length && !commentCols.includes('user_id')) {
    conn.exec('ALTER TABLE mod_comments ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    console.log('[db] Миграция: добавлена колонка mod_comments.user_id');
  }

  {
    const cols = conn.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    const addCol = (name, def) => {
      if (cols.includes(name)) return;
      conn.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
      console.log(`[db] Миграция: добавлена колонка users.${name}`);
    };
    addCol('telegram_id', 'INTEGER');
    addCol('telegram_username', 'TEXT');
    addCol('is_banned', 'INTEGER NOT NULL DEFAULT 0');
    addCol('last_ip', 'TEXT');
  }
  conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL');

  {
    const dupGroups = conn.prepare(
      `SELECT mod_id, LOWER(tag) AS low FROM mod_tags GROUP BY mod_id, LOWER(tag) HAVING COUNT(*) > 1`
    ).all();
    if (dupGroups.length) {
      const mergeTx = conn.transaction((groups) => {
        groups.forEach(({ mod_id, low }) => {
          conn.prepare('DELETE FROM mod_tags WHERE mod_id = ? AND LOWER(tag) = ?').run(mod_id, low);
          conn.prepare('INSERT OR IGNORE INTO mod_tags (mod_id, tag) VALUES (?, ?)').run(mod_id, low);
        });
      });
      mergeTx(dupGroups);
      console.log(`[db] Миграция: объединены теги-дубликаты в разном регистре (${dupGroups.length})`);
    }
    const mixedCase = conn.prepare(`SELECT COUNT(*) c FROM mod_tags WHERE tag != LOWER(tag)`).get().c;
    if (mixedCase) {
      conn.exec('UPDATE mod_tags SET tag = LOWER(tag)');
      console.log(`[db] Миграция: теги приведены к нижнему регистру (${mixedCase})`);
    }
  }
}

function seed(conn) {
  const gameExists = conn.prepare('SELECT 1 FROM games WHERE slug = ?').get('alem-colony');
  if (!gameExists) {
    conn.prepare('INSERT INTO games (id, slug, name) VALUES (?, ?, ?)')
      .run('alem-colony', 'alem-colony', 'Alem Colony');
    console.log('[db] Добавлена игра: Alem Colony');
  }

  const login = (process.env.OWNER_LOGIN || 'owner').trim();
  const pass = (process.env.OWNER_PASSWORD || 'change-me-now').trim();
  const owner = conn.prepare(`SELECT * FROM admins WHERE role = 'owner' LIMIT 1`).get();

  if (!owner) {
    const hash = bcrypt.hashSync(pass, 10);
    conn.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
      .run(login, hash, 'owner');
    console.log(`[db] Создан владелец админки: логин "${login}". Пароль — из OWNER_PASSWORD в .env. Смените его на вкладке «Настройки» после первого входа.`);
  } else if (process.env.SYNC_OWNER_PASSWORD === 'true') {
    const hash = bcrypt.hashSync(pass, 10);
    conn.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?').run(login, hash, owner.id);
    console.log(`[db] SYNC_OWNER_PASSWORD=true: логин/пароль владельца перезаписаны из .env ("${login}"). Уберите эту переменную после входа.`);
  }
}

function openAndPrepare() {
  const conn = openConnection();
  migrate(conn);
  seed(conn);
  return conn;
}

let inner = openAndPrepare();

function reload() {
  try { inner.close(); } catch (e) { /* соединение уже могло быть закрыто/битым — не страшно */ }
  inner = openAndPrepare();
  console.log('[db] Соединение с базой переоткрыто (reload) — восстановленные данные подхвачены без перезапуска процесса.');
}

const dbProxy = new Proxy({}, {
  get(target, prop) {
    if (prop === 'reload') return reload;
    const value = inner[prop];
    return typeof value === 'function' ? value.bind(inner) : value;
  },
});

module.exports = dbProxy;
