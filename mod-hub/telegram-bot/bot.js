// telegram-bot/bot.js
// Отдельный Telegram-бот для Alem Mod. Работает через long polling (сам
// периодически спрашивает Telegram "есть новые сообщения?"), поэтому ему
// НЕ нужен белый IP, домен или открытый порт — прекрасно работает в
// Termux на обычном телефоне за NAT/мобильным интернетом, точно так же
// на VPS.
//
// Что умеет:
//   /start    — прислать ваш chat_id (впишите его на сайте в
//               TELEGRAM_ADMIN_CHAT_ID и в этот бот в ADMIN_CHAT_IDS)
//   /pending  — показать всё, что сейчас висит на модерации, с кнопками
//               «Одобрить» / «Отклонить» под каждой записью
//   кнопки под уведомлением от сайта — тоже работают, бот их ловит и
//               сразу шлёт решение обратно на сайт через /api/bot/*
//
// Никаких npm-пакетов не требуется — используется встроенный fetch
// (Node 18+, в Termux пакет nodejs его уже содержит).

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ---------------------------------------------------------------- .env
// Простой загрузчик .env без зависимостей — читает файл рядом со скриптом.
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  });
}
loadEnv();

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const SITE_URL = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const BOT_API_SECRET = (process.env.BOT_API_SECRET || '').trim();
const ADMIN_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Команды перезапуска выполняются ЛОКАЛЬНО, прямо тем же процессом, что и
// сам бот, — специально не через HTTP на сайт: если сайт лежит, запрос на
// "перезапусти себя" через HTTP до него как раз и не дойдёт. Поэтому нужно,
// чтобы бот физически работал на той же VPS, что и сайт (см. README).
const SITE_RESTART_CMD = (process.env.SITE_RESTART_CMD || 'pm2 restart mod-hub').trim();
// Полная перезагрузка VPS целиком — не просто nginx, а вся машина. Значит,
// и сам бот при этом перезапустится вместе со всем остальным (см. предупреждение
// перед выполнением и README про автозапуск бота через pm2 после ребута).
const SERVER_REBOOT_CMD = (process.env.SERVER_REBOOT_CMD || 'sudo systemctl reboot').trim();

if (!BOT_TOKEN || !SITE_URL || !BOT_API_SECRET) {
  console.error('[bot] Заполните telegram-bot/.env: нужны BOT_TOKEN, SITE_URL и BOT_API_SECRET (см. .env.example).');
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------------------------------------------------------------- helpers
async function tg(method, payload) {
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`[bot] Ошибка вызова Telegram API (${method}):`, err.message);
    return { ok: false, error: err.message };
  }
}

async function siteApi(pathname, opts = {}) {
  try {
    const res = await fetch(`${SITE_URL}${pathname}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_API_SECRET },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return await res.json();
  } catch (err) {
    return { error: `не удалось достучаться до сайта: ${err.message}` };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function isAdmin(chatId) {
  // Если список пуст — админом считается кто угодно (для первого запуска,
  // пока вы не вписали свой chat_id). Как только список задан — только он.
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(String(chatId));
}

// ---------------------------------------------------------------- команды
async function sendPendingList(chatId) {
  const data = await siteApi('/api/bot/pending');
  if (data.error) {
    await tg('sendMessage', { chat_id: chatId, text: `Ошибка запроса к сайту: ${data.error}` });
    return;
  }
  if (!data.mods.length && !data.versions.length) {
    await tg('sendMessage', { chat_id: chatId, text: 'На модерации сейчас пусто ✅' });
    return;
  }
  for (const m of data.mods) {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `📦 Мод: <b>${escapeHtml(m.name)}</b>\n${escapeHtml(m.summary || '')}`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Одобрить', callback_data: `approve_mod:${m.id}` },
        { text: '❌ Отклонить', callback_data: `reject_mod:${m.id}` },
      ]] },
    });
  }
  for (const v of data.versions) {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `🧩 Версия: <b>${escapeHtml(v.mod_name)}</b> — ${escapeHtml(v.version_label)} (${v.file_size_human})`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Одобрить', callback_data: `approve_version:${v.id}` },
        { text: '❌ Отклонить', callback_data: `reject_version:${v.id}` },
      ]] },
    });
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `Привет! Это бот модерации Alem Mod.\n\nВаш chat_id: <code>${chatId}</code>\n\n`
        + `Впишите его в переменную <b>ADMIN_CHAT_IDS</b> в файле .env этого бота и в <b>TELEGRAM_ADMIN_CHAT_ID</b> `
        + `в .env самого сайта (через запятую, если админов несколько) — после этого будете получать уведомления `
        + `о новых модах и сможете модерировать их прямо здесь.\n\nКоманды:\n/pending — что сейчас на модерации\n/restart — перезапустить сайт и/или nginx`,
    });
    return;
  }

  if (!isAdmin(chatId)) return; // остальное — только для админов из ADMIN_CHAT_IDS

  if (text === '/pending' || text === '/status') {
    await sendPendingList(chatId);
    return;
  }

  if (text === '/restart') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Что перезапустить?',
      reply_markup: { inline_keyboard: [[
        { text: '🌐 Сайт', callback_data: 'restart_ask:site' },
        { text: '🖥 Сервер (весь VPS)', callback_data: 'restart_ask:server' },
        { text: '🔁 Оба', callback_data: 'restart_ask:both' },
      ]] },
    });
  }
}

const RESTART_LABELS = { site: 'сайт', server: 'сервер целиком (перезагрузка VPS)', both: 'сайт, затем сервер целиком' };

/** Выполнить одну команду перезапуска и вернуть человекочитаемый результат
 *  (без утечки полного stdout/stderr в чат — только факт успеха/ошибки и
 *  первая строка сообщения об ошибке, для остального — смотреть логи бота). */
async function runRestartCmd(label, cmd) {
  if (!cmd) return `⚠️ ${label}: команда не настроена (см. telegram-bot/.env).`;
  try {
    await execAsync(cmd, { timeout: 25000 });
    return `✅ ${label}: перезапущено.`;
  } catch (err) {
    const short = (err.stderr || err.message || 'неизвестная ошибка').toString().trim().split('\n')[0];
    return `❌ ${label}: ошибка — ${short}`;
  }
}

async function handleCallbackQuery(cq) {
  const chatId = cq.message.chat.id;
  if (!isAdmin(chatId)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Нет доступа.' });
    return;
  }

  const [action, target] = (cq.data || '').split(':');

  // ------------------------------------------------------ перезапуск: шаг подтверждения
  if (action === 'restart_ask') {
    const extraWarning = (target === 'server' || target === 'both')
      ? ' Бот при этом тоже перезагрузится вместе с VPS и вернётся сам через 30–90 секунд, если настроен автозапуск (см. README, раздел про pm2 startup).'
      : '';
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: `Точно перезапустить ${RESTART_LABELS[target]}?${extraWarning}`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Да, перезапустить', callback_data: `restart_do:${target}` },
        { text: '❌ Отмена', callback_data: 'restart_cancel' },
      ]] },
    });
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }

  if (action === 'restart_cancel') {
    await tg('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: 'Отменено.' });
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }

  if (action === 'restart_do') {
    await tg('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: `⏳ Перезапускаю: ${RESTART_LABELS[target]}...` });
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Выполняю...' });

    const results = [];
    if (target === 'site' || target === 'both') {
      results.push(await runRestartCmd('Сайт', SITE_RESTART_CMD));
    }
    if (target === 'server' || target === 'both') {
      // Предупреждаем ДО выполнения — после реальной команды на перезагрузку
      // бот и сама VPS могут вырубиться раньше, чем успеют отправиться
      // следующие сообщения, поэтому итоговый отчёт ниже может не дойти
      // (и это нормально, машина реально перезагружается).
      await tg('sendMessage', {
        chat_id: chatId,
        text: '⏳ Отправлена команда на перезагрузку сервера — бот сейчас отключится вместе с VPS и вернётся сам, если настроен автозапуск (pm2 startup).',
      }).catch(() => {});
      results.push(await runRestartCmd('Сервер', SERVER_REBOOT_CMD));
    }

    await tg('sendMessage', { chat_id: chatId, text: results.join('\n') }).catch(() => {});
    return;
  }

  // ------------------------------------------------------ модерация (approve/reject)
  const endpoints = {
    approve_mod: `/api/bot/mods/${target}/approve`,
    reject_mod: `/api/bot/mods/${target}/reject`,
    approve_version: `/api/bot/mod-versions/${target}/approve`,
    reject_version: `/api/bot/mod-versions/${target}/reject`,
  };
  const endpoint = endpoints[cq.data.split(':')[0]];
  if (!endpoint) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Неизвестное действие.' });
    return;
  }

  const result = await siteApi(endpoint, { method: 'POST' });
  if (result.error) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: `Ошибка: ${result.error}`, show_alert: true });
    return;
  }

  const actionLabel = cq.data.startsWith('approve') ? '✅ Одобрено' : '❌ Отклонено';
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: `${cq.message.text}\n\n${actionLabel} через бота.`,
  });
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: actionLabel });
}

// ---------------------------------------------------------------- long polling
let offset = 0;
async function poll() {
  try {
    const res = await fetch(`${TG_API}/getUpdates?timeout=50&offset=${offset}`);
    const data = await res.json();
    if (data.ok) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          else if (update.callback_query) await handleCallbackQuery(update.callback_query);
        } catch (err) {
          console.error('[bot] Ошибка обработки апдейта:', err.message);
        }
      }
    } else if (data.error_code) {
      console.error('[bot] Telegram API ответил ошибкой:', data.description);
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch (err) {
    console.error('[bot] Сеть моргнула, пробуем ещё раз через 3 сек:', err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

console.log('[bot] Alem Mod бот запущен, слушаю сообщения... (Ctrl+C — остановить)');
poll();
