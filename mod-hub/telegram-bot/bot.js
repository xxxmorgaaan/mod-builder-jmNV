// telegram-bot/bot.js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

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

const SITE_RESTART_CMD = (process.env.SITE_RESTART_CMD || 'pm2 restart alem-mod').trim();
const SERVER_REBOOT_CMD = (process.env.SERVER_REBOOT_CMD || 'sudo systemctl reboot').trim();

if (!BOT_TOKEN || !SITE_URL || !BOT_API_SECRET) {
  console.error('[bot] Заполните telegram-bot/.env: нужны BOT_TOKEN, SITE_URL и BOT_API_SECRET.');
  process.exit(1);
}
if (ADMIN_IDS.length === 0) {
  console.warn('[bot] ВНИМАНИЕ: ADMIN_CHAT_IDS пуст — бот не будет отвечать никому.');
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(String(chatId));
}

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
  const lines = [];
  if (data.mods.length) {
    lines.push('<b>📦 Моды на модерации:</b>');
    for (const m of data.mods) {
      lines.push(`• <b>${escapeHtml(m.name)}</b> — ${escapeHtml(m.summary || '')}`);
    }
  }
  if (data.versions.length) {
    if (lines.length) lines.push('');
    lines.push('<b>🧩 Версии на модерации:</b>');
    for (const v of data.versions) {
      lines.push(`• <b>${escapeHtml(v.mod_name)}</b> — ${escapeHtml(v.version_label)} (${v.file_size_human})`);
    }
  }
  lines.push('');
  lines.push('Модерировать: на сайте.');
  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: lines.join('\n'),
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!isAdmin(chatId)) {
    if (text === '/start') {
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `Доступ только для администраторов.\n\nВаш chat_id: <code>${chatId}</code>`,
      });
    }
    return;
  }

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `Привет! Бот Alem Mod.\n\nКоманды:\n/pending — что сейчас на модерации\n/restart — перезапустить сайт и/или сервер`,
    });
    return;
  }

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

async function runRestartCmd(label, cmd) {
  if (!cmd) return `⚠️ ${label}: команда не настроена.`;
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

  if (action === 'restart_ask') {
    const extraWarning = (target === 'server' || target === 'both')
      ? ' Бот при этом тоже перезагрузится вместе с VPS и вернётся сам через 30–90 секунд, если настроен автозапуск.'
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
      await tg('sendMessage', {
        chat_id: chatId,
        text: '⏳ Отправлена команда на перезагрузку сервера — бот отключится вместе с VPS и вернётся сам, если настроен автозапуск.',
      }).catch(() => {});
      results.push(await runRestartCmd('Сервер', SERVER_REBOOT_CMD));
    }

    await tg('sendMessage', { chat_id: chatId, text: results.join('\n') }).catch(() => {});
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Неизвестное действие.' });
}

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
