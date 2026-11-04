import { generateKeyPairSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appToken, assessWeather, decide } from '../src/worker.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const snapshot = {
  schemaVersion: 1, source: 'DWD weather snapshot v2', sourceStatus: 'ok',
  lastAttemptAt: '2026-11-04T11:50:00Z', lastSuccessfulAt: null, snapshotPublishedAt: null,
  derivedAt: '2026-11-04T11:59:59Z',
  observations: {
    temperatureHumidity: { status: 'ok', measuredAt: '2026-11-04T11:45:00Z', retrievedAt: '2026-11-04T11:50:00Z', freshnessThresholdMinutes: 60 },
    wind: { status: 'ok', measuredAt: '2026-11-04T11:40:00Z', retrievedAt: '2026-11-04T11:50:00Z', freshnessThresholdMinutes: 60 },
  },
  forecast: { status: 'ok', issuedAt: '2026-11-04T06:00:00Z', retrievedAt: '2026-11-04T11:50:00Z', validThrough: '2026-11-14T00:00:00Z', hasUsablePoint: true },
};
const json = JSON.stringify(snapshot);
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  GITHUB_APP_ID: 'benchmark-only', GITHUB_INSTALLATION_ID: 'benchmark-only',
  GITHUB_APP_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const runHistory = [];

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50_ms: +at(0.50).toFixed(4), p90_ms: +at(0.90).toFixed(4), p95_ms: +at(0.95).toFixed(4), max_ms: +sorted.at(-1).toFixed(4) };
}
async function measure(label, count, fn) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    await fn();
    const cpu = process.cpuUsage(cpuStart);
    samples.push((cpu.user + cpu.system) / 1000);
    if (!Number.isFinite(performance.now() - wallStart)) throw new Error('clock-failure');
  }
  console.log(JSON.stringify({ measurement: label, process_cpu: percentiles(samples) }));
}

console.log(JSON.stringify({ runtime: `Node.js ${process.version}`, note: 'local process CPU only; not Cloudflare Worker CPU', snapshot_bytes: new TextEncoder().encode(json).byteLength }));
await measure('json-parse', 5000, () => JSON.parse(json));
await measure('freshness-and-decision', 10000, () => {
  const assessment = assessWeather(JSON.parse(json), now);
  decide({ mode: 'observe', assessment, runs: runHistory, now });
});
await measure('rsa-sign-and-mock-token-exchange', 100, () => appToken(env, async () => new Response(JSON.stringify({ token: 'mock' }), { status: 201 }), 'read', Math.floor(now / 1000)));
await measure('combined-observe-evaluation-cpu-components-only', 500, async () => {
  const assessment = assessWeather(JSON.parse(json), now);
  decide({ mode: 'observe', assessment, runs: runHistory, now });
  await appToken(env, async () => new Response(JSON.stringify({ token: 'mock' }), { status: 201 }), 'read', Math.floor(now / 1000));
});
