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
const { isBanned: isIpBanned } = require('./src/ip-ban-cache');
const { levelOf, ROLE_LABELS } = require('./src/auth');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Метка версии кода — чтобы можно было проверить в логах (`pm2 logs alem-mod`
// сразу после запуска) и на вкладке «Настройки» в админке, действительно ли
// на сервере запущена та версия, которую вы только что задеплоили, а не
// старая. Меняйте на что угодно понятное вам при каждом обновлении
// (например, дату коммита) — это просто ориентир для сверки, а не что-то,
// что как-то влияет на работу сайта.
const BUILD_MARKER = '2026-09-27: аддоны к модам, лимит скачивания раз в 2 мин, роли админов (владелец/ст.админ/админ/модер), подборки, журнал с фильтрами, без конструктора';

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
  // Уровень роли админа (0 — не админ): 1 модер, 2 админ, 3 старший админ, 4 владелец.
  res.locals.adminLevel = levelOf(req.session && req.session.admin && req.session.admin.role);
  res.locals.roleLabel = ROLE_LABELS[req.session && req.session.admin && req.session.admin.role] || '';
  // Баг-трекер — только для владельца: и сам раздел, и ссылка на него в
  // шапке показывается только ему. Конструктор модов убран с сайта совсем
  // (был по /builder/ — удалён и код, и ссылки на него).
  res.locals.bugsEnabled = res.locals.adminLevel >= 3;
  // Рекламный блок РСЯ в подвале — показывается, только если задан id блока.
  res.locals.yandexAdBlockId = (process.env.YANDEX_AD_BLOCK_ID || '').trim();
  res.locals.telegramBotUsername = (process.env.TELEGRAM_BOT_USERNAME || '').trim();
  res.locals.buildMarker = BUILD_MARKER;
  next();
});

// ---------------------------------------------------------------- бан по IP
// Стоит до статики и роутов: забаненный IP не должен видеть вообще ничего,
// кроме страницы «доступ закрыт» — ни каталог, ни форму публикации.
// Проверка — по кэшу в памяти (src/ip-ban-cache.js), а не SQL-запросом на
// каждый запрос: это самый частый код на сайте, дёргать базу тут лишнее.
app.use((req, res, next) => {
  const ip = clientIp(req);
  if (ip && isIpBanned(ip)) {
    const reason = (() => {
      try { return db.prepare('SELECT reason FROM banned_ips WHERE ip = ?').get(ip)?.reason; }
      catch (e) { return null; }
    })();
    return res.status(403).render('banned', { title: 'Доступ закрыт', reason });
  }
  next();
});

// Конструктор модов убран с сайта — раньше лежал в public/builder и
// раздавался как обычная статика; сами файлы удалены, но на случай, если
// где-то в кэше/закладках осталась старая ссылка — явно отдаём 404, а не
// молча служим что попало (и не полагаемся только на то, что файлов больше
// нет: та же ошибка уже была со «сборками», когда просто убрали ссылку из
// меню, а раздел продолжал открываться напрямую по URL).
app.use('/builder', (req, res) => {
  res.status(404).render('404', { title: 'Страница не найдена' });
});

// Версия статики: меняется при каждом запуске сервера, поэтому после
// обновления браузер сразу берёт новые css/js, а не кэш на час.
app.locals.assetV = Date.now();

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
    && !req.path.startsWith('/uploads') && req.path !== '/healthz'
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
  console.log(`[build] ${BUILD_MARKER}`);

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
