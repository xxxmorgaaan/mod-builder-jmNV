// routes/pages.js
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../src/db');
const { slugify, issueControlCode, verifyControlCode, recordIdFromCode, getVoterToken, canManage, normalizeTag } = require('../src/helpers');
const { uploadModFiles } = require('../src/upload');
const { scanUpload, safeUnlink } = require('../src/scan');
const { notifyAdmin } = require('../src/telegram');
const { logAction } = require('../src/audit');

const router = express.Router();

const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: 'Слишком много публикаций за час. Попробуйте позже.' });

// ---------------------------------------------------------------- helpers
function getGameBySlug(slug) {
  return db.prepare('SELECT * FROM games WHERE slug = ?').get(slug);
}
function tagsFor(modId) {
  return db.prepare('SELECT tag FROM mod_tags WHERE mod_id = ? ORDER BY tag').all(modId).map(r => r.tag);
}
function screenshotsFor(modId) {
  return db.prepare('SELECT * FROM mod_screenshots WHERE mod_id = ? ORDER BY position').all(modId);
}
function versionsFor(modId, { onlyApproved = true } = {}) {
  const sql = onlyApproved
    ? 'SELECT * FROM mod_versions WHERE mod_id = ? AND status = \'approved\' ORDER BY id DESC'
    : 'SELECT * FROM mod_versions WHERE mod_id = ? ORDER BY id DESC';
  return db.prepare(sql).all(modId);
}
function attachSummary(mod) {
  const modAuthor = mod.user_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(mod.user_id) : null;
  return { ...mod, tags: tagsFor(mod.id), cover_path: mod.cover_path, author_username: modAuthor ? modAuthor.username : null };
}

// ---------------------------------------------------------------- главная
router.get('/', (req, res) => {
  const game = getGameBySlug('alem-colony');
  // «Популярное» — не просто у кого больше лайков (у старых модов их
  // естественно накапливается больше), а по соотношению лайков к
  // скачиваниям — так наверх попадают мод которые нравятся, а не только
  // самые старые/скачиваемые. +5 в знаменателе — сглаживание, чтобы мод с
  // 1 скачиванием и 1 лайком не обгонял по «100% рейтингу» реально
  // популярные; минимум 3 скачивания — чтобы совсем свежие мода не
  // попадали в топ на пустом месте.
  const featured = db.prepare(
    `SELECT * FROM mods WHERE game_id = ? AND status = 'approved' AND downloads >= 3
     ORDER BY (CAST(likes AS REAL) / (downloads + 5)) DESC, likes DESC LIMIT 6`
  ).all(game.id).map(attachSummary);
  const recent = db.prepare(
    `SELECT * FROM mods WHERE game_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 6`
  ).all(game.id).map(attachSummary);
  const updated = db.prepare(
    `SELECT * FROM mods WHERE game_id = ? AND status = 'approved' AND updated_at > created_at ORDER BY updated_at DESC LIMIT 6`
  ).all(game.id).map(attachSummary);
  const modCount = db.prepare(`SELECT COUNT(*) c FROM mods WHERE game_id = ? AND status = 'approved'`).get(game.id).c;

  res.render('home', { title: 'Alem Mod — моды для Alem Colony', game, featured, recent, updated, modCount });
});

// ---------------------------------------------------------------- каталог игры
router.get('/games/:slug', (req, res) => {
  const game = getGameBySlug(req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Игра не найдена' });

  const q = (req.query.q || '').trim();
  const tag = normalizeTag(req.query.tag || '');
  const sort = req.query.sort || 'new';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 12;

  let baseSql = `SELECT DISTINCT m.* FROM mods m LEFT JOIN mod_tags t ON t.mod_id = m.id
             WHERE m.game_id = ? AND m.status = 'approved'`;
  const params = [game.id];
  if (q) { baseSql += ' AND (m.name LIKE ? OR m.summary LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (tag) { baseSql += ' AND LOWER(t.tag) = ?'; params.push(tag); }

  const orderMap = {
    new: 'm.created_at DESC',
    updated: 'm.updated_at DESC',
    downloads: 'm.downloads DESC',
    likes: 'm.likes DESC',
    az: 'm.name COLLATE NOCASE ASC',
  };

  // COUNT(*) по тому же WHERE — быстрее, чем один раз вытащить все строки
  // ради total и вручную резать их в JS, особенно когда модов станет много.
  const total = db.prepare(`SELECT COUNT(*) c FROM (${baseSql})`).get(...params).c;

  const pageSql = `${baseSql} ORDER BY ${orderMap[sort] || orderMap.new} LIMIT ? OFFSET ?`;
  const pageItems = db.prepare(pageSql).all(...params, perPage, (page - 1) * perPage).map(attachSummary);

  const popularTags = db.prepare(
    `SELECT LOWER(t.tag) AS tag, COUNT(*) c FROM mod_tags t JOIN mods m ON m.id = t.mod_id
     WHERE m.game_id = ? AND m.status = 'approved' GROUP BY LOWER(t.tag) ORDER BY c DESC LIMIT 16`
  ).all(game.id);

  res.render('catalog', {
    title: `Моды для ${game.name}`, game, mods: pageItems, total, page, perPage,
    pages: Math.max(1, Math.ceil(total / perPage)), q, tag, sort, popularTags,
  });
});

// ---------------------------------------------------------------- публикация
// ВАЖНО: этот роут должен стоять РАНЬШЕ '/mods/:slug' ниже — иначе Express
// принимает "new" за slug мода, ищет несуществующий мод и отдаёт 404.
router.get('/mods/new', (req, res) => {
  const game = getGameBySlug('alem-colony');
  res.render('mod-form', { title: 'Опубликовать мод', game, mode: 'create', mod: null, tags: [] });
});

// ---------------------------------------------------------------- страница мода
router.get('/mods/:slug', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE slug = ?').get(req.params.slug);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });

  const authorized = canManage(req, req.query.code || '', mod.control_code_hash, mod.user_id);
  if (mod.status !== 'approved' && !authorized) {
    return res.status(403).render('pending', { title: 'Мод ещё на модерации', mod });
  }

  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(mod.game_id);
  const versions = versionsFor(mod.id, { onlyApproved: !authorized });
  const screenshots = screenshotsFor(mod.id);
  const tags = tagsFor(mod.id);
  const comments = db.prepare(
    `SELECT c.*, u.username author_username, u.avatar_path author_avatar
     FROM mod_comments c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.mod_id = ? ORDER BY c.created_at DESC`
  ).all(mod.id);
  const author = mod.user_id ? db.prepare('SELECT username, avatar_path FROM users WHERE id = ?').get(mod.user_id) : null;
  const similar = db.prepare(
    `SELECT DISTINCT m.* FROM mods m JOIN mod_tags t ON t.mod_id = m.id
     WHERE m.game_id = ? AND m.id != ? AND m.status = 'approved' AND t.tag IN (${tags.map(() => '?').join(',') || "''"})
     ORDER BY m.likes DESC LIMIT 4`
  ).all(game.id, mod.id, ...tags).map(attachSummary);

  const voter = getVoterToken(req, res);
  const liked = !!db.prepare('SELECT 1 FROM mod_likes WHERE mod_id = ? AND voter_token = ?').get(mod.id, voter);

  res.render('mod-detail', { title: mod.name, mod, game, versions, screenshots, tags, comments, similar, liked, authorized, author, code: req.query.code || '' });
});

router.post('/mods', createLimiter, uploadModFiles.fields([
  { name: 'cover', maxCount: 1 }, { name: 'screenshots', maxCount: 8 }, { name: 'archive', maxCount: 1 },
]), async (req, res) => {
  const game = getGameBySlug('alem-colony');
  const name = (req.body.name || '').trim();
  const summary = (req.body.summary || '').trim();
  const description = (req.body.description || '').trim();
  const versionLabel = (req.body.version || '1.0').trim();
  const changelog = (req.body.changelog || 'Первая публикация.').trim();
  const tags = [...new Set((req.body.tags || '').split(',').map(normalizeTag).filter(Boolean))].slice(0, 10);
  const archive = req.files.archive && req.files.archive[0];
  const cover = req.files.cover && req.files.cover[0];
  const screenshots = req.files.screenshots || [];

  const cleanupUploaded = () => {
    if (archive) safeUnlink(archive.path);
    if (cover) safeUnlink(cover.path);
    screenshots.forEach(f => safeUnlink(f.path));
  };

  // Смотрим статус бана заново в базе, а не в сессии — сессия могла быть
  // открыта ещё до бана и просто не знать о нём.
  if (req.session && req.session.user) {
    const fresh = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(req.session.user.id);
    if (fresh && fresh.is_banned) {
      cleanupUploaded();
      return res.status(403).render('mod-form', {
        title: 'Опубликовать мод', game, mode: 'create', mod: req.body, tags,
        error: 'Ваш аккаунт заблокирован администрацией — публикация модов недоступна.',
      });
    }
  }

  if (!name || !archive) {
    cleanupUploaded();
    return res.status(400).render('mod-form', {
      title: 'Опубликовать мод', game, mode: 'create', mod: req.body, tags,
      error: 'Нужно хотя бы название и файл архива мода (.zip).',
    });
  }

  const scan = await scanUpload(archive.path);
  if (scan.blocked) {
    cleanupUploaded();
    return res.status(400).render('mod-form', {
      title: 'Опубликовать мод', game, mode: 'create', mod: req.body, tags,
      error: `Файл не прошёл проверку и был удалён: ${scan.note}`,
    });
  }

  const id = slugify(name);
  const slug = id;
  const { code, hash } = issueControlCode(id);
  const ownerUserId = (req.session && req.session.user) ? req.session.user.id : null;

  db.prepare(`INSERT INTO mods (id, game_id, slug, name, summary, description, cover_path, control_code_hash, user_id, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(id, game.id, slug, name, summary, description, cover ? `/uploads/covers/${cover.filename}` : null, hash, ownerUserId);

  const insTag = db.prepare('INSERT OR IGNORE INTO mod_tags (mod_id, tag) VALUES (?, ?)');
  tags.forEach(t => insTag.run(id, t));

  const insShot = db.prepare('INSERT INTO mod_screenshots (mod_id, path, position) VALUES (?, ?, ?)');
  screenshots.forEach((f, i) => insShot.run(id, `/uploads/screenshots/${f.filename}`, i));

  db.prepare(`INSERT INTO mod_versions (mod_id, version_label, changelog, file_path, file_size, status, scan_note)
              VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, versionLabel, changelog, `/uploads/archives/${archive.filename}`, archive.size, scan.note);

  const authorLabel = ownerUserId
    ? (db.prepare('SELECT username FROM users WHERE id = ?').get(ownerUserId) || {}).username || 'аккаунт'
    : 'гость (без аккаунта)';
  const moderationUrl = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/admin/moderation`
    : '/admin/moderation (в админке сайта)';
  notifyAdmin(
    `🆕 Кто-то добавил новый мод на сайт!\n`
    + `Название: <b>${name}</b>\n`
    + `Автор: ${authorLabel}\n`
    + `Проверить: ${moderationUrl}`
  );

  res.render('mod-published', { title: 'Мод отправлен на модерацию', mod: { id, name, slug }, code, loggedIn: !!ownerUserId });
});

// ---------------------------------------------------------------- управление по коду
router.get('/manage.html', (req, res) => {
  res.render('manage', { title: 'Управление по коду' });
});

router.post('/manage/lookup', (req, res) => {
  const code = (req.body.code || '').trim();
  const kind = req.body.kind === 'bundle' ? 'bundle' : 'mod';
  const id = recordIdFromCode(code);
  if (!id) return res.render('manage', { title: 'Управление по коду', error: 'Код не похож на настоящий — проверьте, что скопировали его целиком.' });

  if (kind === 'mod') {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(id);
    if (!mod || !verifyControlCode(code, mod.control_code_hash)) {
      return res.render('manage', { title: 'Управление по коду', error: 'Мод с таким кодом не найден.' });
    }
    return res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}`);
  }
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(id);
  if (!bundle || !verifyControlCode(code, bundle.control_code_hash)) {
    return res.render('manage', { title: 'Управление по коду', error: 'Сборка с таким кодом не найдена.' });
  }
  res.redirect(`/bundles/${bundle.public_id}/edit?code=${encodeURIComponent(code)}`);
});

// ---------------------------------------------------------------- редактирование мода
router.get('/mods/:id/edit', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.query.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) {
    return res.status(403).render('manage', { title: 'Управление по коду', error: 'Код не подходит к этому моду.' });
  }
  res.render('mod-form', {
    title: `Редактировать: ${mod.name}`, game: db.prepare('SELECT * FROM games WHERE id=?').get(mod.game_id),
    mode: 'edit', mod, tags: tagsFor(mod.id).join(', '), code,
    versions: versionsFor(mod.id, { onlyApproved: false }), screenshots: screenshotsFor(mod.id),
  });
});

router.post('/mods/:id', uploadModFiles.fields([{ name: 'cover', maxCount: 1 }, { name: 'screenshots', maxCount: 8 }]), (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.body.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) return res.status(403).send('Неверный код управления.');

  // Временная диагностика — если после сохранения изменения по-прежнему не
  // применяются, посмотрите `pm2 logs mod-hub` сразу после клика «Сохранить
  // изменения»: эта строка покажет, дошли ли вообще description/файлы до
  // сервера, или проблема раньше (в браузере/форме). Можно убрать, когда
  // разберёмся — на работу сайта не влияет.
  console.log('[mod-edit]', mod.id, {
    hasDescription: 'description' in req.body, descriptionLen: (req.body.description || '').length,
    hasCoverFile: !!(req.files && req.files.cover), screenshotsCount: (req.files && req.files.screenshots || []).length,
  });

  const name = (req.body.name || mod.name).trim();
  const summary = (req.body.summary || '').trim();
  const description = (req.body.description || '').trim();
  const tags = [...new Set((req.body.tags || '').split(',').map(normalizeTag).filter(Boolean))].slice(0, 10);
  const cover = req.files.cover && req.files.cover[0];

  let newCoverPath = null; // null = не трогать текущую (COALESCE ниже оставит как есть)
  if (cover) {
    newCoverPath = `/uploads/covers/${cover.filename}`;
    if (mod.cover_path) safeUnlink(path.join(__dirname, '..', 'public', mod.cover_path.replace(/^\//, '')));
  }

  db.prepare(`UPDATE mods SET name = ?, summary = ?, description = ?, cover_path = COALESCE(?, cover_path), updated_at = datetime('now') WHERE id = ?`)
    .run(name, summary, description, newCoverPath, mod.id);

  db.prepare('DELETE FROM mod_tags WHERE mod_id = ?').run(mod.id);
  const insTag = db.prepare('INSERT OR IGNORE INTO mod_tags (mod_id, tag) VALUES (?, ?)');
  tags.forEach(t => insTag.run(mod.id, t));

  const screenshots = req.files.screenshots || [];
  if (screenshots.length) {
    const existingCount = db.prepare('SELECT COUNT(*) c FROM mod_screenshots WHERE mod_id = ?').get(mod.id).c;
    const insShot = db.prepare('INSERT INTO mod_screenshots (mod_id, path, position) VALUES (?, ?, ?)');
    screenshots.forEach((f, i) => insShot.run(mod.id, `/uploads/screenshots/${f.filename}`, existingCount + i));
  }

  res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}&saved=1`);
});

router.post('/mods/:id/screenshots/:screenshotId/delete', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.body.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) return res.status(403).send('Неверный код управления.');

  const shot = db.prepare('SELECT * FROM mod_screenshots WHERE id = ? AND mod_id = ?').get(req.params.screenshotId, mod.id);
  if (shot) {
    db.prepare('DELETE FROM mod_screenshots WHERE id = ?').run(shot.id);
    safeUnlink(path.join(__dirname, '..', 'public', shot.path.replace(/^\//, '')));
  }
  res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}`);
});

router.post('/mods/:id/cover/delete', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.body.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) return res.status(403).send('Неверный код управления.');

  if (mod.cover_path) {
    safeUnlink(path.join(__dirname, '..', 'public', mod.cover_path.replace(/^\//, '')));
    db.prepare('UPDATE mods SET cover_path = NULL WHERE id = ?').run(mod.id);
  }
  res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}`);
});

router.post('/mods/:id/versions', uploadModFiles.fields([{ name: 'archive', maxCount: 1 }]), async (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.body.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) return res.status(403).send('Неверный код управления.');
  const archive = req.files.archive && req.files.archive[0];
  if (!archive) return res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}`);

  const scan = await scanUpload(archive.path);
  if (scan.blocked) {
    safeUnlink(archive.path);
    return res.status(400).render('mod-form', {
      title: `Редактировать: ${mod.name}`, game: db.prepare('SELECT * FROM games WHERE id=?').get(mod.game_id),
      mode: 'edit', mod, tags: tagsFor(mod.id).join(', '), code,
      versions: versionsFor(mod.id, { onlyApproved: false }), screenshots: screenshotsFor(mod.id),
      error: `Файл не прошёл проверку и был удалён: ${scan.note}`,
    });
  }

  const versionLabel = (req.body.version || '').trim() || `v${Date.now()}`;
  const changelog = (req.body.changelog || '').trim();
  db.prepare(`INSERT INTO mod_versions (mod_id, version_label, changelog, file_path, file_size, status, scan_note)
              VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(mod.id, versionLabel, changelog, `/uploads/archives/${archive.filename}`, archive.size, scan.note);

  const moderationUrl2 = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/admin/moderation`
    : '/admin/moderation (в админке сайта)';
  notifyAdmin(
    `🆕 Кто-то прислал новую версию мода на сайт!\n`
    + `Мод: <b>${mod.name}</b>\n`
    + `Версия: ${versionLabel}\n`
    + `Проверить: ${moderationUrl2}`
  );

  // Новая версия тоже должна пройти проверку, даже если сам мод уже одобрен.
  res.redirect(`/mods/${mod.id}/edit?code=${encodeURIComponent(code)}&versionSent=1`);
});

router.post('/mods/:id/delete', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const code = req.body.code || '';
  if (!canManage(req, code, mod.control_code_hash, mod.user_id)) return res.status(403).send('Неверный код управления.');
  db.prepare('DELETE FROM mods WHERE id = ?').run(mod.id);
  res.redirect('/');
});

// ---------------------------------------------------------------- скачивание (только одобренное, либо с кодом)
router.get('/mods/:id/download/:versionId', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  const version = db.prepare('SELECT * FROM mod_versions WHERE id = ? AND mod_id = ?').get(req.params.versionId, req.params.id);
  if (!mod || !version) return res.status(404).render('404', { title: 'Файл не найден' });

  const authorized = canManage(req, req.query.code || '', mod.control_code_hash, mod.user_id);
  const publiclyOk = mod.status === 'approved' && version.status === 'approved';
  if (!publiclyOk && !authorized) {
    return res.status(403).render('pending', { title: 'Файл ещё на модерации', mod });
  }

  db.prepare('UPDATE mods SET downloads = downloads + 1 WHERE id = ?').run(mod.id);
  res.download(require('path').join(__dirname, '..', 'public', version.file_path));
});

// ---------------------------------------------------------------- лайк / комментарии
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.post('/mods/:id/like', writeLimiter, (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).json({ error: 'not found' });
  const voter = getVoterToken(req, res);
  const existing = db.prepare('SELECT 1 FROM mod_likes WHERE mod_id = ? AND voter_token = ?').get(mod.id, voter);
  if (existing) {
    db.prepare('DELETE FROM mod_likes WHERE mod_id = ? AND voter_token = ?').run(mod.id, voter);
    db.prepare('UPDATE mods SET likes = MAX(0, likes - 1) WHERE id = ?').run(mod.id);
  } else {
    db.prepare('INSERT INTO mod_likes (mod_id, voter_token) VALUES (?, ?)').run(mod.id, voter);
    db.prepare('UPDATE mods SET likes = likes + 1 WHERE id = ?').run(mod.id);
  }
  const fresh = db.prepare('SELECT likes FROM mods WHERE id = ?').get(mod.id);
  res.json({ likes: fresh.likes, liked: !existing });
});

router.post('/mods/:id/comments', writeLimiter, (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).send('not found');
  const body = (req.body.body || '').trim().slice(0, 2000);
  // Вошёл в аккаунт — подписываем его логином, имя из формы игнорируем,
  // чтобы нельзя было писать под чужим именем. Гость — как представился.
  const loggedIn = req.session && req.session.user;
  const authorName = loggedIn ? loggedIn.username : ((req.body.author_name || 'Гость').trim().slice(0, 40) || 'Гость');
  if (body) {
    db.prepare('INSERT INTO mod_comments (mod_id, author_name, user_id, body) VALUES (?, ?, ?, ?)')
      .run(mod.id, authorName, loggedIn ? loggedIn.id : null, body);
  }
  res.redirect(`/mods/${mod.id}`);
});

// Прямое удаление — только для админов из своей сессии; для всех
// остальных путь только через жалобу (/report/comment/:id →
// /admin/complaints, см. routes/complaints.js и routes/admin.js).
router.post('/mods/:id/comments/:commentId/delete', writeLimiter, (req, res) => {
  if (!(req.session && req.session.admin)) return res.status(403).send('Удалять комментарии могут только администраторы.');
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).send('not found');
  const comment = db.prepare('SELECT * FROM mod_comments WHERE id = ? AND mod_id = ?').get(req.params.commentId, mod.id);
  if (!comment) return res.status(404).send('not found');

  db.prepare('DELETE FROM mod_comments WHERE id = ?').run(comment.id);
  logAction(req.session.admin.username, 'delete_comment', mod.name, comment.body.slice(0, 80));
  res.redirect(`/mods/${mod.id}`);
});

// ---------------------------------------------------------------- публичный профиль разработчика
router.get('/users/:username', (req, res) => {
  const profileUser = db.prepare('SELECT id, username, avatar_path, created_at FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!profileUser) return res.status(404).render('404', { title: 'Пользователь не найден' });

  const mods = db.prepare(`SELECT * FROM mods WHERE user_id = ? AND status = 'approved' ORDER BY created_at DESC`)
    .all(profileUser.id).map(attachSummary);
  const bundles = db.prepare(`SELECT * FROM bundles WHERE user_id = ? AND status = 'approved' ORDER BY created_at DESC`)
    .all(profileUser.id);
  const stats = db.prepare(
    `SELECT COUNT(*) mods_count, COALESCE(SUM(downloads),0) downloads_sum, COALESCE(SUM(likes),0) likes_sum
     FROM mods WHERE user_id = ? AND status = 'approved'`
  ).get(profileUser.id);

  res.render('profile', { title: `Профиль: ${profileUser.username}`, profileUser, mods, bundles, stats });
});

module.exports = router;
