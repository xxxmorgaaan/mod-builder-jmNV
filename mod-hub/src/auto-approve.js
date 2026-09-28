// src/auto-approve.js
// -----------------------------------------------------------------------
// Любая запись, которая вообще попала в БД со статусом 'pending', уже
// прошла эвристику + проверку структуры (+ ClamAV, если включён) — иначе
// её файл был бы удалён и до базы дело не дошло бы (см. src/scan.js).
// Значит «на модерации» здесь означает не «не проверено», а «ждёт, чтобы
// админ посмотрел глазами». Даём на это фиксированное окно; если за это
// время никто не одобрил и не отклонил вручную — публикуем сами.
//
// Отключить полностью: AUTO_APPROVE_MINUTES=0 в .env — тогда всё остаётся
// как раньше, только ручная модерация.
// -----------------------------------------------------------------------

const db = require('./db');

function minutesAgoSql(minutes) {
  return `datetime('now', '-${minutes} minutes')`;
}

function sweepOnce(minutes) {
  const cutoff = minutesAgoSql(minutes);

  const mods = db.prepare(`SELECT id, name FROM mods WHERE status = 'pending' AND created_at <= ${cutoff}`).all();
  mods.forEach(m => {
    db.prepare(`UPDATE mods SET status = 'approved' WHERE id = ?`).run(m.id);
    db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE mod_id = ? AND status = 'pending'`).run(m.id);
    console.log(`[auto-approve] Мод «${m.name}» (${m.id}) опубликован автоматически — прошло ${minutes} мин. без ручной проверки.`);
  });

  const versions = db.prepare(
    `SELECT v.id, v.version_label, m.name mod_name FROM mod_versions v
     JOIN mods m ON m.id = v.mod_id
     WHERE v.status = 'pending' AND m.status = 'approved' AND v.created_at <= ${cutoff}`
  ).all();
  versions.forEach(v => {
    db.prepare(`UPDATE mod_versions SET status = 'approved' WHERE id = ?`).run(v.id);
    console.log(`[auto-approve] Версия «${v.version_label}» мода «${v.mod_name}» опубликована автоматически.`);
  });

  const bundles = db.prepare(`SELECT public_id, name FROM bundles WHERE status = 'pending' AND created_at <= ${cutoff}`).all();
  bundles.forEach(b => {
    db.prepare(`UPDATE bundles SET status = 'approved' WHERE public_id = ?`).run(b.public_id);
    console.log(`[auto-approve] Сборка «${b.name}» опубликована автоматически.`);
  });
}

function startAutoApproveSweep() {
  const minutes = process.env.AUTO_APPROVE_MINUTES !== undefined ? Number(process.env.AUTO_APPROVE_MINUTES) : 2;
  if (!minutes || minutes <= 0) {
    console.log('[auto-approve] Отключено (AUTO_APPROVE_MINUTES=0) — только ручная модерация.');
    return;
  }
  console.log(`[auto-approve] Включено: прошедшее автопроверку и провисевшее ${minutes} мин. без решения админа публикуется само.`);
  sweepOnce(minutes); // сразу на старте — не ждать первого тика, если сервер был выключен дольше окна
  setInterval(() => {
    try { sweepOnce(minutes); }
    catch (err) { console.warn('[auto-approve] Ошибка при проверке очереди:', err.message); }
  }, 30 * 1000); // тик почаще — окно теперь короткое (по умолчанию 2 мин), раз в минуту было бы слишком грубо
}

module.exports = { startAutoApproveSweep };
