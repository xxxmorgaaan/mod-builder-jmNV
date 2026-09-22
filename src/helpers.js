// src/helpers.js
const crypto = require('crypto');
const { nanoid } = require('nanoid');

function slugify(str) {
  const translitMap = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const translit = (str || '').toLowerCase().split('').map(c => translitMap[c] ?? c).join('');
  const base = translit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mod';
  return `${base}-${nanoid(5).toLowerCase()}`;
}

// Коды управления хранятся ОБРАТИМО зашифрованными (AES-256-GCM), а не
// одноразовым хэшем — специально, чтобы админ мог посмотреть код мода и
// подсказать его автору, если тот его потерял и написал в ЛС. Ключ шифрования
// живёт в ENCRYPTION_KEY (.env) — от него зависит и шифрование, и расшифровка,
// поэтому его нельзя терять и нельзя коммитить в открытый репозиторий.
function getEncKey() {
  const raw = process.env.ENCRYPTION_KEY || 'change-me-to-a-long-random-string';
  return crypto.createHash('sha256').update(raw).digest(); // всегда ровно 32 байта для aes-256
}

function encryptCode(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptCode(stored) {
  try {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    return null; // испорчено, или зашифровано другим ENCRYPTION_KEY
  }
}

/** Код управления = <id записи>.<случайная часть> — по id проверка O(1),
 *  сама запись в базе хранится зашифрованной (см. выше), не в открытом виде. */
function issueControlCode(recordId) {
  const code = `${recordId}.${nanoid(14)}`;
  return { code, hash: encryptCode(code) };
}

function verifyControlCode(code, stored) {
  if (!code) return false;
  const decrypted = decryptCode(stored);
  return decrypted !== null && decrypted === code;
}

/** Для админки — достать код обратно, чтобы подсказать забывчивому автору. */
function revealControlCode(stored) {
  return decryptCode(stored);
}

function recordIdFromCode(code) {
  if (!code || !code.includes('.')) return null;
  return code.slice(0, code.indexOf('.'));
}

/** Анонимный «голосующий» токен для лайков — живёт в httpOnly cookie, не привязан к личности. */
function getVoterToken(req, res) {
  if (req.cookies && req.cookies.voter) return req.cookies.voter;
  const token = nanoid(24);
  res.cookie('voter', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 * 2 });
  return token;
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return `${header}\n${body}`;
}

function humanSize(bytes) {
  if (!bytes) return '0 КБ';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Может ли этот запрос управлять записью: верный код, ИЛИ админ в своей сессии,
 *  ИЛИ вошедший разработчик — владелец записи (аккаунт, необязательная альтернатива коду). */
function canManage(req, code, hash, ownerUserId) {
  if (req.session && req.session.admin) return true;
  if (req.session && req.session.user && ownerUserId && req.session.user.id === ownerUserId) return true;
  return verifyControlCode(code, hash);
}

/** Теги хранятся в нижнем регистре — иначе "Оружие" и "оружие" считаются
 *  двумя разными тегами. Показываются с большой буквы через CSS
 *  (text-transform: capitalize на .tag-chip), в базе всегда lower-case. */
function normalizeTag(tag) {
  return (tag || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 30);
}

/** Настоящий IP клиента. С express-совместимым trust proxy req.ip уже
 *  учитывает X-Forwarded-For, тут просто небольшая подчистка формата
 *  IPv4-in-IPv6 (::ffff:1.2.3.4), чтобы бан по IP не путался в двух видах
 *  записи одного и того же адреса. */
function clientIp(req) {
  const raw = (req.ip || (req.connection && req.connection.remoteAddress) || '').trim();
  return raw.replace(/^::ffff:/, '');
}

module.exports = {
  slugify, issueControlCode, verifyControlCode, revealControlCode, recordIdFromCode,
  getVoterToken, toCsv, humanSize, canManage, normalizeTag, clientIp,
};
