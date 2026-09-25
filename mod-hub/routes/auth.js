// routes/auth.js
// Необязательные аккаунты для авторов модов — альтернатива коду управления.
// Никак не пересекается с админкой (admins) — это отдельная, гораздо более
// простая система только для «я не хочу запоминать код».
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../src/db');
const { revealControlCode, clientIp, recordIdFromCode, verifyControlCode } = require('../src/helpers');
const { uploadAvatar } = require('../src/upload');
const { verifyTelegramAuth } = require('../src/telegram');

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: 'Слишком много попыток. Подождите немного.' });

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/account');
  res.render('register', { title: 'Регистрация', error: null });
});

router.post('/register', authLimiter, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const password2 = (req.body.password2 || '').trim();

  if (username.length < 3) {
    return res.status(400).render('register', { title: 'Регистрация', error: 'Логин — минимум 3 символа.' });
  }
  if (password.length < 6) {
    return res.status(400).render('register', { title: 'Регистрация', error: 'Пароль — минимум 6 символов.' });
  }
  if (password !== password2) {
    return res.status(400).render('register', { title: 'Регистрация', error: 'Пароли не совпадают.' });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing) {
    return res.status(400).render('register', { title: 'Регистрация', error: 'Такой логин уже занят.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, last_ip) VALUES (?, ?, ?)').run(username, hash, clientIp(req));
  req.session.user = { id: info.lastInsertRowid, username };
  res.redirect('/account');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/account');
  res.render('login', { title: 'Вход', error: null });
});

router.post('/login', authLimiter, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { title: 'Вход', error: 'Неверный логин или пароль.' });
  }
  if (user.is_banned) {
    return res.status(403).render('login', { title: 'Вход', error: 'Этот аккаунт заблокирован администрацией.' });
  }
  db.prepare('UPDATE users SET last_ip = ? WHERE id = ?').run(clientIp(req), user.id);
  req.session.user = { id: user.id, username: user.username };
  res.redirect('/account');
});

// ---------------------------------------------------------------- вход/регистрация через Telegram
// Работает через Telegram Login Widget (см. кнопку на страницах входа и
// регистрации) — виджет сам подписывает данные и присылает их сюда через
// GET-редирект. Мы просто проверяем подпись (см. src/telegram.js) и либо
// находим существующий аккаунт по telegram_id, либо создаём новый.
router.get('/auth/telegram/callback', authLimiter, (req, res) => {
  const data = req.query;
  if (!verifyTelegramAuth(data)) {
    return res.status(403).render('login', { title: 'Вход', error: 'Не удалось подтвердить вход через Telegram — попробуйте ещё раз.' });
  }
  const telegramId = parseInt(data.id, 10);
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);

  if (!user) {
    // Новый пользователь — заводим аккаунт. Логин по возможности из
    // telegram-юзернейма, иначе — по имени профиля, с добавлением
    // случайного хвоста, если такой логин уже занят.
    let base = (data.username || data.first_name || `tg${telegramId}`).toString()
      .toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 24) || `tg${telegramId}`;
    let candidate = base;
    let attempt = 0;
    while (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(candidate)) {
      attempt += 1;
      candidate = `${base}${attempt}`;
    }
    // Пароля у telegram-аккаунта нет — вход только через Telegram, но
    // колонка NOT NULL, поэтому кладём случайный неиспользуемый хэш.
    const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, telegram_id, telegram_username, last_ip) VALUES (?, ?, ?, ?, ?)'
    ).run(candidate, randomHash, telegramId, data.username || null, clientIp(req));
    user = { id: info.lastInsertRowid, username: candidate, is_banned: 0 };
  } else {
    if (user.is_banned) {
      return res.status(403).render('login', { title: 'Вход', error: 'Этот аккаунт заблокирован администрацией.' });
    }
    db.prepare('UPDATE users SET last_ip = ?, telegram_username = ? WHERE id = ?')
      .run(clientIp(req), data.username || user.telegram_username, user.id);
  }

  req.session.user = { id: user.id, username: user.username };
  res.redirect('/account');
});

router.post('/logout', (req, res) => {
  delete req.session.user;
  res.redirect('/');
});

router.get('/account', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const mods = db.prepare('SELECT * FROM mods WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id)
    .map(m => ({ ...m, controlCode: revealControlCode(m.control_code_hash) }));
  const bundles = db.prepare('SELECT * FROM bundles WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id)
    .map(b => ({ ...b, controlCode: revealControlCode(b.control_code_hash) }));
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('account', {
    title: 'Личный кабинет', mods, bundles, me, saved: !!req.query.saved,
    claimed: !!req.query.claimed, claimError: req.query.claimError || null,
  });
});

// ---------------------------------------------------------------- присвоить мод себе по коду
// Мод мог быть опубликован без аккаунта (просто по коду управления) — эта
// форма позволяет привязать его к своему аккаунту задним числом, чтобы он
// появился в личном кабинете и на публичном профиле. Код — такое же
// доказательство владения, как и обычно: раз он у вас есть, мод ваш.
router.post('/account/claim-mod', authLimiter, (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const code = (req.body.code || '').trim();
  const id = recordIdFromCode(code);
  const mod = id ? db.prepare('SELECT * FROM mods WHERE id = ?').get(id) : null;

  if (!mod || !verifyControlCode(code, mod.control_code_hash)) {
    return res.redirect('/account?claimError=' + encodeURIComponent('Код не подходит ни к одному моду.'));
  }

  db.prepare('UPDATE mods SET user_id = ? WHERE id = ?').run(req.session.user.id, mod.id);
  res.redirect('/account?claimed=1');
});

// Аватарка — необязательна: если не загружать, везде показывается кружок
// с первой буквой логина, так что «пустых» мест в интерфейсе не будет.
router.post('/account/avatar', authLimiter, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.file) {
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?')
      .run(`/uploads/avatars/${req.file.filename}`, req.session.user.id);
  }
  res.redirect('/account?saved=1');
});

router.post('/account/avatar/delete', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.session.user.id);
  res.redirect('/account?saved=1');
});

module.exports = router;
