FROM node:26.10.0-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/package.json ./frontend/
RUN npm ci --workspace=frontend --include-workspace-root=false || npm install --workspace=frontend
COPY frontend/ ./frontend/
WORKDIR /app/frontend
EXPOSE 5173
# Todo 2: connect-probe only — accepts any HTTP status (404 on `/` is expected
# until Todo 10 scaffolds the SPA; Todo 10/12 upgrade this to a 200 check).
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:5173/').then(()=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
