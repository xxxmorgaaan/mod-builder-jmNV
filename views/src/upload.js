// src/upload.js
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

// Папки загрузок создаём при старте: multer НЕ создаёт их сам и молча
// роняет загрузку, если папки нет. На Railway том монтируется поверх
// public/uploads пустым, так что без этого не работали бы ни аватарки,
// ни обложки — вообще ни одна загрузка на свежем томе.
const UPLOAD_DIRS = ['covers', 'screenshots', 'archives', 'bugs', 'avatars', 'tmp'];
UPLOAD_DIRS.forEach(dir => fs.mkdirSync(path.join(UPLOAD_ROOT, dir), { recursive: true }));

function storageFor(subdir) {
  return multer.diskStorage({
    destination: path.join(UPLOAD_ROOT, subdir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
    },
  });
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ARCHIVE_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

function imageFilter(req, file, cb) {
  cb(null, IMAGE_TYPES.includes(file.mimetype));
}

function archiveFilter(req, file, cb) {
  const ok = ARCHIVE_TYPES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
  cb(null, ok);
}

const uploadCover = multer({
  storage: storageFor('covers'),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const uploadScreens = multer({
  storage: storageFor('screenshots'),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
});

// Резервная копия сайта — кладём во временную папку, после распаковки удаляем.
const uploadBackup = multer({
  dest: path.join(UPLOAD_ROOT, 'tmp'),
  fileFilter: archiveFilter,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const uploadAvatar = multer({
  storage: storageFor('avatars'),
  fileFilter: imageFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

const uploadBugScreens = multer({
  storage: storageFor('bugs'),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
});

const uploadArchive = multer({
  storage: storageFor('archives'),
  fileFilter: archiveFilter,
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Форма публикации мода шлёт всё вместе одним запросом.
const uploadModFiles = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const map = { cover: 'covers', screenshots: 'screenshots', archive: 'archives' };
      cb(null, path.join(UPLOAD_ROOT, map[file.fieldname] || 'archives'));
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'archive') return archiveFilter(req, file, cb);
    return imageFilter(req, file, cb);
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 10 },
});

module.exports = { uploadCover, uploadScreens, uploadAvatar, uploadBackup, uploadBugScreens, uploadArchive, uploadModFiles, UPLOAD_ROOT };
