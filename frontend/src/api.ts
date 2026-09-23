/**
 * Todo 10: frontend API helpers.
 *
 * base = import.meta.env.VITE_API_URL ?? '' — absolute backend URL in
 * compose browsers (VITE_API_URL=http://localhost:3001); empty in local
 * `npm run dev` so relative '/api' hits the Vite dev proxy (-> 3001).
 */

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface StatusPayload {
  status: SaleStatus;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export interface ErrorEnvelope {
  error: string;
  message: string;
}

const base: string = import.meta.env.VITE_API_URL ?? '';

function apiUrl(path: string): string {
  return `${base}${path}`;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'bad-response', message: text.slice(0, 200) };
  }
}

function isEnvelope(v: unknown): v is ErrorEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['error'] === 'string' && typeof r['message'] === 'string';
}

export async function getStatus(): Promise<StatusPayload> {
  const res = await fetch(apiUrl('/api/sale/status'));
  const body = (await parseJson(res)) as StatusPayload;
  if (!res.ok) {
    const msg = isEnvelope(body) ? `${body.error}: ${body.message}` : `HTTP ${String(res.status)}`;
    throw new Error(msg);
  }
  return body;
}

export interface PurchaseOk {
  result: 'purchased';
  unitId: number;
}

/** ok:true with envelope; ok:false carries the server {error,message}. */
export type PurchaseOutcome =
  | { ok: true; body: PurchaseOk }
  | { ok: false; status: number; error: string; message: string };

export async function postPurchase(userId: string): Promise<PurchaseOutcome> {
  const res = await fetch(apiUrl('/api/purchase'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body: unknown = await parseJson(res);
  if (res.ok) {
    return { ok: true, body: body as PurchaseOk };
  }
  if (isEnvelope(body)) {
    return { ok: false, status: res.status, error: body.error, message: body.message };
  }
  return { ok: false, status: res.status, error: 'bad-response', message: `HTTP ${String(res.status)}` };
}

export interface ConfirmOk {
  result: 'purchased';
  unitId: number;
}

export type ConfirmOutcome =
  | { ok: true; body: ConfirmOk }
  | { ok: false; status: number; error: string; message: string };

export async function getPurchase(userId: string): Promise<ConfirmOutcome> {
  const res = await fetch(apiUrl(`/api/purchase/${encodeURIComponent(userId)}`));
  const body: unknown = await parseJson(res);
  if (res.ok) {
    return { ok: true, body: body as ConfirmOk };
  }
  if (isEnvelope(body)) {
    return { ok: false, status: res.status, error: body.error, message: body.message };
  }
  return { ok: false, status: res.status, error: 'bad-response', message: `HTTP ${String(res.status)}` };
}

/** SSE stream URL for EventSource (absolute in compose, relative in dev). */
export function eventsUrl(): string {
  return apiUrl('/api/sale/events');
}
