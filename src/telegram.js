// src/telegram.js
// Уведомления владельцу в Telegram (новый мод/версия на модерации) и
// проверка подписи Telegram Login Widget (вход/регистрация через Telegram).
// Всё завязано на переменные окружения — если они не заданы, функции тихо
// ничего не делают (сайт при этом продолжает работать как обычно).
const crypto = require('crypto');

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
// Можно указать несколько chat_id через запятую — уведомление уйдёт каждому
// админу отдельным сообщением (например, "111111111,222222222").
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Отправить текстовое сообщение всем админам в Telegram. Никогда не бросает
 *  исключение наружу — сеть могла моргнуть, токен мог быть не задан, это
 *  не повод ронять запрос пользователя, который просто публиковал мод. */
async function notifyAdmin(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_IDS.length) return;
  await Promise.all(ADMIN_CHAT_IDS.map(async (chatId) => {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
    } catch (err) {
      console.error(`[telegram] Не удалось отправить уведомление (chat_id ${chatId}):`, err.message);
    }
  }));
}

/** Проверка подписи данных, которые прислал Telegram Login Widget.
 *  Алгоритм из документации Telegram: секрет = SHA256(bot token), подпись —
 *  HMAC-SHA256 от отсортированных полей "key=value" через \n, сверяем с hash. */
function verifyTelegramAuth(data) {
  if (!BOT_TOKEN) return false;
  const { hash, ...rest } = data;
  if (!hash) return false;
  const checkString = Object.keys(rest)
    .filter(k => rest[k] !== undefined && rest[k] !== null)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac.length !== hash.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))) return false;
  // auth_date не старше суток — старую, возможно переиспользованную ссылку не принимаем.
  const authDate = parseInt(rest.auth_date, 10) || 0;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  return ageSeconds >= 0 && ageSeconds < 86400;
}

/** То же самое, но с кнопками под сообщением (inline keyboard) — например
 *  «Одобрить» / «Отклонить» прямо под уведомлением о новом моде. buttons —
 *  массив [{ text, callback_data }] (одна строка кнопок). Нажатие кнопки
 *  ловит только запущенный бот (long polling, см. /telegram-bot) — само по
 *  себе sendMessage от сайта кнопки просто рисует. */
async function notifyAdminWithButtons(text, buttons) {
  if (!BOT_TOKEN || !ADMIN_CHAT_IDS.length) return;
  await Promise.all(ADMIN_CHAT_IDS.map(async (chatId) => {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [buttons] },
        }),
      });
    } catch (err) {
      console.error(`[telegram] Не удалось отправить уведомление (chat_id ${chatId}):`, err.message);
    }
  }));
}

module.exports = { notifyAdmin, notifyAdminWithButtons, verifyTelegramAuth, botConfigured: () => !!BOT_TOKEN };
