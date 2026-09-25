# Stage 1: build the production bundle. VITE_API_URL must be baked in at
# build time (Vite inlines import.meta.env), so it arrives as a build arg:
# browsers in compose hit the backend directly at http://localhost:3001.
FROM node:26.10.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/package.json ./frontend/
RUN npm ci --workspace=frontend --include-workspace-root=false || npm install --workspace=frontend
COPY frontend/ ./frontend/
WORKDIR /app/frontend
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Stage 2: serve the static bundle from nginx (no dev server, no HMR).
# SPA fallback sends deep links to index.html.
FROM nginx:1.31-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5173
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
