// routes/bundles.js
const express = require('express');
const path = require('path');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const db = require('../src/db');
const { slugify, issueControlCode, verifyControlCode, getVoterToken, canManage } = require('../src/helpers');
const { uploadModFiles } = require('../src/upload');

const router = express.Router();
const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function modsIn(bundleId) {
  return db.prepare(
    `SELECT m.* FROM bundle_mods bm JOIN mods m ON m.id = bm.mod_id WHERE bm.bundle_id = ? ORDER BY m.name`
  ).all(bundleId);
}

router.get('/games/:slug/bundles', (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Игра не найдена' });
  const bundles = db.prepare(`SELECT * FROM bundles WHERE game_id = ? AND status = 'approved' ORDER BY created_at DESC`).all(game.id)
    .map(b => ({ ...b, modCount: modsIn(b.id).length }));
  res.render('bundles-catalog', { title: `Сборки модов для ${game.name}`, game, bundles });
});

router.get('/bundles/new', (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE slug = ?').get('alem-colony');
  const availableMods = db.prepare(`SELECT id, name FROM mods WHERE game_id = ? AND status = 'approved' ORDER BY name`).all(game.id);
  if (availableMods.length < 2) {
    return res.render('bundle-form', { title: 'Собрать сборку', game, mode: 'create', bundle: null, availableMods, selected: [],
      error: 'Пока в каталоге меньше двух одобренных модов — сборку не из чего собирать.' });
  }
  res.render('bundle-form', { title: 'Собрать сборку', game, mode: 'create', bundle: null, availableMods, selected: [] });
});

router.post('/bundles', createLimiter, uploadModFiles.fields([{ name: 'cover', maxCount: 1 }]), (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE slug = ?').get('alem-colony');
  const name = (req.body.name || '').trim();
  const summary = (req.body.summary || '').trim();
  const description = (req.body.description || '').trim();
  const modIds = [].concat(req.body.mod_ids || []).filter(Boolean);
  const availableMods = db.prepare(`SELECT id, name FROM mods WHERE game_id = ? AND status = 'approved' ORDER BY name`).all(game.id);

  if (!name || modIds.length < 2) {
    return res.status(400).render('bundle-form', {
      title: 'Собрать сборку', game, mode: 'create', bundle: req.body, availableMods, selected: modIds,
      error: 'Нужно название и минимум 2 выбранных мода.',
    });
  }

  const publicId = slugify(name);
  const { code, hash } = issueControlCode(publicId);
  const cover = req.files.cover && req.files.cover[0];
  const ownerUserId = (req.session && req.session.user) ? req.session.user.id : null;

  const info = db.prepare(
    `INSERT INTO bundles (public_id, game_id, slug, name, summary, description, cover_path, control_code_hash, user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(publicId, game.id, publicId, name, summary, description, cover ? `/uploads/covers/${cover.filename}` : null, hash, ownerUserId);

  const insBm = db.prepare('INSERT OR IGNORE INTO bundle_mods (bundle_id, mod_id) VALUES (?, ?)');
  modIds.forEach(mid => insBm.run(info.lastInsertRowid, mid));

  res.render('mod-published', { title: 'Сборка отправлена на модерацию', mod: { id: publicId, name, slug: publicId }, code, isBundle: true, loggedIn: !!ownerUserId });
});

router.get('/bundles/:id', (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle) return res.status(404).render('404', { title: 'Сборка не найдена' });
  const authorized = canManage(req, req.query.code || '', bundle.control_code_hash, bundle.user_id);
  if (bundle.status !== 'approved' && !authorized) {
    return res.status(403).render('pending', { title: 'Сборка ещё на модерации', mod: bundle });
  }
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(bundle.game_id);
  const mods = modsIn(bundle.id).filter(m => authorized || m.status === 'approved');
  const voter = getVoterToken(req, res);
  const liked = !!db.prepare('SELECT 1 FROM bundle_likes WHERE bundle_id = ? AND voter_token = ?').get(bundle.id, voter);
  res.render('bundle-detail', { title: bundle.name, bundle, game, mods, liked, authorized, code: req.query.code || '' });
});

router.get('/bundles/:id/edit', (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle) return res.status(404).render('404', { title: 'Сборка не найдена' });
  const code = req.query.code || '';
  if (!canManage(req, code, bundle.control_code_hash, bundle.user_id)) {
    return res.status(403).render('manage', { title: 'Управление по коду', error: 'Код не подходит к этой сборке.' });
  }
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(bundle.game_id);
  const availableMods = db.prepare(`SELECT id, name FROM mods WHERE game_id = ? AND status = 'approved' ORDER BY name`).all(game.id);
  const selected = modsIn(bundle.id).map(m => m.id);
  res.render('bundle-form', { title: `Редактировать сборку: ${bundle.name}`, game, mode: 'edit', bundle, availableMods, selected, code });
});

router.post('/bundles/:id', uploadModFiles.fields([{ name: 'cover', maxCount: 1 }]), (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle) return res.status(404).render('404', { title: 'Сборка не найдена' });
  const code = req.body.code || '';
  if (!canManage(req, code, bundle.control_code_hash, bundle.user_id)) return res.status(403).send('Неверный код управления.');

  const name = (req.body.name || bundle.name).trim();
  const summary = (req.body.summary || '').trim();
  const description = (req.body.description || '').trim();
  const modIds = [].concat(req.body.mod_ids || []).filter(Boolean);
  const cover = req.files.cover && req.files.cover[0];

  db.prepare(`UPDATE bundles SET name=?, summary=?, description=?, cover_path=COALESCE(?, cover_path), updated_at=datetime('now') WHERE id=?`)
    .run(name, summary, description, cover ? `/uploads/covers/${cover.filename}` : null, bundle.id);

  db.prepare('DELETE FROM bundle_mods WHERE bundle_id = ?').run(bundle.id);
  const insBm = db.prepare('INSERT OR IGNORE INTO bundle_mods (bundle_id, mod_id) VALUES (?, ?)');
  modIds.forEach(mid => insBm.run(bundle.id, mid));

  res.redirect(`/bundles/${bundle.public_id}/edit?code=${encodeURIComponent(code)}&saved=1`);
});

router.post('/bundles/:id/delete', (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle) return res.status(404).render('404', { title: 'Сборка не найдена' });
  const code = req.body.code || '';
  if (!canManage(req, code, bundle.control_code_hash, bundle.user_id)) return res.status(403).send('Неверный код управления.');
  db.prepare('DELETE FROM bundles WHERE id = ?').run(bundle.id);
  res.redirect('/');
});

router.post('/bundles/:id/like', writeLimiter, (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'not found' });
  const voter = getVoterToken(req, res);
  const existing = db.prepare('SELECT 1 FROM bundle_likes WHERE bundle_id = ? AND voter_token = ?').get(bundle.id, voter);
  if (existing) {
    db.prepare('DELETE FROM bundle_likes WHERE bundle_id = ? AND voter_token = ?').run(bundle.id, voter);
    db.prepare('UPDATE bundles SET likes = MAX(0, likes - 1) WHERE id = ?').run(bundle.id);
  } else {
    db.prepare('INSERT INTO bundle_likes (bundle_id, voter_token) VALUES (?, ?)').run(bundle.id, voter);
    db.prepare('UPDATE bundles SET likes = likes + 1 WHERE id = ?').run(bundle.id);
  }
  const fresh = db.prepare('SELECT likes FROM bundles WHERE id = ?').get(bundle.id);
  res.json({ likes: fresh.likes, liked: !existing });
});

// «Скачать всё» — на лету собирает архив из последних одобренных версий каждого мода сборки.
router.get('/bundles/:id/download-all', (req, res) => {
  const bundle = db.prepare('SELECT * FROM bundles WHERE public_id = ?').get(req.params.id);
  if (!bundle || bundle.status !== 'approved') return res.status(404).render('404', { title: 'Сборка не найдена' });

  const mods = modsIn(bundle.id).filter(m => m.status === 'approved');
  res.attachment(`${bundle.slug}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  mods.forEach(mod => {
    const version = db.prepare(`SELECT * FROM mod_versions WHERE mod_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`).get(mod.id);
    if (version) {
      archive.file(path.join(__dirname, '..', 'public', version.file_path), { name: `${mod.slug}.zip` });
    }
  });
  archive.finalize();
});

module.exports = router;
