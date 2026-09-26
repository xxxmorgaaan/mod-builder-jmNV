// routes/admin.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { uploadBackup } = require('../src/upload');
const { restoreFromZipFile } = require('../src/backup');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { requireAdmin, requireOwner } = require('../src/auth');
const { toCsv, humanSize, revealControlCode, moscowDateStr, normalizeTag } = require('../src/helpers');
const { listZipEntries, readZipEntry } = require('../src/scan');
const { logAction, actorFromReq } = require('../src/audit');
const { invalidate: invalidateIpBanCache } = require('../src/ip-ban-cache');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: 'Слишком много попыток входа. Подождите немного.' });

// ---------------------------------------------------------------- вход/выход
router.get('/admin.html', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/moderation');
  res.render('admin/login', { title: 'Вход в админку', error: null });
});
router.get('/admin', (req, res) => res.redirect('/admin.html'));

router.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const cleanUsername = (username || '').trim();
  const cleanPassword = (password || '').trim();
  const admin = db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(cleanUsername);
  const ok = admin && bcrypt.compareSync(cleanPassword, admin.password_hash);
  if (!ok) {
    return res.status(401).render('admin/login', {
      title: 'Вход в админку',
      error: 'Неверный логин или пароль. Если уверены, что всё верно — воспользуйтесь страницей восстановления доступа (раздел 5 в README).',
    });
  }
  req.session.admin = { id: admin.id, username: admin.username, role: admin.role };
  res.redirect('/admin/moderation');
});

// ---------------------------------------------------------------- восстановление доступа
// Работает НАПРЯМУЮ с базой прямо сейчас, без перезапуска и без гадания,
// подхватились ли переменные окружения — надёжнее, чем всё остальное выше.
// Включается только явным заданием RESET_TOKEN в переменных окружения —
// без него страница отвечает 404, как будто её не существует.
router.get('/admin/emergency-reset', (req, res) => {
  if (!process.env.RESET_TOKEN) return res.status(404).render('404', { title: 'Страница не найдена' });
  res.render('admin/emergency-reset', { title: 'Восстановление доступа', error: null, done: null });
});

router.post('/admin/emergency-reset', loginLimiter, (req, res) => {
  if (!process.env.RESET_TOKEN) return res.status(404).render('404', { title: 'Страница не найдена' });
  const token = (req.body.token || '').trim();
  const newUsername = (req.body.username || '').trim();
  const newPassword = (req.body.password || '').trim();

  if (!token || token !== process.env.RESET_TOKEN) {
    return res.status(403).render('admin/emergency-reset', { title: 'Восстановление доступа', error: 'Неверный токен.', done: null });
  }
  if (!newUsername || newPassword.length < 6) {
    return res.status(400).render('admin/emergency-reset', { title: 'Восстановление доступа', error: 'Укажите логин и пароль (минимум 6 символов).', done: null });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  const owner = db.prepare(`SELECT * FROM admins WHERE role = 'owner' LIMIT 1`).get();
  if (owner) {
    db.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?').run(newUsername, hash, owner.id);
  } else {
    db.prepare(`INSERT INTO admins (username, password_hash, role) VALUES (?, ?, 'owner')`).run(newUsername, hash);
  }
  console.log(`[emergency-reset] Логин и пароль владельца заданы заново: "${newUsername}".`);
  res.render('admin/emergency-reset', { title: 'Восстановление доступа', error: null, done: newUsername });
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin.html'));
});

router.use('/admin', requireAdmin);

// ---------------------------------------------------------------- модерация (главная вкладка)
router.get('/admin/moderation', (req, res) => {
  const pendingMods = db.prepare(`SELECT * FROM mods WHERE status = 'pending' ORDER BY created_at`).all()
    .map(m => {
      const firstVersion = db.prepare('SELECT scan_note FROM mod_versions WHERE mod_id = ? ORDER BY id LIMIT 1').get(m.id);
      return { ...m, scan_note: firstVersion ? firstVersion.scan_note : null };
    });
  const pendingVersions = db.prepare(
    `SELECT v.*, m.name mod_name, m.id mod_id FROM mod_versions v JOIN mods m ON m.id = v.mod_id
     WHERE v.status = 'pending' AND m.status = 'approved' ORDER BY v.created_at`
  ).all();
  res.render('admin/moderation', { title: 'Модерация', pendingMods, pendingVersions, humanSize });
});

router.post('/admin/mods/:id/approve', (req, res) => {
  const mod = db.prepare('SELECT name FROM mods WHERE id = ?').get(req.params.id);
  db.prepare(`UPDATE mods SET status = 'approved', moderation_note = NULL WHERE id = ?`).run(req.params.id);
  db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE mod_id = ? AND status = 'pending'`).run(req.params.id);
  logAction(actorFromReq(req), 'approve_mod', mod ? mod.name : req.params.id);
  res.redirect('/admin/moderation');
});
router.post('/admin/mods/:id/reject', (req, res) => {
  const mod = db.prepare('SELECT name FROM mods WHERE id = ?').get(req.params.id);
  const note = (req.body.note || '').trim();
  db.prepare(`UPDATE mods SET status = 'rejected', moderation_note = ? WHERE id = ?`).run(note, req.params.id);
  logAction(actorFromReq(req), 'reject_mod', mod ? mod.name : req.params.id, note);
  res.redirect('/admin/moderation');
});
router.post('/admin/mods/bulk-approve', (req, res) => {
  const ids = [].concat(req.body.ids || []).filter(Boolean);
  if (ids.length) {
    const names = [];
    const approveMod = db.transaction((modIds) => {
      modIds.forEach((id) => {
        const mod = db.prepare('SELECT name FROM mods WHERE id = ?').get(id);
        if (!mod) return;
        db.prepare(`UPDATE mods SET status = 'approved', moderation_note = NULL WHERE id = ?`).run(id);
        db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE mod_id = ? AND status = 'pending'`).run(id);
        names.push(mod.name);
      });
    });
    approveMod(ids);
    logAction(actorFromReq(req), 'bulk_approve_mods', `${names.length} шт.`, names.join(', '));
  }
  res.redirect('/admin/moderation');
});
router.post('/admin/mod-versions/:id/approve', (req, res) => {
  const version = db.prepare('SELECT v.mod_id, v.version_label, m.name mod_name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = ?').get(req.params.id);
  db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE id = ?`).run(req.params.id);
  if (version) {
    db.prepare(`UPDATE mods SET updated_at = datetime('now') WHERE id = ?`).run(version.mod_id);
    logAction(actorFromReq(req), 'approve_version', `${version.mod_name} — ${version.version_label}`);
  }
  res.redirect('/admin/moderation');
});
router.post('/admin/mod-versions/:id/reject', (req, res) => {
  const version = db.prepare('SELECT v.version_label, m.name mod_name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = ?').get(req.params.id);
  db.prepare(`UPDATE mod_versions SET status = 'rejected' WHERE id = ?`).run(req.params.id);
  if (version) logAction(actorFromReq(req), 'reject_version', `${version.mod_name} — ${version.version_label}`);
  res.redirect('/admin/moderation');
});
router.post('/admin/mod-versions/bulk-approve', (req, res) => {
  const ids = [].concat(req.body.ids || []).filter(Boolean);
  if (ids.length) {
    const labels = [];
    const approveVersion = db.transaction((versionIds) => {
      versionIds.forEach((id) => {
        const version = db.prepare('SELECT v.mod_id, v.version_label, m.name mod_name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = ?').get(id);
        if (!version) return;
        db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE id = ?`).run(id);
        db.prepare(`UPDATE mods SET updated_at = datetime('now') WHERE id = ?`).run(version.mod_id);
        labels.push(`${version.mod_name} — ${version.version_label}`);
      });
    });
    approveVersion(ids);
    logAction(actorFromReq(req), 'bulk_approve_versions', `${labels.length} шт.`, labels.join(', '));
  }
  res.redirect('/admin/moderation');
});
router.post('/admin/bundles/:id/approve', (req, res) => {
  db.prepare(`UPDATE bundles SET status = 'approved', moderation_note = NULL WHERE public_id = ?`).run(req.params.id);
  logAction(actorFromReq(req), 'approve_bundle', req.params.id);
  res.redirect('/admin/moderation');
});
router.post('/admin/bundles/:id/reject', (req, res) => {
  const note = (req.body.note || '').trim();
  db.prepare(`UPDATE bundles SET status = 'rejected', moderation_note = ? WHERE public_id = ?`).run(note, req.params.id);
  logAction(actorFromReq(req), 'reject_bundle', req.params.id, note);
  res.redirect('/admin/moderation');
});

// ---------------------------------------------------------------- таблица модов
// ---------------------------------------------------------------- просмотр файлов мода (ручная проверка)
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const TEXT_EXT = ['.json', '.txt', '.md', '.lua'];
function fileKind(entryPath) {
  const ext = entryPath.slice(entryPath.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (TEXT_EXT.includes(ext)) return 'text';
  return 'other';
}

router.get('/admin/mods/:id/inspect', async (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).render('404', { title: 'Мод не найден' });
  const versions = db.prepare('SELECT * FROM mod_versions WHERE mod_id = ? ORDER BY id DESC').all(mod.id);
  const version = req.query.version
    ? versions.find(v => String(v.id) === req.query.version)
    : versions[0];
  if (!version) return res.render('admin/inspect', { title: `Файлы: ${mod.name}`, mod, versions, version: null, entries: [], error: null, humanSize });

  try {
    const entries = (await listZipEntries(path.join(__dirname, '..', 'public', version.file_path)))
      .map(e => ({ ...e, kind: fileKind(e.path) }));
    res.render('admin/inspect', { title: `Файлы: ${mod.name}`, mod, versions, version, entries, error: null, humanSize });
  } catch (err) {
    res.render('admin/inspect', { title: `Файлы: ${mod.name}`, mod, versions, version, entries: [], error: 'Не удалось открыть архив: ' + err.message, humanSize });
  }
});

router.get('/admin/mods/:id/inspect/file', async (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).send('not found');
  const version = db.prepare('SELECT * FROM mod_versions WHERE id = ? AND mod_id = ?').get(req.query.version, mod.id);
  if (!version) return res.status(404).send('not found');
  try {
    const buf = await readZipEntry(path.join(__dirname, '..', 'public', version.file_path), req.query.path || '');
    if (!buf) return res.status(404).send('файл не найден в архиве');
    const ext = (req.query.path || '').slice((req.query.path || '').lastIndexOf('.')).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.type(mimeMap[ext] || 'text/plain; charset=utf-8').send(buf);
  } catch (err) {
    res.status(500).send('Ошибка чтения файла: ' + err.message);
  }
});

// Проверка синтаксиса .lua-файла прямо в браузере, без выполнения кода —
// luaparse только разбирает грамматику и указывает на синтаксическую
// ошибку (если она есть) с номером строки. Не антивирус и не песочница —
// просто быстро поймать явно битый/неполный скрипт до одобрения мода.
router.get('/admin/mods/:id/inspect/lint-lua', async (req, res) => {
  const mod = db.prepare('SELECT id FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).json({ ok: false, error: 'мод не найден' });
  const version = db.prepare('SELECT * FROM mod_versions WHERE id = ? AND mod_id = ?').get(req.query.version, mod.id);
  if (!version) return res.status(404).json({ ok: false, error: 'версия не найдена' });

  let luaparse;
  try {
    luaparse = require('luaparse');
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Модуль luaparse не установлен на сервере — выполните npm install и перезапустите сайт.' });
  }

  try {
    const buf = await readZipEntry(path.join(__dirname, '..', 'public', version.file_path), req.query.path || '');
    if (!buf) return res.status(404).json({ ok: false, error: 'файл не найден в архиве' });
    try {
      luaparse.parse(buf.toString('utf8'));
      res.json({ ok: true });
    } catch (parseErr) {
      res.json({ ok: false, error: parseErr.message, line: parseErr.line || null });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Ошибка чтения файла: ' + err.message });
  }
});

router.get('/admin/mods', (req, res) => {
  const mods = db.prepare(`SELECT * FROM mods ORDER BY created_at DESC`).all()
    .map(m => ({ ...m, controlCode: revealControlCode(m.control_code_hash) }));
  // Теги — одним запросом на все моды разом, а не по одному на строку.
  const tagsByMod = {};
  db.prepare('SELECT mod_id, tag FROM mod_tags').all().forEach((r) => {
    (tagsByMod[r.mod_id] = tagsByMod[r.mod_id] || []).push(r.tag);
  });
  mods.forEach((m) => { m.tagsList = (tagsByMod[m.id] || []).join(', '); });
  res.render('admin/mods', { title: 'Все моды', mods });
});
router.get('/admin/mods/export.csv', (req, res) => {
  const mods = db.prepare(`SELECT id, name, status, downloads, likes, created_at FROM mods ORDER BY created_at DESC`).all();
  const csv = toCsv(mods, [
    { key: 'id', label: 'id' }, { key: 'name', label: 'Название' }, { key: 'status', label: 'Статус' },
    { key: 'downloads', label: 'Скачиваний' }, { key: 'likes', label: 'Лайков' }, { key: 'created_at', label: 'Создан' },
  ]);
  res.header('Content-Type', 'text/csv; charset=utf-8').attachment('mods.csv').send('\uFEFF' + csv);
});
router.post('/admin/mods/:id/tags', (req, res) => {
  const mod = db.prepare('SELECT name FROM mods WHERE id = ?').get(req.params.id);
  if (mod) {
    const tags = [...new Set((req.body.tags || '').split(',').map(normalizeTag).filter(Boolean))].slice(0, 10);
    db.prepare('DELETE FROM mod_tags WHERE mod_id = ?').run(req.params.id);
    const insertTag = db.prepare('INSERT OR IGNORE INTO mod_tags (mod_id, tag) VALUES (?, ?)');
    tags.forEach((t) => insertTag.run(req.params.id, t));
    logAction(actorFromReq(req), 'edit_tags', mod.name, tags.join(', ') || '(теги очищены)');
  }
  res.redirect('/admin/mods');
});
router.post('/admin/mods/:id/visibility', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (mod) {
    const next = mod.status === 'hidden' ? 'approved' : 'hidden';
    db.prepare('UPDATE mods SET status = ? WHERE id = ?').run(next, mod.id);
    logAction(actorFromReq(req), next === 'hidden' ? 'hide_mod' : 'unhide_mod', mod.name);
  }
  res.redirect('/admin/mods');
});
router.post('/admin/mods/:id/delete', (req, res) => {
  const mod = db.prepare('SELECT name FROM mods WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM mods WHERE id = ?').run(req.params.id);
  logAction(actorFromReq(req), 'delete_mod', mod ? mod.name : req.params.id);
  res.redirect('/admin/mods');
});

// ---------------------------------------------------------------- таблица сборок
router.get('/admin/bundles', (req, res) => {
  const bundles = db.prepare(`SELECT * FROM bundles ORDER BY created_at DESC`).all()
    .map(b => ({ ...b, controlCode: revealControlCode(b.control_code_hash) }));
  res.render('admin/bundles', { title: 'Все сборки', bundles });
});
router.get('/admin/bundles/export.csv', (req, res) => {
  const bundles = db.prepare(`SELECT public_id, name, status, likes, created_at FROM bundles ORDER BY created_at DESC`).all();
  const csv = toCsv(bundles, [
    { key: 'public_id', label: 'id' }, { key: 'name', label: 'Название' }, { key: 'status', label: 'Статус' },
    { key: 'likes', label: 'Лайков' }, { key: 'created_at', label: 'Создана' },
  ]);
  res.header('Content-Type', 'text/csv; charset=utf-8').attachment('bundles.csv').send('\uFEFF' + csv);
});
router.post('/admin/bundles/:id/visibility', (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (bundle) {
    const next = bundle.status === 'hidden' ? 'approved' : 'hidden';
    db.prepare('UPDATE bundles SET status = ? WHERE public_id = ?').run(next, bundle.public_id);
    logAction(actorFromReq(req), next === 'hidden' ? 'hide_bundle' : 'unhide_bundle', bundle.name);
  }
  res.redirect('/admin/bundles');
});
router.post('/admin/bundles/:id/delete', (req, res) => {
  const bundle = db.prepare('SELECT name FROM bundles WHERE public_id = ?').get(req.params.id);
  db.prepare('DELETE FROM bundles WHERE public_id = ?').run(req.params.id);
  logAction(actorFromReq(req), 'delete_bundle', bundle ? bundle.name : req.params.id);
  res.redirect('/admin/bundles');
});

// ---------------------------------------------------------------- пользователи (баны)
router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM mods m WHERE m.user_id = u.id) mods_count
     FROM users u ORDER BY u.created_at DESC`
  ).all();
  const bannedIps = db.prepare('SELECT * FROM banned_ips ORDER BY created_at DESC').all();
  res.render('admin/users', { title: 'Пользователи', users, bannedIps });
});

router.post('/admin/users/:id/ban', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user) {
    db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(user.id);
    // Заодно баним и последний известный IP этого аккаунта — иначе с того же
    // IP тут же можно завести новый аккаунт и продолжить как ни в чём не бывало.
    if (user.last_ip) {
      db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason) VALUES (?, ?)')
        .run(user.last_ip, `Аккаунт «${user.username}» заблокирован`);
    }
    invalidateIpBanCache();
    logAction(actorFromReq(req), 'ban_user', user.username);
  }
  res.redirect('/admin/users');
});
router.post('/admin/users/:id/unban', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user) {
    db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(user.id);
    if (user.last_ip) db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(user.last_ip);
    invalidateIpBanCache();
    logAction(actorFromReq(req), 'unban_user', user.username);
  }
  res.redirect('/admin/users');
});
router.post('/admin/ban-ip', (req, res) => {
  const ip = (req.body.ip || '').trim();
  const reason = (req.body.reason || '').trim() || null;
  if (ip) {
    db.prepare('INSERT INTO banned_ips (ip, reason) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason').run(ip, reason);
    invalidateIpBanCache();
    logAction(actorFromReq(req), 'ban_ip', ip, reason);
  }
  res.redirect('/admin/users');
});
router.post('/admin/unban-ip', (req, res) => {
  const ip = req.body.ip || '';
  db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(ip);
  invalidateIpBanCache();
  logAction(actorFromReq(req), 'unban_ip', ip);
  res.redirect('/admin/users');
});

// ---------------------------------------------------------------- баг-репорты
router.get('/admin/bugs', (req, res) => {
  const bugs = db.prepare('SELECT * FROM bug_reports ORDER BY created_at DESC').all();
  res.render('admin/bugs', { title: 'Баг-репорты', bugs });
});
router.post('/admin/bugs/:id/status', (req, res) => {
  const status = ['open', 'in_progress', 'resolved', 'wontfix'].includes(req.body.status) ? req.body.status : 'open';
  db.prepare(`UPDATE bug_reports SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  res.redirect('/admin/bugs');
});
router.post('/admin/bugs/:id/delete', (req, res) => {
  db.prepare('DELETE FROM bug_reports WHERE id = ?').run(req.params.id);
  res.redirect('/admin/bugs');
});

// ---------------------------------------------------------------- журнал действий
router.get('/admin/log', (req, res) => {
  const entries = db.prepare('SELECT * FROM admin_actions ORDER BY id DESC LIMIT 200').all();
  res.render('admin/log', { title: 'Журнал действий', entries });
});

router.get('/admin/complaints', (req, res) => {
  const complaints = db.prepare(`SELECT * FROM complaints ORDER BY (status = 'open') DESC, updated_at DESC`).all().map(c => {
    const last = db.prepare('SELECT body, sender FROM complaint_messages WHERE complaint_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    const target = c.target_type === 'mod'
      ? db.prepare('SELECT id, name FROM mods WHERE id = ?').get(c.target_id)
      : db.prepare('SELECT public_id id, name FROM bundles WHERE public_id = ?').get(c.target_id);
    return { ...c, lastMessage: last, target };
  });
  const openId = req.query.open ? Number(req.query.open) : (complaints[0] ? complaints[0].id : null);
  const openMessages = openId ? db.prepare('SELECT sender, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY id').all(openId) : [];
  res.render('admin/complaints', { title: 'Жалобы', complaints, openId, openMessages });
});
router.get('/admin/complaints/:id/messages', (req, res) => {
  const messages = db.prepare('SELECT sender, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY id').all(req.params.id);
  res.json({ messages });
});
router.post('/admin/complaints/:id/reply', (req, res) => {
  const body = (req.body.body || '').trim();
  if (body) {
    db.prepare('INSERT INTO complaint_messages (complaint_id, sender, body) VALUES (?, \'admin\', ?)').run(req.params.id, body);
    db.prepare('UPDATE complaints SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  }
  res.redirect(`/admin/complaints?open=${req.params.id}`);
});
router.post('/admin/complaints/:id/resolve', (req, res) => {
  db.prepare(`UPDATE complaints SET status = 'resolved' WHERE id = ?`).run(req.params.id);
  logAction(actorFromReq(req), 'resolve_complaint', `#${req.params.id}`);
  res.redirect('/admin/complaints');
});
router.post('/admin/complaints/:id/delete-target', (req, res) => {
  const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (complaint) {
    if (complaint.target_type === 'mod') db.prepare('DELETE FROM mods WHERE id = ?').run(complaint.target_id);
    else if (complaint.target_type === 'comment') db.prepare('DELETE FROM mod_comments WHERE id = ?').run(complaint.target_id);
    else db.prepare('DELETE FROM bundles WHERE public_id = ?').run(complaint.target_id);
    db.prepare(`UPDATE complaints SET status = 'resolved' WHERE id = ?`).run(complaint.id);
    logAction(actorFromReq(req), 'delete_via_complaint', `${complaint.target_type} ${complaint.target_id}`, `жалоба #${complaint.id}`);
  }
  res.redirect('/admin/complaints');
});

// ---------------------------------------------------------------- админы (только владелец)
router.get('/admin/admins', requireOwner, (req, res) => {
  const admins = db.prepare('SELECT id, username, role, created_at FROM admins ORDER BY created_at').all();
  res.render('admin/admins', { title: 'Админы', admins });
});
router.post('/admin/admins', requireOwner, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  if (username && password.length >= 6) {
    db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, \'moderator\')')
      .run(username, bcrypt.hashSync(password, 10));
  }
  res.redirect('/admin/admins');
});
router.post('/admin/admins/:id/reset-password', requireOwner, (req, res) => {
  const password = (req.body.password || '').trim();
  if (password.length >= 6) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  res.redirect('/admin/admins');
});
router.post('/admin/admins/:id/delete', requireOwner, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (target && target.role !== 'owner') db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  res.redirect('/admin/admins');
});

// ---------------------------------------------------------------- резервная копия (для переноса на другой хостинг)
// Всё, что нужно для переезда на новый хост: сама база SQLite и все
// загруженные файлы (обложки, скриншоты, архивы модов, картинки багов).
// Распаковать этот .zip в корень нового проекта той же структурой — сайт
// продолжит работать с теми же данными.
// Загрузка резервной копии обратно: распаковывает архив, сделанный кнопкой
// выше, поверх текущих данных, и сразу переоткрывает соединение с базой
// (см. src/backup.js → db.reload()) — новые данные видны сразу, без
// перезапуска сервера.
router.post('/admin/restore', requireOwner, uploadBackup.single('backup'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/settings');
  try {
    const result = await restoreFromZipFile(req.file.path);
    fs.unlink(req.file.path, () => {});
    res.render('admin/settings', {
      title: 'Настройки', saved: false, error: null,
      restored: {
        db: result.restoredDb, files: result.restoredFiles,
        statsRestored: result.statsRestored, commentsRestored: result.commentsRestored, likesRestored: result.likesRestored,
      },
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.render('admin/settings', {
      title: 'Настройки', saved: false,
      error: 'Не удалось прочитать архив резервной копии: ' + err.message,
      restored: null,
    });
  }
});

router.get('/admin/backup', requireOwner, (req, res) => {
  res.attachment(`alem-mod-backup-${new Date().toISOString().slice(0, 10)}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  const dataDir = path.join(__dirname, '..', 'data');
  const dbFile = path.join(dataDir, 'modbuild.db');
  if (fs.existsSync(dbFile)) archive.file(dbFile, { name: 'data/modbuild.db' });

  const uploadDirs = ['covers', 'screenshots', 'archives', 'bugs', 'avatars'];
  uploadDirs.forEach(dir => {
    const full = path.join(__dirname, '..', 'public', 'uploads', dir);
    if (fs.existsSync(full)) archive.directory(full, `public/uploads/${dir}`);
  });

  archive.finalize();
});

// ---------------------------------------------------------------- настройки (свой пароль)
router.get('/admin/settings', (req, res) => {
  const today = moscowDateStr();
  const month = today.slice(0, 7);
  const todayVisits = db.prepare('SELECT count FROM visit_counters WHERE day = ?').get(today);
  const monthVisits = db.prepare(`SELECT COALESCE(SUM(count),0) c FROM visit_counters WHERE day LIKE ?`).get(`${month}%`);
  res.render('admin/settings', {
    title: 'Настройки', saved: !!req.query.saved, error: null, restored: null,
    visitsToday: todayVisits ? todayVisits.count : 0, visitsMonth: monthVisits.c,
  });
});
router.post('/admin/settings/password', (req, res) => {
  const currentPassword = (req.body.current_password || '').trim();
  const newPassword = (req.body.new_password || '').trim();
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.admin.id);
  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.render('admin/settings', { title: 'Настройки', saved: false, error: 'Текущий пароль неверный.', restored: null });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.render('admin/settings', { title: 'Настройки', saved: false, error: 'Новый пароль — минимум 6 символов.', restored: null });
  }
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), admin.id);
  res.redirect('/admin/settings?saved=1');
});

module.exports = router;
