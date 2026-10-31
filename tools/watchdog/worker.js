import { createGitHubAppClient } from "./github-app-adapter.js";

export const URLS = {
  weather:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather.json",
  levelsL:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-lauchhammer.json",
  levelsB:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-biehlen-1.json",
  radar: "https://ronnsendd.github.io/lhh-data-hub/radar/latest.json",
  konrad: "https://ronnsendd.github.io/lhh-data-hub/konrad3d/latest.json",
  grass:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json",
  wildfire:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/waldbrandgefahrenstufe-osl.json",
};
export const LIMITS = {
  weatherMinutes: 45,
  mosmixHours: 12,
  pegelMinutes: 45,
  radarMinutes: 15,
  grassHours: 36,
  timeoutMs: 12000,
  maxBytes: 262144,
  concurrency: 4,
};
const ORIGIN = "https://feuerwehrlauchhammer.sharepoint.com",
  rank = { ERROR: 5, UNKNOWN: 4, UNAVAILABLE: 3, STALE: 2, OK: 1 };
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const timestamp = (x) =>
  typeof x === "string" && Number.isFinite(Date.parse(x))
    ? Date.parse(x)
    : undefined;
const state = (base, status, reasonCode, reason) => ({
  ...base,
  status,
  ...(reasonCode ? { reasonCode } : {}),
  ...(reason ? { reason } : {}),
});
const worst = (xs) =>
  xs
    .map((x) => x?.status)
    .filter((x) => rank[x])
    .sort((a, b) => rank[b] - rank[a])[0] || "UNKNOWN";
function berlinDate(n) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(n));
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function plusDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
export function berlinWallClockToUtc(date, hour) {
  if (!validDate(date)) return;
  const [y, m, d] = date.split("-").map(Number),
    target = Date.UTC(y, m - 1, d, hour);
  let c = target;
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      f
        .formatToParts(new Date(c))
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, +x.value]),
    );
    const delta =
      target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    c += delta;
    if (!delta) break;
  }
  return new Date(c);
}
export function wildfireInterval(date) {
  if (!validDate(date)) return;
  return {
    validFrom: berlinWallClockToUtc(date, 8).toISOString(),
    validUntil: berlinWallClockToUtc(plusDay(date), 8).toISOString(),
  };
}
function age(v, limit, now) {
  const t = timestamp(v);
  if (t === undefined) return { status: "UNKNOWN", ageMinutes: null };
  const d = now - t;
  if (d < -300000)
    return {
      status: "UNKNOWN",
      ageMinutes: Math.round(d / 60000),
      reasonCode: "SOURCE_TIME_IN_FUTURE",
    };
  return {
    status: d > limit ? "STALE" : "OK",
    ageMinutes: Math.max(0, Math.round(d / 60000)),
  };
}
async function textBody(res) {
  if (!res.body) throw Error("EMPTY_BODY");
  const rd = res.body.getReader(),
    chunks = [];
  let n = 0;
  try {
    while (true) {
      const { x, done, value } = await rd
        .read()
        .then((v) => ({ done: v.done, value: v.value }));
      if (done) break;
      n += value.byteLength;
      if (n > LIMITS.maxBytes) {
        await rd.cancel();
        throw Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    rd.releaseLock();
  }
  const b = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    b.set(c, o);
    o += c.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(b);
}
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
async function get(feed, now, fetcher) {
  const initialUrl = new URL(feed.url);
  initialUrl.searchParams.set("_watchdog", String(Math.floor(now / 300000)));
  const allowedOrigin = initialUrl.origin;
  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  try {
    let currentUrl = initialUrl;
    let redirectCount = 0;
    const visited = new Set();
    let response;
    while (true) {
      if (visited.has(currentUrl.href)) throw Error("REDIRECT_LOOP");
      visited.add(currentUrl.href);
      response = await fetcher(currentUrl.href, {
        method: "GET",
        // Cloudflare Workers does not support redirect:"error" for this
        // subrequest path. Manual mode lets us validate Location before use.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache, max-age=0",
          Pragma: "no-cache",
        },
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // The redirect body is disposable; do not let cancellation failure
          // hide the redirect policy result.
        }
      }
      if (!location) throw Error("REDIRECT_MISSING_LOCATION");
      if (redirectCount >= MAX_REDIRECTS) throw Error("REDIRECT_LIMIT_EXCEEDED");
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw Error("UNSAFE_REDIRECT");
      }
      if (
        nextUrl.protocol !== "https:" ||
        nextUrl.origin !== allowedOrigin ||
        nextUrl.username ||
        nextUrl.password
      )
        throw Error("REDIRECT_HOST_NOT_ALLOWED");
      currentUrl = nextUrl;
      redirectCount++;
    }
    const ageHeader = response.headers.get("age");
    const ageSeconds =
      ageHeader === null ? Number.NaN : Number(ageHeader);
    const transport = {
      httpDate: response.headers.get("date"),
      httpLastModified: response.headers.get("last-modified"),
      httpAgeSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    };
    if (!response.ok)
      return {
        failure: state(
          {
            key: feed.key,
            label: feed.label,
            checkedAt: new Date(now).toISOString(),
            httpStatus: response.status,
            transport,
            reason: "Öffentliche Quelle antwortete mit HTTP-Fehler.",
          },
          response.status === 404 ? "UNAVAILABLE" : "ERROR",
          response.status === 404
            ? "FEED_NOT_FOUND"
            : response.status === 429
              ? "UPSTREAM_RATE_LIMIT"
              : "UPSTREAM_HTTP_ERROR",
        ),
      };
    let j;
    try {
      j = JSON.parse(await textBody(response));
    } catch (e) {
      throw Error(
        e instanceof SyntaxError ? "INVALID_JSON" : e.message || "INVALID_BODY",
      );
    }
    if (!obj(j)) throw Error("INVALID_SCHEMA");
    return { j, transport, durationMs: Date.now() - start };
  } catch (e) {
    const knownCodes = [
      "INVALID_JSON",
      "INVALID_SCHEMA",
      "BODY_TOO_LARGE",
      "REDIRECT_LOOP",
      "REDIRECT_MISSING_LOCATION",
      "REDIRECT_LIMIT_EXCEEDED",
      "REDIRECT_HOST_NOT_ALLOWED",
      "UNSAFE_REDIRECT",
    ];
    const code =
      controller.signal.aborted || e.name === "AbortError"
        ? "TIMEOUT"
        : knownCodes.includes(e.message)
          ? e.message
          : "FETCH_FAILED";
    return {
      failure: state(
        {
          key: feed.key,
          label: feed.label,
          checkedAt: new Date(now).toISOString(),
          reason:
            code === "TIMEOUT"
              ? "Abrufzeitlimit überschritten."
              : code.startsWith("REDIRECT_") || code === "UNSAFE_REDIRECT"
                ? "Weiterleitung wurde aus Sicherheitsgründen abgewiesen."
                : "Feed konnte nicht abgerufen oder gelesen werden.",
        },
        "ERROR",
        code,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
function obs(o, field, now) {
  if (!obj(o))
    return state(
      { field, measuredAt: null, retrievedAt: null },
      "UNAVAILABLE",
      "PRODUCT_MISSING",
    );
  const base = {
    field,
    measuredAt: o.measuredAt ?? null,
    retrievedAt: o.retrievedAt ?? null,
  };
  if (o.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
  if (o.status === "stale") return state(base, "STALE", "PRODUCER_STALE");
  if (!["ok", "partial"].includes(o.status))
    return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  if (typeof o.values?.[field] !== "number")
    return state(base, "UNAVAILABLE", "VALUE_MISSING");
  const lim = Math.min(
      45,
      Number.isFinite(o.freshnessThresholdMinutes)
        ? o.freshnessThresholdMinutes
        : 45,
    ),
    a = age(o.measuredAt, lim * 60000, now);
  return state(
    { ...base, ageMinutes: a.ageMinutes, thresholdMinutes: lim },
    a.status,
    a.reasonCode,
  );
}
function mos(f, now) {
  if (!obj(f)) return state({ product: "MOSMIX-L" }, "UNAVAILABLE", "MISSING");
  const base = {
    product: "MOSMIX-L",
    issuedAt: f.issuedAt ?? null,
    retrievedAt: f.retrievedAt ?? null,
  };
  if (f.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
  if (f.status === "stale") return state(base, "STALE", "PRODUCER_STALE");
  if (f.status === "unavailable")
    return state(base, "UNAVAILABLE", "PRODUCER_UNAVAILABLE");
  if (!["ok", "partial"].includes(f.status))
    return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  if (!Array.isArray(f.points))
    return state(base, "UNAVAILABLE", "POINTS_MISSING");
  const a = age(f.issuedAt, 12 * 3600000, now),
    p = f.points
      .filter((x) => timestamp(x?.validAt) >= now)
      .sort((x, y) => timestamp(x.validAt) - timestamp(y.validAt))
      .find(
        (x) =>
          obj(x.values) &&
          Object.values(x.values).some(
            (v) => typeof v === "number" && Number.isFinite(v),
          ),
      );
  if (a.status !== "OK")
    return state(
      { ...base, ageMinutes: a.ageMinutes },
      a.status,
      a.reasonCode || "ISSUE_STALE",
    );
  if (!p)
    return state({ ...base, validAt: null }, "UNAVAILABLE", "NO_VALID_POINT");
  return state(
    {
      ...base,
      validAt: p.validAt,
      validThrough: f.points
        .map((x) => timestamp(x?.validAt))
        .filter(Number.isFinite).length
        ? new Date(
            Math.max(
              ...f.points
                .map((x) => timestamp(x?.validAt))
                .filter(Number.isFinite),
            ),
          ).toISOString()
        : null,
    },
    "OK",
  );
}
function weather(j, c, now) {
  if (j.schemaVersion !== 2 || !obj(j.observations) || !obj(j.forecast))
    return state(c, "ERROR", "INVALID_SCHEMA");
  const fields = [
      ["temperatureHumidity", "temperatureC"],
      ["temperatureHumidity", "relativeHumidityPercent"],
      ["temperatureHumidity", "dewPointC"],
      ["stationPressure", "stationPressureHpa"],
      ["wind", "windSpeedKmh"],
      ["wind", "windDirectionDeg"],
      ["windGust", "windGustKmh"],
      ["precipitation", "precipitation10MinMm"],
    ],
    products = fields.map(([p, f]) => obs(j.observations[p], f, now)),
    forecast = mos(j.forecast, now);
  const producer =
    j.status === "error"
      ? "ERROR"
      : j.status === "stale"
        ? "STALE"
        : ["ok", "partial"].includes(j.status)
          ? null
          : "UNKNOWN";
  return {
    ...c,
    sourceStatus: j.status ?? null,
    products: { observations: products, forecast },
    status: worst([
      ...products,
      forecast,
      ...(producer ? [{ status: producer }] : []),
    ]),
  };
}
function level(j, c, station, now) {
  if (
    j.schemaVersion !== 1 ||
    j.station !== station ||
    !obj(j.latestMeasurement)
  )
    return state(c, "ERROR", "INVALID_SCHEMA");
  const m = j.latestMeasurement,
    t = m.measuredAtUtc || m.measuredAt,
    lim = Math.min(
      45,
      Number.isFinite(j.freshnessThresholdMinutes)
        ? j.freshnessThresholdMinutes
        : 45,
    ),
    a = age(t, lim * 60000, now),
    base = {
      ...c,
      station,
      stationNumber: j.stationNumber ?? null,
      measuredAt: t ?? null,
      retrievedAt: j.retrievedAt ?? null,
      waterLevelCm: m.waterLevelCm ?? null,
      ageMinutes: a.ageMinutes,
      thresholdMinutes: lim,
    };
  if (j.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
  if (!["ok", "stale"].includes(j.status))
    return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  if (typeof m.waterLevelCm !== "number")
    return state(base, "UNAVAILABLE", "VALUE_MISSING");
  if (a.status !== "OK") return state(base, a.status, a.reasonCode);
  return state(
    base,
    j.status === "stale" ? "STALE" : "OK",
    j.status === "stale" ? "PRODUCER_STALE" : undefined,
  );
}
function radar(j, c, now) {
  if (j.status === "unavailable")
    return state(
      { ...c, sourceTime: j.productTime ?? null },
      "UNAVAILABLE",
      "PRODUCT_UNAVAILABLE",
    );
  if (j.status === "error")
    return state(
      { ...c, sourceTime: j.productTime ?? null },
      "ERROR",
      "PRODUCER_ERROR",
    );
  if (
    typeof j.productTime !== "string" ||
    typeof j.frameId !== "string" ||
    !j.rainImage ||
    !j.coverageImage
  )
    return state(
      { ...c, sourceTime: j.productTime ?? null },
      "UNKNOWN",
      "PRODUCT_TIME_MISSING",
    );
  const a = age(j.productTime, 15 * 60000, now),
    base = {
      ...c,
      sourceTime: j.productTime,
      retrievedAt: j.retrievedAt ?? null,
      ageMinutes: a.ageMinutes,
      thresholdMinutes: 15,
    };
  if (!["ok", "current", "stale"].includes(j.status))
    return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  if (a.status !== "OK") return state(base, a.status, a.reasonCode);
  return state(
    base,
    j.status === "stale" ? "STALE" : "OK",
    j.status === "stale" ? "PRODUCER_STALE" : undefined,
  );
}
function konrad(j, c, now) {
  if (
    j.schemaVersion === 1 &&
    j.product === "DWD KONRAD3D" &&
    j.source === "DWD" &&
    j.status === "unavailable"
  )
    return state(
      {
        ...c,
        sourceTime: j.referenceTime ?? null,
        retrievedAt: j.retrievedAt ?? null,
        jsonPublishedAt: j.publishedAt ?? null,
      },
      "UNAVAILABLE",
      "PRODUCT_UNAVAILABLE",
    );
  if (
    j.schemaVersion !== 1 ||
    j.product !== "DWD KONRAD3D" ||
    j.source !== "DWD"
  )
    return state(c, "ERROR", "INVALID_SCHEMA");
  const a = age(j.referenceTime, 15 * 60000, now),
    base = {
      ...c,
      sourceTime: j.referenceTime ?? null,
      creationTime: j.creationTime ?? null,
      retrievedAt: j.retrievedAt ?? null,
      jsonPublishedAt: j.publishedAt ?? null,
      cellResult: j.cellResult ?? null,
      ageMinutes: a.ageMinutes,
      thresholdMinutes: 15,
    };
  if (j.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
  if (!["current", "stale"].includes(j.status))
    return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  if (a.status !== "OK") return state(base, a.status, a.reasonCode);
  return state(
    base,
    j.status === "stale" ? "STALE" : "OK",
    j.status === "stale" ? "PRODUCER_STALE" : undefined,
  );
}
function grass(j, c, now) {
  if (j.schemaVersion !== 1 || !obj(j.source) || !Array.isArray(j.days))
    return state(c, "ERROR", "INVALID_SCHEMA");
  const today = berlinDate(now),
    matches = j.days.filter(
      (x) =>
        x?.date === today &&
        Number.isInteger(x.index) &&
        x.index >= 1 &&
        x.index <= 5,
    ),
    base = {
      ...c,
      sourceTime: j.source.dataAsOf ?? null,
      retrievedAt: j.retrievedAt ?? null,
      forecastDate: matches[0]?.date ?? null,
      index: matches[0]?.index ?? null,
    };
  if (j.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
  if (matches.length !== 1) return state(base, "UNAVAILABLE", "TODAY_MISSING");
  const a = age(j.source.dataAsOf, 36 * 3600000, now);
  if (a.status !== "OK")
    return state(
      { ...base, ageHours: a.ageMinutes === null ? null : a.ageMinutes / 60 },
      a.status,
      a.reasonCode,
    );
  return state(
    { ...base, ageHours: a.ageMinutes / 60 },
    j.status === "ok" ? "OK" : "UNKNOWN",
    j.status === "ok" ? undefined : "PRODUCER_STATUS",
  );
}
function wildfire(j, c, now) {
  if (
    j.schemaVersion !== 1 ||
    j.district?.regionalschluessel !== "12066" ||
    !Number.isInteger(j.level) ||
    j.level < 1 ||
    j.level > 5 ||
    !validDate(j.sourceDate)
  )
    return state(c, "UNAVAILABLE", "VALID_VALUE_MISSING");
  const v = wildfireInterval(j.sourceDate),
    base = {
      ...c,
      sourceDate: j.sourceDate,
      level: j.level,
      description: j.description ?? null,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      retrievedAt: j.retrievedAt ?? null,
    };
  if (now < Date.parse(v.validFrom))
    return state(base, "UNKNOWN", "NOT_VALID_YET");
  if (now >= Date.parse(v.validUntil))
    return state(base, "STALE", "VALIDITY_EXPIRED");
  return state(
    base,
    j.fetchStatus === "success" ? "OK" : "ERROR",
    j.fetchStatus === "success" ? undefined : "FETCH_NOT_CONFIRMED",
  );
}
const feeds = [
  ["weather", "DWD-Wetter", URLS.weather, weather],
  [
    "pegel_lauchhammer",
    "Pegel Lauchhammer",
    URLS.levelsL,
    (j, c, n) => level(j, c, "Lauchhammer", n),
  ],
  [
    "pegel_biehlen_1",
    "Pegel Biehlen 1",
    URLS.levelsB,
    (j, c, n) => level(j, c, "Biehlen 1", n),
  ],
  ["radolan_ry", "RADOLAN-RY", URLS.radar, radar],
  ["konrad3d", "KONRAD3D", URLS.konrad, konrad],
  ["graslandfeuerindex", "DWD-Graslandfeuerindex", URLS.grass, grass],
  ["waldbrand_osl", "Waldbrandgefahrenstufe OSL", URLS.wildfire, wildfire],
];
async function mapLimit(xs, n, fn) {
  const out = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (true) {
        const k = i++;
        if (k >= xs.length) return;
        out[k] = await fn(xs[k]);
      }
    }),
  );
  return out;
}
const times = (j) => ({
  producerRetrievedAt: j.retrievedAt ?? null,
  producerLastSuccessfulAt: j.lastSuccessfulAt ?? null,
  producerLastAttemptAt: j.lastAttemptAt ?? null,
  jsonPublishedAt: j.publishedAt ?? null,
});
export async function collectStatus({
  nowMs = Date.now(),
  fetcher = fetch,
} = {}) {
  const checkedAt = new Date(nowMs).toISOString(),
    sources = await mapLimit(
      feeds,
      LIMITS.concurrency,
      async ([key, label, url, evalFn]) => {
        const r = await get({ key, label, url }, nowMs, fetcher);
        if (r.failure) return r.failure;
        const c = {
          key,
          label,
          checkedAt,
          durationMs: r.durationMs,
          transport: {
            httpDate: r.transport.httpDate,
            httpLastModified: r.transport.httpLastModified,
            httpAgeSeconds: r.transport.httpAgeSeconds,
          },
          ...times(r.j),
        };
        try {
          return evalFn(r.j, c, nowMs);
        } catch {
          return state({ key, label, checkedAt }, "ERROR", "EVALUATION_FAILED");
        }
      },
    );
  return {
    schemaVersion: 1,
    mode: "observe-only",
    checkedAt,
    overallStatus: worst(sources),
    sources,
    guarantees: {
      githubRestApiUsed: false,
      writesPerformed: false,
      workflowDispatchPerformed: false,
      persistenceUsed: false,
      freshnessFromSourceTimes: true,
    },
  };
}
const headers = (o) => {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
  if (o === ORIGIN) {
    h["Access-Control-Allow-Origin"] = ORIGIN;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Accept";
  }
  return h;
};
export default {
  async fetch(req) {
    const u = new URL(req.url),
      o = req.headers.get("Origin");
    if (req.method === "OPTIONS") {
      if (o && o !== ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: headers(o) });
    }
    if (req.method !== "GET")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, OPTIONS" },
      });
    if (!["/", "/status"].includes(u.pathname))
      return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(await collectStatus()), {
      headers: headers(o),
    });
  },
  async scheduled(event, env) {
    const r = await collectStatus();
    console.log(
      JSON.stringify({
        event: "feed_watchdog_check",
        requestId: crypto.randomUUID(),
        cron: event?.cron ?? null,
        scheduledAt: event?.scheduledTime
          ? new Date(event.scheduledTime).toISOString()
          : null,
        checkedAt: r.checkedAt,
        overallStatus: r.overallStatus,
        sources: r.sources.map(
          ({
            key,
            status,
            reasonCode,
            ageMinutes,
            ageHours,
            sourceTime,
            measuredAt,
            validUntil,
          }) => ({
            key,
            status,
            reasonCode: reasonCode ?? null,
            ageMinutes: ageMinutes ?? null,
            ageHours: ageHours ?? null,
            sourceTime: sourceTime ?? measuredAt ?? null,
            validUntil: validUntil ?? null,
          }),
        ),
      }),
    );

    if (env?.GITHUB_APP_READ_ENABLED !== "true") return;

    let snapshot;
    try {
      snapshot = await createGitHubAppClient(env).getWorkflowSnapshot();
    } catch (error) {
      console.log(JSON.stringify({
        event: "github_workflow_observation",
        requestId: crypto.randomUUID(),
        repository: "RonnsenDD/lhh-data-hub",
        checkedAt: new Date().toISOString(),
        queryStatus: "ERROR",
        reasonCode: typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : "GITHUB_OBSERVATION_FAILED",
        httpStatus: Number.isInteger(error?.status) ? error.status : null,
        stage: typeof error?.stage === "string" && /^[a-z_]+$/.test(error.stage)
          ? error.stage
          : "unknown",
      }));
      return;
    }

    console.log(JSON.stringify({
      event: "github_workflow_observation",
      requestId: crypto.randomUUID(),
      repository: snapshot.repository,
      checkedAt: snapshot.checkedAt,
      queryStatus: snapshot.queryStatus,
      reasonCode: snapshot.reasonCode ?? null,
      httpStatus: snapshot.httpStatus ?? null,
      retryAfterSeconds: snapshot.retryAfterSeconds ?? null,
      rateLimitRemaining: snapshot.rateLimitRemaining ?? null,
      rateLimitResetAt: snapshot.rateLimitResetAt ?? null,
      workflows: snapshot.workflows.map((workflow) => ({
        file: workflow.file,
        cron: workflow.cron,
        queryStatus: workflow.queryStatus,
        reasonCode: workflow.reasonCode ?? null,
        httpStatus: workflow.httpStatus ?? null,
        retryAfterSeconds: workflow.retryAfterSeconds ?? null,
        rateLimitRemaining: workflow.rateLimitRemaining ?? null,
        rateLimitResetAt: workflow.rateLimitResetAt ?? null,
        lastSuccess: workflow.lastSuccess
          ? {
              id: workflow.lastSuccess.id,
              createdAt: workflow.lastSuccess.createdAt,
              startedAt: workflow.lastSuccess.startedAt,
              conclusion: workflow.lastSuccess.conclusion,
              headSha: workflow.lastSuccess.headSha,
            }
          : null,
        lastFailure: workflow.lastFailure
          ? {
              id: workflow.lastFailure.id,
              createdAt: workflow.lastFailure.createdAt,
              startedAt: workflow.lastFailure.startedAt,
              conclusion: workflow.lastFailure.conclusion,
              headSha: workflow.lastFailure.headSha,
            }
          : null,
        activeRuns: workflow.activeRuns ?? [],
        lastAutomaticRunCreatedAt: workflow.lastAutomaticRunCreatedAt ?? null,
        lastAutomaticRunStartedAt: workflow.lastAutomaticRunStartedAt ?? null,
        minutesSinceLastAutomaticRunCreated:
          workflow.minutesSinceLastAutomaticRunCreated ?? null,
        minutesSinceLastAutomaticRunStarted:
          workflow.minutesSinceLastAutomaticRunStarted ?? null,
        latestExpectedScheduleTickAt: workflow.latestExpectedScheduleTickAt ?? null,
        latestExpectedTickOverdueMinutes:
          workflow.latestExpectedTickOverdueMinutes ?? null,
        lastAutomaticScheduleCreationDelayMinutes:
          workflow.lastAutomaticScheduleCreationDelayMinutes ?? null,
        lastAutomaticRunStartDelayMinutes:
          workflow.lastAutomaticRunStartDelayMinutes ?? null,
        missingExpectedScheduleTicksBetweenLatestAutomaticRuns:
          workflow.missingExpectedScheduleTicksBetweenLatestAutomaticRuns ?? null,
      })),
    }));
  },
};
