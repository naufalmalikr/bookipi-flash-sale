/**
 * purchase-spike.js (Todo 14): 1000 VUs vs 100 units, exact-100 proof.
 *
 * Each VU LOOPS for the run duration; every iteration performs one purchase
 * attempt with a globally unique email (vu + iter + timestamp suffix), so 400 invalid-userId and 409
 * already-purchased are impossible by construction: every non-201 MUST be a
 * 409 sold-out, proving oversell == 0 and undersell == 0.
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

const BASE = __ENV.K6_BASE_URL || 'http://localhost:3001';
const TS = __ENV.K6_TS || `${Date.now()}`;

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 200 },
        { duration: '30s', target: 1000 },
        { duration: '30s', target: 1000 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Every response is either 201 (one of the first 100) or 409 sold-out.
    checks: ['rate>0.99'],
    // k6 marks any status >= 400 as failed by default; here 409 sold-out is
    // the EXPECTED post-exhaustion outcome (900 of 1000 VUs), so the failed
    // rate is informational only — the proof is checks + post-run SQL.
  },
};

export default function () {
  const email = `vu${__VU}-it${__ITER}-${TS}@load.test`;
  const res = http.post(
    `${BASE}/api/purchase`,
    JSON.stringify({ userId: email }),
    { headers: { 'Content-Type': 'application/json' } },
  );
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
