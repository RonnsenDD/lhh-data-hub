import test from "node:test";
import assert from "node:assert/strict";
import { runWatchdog, SOURCE_CONFIG } from "./watchdog.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const TOKEN = "test-token";
const freshWeather = {
  status: "ok",
  observations: {
    temperatureHumidity: { status: "ok", measuredAt: "2026-10-29T11:45:00Z", freshnessThresholdMinutes: 60 },
    precipitation: { status: "ok", measuredAt: "2026-10-29T11:50:00Z", freshnessThresholdMinutes: 60 },
  },
  forecast: { status: "ok", issuedAt: "2026-10-29T06:00:00Z" },
};
const freshLevel = (station, time) => ({
  status: "ok",
  station,
  freshnessThresholdMinutes: 45,
  latestMeasurement: { measuredAtUtc: time, waterLevelCm: 42 },
});
const freshRadar = (productTime, referenceTime) => [
  { status: "current", productTime, publishedAt: "2026-10-29T11:58:00Z", product: "RADOLAN-RY" },
  { status: "current", referenceTime, publishedAt: "2026-10-29T11:58:00Z", product: "KONRAD3D" },
];
const freshGrassland = {
  status: "ok",
  source: { dataAsOf: "2026-10-29T05:00:00Z" },
  today: { date: "2026-10-29", index: 1 },
};
const dataBySource = {
  weather: [freshWeather],
  levels: [freshLevel("Lauchhammer", "2026-10-29T11:45:00Z"), freshLevel("Biehlen 1", "2026-10-29T11:45:00Z")],
  radar: freshRadar("2026-10-29T11:50:00Z", "2026-10-29T11:45:00Z"),
  grassland: [freshGrassland],
};

function makeFetch(options = {}) {
  const calls = [];
  const runSourceById = new Map();
  const lastSchedule = options.lastSchedule || "2026-10-29T11:45:00Z";
  return {
    calls,
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (options.apiFailure && String(url).startsWith("https://api.github.com/")) {
        return new Response("unavailable", { status: 503 });
      }
      if (init.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (String(url).includes("/actions/workflows/")) {
        const source = SOURCE_CONFIG.find((item) => String(url).includes(encodeURIComponent(item.workflow)));
        const runId = 101 + SOURCE_CONFIG.indexOf(source);
        if (source) runSourceById.set(runId, source);
        const runs = options.noSchedule ? [] : [{
          id: runId,
          event: "schedule",
          status: options.active ? "in_progress" : "completed",
          conclusion: "failure",
          created_at: lastSchedule,
          run_started_at: lastSchedule,
        }];
        if (options.active) {
          const source = SOURCE_CONFIG.find((item) => String(url).includes(encodeURIComponent(item.workflow)));
          const activeId = 202 + SOURCE_CONFIG.indexOf(source);
          if (source) runSourceById.set(activeId, source);
          runs.push({ id: activeId, event: "workflow_dispatch", status: "in_progress", created_at: "2026-10-29T11:59:00Z" });
        }
        return Response.json({ workflow_runs: runs });
      }
      if (String(url).includes("/actions/runs/")) {
        const producerConclusion = options.producerConclusion || "success";
        const auditConclusion = options.auditConclusion || "failure";
        const runId = Number(String(url).split("/runs/")[1]?.split("/")[0]);
        const source = runSourceById.get(runId);
        return Response.json({ jobs: [
          { name: source?.producerJob || "update", status: "completed", conclusion: producerConclusion },
          { name: "Schedule health (separate from producer result)", status: "completed", conclusion: auditConclusion },
        ] });
      }
      if (String(url).includes("/commits?path=")) {
        const date = options.oldPublication ? "2026-10-29T10:00:00Z" : "2026-10-29T11:59:00Z";
        return Response.json([{ commit: { committer: { date } } }]);
      }
      for (const source of SOURCE_CONFIG) {
        for (let index = 0; index < source.dataUrls.length; index += 1) {
          if (String(url) === source.dataUrls[index]) {
            const payload = dataBySource[source.id][index];
            if (options.stale && source.id === "weather") {
              return Response.json({
                ...freshWeather,
                observations: { temperatureHumidity: { status: "ok", measuredAt: "2026-10-29T09:00:00Z", freshnessThresholdMinutes: 60 } },
              });
            }
            return Response.json(payload);
          }
        }
      }
      throw new Error("Unexpected test URL " + url);
    },
  };
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
  };
}

test("missing schedule is reported and only dispatches existing workflows", async () => {
  const mock = makeFetch({ noSchedule: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  assert.equal(report.sources.length, 4);
  assert.ok(report.sources.every((item) => item.status === "Automatik ausgefallen"));
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 4);
  assert.ok(mock.calls.filter((call) => call.method === "POST").every((call) => call.url.endsWith("/dispatches")));
});

test("status ok cannot override stale observation timestamps", async () => {
  const mock = makeFetch({ stale: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  const weather = report.sources.find((item) => item.id === "weather");
  assert.equal(weather.dataStatus, "veraltet");
  assert.equal(weather.status, "veraltet");
  assert.ok(mock.calls.some((call) => call.url.includes("update-dwd-weather.yml/dispatches")));
});

test("GitHub API errors are visible and block blind dispatches", async () => {
  const mock = makeFetch({ apiFailure: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  assert.ok(report.sources.every((item) => item.status === "Abruf fehlgeschlagen"));
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 0);
});

test("an active producer run prevents duplicate dispatch", async () => {
  const mock = makeFetch({ noSchedule: true, active: true, stale: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  const weather = report.sources.find((item) => item.id === "weather");
  assert.equal(weather.dispatch.state, "skipped-running");
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 0);
});

test("dispatch acknowledgement is not called a successful refresh", async () => {
  const mock = makeFetch({ noSchedule: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  const weather = report.sources.find((item) => item.id === "weather");
  assert.equal(weather.status, "Automatik ausgefallen");
  assert.equal(weather.dispatch.state, "requested");
  assert.match(weather.dispatch.note, /kein Erfolgsnachweis/);
});

test("a failed audit job does not erase a successful producer result", async () => {
  const mock = makeFetch({ auditConclusion: "failure" });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  for (const item of report.sources) {
    assert.notEqual(item.status, "Abruf fehlgeschlagen");
    assert.equal(item.workflow.producerJobConclusion, "success");
    assert.equal(item.workflow.scheduleAuditConclusion, "failure");
  }
});

test("dispatch cooldown prevents repeated recovery calls", async () => {
  const mock = makeFetch({ noSchedule: true });
  const initial = {};
  for (const source of SOURCE_CONFIG) initial["lastDispatch:" + source.id] = "2026-10-29T11:30:00Z";
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage(initial) });
  assert.ok(report.sources.every((item) => item.dispatch.state === "skipped-cooldown"));
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 0);
});

test("old publication time is not hidden by fresh source timestamps", async () => {
  const mock = makeFetch({ oldPublication: true });
  const report = await runWatchdog({ nowMs: NOW, token: TOKEN, fetcher: mock.fetcher, storage: makeStorage() });
  const weather = report.sources.find((item) => item.id === "weather");
  assert.equal(weather.dataStatus, "aktuell");
  assert.equal(weather.status, "Abruf fehlgeschlagen");
  assert.match(weather.reason, /Veröffentlichung älter/);
});
