// Todo 2 placeholder DB-reachability probe — Todo 4 replaces with real seed+listen.
// Exits 0 when DATABASE_URL host:port accepts TCP, 1 otherwise. No deps.
import net from 'node:net';

const raw = process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres:5432/flashsale';
let host = 'postgres';
let port = 5432;
try {
  const u = new URL(raw);
  host = u.hostname || host;
  port = Number(u.port || 5432);
} catch {
  // keep defaults
}

const ok = await new Promise((resolve) => {
  const s = net.connect({ host, port }, () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.setTimeout(2000, () => {
    s.destroy();
    resolve(false);
  });
});
process.exit(ok ? 0 : 1);
