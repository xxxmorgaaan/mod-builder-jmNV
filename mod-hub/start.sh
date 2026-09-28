#!/bin/sh
# Не используется по умолчанию — обычный Dockerfile в этом репозитории
# запускает сайт напрямую через `npm start` (ClamAV выключен, см.
# CLAMAV_ENABLED=false в Dockerfile). Этот скрипт нужен, только если
# захотите ВКЛЮЧИТЬ ClamAV: тогда в Dockerfile —
#   1) добавьте в RUN apt-get install: clamav clamav-daemon clamav-freshclam
#   2) поменяйте ENV CLAMAV_ENABLED=false на true
#   3) поменяйте CMD ["npm", "start"] на CMD ["./start.sh"]
# Подробности — раздел 9 в README.md.
#
# Обновляет базы сигнатур, поднимает clamd в фоне, затем запускает сайт.
# Если ClamAV не смог стартовать (например, freshclam не достучался до
# интернета при билде) — сайт всё равно запустится, просто src/scan.js
# сам определит, что ClamAV недоступен, и пометит это в scan_note.

set -e

echo "[start] Обновляю базы ClamAV (freshclam)…"
freshclam --quiet || echo "[start] freshclam не смог обновиться — продолжаю с тем, что есть (или без баз)."

echo "[start] Запускаю clamd в фоне…"
clamd &

echo "[start] Запускаю сайт…"
exec node server.js
