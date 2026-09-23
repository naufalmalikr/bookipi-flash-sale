/**
 * Boot-time environment parsing with strict UTC ISO-8601 Z-only validation.
 *
 * SALE_START / SALE_END MUST match ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$
 * and Date.parse() must succeed. Violation -> console.error 500-at-boot line
 * + process.exit(1) (never boot with a skewed/ambiguous window).
 * Defaults: now+60s / now+10min, STOCK_QTY semantics untouched (seed owns it).
 */

const Z_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export interface BootEnv {
  port: number;
  saleStart: string;
  saleEnd: string;
  rateLimitBuy: number;
}

function parseZoned(name: string, raw: string | undefined, fallback: string): string {
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (!Z_UTC_RE.test(value) || Number.isNaN(Date.parse(value))) {
    // 500-at-boot log line: window config is a server error, not a 4xx.
    console.error(
      `[boot] 500 invalid ${name}=${JSON.stringify(value)} ` +
        `(must be UTC ISO-8601 with trailing Z, e.g. 2026-09-23T07:40:00Z)`,
    );
    process.exit(1);
  }
  return value;
}

export function loadBootEnv(): BootEnv {
  const now = Date.now();
  const defaultStart = new Date(now + 60_000).toISOString();
  const defaultEnd = new Date(now + 10 * 60_000).toISOString();

  const saleStart = parseZoned('SALE_START', process.env['SALE_START'], defaultStart);
  const saleEnd = parseZoned('SALE_END', process.env['SALE_END'], defaultEnd);

  if (Date.parse(saleEnd) <= Date.parse(saleStart)) {
    console.error(
      `[boot] 500 invalid SALE_END=${JSON.stringify(saleEnd)} ` +
        `(must be after SALE_START=${JSON.stringify(saleStart)})`,
    );
    process.exit(1);
  }

  const portRaw: string | undefined = process.env['PORT'];
  let port = 3001;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number.parseInt(portRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    }
  }

  const rlRaw: string | undefined = process.env['RATE_LIMIT_BUY'];
  let rateLimitBuy = 10;
  if (rlRaw !== undefined && rlRaw !== '') {
    const parsed = Number.parseInt(rlRaw, 10);
    // 0 (or negative) DISABLES the buy rate limit entirely — load-test switch
    // (Todo 14 k6 proof). Positive integers set max req/min/IP. Non-numeric
    // input falls back to the default 10.
    if (Number.isInteger(parsed) && parsed >= 0) {
      rateLimitBuy = parsed;
    }
  }

  return { port, saleStart, saleEnd, rateLimitBuy };
}
