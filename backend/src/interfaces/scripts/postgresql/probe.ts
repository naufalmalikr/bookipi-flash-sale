/**
 * Postgres TCP reachability probe (thin script adapter).
 *
 * DB host/port come ONLY from loadConfig().databaseUrl — the sole
 * process.env reader. Exits 0 when the host:port accepts TCP, 1 otherwise.
 * No dependencies beyond node:net.
 *
 * Runnable standalone:
 *   node --experimental-strip-types src/interfaces/scripts/postgresql/probe.ts
 * Built output:
 *   node dist/interfaces/scripts/postgresql/probe.js
 */

import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../../Config.ts';

export interface ProbeTarget {
  host: string;
  port: number;
}

/** Parse host/port out of a postgres URL, falling back to compose defaults. */
export function parseHostPort(databaseUrl: string): ProbeTarget {
  let host = 'postgres';
  let port = 5432;
  try {
    const u = new URL(databaseUrl);
    host = u.hostname || host;
    port = Number(u.port || 5432);
  } catch {
    // keep defaults
  }
  return { host, port };
}

function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export async function probeDatabase(timeoutMs = 2000): Promise<ProbeTarget & { reachable: boolean }> {
  const { databaseUrl } = loadConfig();
  const { host, port } = parseHostPort(databaseUrl);
  const reachable = await probeTcp(host, port, timeoutMs);
  return { host, port, reachable };
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const result = await probeDatabase();
  if (!result.reachable) {
    process.stderr.write(
      `[probe] postgres unreachable at ${result.host}:${String(result.port)}\n`,
    );
  }
  process.exit(result.reachable ? 0 : 1);
}
