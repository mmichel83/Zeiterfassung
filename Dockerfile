# Zeiterfassung – Container (keine npm-Pakete nötig)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    PORT=3000 \
    DB_FILE=/app/data/zeiterfassung.db
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
