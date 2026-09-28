#!/bin/bash
# scripts/backup-to-drive.sh
#
# Бэкапит папку проекта (/root/alem-mod) в .tar.gz и кладёт копию в двух
# местах: локально на VPS в /backup/ (НЕ внутри /root — отдельная папка на
# верхнем уровне) и на Google Диск через rclone. В обоих местах хранится не
# больше MAX_BACKUPS штук — при появлении нового бэкапа самый старый
# удаляется.
#
# node_modules и .git из архива исключены намеренно: node_modules
# восстанавливается одной командой `npm install`, а .git — это история
# кода, а не данные сайта (сами данные — data/ и public/uploads — внутри
# папки проекта, они попадают в архив как обычно).
#
# Запуск вручную для проверки: sh /root/alem-mod/scripts/backup-to-drive.sh
# Обычный запуск — по расписанию через cron (см. README ниже про crontab).

set -uo pipefail

SOURCE_DIR="/root/alem-mod"
LOCAL_BACKUP_DIR="/backup"
GDRIVE_REMOTE="gdrive:alem-mod-backups"   # имя remote в rclone : папка на Google Диске
MAX_BACKUPS=4

STAMP=$(date +%Y-%m-%d_%H-%M)
ARCHIVE_NAME="alem-mod-backup-${STAMP}.tar.gz"
ARCHIVE_PATH="${LOCAL_BACKUP_DIR}/${ARCHIVE_NAME}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$LOCAL_BACKUP_DIR"

log "Создаю архив ${ARCHIVE_PATH}..."
if ! tar --exclude="node_modules" --exclude=".git" --exclude="data/restore-inbox/processed" \
      -czf "$ARCHIVE_PATH" -C "$(dirname "$SOURCE_DIR")" "$(basename "$SOURCE_DIR")"; then
  log "ОШИБКА: не удалось создать архив — прерываю (на Google Диск заливать нечего)."
  exit 1
fi
log "Архив создан, размер: $(du -h "$ARCHIVE_PATH" | cut -f1)"

# ---------------------------------------------------------------- Google Диск
if command -v rclone >/dev/null 2>&1; then
  log "Загружаю на Google Диск (${GDRIVE_REMOTE})..."
  if rclone copy "$ARCHIVE_PATH" "$GDRIVE_REMOTE" --quiet; then
    log "Загружено на Google Диск."
  else
    log "ОШИБКА: не удалось загрузить на Google Диск (локальная копия всё равно осталась в ${LOCAL_BACKUP_DIR})."
  fi
else
  log "ОШИБКА: rclone не установлен — пропускаю загрузку на Google Диск. См. scripts/README-backup.md."
fi

# ---------------------------------------------------------------- ротация: локально
log "Чищу старые локальные бэкапы (оставляю последние ${MAX_BACKUPS})..."
ls -1t "${LOCAL_BACKUP_DIR}"/alem-mod-backup-*.tar.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | while read -r old; do
  log "  удаляю локально: $old"
  rm -f "$old"
done

# ---------------------------------------------------------------- ротация: Google Диск
if command -v rclone >/dev/null 2>&1; then
  log "Чищу старые бэкапы на Google Диске (оставляю последние ${MAX_BACKUPS})..."
  # Имена файлов начинаются с даты в сортируемом формате — обычная
  # алфавитная сортировка = сортировка по времени.
  rclone lsf "$GDRIVE_REMOTE" --files-only 2>/dev/null | sort | head -n -"$MAX_BACKUPS" | while read -r old; do
    log "  удаляю с Google Диска: $old"
    rclone deletefile "${GDRIVE_REMOTE}/${old}"
  done
fi

log "Готово."
