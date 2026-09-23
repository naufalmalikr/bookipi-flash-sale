import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rlPkg = require('@fastify/rate-limit/package.json');
console.log(`rate-limit pkg version: ${rlPkg.version}`);

const app = Fastify({ logger: false });
await app.register(rateLimit, { max: 10, timeWindow: '1 minute', global: false });
console.log('rate-limit plugin registered OK');

app.get('/health', async () => ({ ok: true }));

const res = await app.inject({ method: 'GET', url: '/health' });
console.log(`GET /health -> ${res.statusCode} ${res.body}`);
if (res.statusCode !== 200) {
  console.error('FAIL: /health did not return 200');
  process.exit(1);
}
const body = JSON.parse(res.body);
if (body.ok !== true) {
  console.error('FAIL: /health body mismatch');
  process.exit(1);
}
console.log('BOOT OK: exit 0');
process.exit(0);
