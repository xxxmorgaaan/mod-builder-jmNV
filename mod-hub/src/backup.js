// src/backup.js
// Общая логика резервного копирования/восстановления — используется и
// кнопкой в админке (routes/admin.js), и автоматическим наблюдателем за
// папкой data/restore-inbox (src/restore-watcher.js), чтобы не дублировать
// код в двух местах.
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const db = require('./db');

const ROOT = path.join(__dirname, '..');

/** Снимок «живой активности» прямо перед восстановлением — то, что
 *  накопилось уже ПОСЛЕ момента, когда был сделан бэкап (новые
 *  комментарии, скачивания, лайки). Матчим моды не по внутреннему id (он
 *  мог не совпадать, если между бэкапом и восстановлением база успевала
 *  обнулиться и мод пересоздавался), а по паре game_id+slug — она
 *  стабильна для мода на всё время его жизни. */
function snapshotLiveActivity() {
  try {
    const mods = db.prepare('SELECT id, game_id, slug, downloads, likes FROM mods').all();
    const comments = db.prepare(
      `SELECT m.game_id, m.slug, c.author_name, u.username author_username, c.body, c.created_at
       FROM mod_comments c JOIN mods m ON m.id = c.mod_id LEFT JOIN users u ON u.id = c.user_id`
    ).all();
    const likeVotes = db.prepare(
      `SELECT m.game_id, m.slug, l.voter_token
       FROM mod_likes l JOIN mods m ON m.id = l.mod_id`
    ).all();
    return { mods, comments, likeVotes };
  } catch (e) {
    // Самый первый запуск (таблиц ещё может не быть) — снимать нечего.
    return { mods: [], comments: [], likeVotes: [] };
  }
}

/** Накладывает снимок сверху на только что восстановленную базу: числа —
 *  по максимуму (не откатываем то, что уже накопилось живьём), комментарии
 *  и голоса-лайки — добавляем те, которых в восстановленной базе ещё нет. */
function reapplyLiveActivity(snapshot) {
  const result = { statsRestored: 0, commentsRestored: 0, likesRestored: 0 };
  if (!snapshot || !snapshot.mods.length) return result;

  const findMod = db.prepare('SELECT id, downloads, likes FROM mods WHERE game_id = ? AND slug = ?');
  const updateStats = db.prepare('UPDATE mods SET downloads = ?, likes = ? WHERE id = ?');
  const commentExists = db.prepare(
    'SELECT 1 FROM mod_comments WHERE mod_id = ? AND author_name = ? AND body = ? AND created_at = ?'
  );
  const findUserByUsername = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
  const insertComment = db.prepare(
    'INSERT INTO mod_comments (mod_id, author_name, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertLikeVote = db.prepare('INSERT OR IGNORE INTO mod_likes (mod_id, voter_token) VALUES (?, ?)');

  const modIdBySlug = new Map(); // 'game_id/slug' -> восстановленный id, чтобы не искать заново для лайков/комментов
  snapshot.mods.forEach((old) => {
    const current = findMod.get(old.game_id, old.slug);
    if (!current) return; // такого мода в восстановленных данных нет — не наш случай
    modIdBySlug.set(`${old.game_id}/${old.slug}`, current.id);
    const downloads = Math.max(current.downloads, old.downloads);
    const likes = Math.max(current.likes, old.likes);
    if (downloads !== current.downloads || likes !== current.likes) {
      updateStats.run(downloads, likes, current.id);
      result.statsRestored++;
    }
  });

  snapshot.comments.forEach((c) => {
    const modId = modIdBySlug.get(`${c.game_id}/${c.slug}`);
    if (!modId) return;
    if (commentExists.get(modId, c.author_name, c.body, c.created_at)) return;
    const user = c.author_username ? findUserByUsername.get(c.author_username) : null;
    insertComment.run(modId, c.author_name, user ? user.id : null, c.body, c.created_at);
    result.commentsRestored++;
  });

  snapshot.likeVotes.forEach((v) => {
    const modId = modIdBySlug.get(`${v.game_id}/${v.slug}`);
    if (!modId) return;
    const info = insertLikeVote.run(modId, v.voter_token);
    if (info.changes) result.likesRestored++;
  });

  return result;
}

/** Распаковывает .zip резервной копии поверх текущих данных (база +
 *  загруженные файлы) и — это главное — переоткрывает соединение с базой
 *  (db.reload()), чтобы уже запущенный сервер сразу увидел новые данные,
 *  без ручного перезапуска процесса. Перед перезаписью снимает «живую»
 *  активность (комментарии/скачивания/лайки) и накладывает её обратно
 *  поверх восстановленных данных — иначе бэкап отматывал бы эти счётчики
 *  назад к моменту, когда бэкап был сделан. */
async function restoreFromZipFile(zipPath) {
  let restoredDb = false;
  let restoredFiles = 0;

  const liveSnapshot = snapshotLiveActivity();

  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    // Пускаем только те пути, которые сами же кладём в бэкап — чтобы архив
    // не мог записать что-то поверх кода приложения.
    const ok = entry.path === 'data/modbuild.db'
      || /^public\/uploads\/(covers|screenshots|archives|bugs|avatars)\/[^/]+$/.test(entry.path);
    if (!ok || entry.path.includes('..')) continue;

    const dest = path.join(ROOT, entry.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.buffer());
    if (entry.path === 'data/modbuild.db') restoredDb = true; else restoredFiles++;
  }

  let merge = { statsRestored: 0, commentsRestored: 0, likesRestored: 0 };
  if (restoredDb) {
    db.reload();
    merge = reapplyLiveActivity(liveSnapshot);
  }

  return { restoredDb, restoredFiles, ...merge };
}

module.exports = { restoreFromZipFile };
