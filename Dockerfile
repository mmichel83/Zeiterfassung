# Zeiterfassung – Container (keine npm-Pakete nötig)
# Läuft mit docker compose und auf Railway. Die Daten liegen in /app/data,
# dort muss ein dauerhafter Speicher (Volume) eingehängt werden.
FROM node:22-alpine
RUN apk add --no-cache tzdata
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
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
