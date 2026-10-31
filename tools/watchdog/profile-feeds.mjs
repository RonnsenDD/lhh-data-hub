import { readFile } from "node:fs/promises";
import { cpuUsage } from "node:process";

const ITERATIONS = Number(process.env.WATCHDOG_PROFILE_ITERATIONS || 10000);
const snapshotDir = process.env.WATCHDOG_PROFILE_DIR;
const selectedFeed = process.env.WATCHDOG_PROFILE_FEED;
const definitions = [
  ["weather", "dwd-weather.json", { schemaVersion: 2, forecast: { points: Array.from({ length: 247 }, (_, i) => ({ validAt: `2026-11-${String(1 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`, values: { temperature: 4 + i, wind: 1 + i } })) } }],
  ["pegel_lauchhammer", "level-l.json", { latestMeasurement: { measuredAtUtc: "2026-10-31T10:30:00Z", waterLevelCm: 50 }, history: [] }],
  ["pegel_biehlen_1", "level-b.json", { latestMeasurement: { measuredAtUtc: "2026-10-31T10:30:00Z", waterLevelCm: 50 }, history: [] }],
  ["radolan_ry", "radar.json", { status: "current", productTime: "2026-10-31T10:30:00Z", frameId: "profile", rainImage: "rain.png", coverageImage: "coverage.png" }],
  ["konrad3d", "konrad.json", { schemaVersion: 1, product: "DWD KONRAD3D", source: "DWD", status: "current", referenceTime: "2026-10-31T10:30:00Z", cells: [] }],
  ["graslandfeuerindex", "grass.json", { schemaVersion: 1, status: "ok", source: { dataAsOf: "2026-10-31T10:30:00Z" }, days: [{ date: "2026-10-31", index: 1 }] }],
  ["waldbrand_osl", "wildfire.json", { schemaVersion: 1, district: { regionalschluessel: "12066" }, level: 1, sourceDate: "2026-10-31", fetchStatus: "success" }],
];
const selected = process.env.WATCHDOG_PROFILE_FEED;
const entries = [];
for (const [key, filename, fixture] of definitions) {
  if (selectedFeed && selectedFeed !== key) continue;
  if (selected && selected !== key) continue;
  let text = JSON.stringify(fixture);
  let sample = "schema fixture";
  if (snapshotDir) {
    try {
      text = await readFile(`${snapshotDir}/${filename}`, "utf8");
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object");
      sample = "public JSON snapshot";
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Invalid ${filename}: ${error.message}`);
    }
  }
  entries.push({ key, text, bytes: new TextEncoder().encode(text), parsed: JSON.parse(text), sample });
}
if (entries.length === 0) throw new Error(`Unknown WATCHDOG_PROFILE_FEED: ${selected}`);

if (entries.length === 0) throw new Error(`Unknown WATCHDOG_PROFILE_FEED: ${selectedFeed}`);
const results = [];
for (const entry of entries) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  for (let i = 0; i < 100; i++) JSON.parse(decoder.decode(entry.bytes));
  const before = cpuUsage();
  for (let i = 0; i < ITERATIONS; i++) JSON.parse(decoder.decode(entry.bytes));
  const used = cpuUsage(before);
  const pointCount = entry.key === "weather" ? entry.parsed.forecast?.points?.length ?? null : undefined;
  results.push({
    feed: entry.key,
    sample: entry.sample,
    bytes: entry.bytes.byteLength,
    mosmixPointCount: pointCount,
    decodeAndJsonParseCpuMsPerIteration: Number(((used.user + used.system) / 1000 / ITERATIONS).toFixed(4)),
  });
}
console.log(JSON.stringify({
  profile: "Synchronous UTF-8 decode + JSON.parse only; local Node process CPU, not Cloudflare CPU",
  node: process.version,
  iterations: ITERATIONS,
  snapshotDirectory: snapshotDir ?? null,
  selectedFeed: selectedFeed ?? "all",
  feeds: results,
  note: "No fetch, Worker evaluator, logging, network wait, or Cloudflare runtime is included. Set WATCHDOG_PROFILE_FEED to create a per-feed Node --cpu-prof flamegraph.",
}, null, 2));
