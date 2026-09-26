// src/restore-watcher.js
// Следит за папкой data/restore-inbox — любой .zip резервной копии,
// закинутый туда (через scp/sftp/файловый менеджер, как удобно), сам
// распакуется поверх текущих данных, а обработанный файл переедет в
// data/restore-inbox/processed, чтобы не применялся повторно.
//
// Зачем это отдельно от кнопки «Восстановить» в админке: та требует
// загрузки через браузер (тянуть большой .zip через мобильный интернет в
// веб-форму неудобно и может упираться в лимиты), а сюда файл можно просто
// скопировать по SFTP/через файловый менеджер Termux — и всё применится
// само, без захода на сайт.
const fs = require('fs');
const path = require('path');
const { restoreFromZipFile } = require('./backup');
const { notifyAdmin } = require('./telegram');

const INBOX_DIR = path.join(__dirname, '..', 'data', 'restore-inbox');
const PROCESSED_DIR = path.join(INBOX_DIR, 'processed');

function ensureDirs() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
}

async function scanOnce() {
  ensureDirs();
  let names;
  try { names = fs.readdirSync(INBOX_DIR); } catch (e) { return; }

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const fullPath = path.join(INBOX_DIR, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (e) { continue; }
    if (!stat.isFile()) continue;

    // Файл мог ещё докачиваться (например, идёт scp) — если он изменился в
    // размере за последнюю секунду, подождём следующего тика вместо того,
    // чтобы распаковывать недокачанный архив.
    await new Promise((r) => setTimeout(r, 800));
    let stat2;
    try { stat2 = fs.statSync(fullPath); } catch (e) { continue; }
    if (stat2.size !== stat.size || stat2.size === 0) continue;

    try {
      const result = await restoreFromZipFile(fullPath);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(fullPath, path.join(PROCESSED_DIR, `${stamp}__${name}`));
      console.log(`[restore-watcher] Восстановлено из "${name}": база=${result.restoredDb ? 'обновлена' : 'без изменений'}, файлов=${result.restoredFiles}, сохранено активности: моды=${result.statsRestored}, комментарии=${result.commentsRestored}, лайки=${result.likesRestored}.`);
      notifyAdmin(
        `♻️ Резервная копия восстановлена автоматически из файла <b>${name}</b>\n`
        + `База: ${result.restoredDb ? 'обновлена' : 'без изменений'}\nФайлов: ${result.restoredFiles}\n`
        + `Сохранена накопленная активность — счётчиков: ${result.statsRestored}, комментариев: ${result.commentsRestored}, лайков: ${result.likesRestored}`
      );
    } catch (err) {
      console.error(`[restore-watcher] Не удалось обработать "${name}":`, err.message);
      // Помечаем файл как проблемный, чтобы не пытаться обработать его на
      // каждом следующем тике бесконечно.
      try { fs.renameSync(fullPath, `${fullPath}.error`); } catch (e2) { /* не критично */ }
      notifyAdmin(`⚠️ Не удалось автоматически восстановить резервную копию из файла <b>${name}</b>: ${err.message}`);
    }
  }
}

function startRestoreWatcher(intervalMs = 15000) {
  ensureDirs();
  console.log(`[restore-watcher] Слежу за data/restore-inbox — закиньте туда .zip резервной копии, применится сам (проверка каждые ${Math.round(intervalMs / 1000)} сек).`);
  scanOnce().catch((err) => console.error('[restore-watcher] Ошибка первичной проверки:', err.message));
  const timer = setInterval(() => {
    scanOnce().catch((err) => console.error('[restore-watcher] Ошибка проверки:', err.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { startRestoreWatcher };
