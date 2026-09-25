// routes/bot-api.js
// Отдельный маленький API специально для собственного Telegram-бота (см.
// папку /telegram-bot в корне проекта) — чтобы модерировать моды прямо из
// Telegram, не заходя в браузер. Никак не пересекается с обычной админкой
// на сессиях (routes/admin.js) — тут авторизация по общему секрету в
// заголовке, потому что бот не умеет ходить с браузерными cookie.
//
// Включается только если задан BOT_API_SECRET в .env — без него все роуты
// отвечают 404, как будто их не существует (тот же приём, что и у
// /admin/emergency-reset).
const express = require('express');
const db = require('../src/db');
const { humanSize } = require('../src/helpers');

const router = express.Router();

function requireBotSecret(req, res, next) {
  const secret = (process.env.BOT_API_SECRET || '').trim();
  if (!secret) return res.status(404).json({ error: 'not configured' });
  if (req.get('X-Bot-Secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
}
router.use(requireBotSecret);

// ---------------------------------------------------------------- очередь на модерацию
router.get('/pending', (req, res) => {
  const mods = db.prepare(`SELECT id, name, summary, created_at FROM mods WHERE status = 'pending' ORDER BY created_at`).all();
  const versions = db.prepare(
    `SELECT v.id, v.version_label, v.file_size, v.changelog, m.id mod_id, m.name mod_name
     FROM mod_versions v JOIN mods m ON m.id = v.mod_id
     WHERE v.status = 'pending' AND m.status = 'approved' ORDER BY v.created_at`
  ).all().map(v => ({ ...v, file_size_human: humanSize(v.file_size) }));
  res.json({ mods, versions });
});

// ---------------------------------------------------------------- моды
router.post('/mods/:id/approve', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE mods SET status = 'approved', moderation_note = NULL WHERE id = ?`).run(mod.id);
  db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE mod_id = ? AND status = 'pending'`).run(mod.id);
  res.json({ ok: true, name: mod.name });
});
router.post('/mods/:id/reject', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.params.id);
  if (!mod) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE mods SET status = 'rejected', moderation_note = ? WHERE id = ?`).run((req.body.note || '').trim() || null, mod.id);
  res.json({ ok: true, name: mod.name });
});

// ---------------------------------------------------------------- версии
router.post('/mod-versions/:id/approve', (req, res) => {
  const version = db.prepare('SELECT v.*, m.name mod_name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = ?').get(req.params.id);
  if (!version) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE id = ?`).run(version.id);
  db.prepare(`UPDATE mods SET updated_at = datetime('now') WHERE id = ?`).run(version.mod_id);
  res.json({ ok: true, name: version.mod_name, label: version.version_label });
});
router.post('/mod-versions/:id/reject', (req, res) => {
  const version = db.prepare('SELECT v.*, m.name mod_name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = ?').get(req.params.id);
  if (!version) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE mod_versions SET status = 'rejected' WHERE id = ?`).run(version.id);
  res.json({ ok: true, name: version.mod_name, label: version.version_label });
});

module.exports = router;
