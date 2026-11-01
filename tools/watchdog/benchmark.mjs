import { generateKeyPairSync } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import worker, { collectDispatchStatus, collectStatus, formatScheduledStatus, URLS } from "./worker.js";

const NOW = Date.parse(process.env.WATCHDOG_BENCH_NOW || "2026-10-31T11:00:00Z");
const WARMUP = Number(process.env.WATCHDOG_BENCH_WARMUP || 20);
const ITERATIONS = Number(process.env.WATCHDOG_BENCH_ITERATIONS || 100);
const PROFILE_ITERATIONS = Number(process.env.WATCHDOG_PROFILE_ITERATIONS || 50);

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
const weather = feeds[URLS.weather];
feeds[URLS.weatherFreshness] = {
  schemaVersion: 1,
  sourceStatus: weather.status,
  lastAttemptAt: weather.lastAttemptAt ?? null,
  lastSuccessfulAt: weather.lastSuccessfulAt ?? null,
  sourcePublishedAt: weather.publishedAt ?? null,
  derivedAt: new Date(NOW).toISOString(),
  observations: Object.fromEntries(Object.entries(weather.observations).map(([name, product]) => [name, {
    status: product.status,
    measuredAt: product.measuredAt ?? null,
    retrievedAt: product.retrievedAt ?? null,
    freshnessThresholdMinutes: product.freshnessThresholdMinutes ?? null,
    availableFields: Object.entries(product.values ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value)).map(([key]) => key),
  }])),
  forecast: {
    status: weather.forecast.status,
    issuedAt: weather.forecast.issuedAt,
    retrievedAt: weather.forecast.retrievedAt ?? null,
    validAt: weather.forecast.points.find((point) => point.validAt && Object.values(point.values ?? {}).some((value) => typeof value === "number" && Number.isFinite(value)))?.validAt ?? null,
    validThrough: weather.forecast.points.at(-1)?.validAt ?? null,
    hasUsablePoint: weather.forecast.points.some((point) => Date.parse(point.validAt) >= NOW && Object.values(point.values ?? {}).some((value) => typeof value === "number" && Number.isFinite(value))),
  },
};
const staleFeeds = makeFeeds();
staleFeeds[URLS.weather].observations.wind.measuredAt = new Date(NOW - 60 * 60_000).toISOString();
staleFeeds[URLS.radar].productTime = new Date(NOW - 20 * 60_000).toISOString();
const snapshotFiles = new Map([
  [URLS.weather, "dwd-weather.json"],
  [URLS.weatherFreshness, "dwd-weather-freshness.json"],
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
const staleFeedBodies = new Map(Object.entries(staleFeeds).map(([url, data]) => [url, snapshotBodies.get(url) ?? JSON.stringify(data)]));
const profiledWeather = JSON.parse(feedBodies.get(URLS.weather));
if (!snapshotBodies.has(URLS.weatherFreshness)) feedBodies.set(URLS.weatherFreshness, JSON.stringify({
  schemaVersion: 1,
  sourceStatus: profiledWeather.status,
  lastAttemptAt: profiledWeather.lastAttemptAt ?? null,
  lastSuccessfulAt: profiledWeather.lastSuccessfulAt ?? null,
  snapshotPublishedAt: profiledWeather.publishedAt ?? null,
  derivedAt: new Date(NOW).toISOString(),
  observations: Object.fromEntries(Object.entries(profiledWeather.observations).map(([name, product]) => [name, {
    status: product.status,
    measuredAt: product.measuredAt ?? null,
    retrievedAt: product.retrievedAt ?? null,
    freshnessThresholdMinutes: product.freshnessThresholdMinutes ?? null,
    availableFields: Object.entries(product.values ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value)).map(([key]) => key),
  }])),
  forecast: {
    status: profiledWeather.forecast.status,
    issuedAt: profiledWeather.forecast.issuedAt,
    retrievedAt: profiledWeather.forecast.retrievedAt ?? null,
    validAt: profiledWeather.forecast.points.find((point) => point.validAt && Object.values(point.values ?? {}).some((value) => typeof value === "number" && Number.isFinite(value)))?.validAt ?? null,
    validThrough: profiledWeather.forecast.points.at(-1)?.validAt ?? null,
    hasUsablePoint: profiledWeather.forecast.points.some((point) => Date.parse(point.validAt) >= NOW && Object.values(point.values ?? {}).some((value) => typeof value === "number" && Number.isFinite(value))),
  },
}, null, 2) + "\n");
const staleManifest = JSON.parse(feedBodies.get(URLS.weatherFreshness));
staleManifest.observations.wind.measuredAt = new Date(NOW - 60 * 60_000).toISOString();
staleManifest.observations.wind.status = "stale";
staleFeedBodies.set(URLS.weatherFreshness, JSON.stringify(staleManifest));
let activeFeedBodies = feedBodies;
const feedBytes = [...feedBodies.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0);
const dispatchFeedBytes = [URLS.weatherFreshness, URLS.radar, URLS.konrad]
  .reduce((sum, url) => sum + Buffer.byteLength(feedBodies.get(url) ?? ""), 0);
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
const tokenBody = JSON.stringify({ token: "ephemeral-benchmark-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
let githubApiCalls = 0;
let feedCalls = 0;
let dispatchCalls = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.github.com") {
    githubApiCalls++;
    if (url.pathname.endsWith("/dispatches")) {
      dispatchCalls++;
      return new Response(null, { status: 204 });
    }
    return new Response(url.pathname.endsWith("/access_tokens") ? tokenBody : runsBody, { status: 200, headers: { "content-type": "application/json" } });
  }
  feedCalls++;
  const body = activeFeedBodies.get(url.origin + url.pathname);
  return body ? new Response(body, { status: 200, headers: { "content-type": "application/json", age: "0" } }) : new Response(null, { status: 404 });
};

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function benchmark(mode) {
  const githubReadEnabled = mode === "github-read";
  activeFeedBodies = mode === "stale-observe" ? staleFeedBodies : feedBodies;
  const env = {
    WATCHDOG_DIAGNOSTICS_ENABLED: mode === "diagnostics" ? "true" : "false",
    ...(githubReadEnabled ? {
    GITHUB_APP_READ_ENABLED: "true",
    WORKFLOW_DISPATCH_ENABLED: "false",
    GITHUB_APP_ID: "5555433",
    GITHUB_INSTALLATION_ID: "177220128",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  } : {}),
  };
  const oldLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < WARMUP; i++) await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW }, env);
    githubApiCalls = 0;
    feedCalls = 0;
    dispatchCalls = 0;
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
    if (feedCalls !== 3 * ITERATIONS) throw new Error(`Expected ${3 * ITERATIONS} dispatch freshness requests, observed ${feedCalls}`);
    const expectedGitHubCalls = githubReadEnabled ? 6 * ITERATIONS : 0;
    if (githubApiCalls !== expectedGitHubCalls) throw new Error("Unexpected GitHub request count: " + githubApiCalls + "; expected " + expectedGitHubCalls);
    if (dispatchCalls !== 0) throw new Error("Benchmark must never dispatch workflows");
    cpuMs.sort((a, b) => a - b);
    wallMs.sort((a, b) => a - b);
    return {
      mode,
      iterations: ITERATIONS,
      feedFixtureBytes: feedBytes,
      dispatchFixtureBytes: dispatchFeedBytes,
      feedSamples,
      feedRequests: feedCalls,
      githubApiCalls,
      dispatchRequests: dispatchCalls,
      totalProcessCpuMs: Number(((totalCpu.user + totalCpu.system) / 1000).toFixed(2)),
      meanCpuMsPerInvocation: Number(((totalCpu.user + totalCpu.system) / 1000 / ITERATIONS).toFixed(3)),
      medianCpuMsPerInvocation: Number(percentile(cpuMs, 0.5).toFixed(3)),
      p90CpuMsPerInvocation: Number(percentile(cpuMs, 0.9).toFixed(3)),
      p95CpuMsPerInvocation: Number(percentile(cpuMs, 0.95).toFixed(3)),
      maxCpuMsPerInvocation: Number(cpuMs.at(-1).toFixed(3)),
      medianWallMsPerInvocation: Number(percentile(wallMs, 0.5).toFixed(3)),
    };
  } finally {
    console.log = oldLog;
  }
}

async function profileComponents() {
  activeFeedBodies = feedBodies;
  const samples = new Map();
  for (let i = 0; i < PROFILE_ITERATIONS; i++) {
    for (const [path, report] of [
      ["full-public", await collectStatus({ nowMs: NOW, includeDiagnostics: true })],
      ["dispatch-minimal", await collectDispatchStatus({ nowMs: NOW, includeDiagnostics: true })],
    ]) {
      for (const row of report.diagnostics) {
        const key = `${path}:${row.key}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(row);
      }
    }
  }
  const stats = (rows, key) => {
    const sorted = rows.map((row) => row[key] ?? 0).sort((a, b) => a - b);
    return {
      medianMs: Number(percentile(sorted, 0.5).toFixed(4)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
    };
  };
  return [...samples.entries()].map(([feed, rows]) => ({
    feed,
    bytes: rows[0].bodyBytes,
    decode: stats(rows, "decodeMs"),
    jsonParse: stats(rows, "jsonParseMs"),
    evaluation: stats(rows, "evaluationMs"),
  }));
}

async function benchmarkPublicStatus() {
  activeFeedBodies = feedBodies;
  const oldLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < WARMUP; i++) await worker.fetch(new Request("https://watchdog.example/status"));
    feedCalls = 0;
    const cpuMs = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = process.cpuUsage();
      const response = await worker.fetch(new Request("https://watchdog.example/status"));
      if (!response.ok) throw new Error("public /status returned non-2xx");
      await response.arrayBuffer();
      const cpu = process.cpuUsage(start);
      cpuMs.push((cpu.user + cpu.system) / 1000);
    }
    if (feedCalls !== 7 * ITERATIONS) throw new Error(`Expected ${7 * ITERATIONS} public status feed requests, observed ${feedCalls}`);
    cpuMs.sort((a, b) => a - b);
    return {
      mode: "public-status-full-seven-feeds",
      iterations: ITERATIONS,
      feedRequests: feedCalls,
      medianNodeCpuMs: Number(percentile(cpuMs, 0.5).toFixed(3)),
      p90NodeCpuMs: Number(percentile(cpuMs, 0.9).toFixed(3)),
      p95NodeCpuMs: Number(percentile(cpuMs, 0.95).toFixed(3)),
      maxNodeCpuMs: Number(cpuMs.at(-1).toFixed(3)),
    };
  } finally {
    console.log = oldLog;
  }
}

async function benchmarkCollector(mode, collector, expectedFeeds) {
  activeFeedBodies = feedBodies;
  for (let i = 0; i < WARMUP; i++) await collector({ nowMs: NOW });
  feedCalls = 0;
  const cpuMs = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.cpuUsage();
    await collector({ nowMs: NOW });
    const cpu = process.cpuUsage(start);
    cpuMs.push((cpu.user + cpu.system) / 1000);
  }
  if (feedCalls !== expectedFeeds * ITERATIONS) throw new Error(`${mode}: expected ${expectedFeeds * ITERATIONS} feed requests, observed ${feedCalls}`);
  cpuMs.sort((a, b) => a - b);
  return {
    mode,
    iterations: ITERATIONS,
    feedRequests: feedCalls,
    responseBytesPerInvocation: mode.includes("scheduled") ? dispatchFeedBytes : feedBytes,
    medianNodeCpuMs: Number(percentile(cpuMs, 0.5).toFixed(3)),
    p90NodeCpuMs: Number(percentile(cpuMs, 0.9).toFixed(3)),
    p95NodeCpuMs: Number(percentile(cpuMs, 0.95).toFixed(3)),
    maxNodeCpuMs: Number(cpuMs.at(-1).toFixed(3)),
  };
}

async function benchmarkFormatting() {
  activeFeedBodies = feedBodies;
  const full = await collectStatus({ nowMs: NOW });
  const scheduled = await collectDispatchStatus({ nowMs: NOW });
  const measure = (mode, format) => {
    const samples = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = process.cpuUsage();
      format();
      const cpu = process.cpuUsage(start);
      samples.push((cpu.user + cpu.system) / 1000);
    }
    samples.sort((a, b) => a - b);
    return {
      mode,
      iterations: ITERATIONS,
      outputBytes: Buffer.byteLength(format()),
      medianNodeCpuMs: Number(percentile(samples, 0.5).toFixed(4)),
      p90NodeCpuMs: Number(percentile(samples, 0.9).toFixed(4)),
      p95NodeCpuMs: Number(percentile(samples, 0.95).toFixed(4)),
      maxNodeCpuMs: Number(samples.at(-1).toFixed(4)),
    };
  };
  return [
    measure("full-public-json-serialization", () => JSON.stringify(full)),
    measure("scheduled-status-log-formatting", () => formatScheduledStatus(scheduled, { cron: "*/5 * * * *", scheduledTime: NOW })),
  ];
}

console.log(JSON.stringify({ benchmark: "Node process CPU with mocked outbound HTTP; not Cloudflare CPU", node: process.version, warmupInvocations: WARMUP, snapshotDirectory: snapshotDir ?? null, componentProfileIterations: PROFILE_ITERATIONS, componentProfile: await profileComponents(), collectionComparison: [await benchmarkCollector("full-seven-feed-collection", collectStatus, 7), await benchmarkCollector("scheduled-three-feed-collection", collectDispatchStatus, 3)], formatting: await benchmarkFormatting(), results: [await benchmark("disabled"), await benchmark("stale-observe"), await benchmark("diagnostics"), await benchmark("github-read")], publicStatus: await benchmarkPublicStatus() }, null, 2));
