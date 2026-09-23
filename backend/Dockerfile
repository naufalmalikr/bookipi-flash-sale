FROM node:26.10.0-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
RUN npm ci --workspace=backend --include-workspace-root=false
COPY backend/ ./backend/
RUN npm run build --workspace=backend
RUN chmod +x ./backend/docker-entrypoint.sh
WORKDIR /app/backend
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3001/health || exit 1
ENTRYPOINT ["sh", "/app/backend/docker-entrypoint.sh"]
