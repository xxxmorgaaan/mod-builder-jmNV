// routes/complaints.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../src/db');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

function targetExists(type, id) {
  if (type === 'mod') return db.prepare('SELECT id, name FROM mods WHERE id = ?').get(id);
  if (type === 'bundle') return db.prepare('SELECT public_id id, name FROM bundles WHERE public_id = ?').get(id);
  if (type === 'comment') {
    const c = db.prepare('SELECT id, author_name, body FROM mod_comments WHERE id = ?').get(id);
    if (!c) return null;
    return { id: c.id, name: `Комментарий от «${c.author_name}»: ${c.body.slice(0, 60)}${c.body.length > 60 ? '…' : ''}` };
  }
  return null;
}

router.get('/report/:type/:id', (req, res) => {
  const target = targetExists(req.params.type, req.params.id);
  if (!target) return res.status(404).render('404', { title: 'Не найдено' });
  res.render('report-form', { title: `Жалоба: ${target.name}`, type: req.params.type, target });
});

router.post('/report/:type/:id', limiter, (req, res) => {
  const target = targetExists(req.params.type, req.params.id);
  if (!target) return res.status(404).render('404', { title: 'Не найдено' });
  const body = (req.body.body || '').trim().slice(0, 3000);
  if (!body) return res.redirect(`/report/${req.params.type}/${req.params.id}`);

  const token = nanoid(28);
  const tokenHash = bcrypt.hashSync(token, 10);
  const info = db.prepare('INSERT INTO complaints (target_type, target_id, token_hash) VALUES (?, ?, ?)')
    .run(req.params.type, req.params.id, tokenHash);
  db.prepare('INSERT INTO complaint_messages (complaint_id, sender, body) VALUES (?, \'user\', ?)').run(info.lastInsertRowid, body);

  res.render('complaint-created', { title: 'Жалоба отправлена', complaintId: info.lastInsertRowid, token });
});

// Токен хранится как <id жалобы>.<секрет> — так же, как код управления модом.
function findComplaintByToken(token) {
  if (!token || !token.includes('.')) return null;
  const id = token.slice(0, token.indexOf('.'));
  const secret = token.slice(token.indexOf('.') + 1);
  const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  if (!complaint || !bcrypt.compareSync(secret, complaint.token_hash)) return null;
  return complaint;
}

router.get('/complaints/:token', (req, res) => {
  const complaint = findComplaintByToken(req.params.token);
  if (!complaint) return res.status(404).render('404', { title: 'Обращение не найдено' });
  const target = targetExists(complaint.target_type, complaint.target_id);
  res.render('complaint-chat', { title: 'Переписка по жалобе', complaint, target, token: req.params.token });
});

router.get('/api/complaints/:token/messages', (req, res) => {
  const complaint = findComplaintByToken(req.params.token);
  if (!complaint) return res.status(404).json({ error: 'not found' });
  const messages = db.prepare('SELECT sender, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY id').all(complaint.id);
  res.json({ status: complaint.status, messages });
});

router.post('/api/complaints/:token/messages', limiter, (req, res) => {
  const complaint = findComplaintByToken(req.params.token);
  if (!complaint) return res.status(404).json({ error: 'not found' });
  const body = (req.body.body || '').trim().slice(0, 3000);
  if (body) {
    db.prepare('INSERT INTO complaint_messages (complaint_id, sender, body) VALUES (?, \'user\', ?)').run(complaint.id, body);
    db.prepare('UPDATE complaints SET updated_at = datetime(\'now\') WHERE id = ?').run(complaint.id);
  }
  res.json({ ok: true });
});

module.exports = router;
