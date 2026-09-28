// src/session-store.js
// Собственное хранилище сессий на базе той же SQLite-базы, что и весь
// остальной сайт — без сторонних npm-пакетов вроде connect-sqlite3.
//
// Зачем это вообще нужно: по умолчанию express-session хранит сессии
// прямо в памяти процесса (MemoryStore). Как только сервер перезапускается
// (обновили код, упал процесс, перезагрузили VPS/телефон) — вся память
// обнуляется, и ВСЕ пользователи разом вылетают из аккаунтов, будто
// впервые зашли на сайт. Именно из-за этого раньше приходилось заново
// логиниться. Храня сессии в файле базы данных, они переживают перезапуск
// сервера точно так же, как переживают его моды и пользователи.
const { Store } = require('express-session');

class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');

    // ВАЖНО: запросы готовятся заново при каждом вызове (db.prepare(...)
    // прямо в методах ниже), а не один раз здесь в конструкторе. Если база
    // была переоткрыта через db.reload() (после восстановления из бэкапа),
    // statement'ы, подготовленные на старом соединении, начинают падать —
    // а метод get()/set() ниже каждый раз берёт db.prepare() заново и сам
    // подхватывает актуальное соединение.

    // Раз в час подчищаем истёкшие сессии, чтобы таблица не росла вечно.
    const timer = setInterval(() => {
      try { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch (e) { /* не критично */ }
    }, 60 * 60 * 1000);
    if (timer.unref) timer.unref(); // не мешает процессу нормально завершиться

    this.defaultMaxAge = 1000 * 60 * 60 * 24 * 30; // 30 дней, если у cookie не задан свой maxAge
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || this.defaultMaxAge;
      this.db.prepare(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
      ).run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || this.defaultMaxAge;
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() + maxAge, sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }
}

module.exports = SqliteSessionStore;
