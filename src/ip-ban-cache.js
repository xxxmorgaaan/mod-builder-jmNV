// src/ip-ban-cache.js
// Раньше проверка бана по IP делала SQL-запрос на КАЖДЫЙ входящий запрос —
// это самый частый код на всём сайте, он выполняется перед вообще любой
// страницей. Список банов меняется редко (админ жмёт «забанить» несколько
// раз в неделю, не каждую секунду), поэтому держим его в памяти процесса и
// обновляем: сразу после любого бана/разбана из админки (invalidate()), и
// на всякий случай сами раз в минуту — если банов на VPS несколько
// процессов (несколько воркеров pm2), это подхватит изменения от других.
const db = require('./db');

let bannedSet = new Set();

function refresh() {
  try {
    bannedSet = new Set(db.prepare('SELECT ip FROM banned_ips').all().map(r => r.ip));
  } catch (e) {
    // Таблицы может ещё не быть при самом первом запуске — не страшно,
    // следующий refresh (через минуту или после первого бана) подхватит.
  }
}
refresh();
const timer = setInterval(refresh, 60 * 1000);
if (timer.unref) timer.unref();

function isBanned(ip) {
  return bannedSet.has(ip);
}

module.exports = { isBanned, invalidate: refresh };
