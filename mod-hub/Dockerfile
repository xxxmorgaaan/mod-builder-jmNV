# Простой Dockerfile: ставит инструменты, нужные для сборки better-sqlite3
# (нативный модуль), и запускает сайт обычным npm start. ClamAV сюда
# специально не ставится — по умолчанию сайт полагается на встроенную
# проверку без внешних зависимостей (эвристика по архиву + сравнение
# структуры мода, см. src/scan.js). Если ClamAV всё же нужен — раздел 9
# в README.md показывает, что добавить в этот файл.

FROM node:18-slim

# Инструменты для сборки better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# npm install вместо npm ci — не требует строгого совпадения lock-файла
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV CLAMAV_ENABLED=false
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
