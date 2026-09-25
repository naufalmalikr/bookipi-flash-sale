/**
 * purchase-spike.js: 1000 VUs vs 100 units, exact-100 proof + duplicate-buyer proof.
 *
 * Two scenarios share one run and one backend (separate VU pools, separate
 * censuses via the automatic `scenario` tag):
 *
 * 1. `spike` — each VU LOOPS for the run duration; every iteration performs
 *    one purchase attempt with a globally unique email (vu + iter + timestamp
 *    suffix), so 400 invalid-userId and 409 already-purchased are impossible
 *    by construction: every non-201 MUST be a 409 sold-out, proving
 *    oversell == 0 and undersell == 0.
 *
 * 2. `duplicate` — 10 VUs start at t=0 (while the spike ramp is still near
 *    zero, so stock is plentiful) and each hammers ONE fixed email
 *    (dup<VU>-<ts>@load.test) for 30s, sequentially. The first attempt per
 *    email wins a unit; every later attempt must be rejected. This loads the
 *    one-item-per-user rule — the pre-transaction repeat-buyer fast path
 *    plus the UNIQUE(sale_id, canonical_user_id) backstop — at request rates
 *    the 2-way integration race never reaches. Thresholds below assert:
 *    exactly one 201 per distinct email, every other response
 *    already-purchased, zero sold-out, zero other statuses.
 *
 * K6_DUP_ONLY=true runs only the duplicate scenario (standalone validation
 * against a scratch backend; the recorded proof run is spike-only).
 *
 * Full run command (host networking reaches localhost:3001; --user UID:GID
 * so the container can write results.json to the bind mount) is in
 * stress/README.md.
 *
 * Requires: STOCK_QTY=100 seed, ACTIVE window, RATE_LIMIT_BUY=0 backend
 * (see README.md — without the bypass, single-source-NAT VUs share one IP
 * and 429s pollute the proof).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.K6_BASE_URL || 'http://localhost:3001';
const TS = __ENV.K6_TS || `${Date.now()}`;
const DUP_ONLY = __ENV.K6_DUP_ONLY === 'true';
const DUP_VUS = 10;
const DUP_DURATION = '30s';

const dup201 = new Counter('dup_201');
const dupAlready = new Counter('dup_already');
const dupSoldout = new Counter('dup_soldout');
const dupOther = new Counter('dup_other');

const scenarios = {
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '20s', target: 200 },
      { duration: '30s', target: 1000 },
      { duration: '30s', target: 1000 },
      { duration: '10s', target: 0 },
    ],
    exec: 'spikeLoop',
  },
  duplicate: {
    executor: 'constant-vus',
    vus: DUP_VUS,
    duration: DUP_DURATION,
    startTime: '0s',
    exec: 'duplicateLoop',
  },
};

export const options = {
  scenarios: DUP_ONLY ? { duplicate: scenarios.duplicate } : scenarios,
  thresholds: {
    // Every response must parse to a result code or an error envelope.
    'checks{scenario:spike}': ['rate>0.99'],
    'checks{scenario:duplicate}': ['rate>0.99'],
    // One 201 per distinct duplicate email; every retry must read
    // already-purchased (fast path or 23505 mapping) — never sold-out
    // (no in-flight winner at exhaustion for these emails), never 400/429/5xx.
    dup_201: [`count == ${DUP_VUS}`],
    dup_already: [`count >= ${DUP_VUS}`],
    dup_soldout: ['count == 0'],
    dup_other: ['count == 0'],
    // k6 marks any status >= 400 as failed by default; here 409s are the
    // EXPECTED post-exhaustion outcome, so http_req_failed is informational
    // only — the proof is checks, the counters above, and post-run SQL.
  },
};

function buy(email) {
  return http.post(`${BASE}/api/purchase`, JSON.stringify({ userId: email }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseErrorCode(res) {
  try {
    const b = res.json();
    if (b !== null && typeof b === 'object' && 'error' in b) return String(b.error);
    return '';
  } catch {
    return 'unparseable';
  }
}

export function spikeLoop() {
  const res = buy(`vu${__VU}-it${__ITER}-${TS}@load.test`);
  check(res, {
    'purchased or sold-out (no other status possible)': (r) =>
      r.status === 201 || r.status === 409,
    'response body carries result or error code': (r) => {
      try {
        const b = r.json();
        return (
          (b !== null && typeof b === 'object' && 'result' in b) ||
          (b !== null && typeof b === 'object' && 'error' in b)
        );
      } catch {
        return false;
      }
    },
  });
}

export function duplicateLoop() {
  const res = buy(`dup${__VU}-${TS}@load.test`);
  const error = parseErrorCode(res);
  if (res.status === 201) dup201.add(1);
  else if (res.status === 409 && error === 'already-purchased') dupAlready.add(1);
  else if (res.status === 409 && error === 'sold-out') dupSoldout.add(1);
  else dupOther.add(1);
  check(res, {
    'first attempt wins OR retry reads already-purchased': (r) =>
      r.status === 201 || (r.status === 409 && error === 'already-purchased'),
  });
}

export default function spikeLoopAlias() {
  spikeLoop();
}
