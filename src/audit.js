// src/audit.js
// Журнал действий модераторов/админов — кто, что и когда одобрил, отклонил,
// удалил или забанил. Пишем в него из routes/admin.js (и routes/bot-api.js
// для действий через Telegram-бота) при каждом изменяющем действии.
const db = require('./db');

/** actorName — логин админа (или "Telegram-бот" для действий через бота).
 *  action — короткий код действия ('approve_mod', 'ban_user', ...).
 *  target — человекочитаемое имя объекта (название мода, логин юзера).
 *  details — необязательная доп. информация (причина отклонения и т.п.). */
function logAction(actorName, action, target, details) {
  try {
    db.prepare('INSERT INTO admin_actions (admin_name, action, target, details) VALUES (?, ?, ?, ?)')
      .run(actorName || 'неизвестно', action, target || null, details || null);
  } catch (e) {
    console.error('[audit] Не удалось записать в журнал действий:', e.message);
  }
}

/** Достаёт логин админа из сессии текущего запроса — самый частый случай. */
function actorFromReq(req) {
  return (req.session && req.session.admin && req.session.admin.username) || 'неизвестно';
}

module.exports = { logAction, actorFromReq };
