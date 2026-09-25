// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('./src/session-store');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const { startAutoApproveSweep } = require('./src/auto-approve');
const { startRestoreWatcher } = require('./src/restore-watcher');
const { clientIp, moscowDateStr } = require('./src/helpers');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;

// За реверс-прокси (Railway и почти любой другой хостинг) req.ip без этого
// всегда равен адресу самого прокси — тогда бан по IP банил бы всех разом.
app.set('trust proxy', 1);

// ---------------------------------------------------------------- view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------- security & parsing
app.use(helmet({
  contentSecurityPolicy: false, // включите и настройте под свой домен перед продакшеном
}));
app.use(compression()); // gzip на HTML/CSS/JS/JSON-ответы — заметно ускоряет каталог на телефоне
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  store: new SqliteSessionStore(db),
  secret: process.env.SESSION_SECRET || 'change-me-to-a-long-random-string',
  resave: false,
  saveUninitialized: false,
  // rolling — срок жизни куки продлевается при каждом визите, так что
  // активный пользователь не разлогинивается вообще, пока заходит хотя бы
  // раз в 30 дней. Сессии при этом хранятся в базе (см. src/session-store.js),
  // а не в памяти процесса — переживают перезапуск сервера.
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
  maxAge: '30d', // обложки/скриншоты/архивы не перезаписываются на месте — новый файл всегда новое имя
}));

// ---------------------------------------------------------------- locals для всех шаблонов
// Идёт ДО любых мест, где может отрендериться страница (включая 404 у
// охранника /builder ниже) — иначе шаблон шапки упадёт на неопределённых
// переменных.
app.use((req, res, next) => {
  res.locals.siteAuthorName = process.env.SITE_AUTHOR_NAME || 'МОРГАН';
  res.locals.siteAuthorTelegram = process.env.SITE_AUTHOR_TELEGRAM || '@Xxmorgaan';
  res.locals.gameDevTelegram = process.env.GAME_DEV_TELEGRAM || '@alemcolony';
  res.locals.admin = (req.session && req.session.admin) || null;
  // Логин держим в сессии, а аватарку подтягиваем из базы — так она
  // обновляется сразу после замены, без перезахода в аккаунт.
  res.locals.user = (req.session && req.session.user) || null;
  if (res.locals.user) {
    try {
      const row = require('./src/db').prepare('SELECT avatar_path FROM users WHERE id = ?').get(res.locals.user.id);
      res.locals.user = { ...res.locals.user, avatar: row ? row.avatar_path : null };
    } catch (e) { /* база могла ещё не мигрировать — не повод ронять страницу */ }
  }
  res.locals.isOwner = !!(req.session && req.session.admin && req.session.admin.role === 'owner');
  // Баг-трекер и конструктор модов — только для владельца: и сам раздел, и
  // ссылки на него в шапке/подвале показываются только ему.
  res.locals.bugsEnabled = res.locals.isOwner;   // баг-трекер — только владельцу
  res.locals.builderEnabled = true;              // конструктор модов — всем
  // Рекламный блок РСЯ в подвале — показывается, только если задан id блока.
  res.locals.yandexAdBlockId = (process.env.YANDEX_AD_BLOCK_ID || '').trim();
  res.locals.telegramBotUsername = (process.env.TELEGRAM_BOT_USERNAME || '').trim();
  next();
});

// ---------------------------------------------------------------- бан по IP
// Стоит до статики и роутов: забаненный IP не должен видеть вообще ничего,
// кроме страницы «доступ закрыт» — ни каталог, ни форму публикации.
app.use((req, res, next) => {
  try {
    const ip = clientIp(req);
    if (ip) {
      const banned = require('./src/db').prepare('SELECT reason FROM banned_ips WHERE ip = ?').get(ip);
      if (banned) return res.status(403).render('banned', { title: 'Доступ закрыт', reason: banned.reason });
    }
  } catch (e) { /* база могла ещё не мигрировать — не повод ронять весь сайт */ }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h', // css/js/картинки конструктора правятся редко, но имя файла не версионируется — час за глаза
}));

// ---------------------------------------------------------------- счётчик посещений
// Считаем только настоящие переходы по страницам: GET, не статика (та уже
// перехвачена express.static выше и сюда не дойдёт), не API/админка/аплоады,
// не служебные запросы браузера (favicon/robots) и не известные боты —
// иначе, например, каждый предпросмотр ссылки в Telegram или обход
// поискового робота считался бы «посещением», раздувая цифры.
const BOT_UA_RE = /bot|crawl|spider|preview|facebookexternalhit|telegrambot|vkshare|slackbot|whatsapp|googlebot|yandexbot|bingbot|applebot|discordbot|curl|wget|headlesschrome/i;
const IGNORED_VISIT_PATHS = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml']);

app.use((req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/api')
    && !req.path.startsWith('/uploads') && !req.path.startsWith('/builder') && req.path !== '/healthz'
    && !IGNORED_VISIT_PATHS.has(req.path) && !BOT_UA_RE.test(ua)) {
    try {
      const day = moscowDateStr();
      const db = require('./src/db');
      const updated = db.prepare('UPDATE visit_counters SET count = count + 1 WHERE day = ?').run(day);
      if (updated.changes === 0) db.prepare('INSERT OR IGNORE INTO visit_counters (day, count) VALUES (?, 1)').run(day);
    } catch (e) { /* счётчик — не критично, не должен ронять страницу */ }
  }
  next();
});

// ---------------------------------------------------------------- роуты
app.use('/', require('./routes/pages'));
// Сборки полностью отключены — раздел скрыт из интерфейса и теперь не
// подключается вообще, поэтому /games/.../bundles и /bundles/* отдают 404,
// как и должно быть. Сам код (routes/bundles.js, views/bundle-*.ejs)
// оставлен на месте на случай, если раздел решат вернуть — просто
// раскомментировать строку ниже.
// app.use('/', require('./routes/bundles'));
app.use('/', require('./routes/complaints'));
app.use('/bugs', require('./routes/bugs'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/admin'));
app.use('/api/bot', require('./routes/bot-api'));

// ---------------------------------------------------------------- 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Страница не найдена' });
});

// ---------------------------------------------------------------- healthcheck / keep-alive
// Лёгкий эндпоинт для внешнего пинга (UptimeRobot, cron-job.org — надёжнее)
// и для встроенного самопинга ниже (подстраховка, чтобы Railway не считал
// сервис неактивным на бесплатных/спящих планах).
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------------------------------------------------------------- обработка ошибок
// Общий перехватчик: что бы ни упало (даже неожиданно) — обычный игрок
// видит спокойную страницу, а не стек вызовов с путями к файлам и кодом.
// Технические подробности уходят только в серверный лог (Railway → Logs),
// туда игрок не заглядывает. Должен идти последним — после всех роутов.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '—', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500);
  res.render('500', { title: 'Что-то пошло не так' });
});

app.listen(PORT, () => {
  console.log(`Alem Mod запущен: http://localhost:${PORT}`);

  startAutoApproveSweep();
  startRestoreWatcher();

  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    const pingUrl = `${publicUrl.replace(/\/+$/, '')}/healthz`;
    const intervalMs = 4 * 60 * 1000; // раз в 4 минуты — с запасом от типичных 5-минутных таймаутов сна
    setInterval(() => {
      fetch(pingUrl).catch(() => { /* сеть могла моргнуть — просто попробуем в следующий раз */ });
    }, intervalMs);
    console.log(`[keep-alive] Самопинг включён: ${pingUrl} каждые ${intervalMs / 60000} мин.`);
  } else {
    console.log('[keep-alive] PUBLIC_URL не задан — самопинг выключен. '
      + 'Надёжнее всего добавить внешний пинг на /healthz (UptimeRobot, cron-job.org) независимо от этого.');
  }
});
