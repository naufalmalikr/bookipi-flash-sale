#!/usr/bin/env node
/**
 * summarize.mjs — regenerates stress/results-summary.json from the raw k6
 * NDJSON output (--out json=...). Streams line by line; the raw file is
 * hundreds of MB, so nothing large is held in memory except the per-status
 * duration samples (one float array per HTTP status).
 *
 * Census recomputed from raw: HTTP status counts, per-status
 * http_req_duration percentiles, peak VUs, total
 * iterations, checks totals. SQL-level facts cannot be derived from the k6
 * dump — those are carried over verbatim from the existing summary (or the
 * previous one) so a regenerated file never invents DB counts.
 *
 * Usage: node stress/summarize.mjs [--in FILE] [--merge FILE] [--out FILE] [--stdout]
 *   --in     raw k6 json (default stress/results.json)
 *   --merge  summary whose sql/assertions/k6 metadata is carried over
 *            (default stress/results-summary.json)
 *   --out    write result here (default stress/results-summary.json);
 *            with --stdout nothing is written.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const rawPath = path.resolve(process.cwd(), argValue('--in', path.join(scriptDir, 'results.json')));
const mergePath = path.resolve(process.cwd(), argValue('--merge', path.join(scriptDir, 'results-summary.json')));
const outPath = path.resolve(process.cwd(), argValue('--out', mergePath));
const toStdout = process.argv.includes('--stdout');

if (!existsSync(rawPath)) {
  console.error(`raw k6 file not found: ${rawPath}`);
  process.exit(1);
}

const statusCounts = new Map();
const durationsByStatus = new Map();
const vusSamples = [];
let iterations = 0;
let checksTotal = 0;
let checksSucceeded = 0;
let k6Version = undefined;

function statusOf(tags) {
  const s = tags?.status;
  if (s === undefined) return 'other';
  const n = Number(s);
  return n >= 200 && n < 300 ? String(n) : n >= 400 && n < 500 ? String(n) : 'other';
}

const lineReader = createInterface({ input: createReadStream(rawPath, { encoding: 'utf8' }) });
for await (const line of lineReader) {
  if (line === '') continue;
  let point;
  try {
    point = JSON.parse(line);
  } catch {
    continue;
  }
  if (point?.type !== 'Point') {
    // The dump's header lines carry the k6 version, e.g.
    // {"type":"Metric",...,"data":{"name":"http_req_duration"...}} — version
    // is embedded elsewhere; scrape it from any full k6 header if present.
    if (typeof point?.version === 'string') k6Version = point.version;
    continue;
  }
  const metric = point.metric;
  const value = Number(point.data?.value) || 0;
  const tags = point.data?.tags;
  if (metric === 'http_reqs') {
    const key = statusOf(tags);
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + value);
  } else if (metric === 'http_req_duration') {
    const key = statusOf(tags);
    if (!durationsByStatus.has(key)) durationsByStatus.set(key, []);
    durationsByStatus.get(key).push(value);
  } else if (metric === 'vus') {
    vusSamples.push(value);
  } else if (metric === 'iterations') {
    iterations += value;
  } else if (metric === 'checks') {
    checksTotal += 1;
    if (value === 1) checksSucceeded += 1;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(value * 100) / 100;
}

function durationSummary(samples) {
  if (samples.length === 0) {
    return { count: 0, avg: null, p50: null, p90: null, p95: null, p99: null, max: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    count: sorted.length,
    avg: round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: round(sorted[sorted.length - 1]),
  };
}

const statusesInOrder = [...statusCounts.keys()].sort();
const durationMs = {};
for (const key of ['201', '409', 'other']) {
  const present = durationsByStatus.has(key);
  const counts =
    key === 'other' ? statusesInOrder.filter((s) => s !== '201' && s !== '409') : [key];
  const mergedSamples = [];
  for (const s of counts) {
    for (const v of durationsByStatus.get(s) ?? []) mergedSamples.push(v);
  }
  if (present || mergedSamples.length > 0 || (key === 'other' && (statusCounts.get('other') ?? 0) > 0)) {
    durationMs[key] = durationSummary(mergedSamples);
  }
}

const census = { 201: statusCounts.get('201') ?? 0, 409: statusCounts.get('409') ?? 0, other: statusCounts.get('other') ?? 0 };
const httpReqsTotal = [...statusCounts.values()].reduce((a, b) => a + b, 0);
const vusMax = vusSamples.length > 0 ? Math.max(...vusSamples) : null;

let merged = {};
if (existsSync(mergePath)) {
  try {
    merged = JSON.parse(readFileSync(mergePath, 'utf8'));
  } catch {
    merged = {};
  }
}

const sqlBlock = merged.sql ?? null;

const summary = {
  assertions: merged.assertions ?? null,
  derived_by:
    'stress/summarize.mjs census of raw results.json (streaming NDJSON parse): ' +
    'HTTP status counts, per-status http_req_duration percentiles, peak VUs, iterations, checks; ' +
    'sql block carried over from the original recorded census (SQL is not derivable from the k6 dump); ' +
    'raw file git-ignored, reproducible via stress/README.md',
  http_req_duration_ms: durationMs,
  http_status_census: census,
  k6: {
    checks_failed: checksTotal - checksSucceeded,
    checks_succeeded: checksSucceeded,
    checks_total: checksTotal,
    exit_code: merged.k6?.exit_code ?? null,
    http_req_failed_rate_informational_only: merged.k6?.http_req_failed_rate_informational_only ?? null,
    http_reqs_total: Math.round(httpReqsTotal),
    iterations: Math.round(iterations),
    threshold_checks_rate_gt_0_99: merged.k6?.threshold_checks_rate_gt_0_99 ?? null,
    version: k6Version ?? merged.k6?.version ?? null,
    vus_max: vusMax,
  },
  notes: [],
  proof: merged.proof ?? null,
  run: merged.run ?? null,
  sql: sqlBlock,
};

const json = JSON.stringify(summary);

if (toStdout) {
  console.log(json);
} else {
  writeFileSync(outPath, `${json}\n`);
  const dur = JSON.stringify(durationMs);
  console.log(
    `census: 201=${census[201]} 409=${census[409]} other=${census.other}; ` +
      `checks=${checksSucceeded}/${checksTotal}; iterations=${Math.round(iterations)}; vus_max=${String(vusMax)}; ` +
      `durations: ${dur.slice(0, 400)}`,
  );
}
