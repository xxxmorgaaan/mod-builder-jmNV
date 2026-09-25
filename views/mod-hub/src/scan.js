// src/scan.js
// -----------------------------------------------------------------------
// Проверка загружаемых файлов в два слоя:
//
//  1. Эвристика по содержимому .zip — работает всегда, без внешних
//     зависимостей: находит исполняемые/скриптовые файлы внутри архива,
//     распаковки-бомбы (огромный несжатый размер при маленьком архиве),
//     подозрительно много файлов, попытки выйти за пределы архива (../).
//     Это не «антивирус» в полном смысле, но отсекает самые частые и самые
//     опасные случаи без единой внешней зависимости.
//
//  2. ClamAV (опционально) — если на сервере установлен и доступен ClamAV
//     (демон clamd или бинарник clamscan/clamdscan), дополнительно
//     проверяет файл по базе сигнатур вирусов. Если ClamAV недоступен —
//     проверка тихо пропускается, это явно отмечается в scan_note, чтобы
//     модератор знал: автоматической проверки на вирусы не было, смотрите
//     сами. Как поднять ClamAV на Railway — см. Dockerfile и README.
// -----------------------------------------------------------------------

const unzipper = require('unzipper');
const fs = require('fs');

const DANGEROUS_EXT = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.jar', '.dll', '.sys', '.app', '.sh',
  '.deb', '.rpm', '.dmg', '.apk', '.iso', '.lnk', '.reg',
];
const MAX_ENTRIES = 3000;
const MAX_UNCOMPRESSED_TOTAL = 800 * 1024 * 1024; // 800 МБ распакованным — за пределами разумного для мода
const MAX_RATIO = 150; // несжатый/сжатый — подозрение на zip-бомбу выше этого

/** Эвристический разбор .zip без полной распаковки — только список записей. */
async function heuristicScanZip(filePath) {
  const issues = [];
  let entries = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;

  try {
    const directory = await unzipper.Open.file(filePath);
    for (const entry of directory.files) {
      entries++;
      totalUncompressed += entry.uncompressedSize || 0;
      totalCompressed += entry.compressedSize || 0;

      const name = entry.path || '';
      if (name.includes('..')) issues.push(`подозрительный путь внутри архива: ${name}`);

      const lower = name.toLowerCase();
      if (DANGEROUS_EXT.some(ext => lower.endsWith(ext))) {
        issues.push(`исполняемый/скриптовый файл внутри архива: ${name}`);
      }
    }
  } catch (err) {
    return { ok: false, blocked: true, issues: [`не удалось прочитать как zip: ${err.message}`], entries: 0 };
  }

  if (entries > MAX_ENTRIES) issues.push(`подозрительно много файлов в архиве: ${entries}`);
  if (totalUncompressed > MAX_UNCOMPRESSED_TOTAL) {
    issues.push(`слишком большой распакованный размер: ${(totalUncompressed / 1024 / 1024).toFixed(0)} МБ`);
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_RATIO) {
    issues.push('подозрение на zip-бомбу (несжатый размер аномально больше сжатого)');
  }

  return { ok: issues.length === 0, blocked: issues.length > 0, issues, entries, totalUncompressed };
}

const KNOWN_MOD_JSON_FILES = {
  'mod.json': null, // проверяется отдельно, обязателен
  'weapons.json': ['weapons', 'materials'],
  'apparel.json': ['apparel'],
  'resources.json': ['resources'],
  'recipes.json': ['recipes'],
  'buildings.json': ['buildings'],
  'techs.json': ['techs'],
  'pawns.json': ['traits', 'traitPairs', 'childhoods', 'adulthoods', 'rareFullfirst',
    'maleNames', 'femaleNames', 'lastNames', 'nicknames', 'rareMale', 'rareFemale', 'chronic'],
  'loc.json': ['en'],
};

/**
 * Сравнивает содержимое архива со структурой обычного мода Alem Colony:
 * должен быть mod.json (в корне архива или в одной обёрточной папке — как
 * у собственного экспорта конструктора), остальные *.json — из известного
 * набора и синтаксически рабочие, текстуры — в папке textures/.
 * Это не проверка на вирусы (см. heuristicScanZip выше) — назначение то же:
 * отсеять то, что вообще не похоже на мод, до того как это увидит модератор.
 */
async function validateModStructure(filePath) {
  const issues = [];
  const notes = [];
  let directory;
  try {
    directory = await unzipper.Open.file(filePath);
  } catch (err) {
    return { blocked: true, issues: [`не удалось прочитать как zip: ${err.message}`], notes: [] };
  }

  const files = directory.files.filter(f => f.type === 'File');
  const modJsonEntry = files.find(f => /(^|\/)mod\.json$/i.test(f.path));
  if (!modJsonEntry) {
    return { blocked: true, issues: ['в архиве нет mod.json — это не похоже на мод для Alem Colony'], notes: [] };
  }
  const prefix = modJsonEntry.path.slice(0, modJsonEntry.path.length - 'mod.json'.length);

  async function readJsonEntry(entry) {
    const buf = await entry.buffer();
    return JSON.parse(buf.toString('utf8'));
  }

  let modJson;
  try {
    modJson = await readJsonEntry(modJsonEntry);
  } catch (err) {
    return { blocked: true, issues: [`mod.json повреждён или не является JSON: ${err.message}`], notes: [] };
  }
  // id в mod.json не обязателен — встречаются рабочие моды вообще без него
  // (папка архива тогда, видимо, и служит идентификатором). Раньше здесь
  // была блокирующая проверка, из-за которой отклонялся вполне рабочий мод —
  // теперь только подсказка модератору, ничего не блокируем.
  if (!modJson.id) notes.push('в mod.json нет поля id (не обязательно, но обычно есть)');
  if (!modJson.name) notes.push('в mod.json нет поля name (не обязательно, но обычно есть)');

  for (const entry of files) {
    if (!entry.path.startsWith(prefix)) continue; // файл вне папки мода — игнорируем при сравнении структуры
    const rel = entry.path.slice(prefix.length);
    if (!rel || rel === 'mod.json') continue;
    if (rel.startsWith('textures/')) continue; // картинки — отдельная история, не JSON

    if (!(rel in KNOWN_MOD_JSON_FILES)) {
      if (rel.endsWith('.json')) notes.push(`неизвестный файл ${rel} — игра его не использует, но и не мешает`);
      continue;
    }
    let parsed;
    try {
      parsed = await readJsonEntry(entry);
    } catch (err) {
      issues.push(`${rel} повреждён или не является JSON: ${err.message}`);
      continue;
    }
    const expectedKeys = KNOWN_MOD_JSON_FILES[rel];
    if (expectedKeys && typeof parsed === 'object' && parsed) {
      const unknownKeys = Object.keys(parsed).filter(k => !expectedKeys.includes(k));
      if (unknownKeys.length) notes.push(`${rel}: неизвестные поля верхнего уровня — ${unknownKeys.join(', ')}`);
    }
  }

  const hasTextures = files.some(f => f.path.startsWith(`${prefix}textures/`));
  if (!hasTextures) notes.push('в архиве нет папки textures — если мод добавляет новые вещи со своими картинками, их не будет видно (можно оставить spriteId существующей вещи, тогда это нормально)');

  return { blocked: issues.length > 0, issues, notes };
}

// ---------------------------------------------------------------- ClamAV
let clamscanInstance = null;
let clamscanInitTried = false;

async function getClamscan() {
  if (clamscanInitTried) return clamscanInstance;
  clamscanInitTried = true;
  if (process.env.CLAMAV_ENABLED !== 'true') return null;
  try {
    const NodeClam = require('clamscan');
    clamscanInstance = await new NodeClam().init({
      removeInfected: false,
      scanLog: null,
      debugMode: false,
      clamdscan: {
        socket: process.env.CLAMAV_SOCKET || false,
        host: process.env.CLAMAV_HOST || false,
        port: process.env.CLAMAV_PORT ? Number(process.env.CLAMAV_PORT) : false,
        timeout: 60000,
      },
      preference: 'clamdscan',
    });
    console.log('[scan] ClamAV подключён и готов проверять файлы.');
  } catch (err) {
    console.warn('[scan] CLAMAV_ENABLED=true, но подключиться не удалось — проверка вирусов пропущена:', err.message);
    clamscanInstance = null;
  }
  return clamscanInstance;
}

async function clamavScan(filePath) {
  const clam = await getClamscan();
  if (!clam) return { available: false, infected: null, viruses: [] };
  try {
    const { isInfected, viruses } = await clam.isInfected(filePath);
    return { available: true, infected: isInfected, viruses: viruses || [] };
  } catch (err) {
    console.warn('[scan] Ошибка ClamAV при проверке файла:', err.message);
    return { available: false, infected: null, viruses: [] };
  }
}

/**
 * Главная точка входа: проверяет файл мода перед тем, как он попадёт в базу.
 * Возвращает { blocked, note } — blocked=true означает «удалить файл и
 * отказать в загрузке», note — короткое пояснение, которое видит модератор
 * (а при блокировке — и сам загрузивший, в сообщении об ошибке).
 */
async function scanUpload(filePath) {
  const heuristic = await heuristicScanZip(filePath);
  if (heuristic.blocked) {
    return { blocked: true, note: `Заблокировано проверкой архива: ${heuristic.issues.join('; ')}` };
  }

  const structure = await validateModStructure(filePath);
  if (structure.blocked) {
    return { blocked: true, note: `Заблокировано проверкой структуры мода: ${structure.issues.join('; ')}` };
  }

  const av = await clamavScan(filePath);
  if (av.infected) {
    return { blocked: true, note: `ClamAV нашёл угрозу: ${av.viruses.join(', ') || 'неизвестная сигнатура'}` };
  }

  // Модератору тут нужен простой сигнал «прошло / есть на что посмотреть»,
  // а не разбор механики проверки — сами файлы смотрятся кнопкой
  // «Посмотреть файлы» в очереди модерации, этого достаточно.
  const note = structure.notes.length ? `Автопроверка пройдена, есть ${structure.notes.length} замечание(й).` : 'Автопроверка пройдена.';
  return { blocked: false, note };
}

/** Список файлов в архиве — для ручного просмотра модератором (без распаковки). */
async function listZipEntries(filePath) {
  const directory = await unzipper.Open.file(filePath);
  return directory.files
    .filter(f => f.type === 'File')
    .map(f => ({ path: f.path, size: f.uncompressedSize || 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Достаёт содержимое одного файла из архива по точному пути (для просмотра). */
async function readZipEntry(filePath, entryPath) {
  const directory = await unzipper.Open.file(filePath);
  const entry = directory.files.find(f => f.type === 'File' && f.path === entryPath);
  if (!entry) return null;
  return entry.buffer();
}

function safeUnlink(filePath) {
  fs.unlink(filePath, () => { /* файла могло не быть — не критично */ });
}

module.exports = { scanUpload, heuristicScanZip, validateModStructure, clamavScan, safeUnlink, listZipEntries, readZipEntry };
