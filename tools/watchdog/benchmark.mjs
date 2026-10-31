import { generateKeyPairSync } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import worker, { URLS } from "./worker.js";

const NOW = Date.parse("2026-10-31T11:00:00Z");
const WARMUP = Number(process.env.WATCHDOG_BENCH_WARMUP || 20);
const ITERATIONS = Number(process.env.WATCHDOG_BENCH_ITERATIONS || 100);

function makeFeeds() {
  const points = Array.from({ length: 168 }, (_, index) => ({
    validAt: new Date(NOW + (index + 1) * 3600000).toISOString(),
    values: Object.fromEntries(Array.from({ length: 12 }, (_, field) => [`field${field}`, 1 + index + field])),
  }));
  return {
    [URLS.weather]: {
      schemaVersion: 2,
      status: "ok",
      observations: {
        temperatureHumidity: { status: "ok", measuredAt: new Date(NOW - 600000).toISOString(), values: { temperatureC: 7, relativeHumidityPercent: 80, dewPointC: 4 } },
        stationPressure: { status: "ok", measuredAt: new Date(NOW - 600000).toISOString(), values: { stationPressureHpa: 1018 } },
        wind: { status: "ok", measuredAt: new Date(NOW - 600000).toISOString(), values: { windSpeedKmh: 10, windDirectionDeg: 270 } },
        windGust: { status: "ok", measuredAt: new Date(NOW - 600000).toISOString(), values: { windGustKmh: 18 } },
        precipitation: { status: "ok", measuredAt: new Date(NOW - 600000).toISOString(), values: { precipitation10MinMm: 0.2 } },
      },
      forecast: { status: "ok", issuedAt: new Date(NOW - 3600000).toISOString(), points },
    },
    [URLS.levelsL]: { schemaVersion: 1, station: "Lauchhammer", latestMeasurement: { waterLevelCm: 55, measuredAtUtc: new Date(NOW - 600000).toISOString() }, status: "ok" },
    [URLS.levelsB]: { schemaVersion: 1, station: "Biehlen 1", latestMeasurement: { waterLevelCm: 39, measuredAtUtc: new Date(NOW - 600000).toISOString() }, status: "ok" },
    [URLS.radar]: { status: "current", frameId: "bench", productTime: new Date(NOW - 300000).toISOString(), rainImage: "rain.png", coverageImage: "coverage.png" },
    [URLS.konrad]: { schemaVersion: 1, product: "DWD KONRAD3D", source: "DWD", status: "current", referenceTime: new Date(NOW - 300000).toISOString() },
    [URLS.grass]: { schemaVersion: 1, status: "ok", source: { dataAsOf: new Date(NOW - 3600000).toISOString() }, days: [{ date: "2026-10-31", index: 1 }] },
    [URLS.wildfire]: { schemaVersion: 1, district: { regionalschluessel: "12066" }, level: 1, sourceDate: "2026-10-31", fetchStatus: "success" },
  };
}

const feeds = makeFeeds();
const snapshotFiles = new Map([
  [URLS.weather, "dwd-weather.json"],
  [URLS.levelsL, "level-l.json"],
  [URLS.levelsB, "level-b.json"],
  [URLS.grass, "grass.json"],
  [URLS.wildfire, "wildfire.json"],
  [URLS.radar, "radar.json"],
  [URLS.konrad, "konrad.json"],
]);
const snapshotBodies = new Map();
const snapshotDir = process.env.WATCHDOG_BENCH_DIR;
if (snapshotDir) {
  for (const [url, filename] of snapshotFiles) {
    try {
      const body = await readFile(`${snapshotDir}/${filename}`, "utf8");
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object");
      snapshotBodies.set(url, body);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Invalid ${filename}: ${error.message}`);
    }
  }
}
const feedBodies = new Map(Object.entries(feeds).map(([url, data]) => [url, snapshotBodies.get(url) ?? JSON.stringify(data)]));
const feedBytes = [...feedBodies.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0);
const feedSamples = Object.entries(feeds).map(([url, data]) => {
  const body = feedBodies.get(url);
  let parsed;
  try { parsed = JSON.parse(body); } catch {}
  return {
    feed: Object.entries(URLS).find(([, candidate]) => candidate === url)?.[0] ?? "unknown",
    sample: snapshotBodies.has(url) ? "public JSON snapshot" : "schema fixture",
    bytes: Buffer.byteLength(body),
    mosmixPointCount: url === URLS.weather ? parsed?.forecast?.points?.length ?? null : undefined,
  };
});
const runsBody = JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, status: "completed", conclusion: "success", event: "schedule", created_at: "2026-10-31T10:48:00Z", run_started_at: "2026-10-31T10:48:02Z", updated_at: "2026-10-31T10:49:00Z", head_sha: "bench" }] });
const tokenBody = JSON.stringify({ token: "ephemeral-benchmark-token", expires_at: new Date(NOW + 3600000).toISOString() });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
let githubApiCalls = 0;
let feedCalls = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.github.com") {
    githubApiCalls++;
    return new Response(url.pathname.endsWith("/access_tokens") ? tokenBody : runsBody, { status: 200, headers: { "content-type": "application/json" } });
  }
  feedCalls++;
  const body = feedBodies.get(url.origin + url.pathname);
  return body ? new Response(body, { status: 200, headers: { "content-type": "application/json", age: "0" } }) : new Response(null, { status: 404 });
};

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function benchmark(mode) {
  const enabled = mode === "enabled";
  const env = enabled ? { GITHUB_APP_READ_ENABLED: "true", GITHUB_APP_ID: "5555433", GITHUB_INSTALLATION_ID: "177220128", GITHUB_APP_PRIVATE_KEY: privateKey } : {};
  const oldLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < WARMUP; i++) await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW }, env);
    githubApiCalls = 0;
    feedCalls = 0;
    const cpuMs = [], wallMs = [];
    const totalCpuStart = process.cpuUsage();
    for (let i = 0; i < ITERATIONS; i++) {
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW }, env);
      const cpu = process.cpuUsage(cpuStart);
      cpuMs.push((cpu.user + cpu.system) / 1000);
      wallMs.push(performance.now() - wallStart);
    }
    const totalCpu = process.cpuUsage(totalCpuStart);
    if (feedCalls !== 7 * ITERATIONS) throw new Error(`Expected ${7 * ITERATIONS} feed requests, observed ${feedCalls}`);
    const expectedGitHubCalls = enabled ? 6 * ITERATIONS : 0;
    if (githubApiCalls !== expectedGitHubCalls) throw new Error(`Expected ${expectedGitHubCalls} GitHub requests, observed ${githubApiCalls}`);
    cpuMs.sort((a, b) => a - b);
    wallMs.sort((a, b) => a - b);
    return {
      mode,
      iterations: ITERATIONS,
      feedFixtureBytes: feedBytes,
      feedSamples,
      feedRequests: feedCalls,
      githubApiCalls,
      totalProcessCpuMs: Number(((totalCpu.user + totalCpu.system) / 1000).toFixed(2)),
      meanCpuMsPerInvocation: Number(((totalCpu.user + totalCpu.system) / 1000 / ITERATIONS).toFixed(3)),
      medianCpuMsPerInvocation: Number(percentile(cpuMs, 0.5).toFixed(3)),
      p95CpuMsPerInvocation: Number(percentile(cpuMs, 0.95).toFixed(3)),
      medianWallMsPerInvocation: Number(percentile(wallMs, 0.5).toFixed(3)),
    };
  } finally {
    console.log = oldLog;
  }
}

console.log(JSON.stringify({ benchmark: "Node process CPU with mocked outbound HTTP; not Cloudflare CPU", node: process.version, warmupInvocations: WARMUP, snapshotDirectory: snapshotDir ?? null, results: [await benchmark("disabled"), await benchmark("enabled")] }, null, 2));
