import { createGitHubAppClient } from "./github-app-adapter.js";

export const URLS = {
  weather:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather.json",
  weatherFreshness:
    "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather-freshness.json",
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
const BERLIN_DATE_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const BERLIN_WALL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const FEED_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export const timestamp = (x) => {
  if (typeof x !== "string") return undefined;
  const value = Date.parse(x);
  return Number.isFinite(value) ? value : undefined;
};
const state = (base, status, reasonCode, reason) => ({
  ...base,
  status,
  ...(reasonCode ? { reasonCode } : {}),
  ...(reason ? { reason } : {}),
});
const worst = (xs) => {
  let status = "UNKNOWN",
    highest = 0;
  for (const item of xs) {
    const value = rank[item?.status] || 0;
    if (value > highest) {
      highest = value;
      status = item.status;
    }
  }
  return status;
};
function berlinDate(n) { return BERLIN_DATE_FORMATTER.format(new Date(n)); }
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
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      BERLIN_WALL_FORMATTER
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
      const { done, value } = await rd.read();
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
  const decodeStartedAt = performance.now();
  return {
    text: FEED_DECODER.decode(b),
    byteLength: n,
    decodeMs: performance.now() - decodeStartedAt,
  };
}
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
async function get(feed, now, fetcher) {
  const initialUrl = new URL(feed.url);
  initialUrl.searchParams.set("_watchdog", String(Math.floor(now / 300000)));
  const allowedOrigin = initialUrl.origin;
  const controller = new AbortController();
  const start = Date.now();
  const fetchStartedAt = performance.now();
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
      // Fetch duration is wall time; it includes network wait and is not CPU.
      // Keep it separate from the synchronous JSON and schema work below.
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
    const fetchWallMs = performance.now() - fetchStartedAt;
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
    let j, body;
    const bodyReadStartedAt = performance.now();
    try {
      body = await textBody(response);
    } catch (e) {
      throw Error(e.message || "INVALID_BODY");
    }
    const bodyReadMs = performance.now() - bodyReadStartedAt;
    const parseStartedAt = performance.now();
    try {
      j = JSON.parse(body.text);
    } catch (e) {
      throw Error(
        e instanceof SyntaxError ? "INVALID_JSON" : e.message || "INVALID_BODY",
      );
    }
    if (!obj(j)) throw Error("INVALID_SCHEMA");
    return {
      j,
      transport,
      durationMs: Date.now() - start,
      diagnostics: {
        fetchWallMs,
        bodyReadWallMs: bodyReadMs,
        decodeMs: body.decodeMs,
        jsonParseMs: performance.now() - parseStartedAt,
        bodyBytes: body.byteLength,
      },
    };
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
function obs(o, field, now, ageCache) {
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
    a = ageCache?.get(o) ?? age(o.measuredAt, lim * 60000, now);
  ageCache?.set(o, a);
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
  const a = age(f.issuedAt, 12 * 3600000, now);
  if (a.status !== "OK")
    return state(
      { ...base, ageMinutes: a.ageMinutes },
      a.status,
      a.reasonCode || "ISSUE_STALE",
    );
  let p,
    pTime = Infinity,
    latestTime = -Infinity;
  for (const point of f.points) {
    const validAt = timestamp(point?.validAt);
    if (validAt === undefined) continue;
    if (validAt > latestTime) latestTime = validAt;
    if (validAt < now || validAt >= pTime || !obj(point.values)) continue;
    let hasFiniteValue = false;
    for (const key in point.values) {
      if (!Object.prototype.hasOwnProperty.call(point.values, key)) continue;
      const value = point.values[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        hasFiniteValue = true;
        break;
      }
    }
    if (hasFiniteValue) {
      p = point;
      pTime = validAt;
    }
  }
  if (!p)
    return state({ ...base, validAt: null }, "UNAVAILABLE", "NO_VALID_POINT");
  return state(
    {
      ...base,
      validAt: p.validAt,
      validThrough: latestTime === -Infinity ? null : new Date(latestTime).toISOString(),
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
    ageCache = new WeakMap(),
    products = fields.map(([p, f]) => obs(j.observations[p], f, now, ageCache)),
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
// Cron/dispatch evaluation consumes the compact source-time sidecar produced
// from the validated DWD snapshot. Public / and /status still evaluate the
// complete weather payload, including all MOSMIX points.
function weatherFreshness(j, c, now) {
  if (j.schemaVersion !== 1 || !obj(j.observations) || !obj(j.forecast))
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
    products = fields.map(([name, field]) => {
      const product = j.observations[name];
      if (!obj(product)) return state({ field, measuredAt: null }, "UNAVAILABLE", "PRODUCT_MISSING");
      const base = { field, measuredAt: product.measuredAt ?? null, retrievedAt: product.retrievedAt ?? null };
      if (product.status === "error") return state(base, "ERROR", "PRODUCER_ERROR");
      if (product.status === "stale") return state(base, "STALE", "PRODUCER_STALE");
      if (! ["ok", "partial"].includes(product.status)) return state(base, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
      if (!Array.isArray(product.availableFields) || !product.availableFields.includes(field))
        return state(base, "UNAVAILABLE", "VALUE_MISSING");
      const thresholdMinutes = Math.min(45,
        Number.isFinite(product.freshnessThresholdMinutes) ? product.freshnessThresholdMinutes : 45);
      const result = age(product.measuredAt, thresholdMinutes * 60000, now);
      return state({ ...base, ageMinutes: result.ageMinutes, thresholdMinutes }, result.status, result.reasonCode);
    });
  const f = j.forecast,
    forecastBase = {
      product: "MOSMIX-L",
      issuedAt: f.issuedAt ?? null,
      retrievedAt: f.retrievedAt ?? null,
      validAt: f.validAt ?? null,
      validThrough: f.validThrough ?? null,
    };
  let forecast;
  if (f.status === "error") forecast = state(forecastBase, "ERROR", "PRODUCER_ERROR");
  else if (f.status === "stale") forecast = state(forecastBase, "STALE", "PRODUCER_STALE");
  else if (f.status === "unavailable") forecast = state(forecastBase, "UNAVAILABLE", "PRODUCER_UNAVAILABLE");
  else if (!["ok", "partial"].includes(f.status)) forecast = state(forecastBase, "UNKNOWN", "PRODUCER_STATUS_UNKNOWN");
  else {
    const result = age(f.issuedAt, LIMITS.mosmixHours * 3600000, now);
    if (result.status !== "OK") forecast = state({ ...forecastBase, ageMinutes: result.ageMinutes }, result.status, result.reasonCode || "ISSUE_STALE");
    else if (f.hasUsablePoint !== true || timestamp(f.validAt) === undefined || timestamp(f.validAt) < now) forecast = state(forecastBase, "UNAVAILABLE", "NO_VALID_POINT");
    else forecast = state(forecastBase, "OK");
  }
  const producer = j.sourceStatus === "error" ? "ERROR" : j.sourceStatus === "stale" ? "STALE" : ["ok", "partial"].includes(j.sourceStatus) ? null : "UNKNOWN";
  return {
    ...c,
    sourceStatus: j.sourceStatus ?? null,
    products: { observations: products, forecast },
    status: worst([...products, forecast, ...(producer ? [{ status: producer }] : [])]),
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
const dispatchFeeds = [
  ["weather", "DWD-Wetter", URLS.weatherFreshness, weatherFreshness],
  ["radolan_ry", "RADOLAN-RY", URLS.radar, radar],
  ["konrad3d", "KONRAD3D", URLS.konrad, konrad],
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
  includeDiagnostics = false,
} = {}) {
  const checkedAt = new Date(nowMs).toISOString(),
    diagnostics = [],
    sources = await mapLimit(
      feeds,
      LIMITS.concurrency,
      async ([key, label, url, evalFn]) => {
        const r = await get({ key, label, url }, nowMs, fetcher);
        if (r.failure) {
          if (includeDiagnostics) diagnostics.push({ key, failure: r.failure.reasonCode ?? "FETCH_FAILED" });
          return r.failure;
        }
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
          const evaluationStartedAt = performance.now();
          const evaluated = evalFn(r.j, c, nowMs);
          if (includeDiagnostics) diagnostics.push({
            key,
            ...r.diagnostics,
            // Evaluation timing is synchronous wall time, a practical CPU proxy.
            evaluationMs: performance.now() - evaluationStartedAt,
          });
          return evaluated;
        } catch {
          return state({ key, label, checkedAt }, "ERROR", "EVALUATION_FAILED");
        }
      },
    );
  const result = {
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
  if (includeDiagnostics) result.diagnostics = diagnostics;
  return result;
}
export async function collectDispatchStatus({
  nowMs = Date.now(),
  fetcher = fetch,
  includeDiagnostics = false,
} = {}) {
  const checkedAt = new Date(nowMs).toISOString(),
    diagnostics = [],
    sources = await mapLimit(
      dispatchFeeds,
      LIMITS.concurrency,
      async ([key, label, url, evalFn]) => {
        const r = await get({ key, label, url }, nowMs, fetcher);
        if (r.failure) {
          if (includeDiagnostics) diagnostics.push({ key, failure: r.failure.reasonCode ?? "FETCH_FAILED" });
          return r.failure;
        }
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
          const evaluationStartedAt = performance.now();
          const evaluated = evalFn(r.j, c, nowMs);
          if (includeDiagnostics) diagnostics.push({
            key,
            ...r.diagnostics,
            evaluationMs: performance.now() - evaluationStartedAt,
          });
          return evaluated;
        } catch {
          return state({ key, label, checkedAt }, "ERROR", "EVALUATION_FAILED");
        }
      },
    );
  const result = {
    schemaVersion: 1,
    mode: "dispatch-observe-only",
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
  if (includeDiagnostics) result.diagnostics = diagnostics;
  return result;
}
const DISPATCH_TARGETS = Object.freeze([
  { workflowFile: "update-dwd-weather.yml", sourceKeys: ["weather"] },
  { workflowFile: "update-radolan-ry.yml", sourceKeys: ["radolan_ry", "konrad3d"] },
]);
const DISPATCH_COOLDOWN_MS = 30 * 60 * 1000;
const DISPATCH_MAX_PER_UTC_DAY = 2;
const DISPATCH_LEASE_MS = 5 * 60 * 1000;

function staleSourceFingerprint(source) {
  const stamps = [];
  if (source.key === "weather") {
    for (const item of source.products?.observations ?? []) {
      if (item?.status !== "STALE") continue;
      const measuredAt = item.measuredAt;
      if (typeof measuredAt === "string" && Number.isFinite(Date.parse(measuredAt))) {
        stamps.push(Date.parse(measuredAt));
      }
    }
    const forecast = source.products?.forecast;
    if (forecast?.status === "STALE" && typeof forecast.issuedAt === "string" && Number.isFinite(Date.parse(forecast.issuedAt))) {
      stamps.push(Date.parse(forecast.issuedAt));
    }
  } else {
    const sourceTime = source.sourceTime ?? source.measuredAt;
    if (typeof sourceTime === "string" && Number.isFinite(Date.parse(sourceTime))) stamps.push(Date.parse(sourceTime));
  }
  // Use the oldest stale product time as the snapshot identity. Freshness
  // changes in sibling fields must not create a new retry identity while the
  // same oldest stale measurement remains unresolved.
  return stamps.length ? source.key + ":oldest=" + Math.min(...stamps) : null;
}

/** Pure observation used while dispatch is disabled. Makes no API/DO calls. */
export function planDispatchObservation(report, snapshot = null) {
  return DISPATCH_TARGETS.map((target) => {
    const sources = report.sources.filter((source) => target.sourceKeys.includes(source.key));
    const stale = sources.filter((source) => source.status === "STALE");
    const detail = (source) => {
      const staleProducts = source.key === "weather"
        ? (source.products?.observations ?? []).filter((item) => item?.status === "STALE")
        : [];
      const timestamps = staleProducts.map((item) => item?.measuredAt).filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
      const forecast = source.key === "weather" && source.products?.forecast?.status === "STALE"
        ? source.products.forecast.issuedAt
        : null;
      if (forecast && Number.isFinite(Date.parse(forecast))) timestamps.push(forecast);
      return {
        key: source.key,
        status: source.status,
        reasonCode: source.reasonCode ?? null,
        ageMinutes: source.ageMinutes ?? null,
        thresholdMinutes: source.thresholdMinutes ?? null,
        sourceTime: timestamps.length ? timestamps.sort()[0] : source.sourceTime ?? source.measuredAt ?? null,
        staleFields: staleProducts.map((item) => item.field ?? "observation"),
        freshObservationCount: source.key === "weather"
          ? (source.products?.observations ?? []).filter((item) => item?.status === "OK").length
          : null,
      };
    };
    if (!stale.length) return { workflowFile: target.workflowFile, decision: "no_stale_source", sources: sources.map(detail) };
    const fingerprints = stale.map(staleSourceFingerprint);
    const workflow = snapshot?.workflows?.find((item) => item.file === target.workflowFile);
    let runState = "not_checked_read_disabled";
    if (snapshot) {
      if (snapshot.queryStatus !== "OK" || workflow?.queryStatus !== "OK") runState = "unavailable";
      else if (workflow.activeRuns?.length) runState = "already_running";
      else runState = "no_active_run";
    }
    return {
      workflowFile: target.workflowFile,
      decision: fingerprints.some((value) => !value)
        ? "blocked_missing_source_time"
        : runState === "unavailable"
          ? "blocked_github_status"
          : runState === "already_running"
            ? "already_running"
            : runState === "no_active_run"
              ? "would_dispatch_if_enabled"
              : "stale_candidate_dispatch_disabled",
      runState,
      sources: stale.map(detail),
    };
  });
}

function logDispatchObservation(report, snapshot = null, logFn = console.log) {
  const decisions = planDispatchObservation(report, snapshot);
  const candidates = decisions.filter((item) => item.decision !== "no_stale_source");
  if (!candidates.length) return;
  logFn(JSON.stringify({
    event: "workflow_dispatch_observation",
    requestId: crypto.randomUUID(),
    repository: "RonnsenDD/lhh-data-hub",
    checkedAt: report.checkedAt,
    mode: "observe_only",
    dispatchEnabled: false,
    githubRunStateChecked: Boolean(snapshot),
    candidates,
  }));
}

function logGitHubError(error) {
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
}

function logWorkflowObservation(snapshot) {
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
        ? { id: workflow.lastSuccess.id, createdAt: workflow.lastSuccess.createdAt, startedAt: workflow.lastSuccess.startedAt, conclusion: workflow.lastSuccess.conclusion, headSha: workflow.lastSuccess.headSha }
        : null,
      lastFailure: workflow.lastFailure
        ? { id: workflow.lastFailure.id, createdAt: workflow.lastFailure.createdAt, startedAt: workflow.lastFailure.startedAt, conclusion: workflow.lastFailure.conclusion, headSha: workflow.lastFailure.headSha }
        : null,
      activeRuns: workflow.activeRuns ?? [],
      lastAutomaticRunCreatedAt: workflow.lastAutomaticRunCreatedAt ?? null,
      lastAutomaticRunStartedAt: workflow.lastAutomaticRunStartedAt ?? null,
      minutesSinceLastAutomaticRunCreated: workflow.minutesSinceLastAutomaticRunCreated ?? null,
      minutesSinceLastAutomaticRunStarted: workflow.minutesSinceLastAutomaticRunStarted ?? null,
      latestExpectedScheduleTickAt: workflow.latestExpectedScheduleTickAt ?? null,
      latestExpectedTickOverdueMinutes: workflow.latestExpectedTickOverdueMinutes ?? null,
      lastAutomaticScheduleCreationDelayMinutes: workflow.lastAutomaticScheduleCreationDelayMinutes ?? null,
      lastAutomaticRunStartDelayMinutes: workflow.lastAutomaticRunStartDelayMinutes ?? null,
      missingExpectedScheduleTicksBetweenLatestAutomaticRuns: workflow.missingExpectedScheduleTicksBetweenLatestAutomaticRuns ?? null,
    })),
  }));
}

async function coordinatorRequest(coordinator, action, payload) {
  const response = await coordinator.fetch(new Request("https://dispatch-coordinator.internal/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
  if (!response.ok) throw new Error("COORDINATOR_HTTP_" + response.status);
  return response.json();
}

export function dispatchCoordinatorStub(namespace) {
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return null;
  return namespace.get(namespace.idFromName("weather-radar-dispatch-v1"));
}

/**
 * Dispatches only feeds already marked STALE by the public-feed evaluator.
 * GitHub is consulted solely for active-run suppression, never to decide freshness.
 */
export async function dispatchStaleSources({ report, client, coordinator, nowMs = Date.now(), logFn = () => {} }) {
  const results = [];
  for (const target of DISPATCH_TARGETS) {
    const staleSources = report.sources.filter((source) =>
      target.sourceKeys.includes(source.key) && source.status === "STALE");
    if (staleSources.length === 0) continue;
    const sourceDetails = staleSources.map(({ key, reasonCode, ageMinutes, ageHours, sourceTime, measuredAt, thresholdMinutes }) => ({
      key, reasonCode: reasonCode ?? null, ageMinutes: ageMinutes ?? null,
      ageHours: ageHours ?? null, sourceTime: sourceTime ?? measuredAt ?? null,
      thresholdMinutes: thresholdMinutes ?? null,
    }));
    const sourceFingerprints = staleSources.map(staleSourceFingerprint);
    if (sourceFingerprints.some((fingerprint) => !fingerprint)) {
      results.push({ workflowFile: target.workflowFile, outcome: "blocked_missing_source_time", sources: sourceDetails });
      continue;
    }
    const sourceFingerprint = sourceFingerprints.sort().join(";");
    let reservation;
    try {
      const before = await client.getWorkflowSnapshot({ files: [target.workflowFile] });
      const workflow = before.workflows?.find((item) => item.file === target.workflowFile);
      if (before.queryStatus !== "OK" || workflow?.queryStatus !== "OK") {
        results.push({ workflowFile: target.workflowFile, outcome: "blocked_github_status", reasonCode: workflow?.reasonCode ?? before.reasonCode ?? "STATUS_UNAVAILABLE", sources: sourceDetails });
        continue;
      }
      if (workflow.activeRuns?.length) {
        results.push({ workflowFile: target.workflowFile, outcome: "already_running", sources: sourceDetails });
        continue;
      }
      reservation = await coordinatorRequest(coordinator, "reserve", {
        workflowFile: target.workflowFile,
        nowMs,
        cooldownMs: DISPATCH_COOLDOWN_MS,
        maxPerUtcDay: DISPATCH_MAX_PER_UTC_DAY,
        leaseMs: DISPATCH_LEASE_MS,
        sourceFingerprint,
      });
      if (!reservation.granted) {
        results.push({ workflowFile: target.workflowFile, outcome: "suppressed", reasonCode: reservation.reason, sources: sourceDetails });
        continue;
      }

      const recheck = await client.getWorkflowSnapshot({ files: [target.workflowFile] });
      const latest = recheck.workflows?.find((item) => item.file === target.workflowFile);
      if (recheck.queryStatus !== "OK" || latest?.queryStatus !== "OK") {
        await coordinatorRequest(coordinator, "finish", {
          workflowFile: target.workflowFile, leaseId: reservation.leaseId, outcome: "uncertain",
        });
        results.push({ workflowFile: target.workflowFile, outcome: "blocked_recheck_failed", reasonCode: latest?.reasonCode ?? recheck.reasonCode ?? "STATUS_UNAVAILABLE", sources: sourceDetails });
        continue;
      }
      if (latest.activeRuns?.length) {
        await coordinatorRequest(coordinator, "finish", {
          workflowFile: target.workflowFile, leaseId: reservation.leaseId, outcome: "already_running",
        });
        results.push({ workflowFile: target.workflowFile, outcome: "already_running", sources: sourceDetails });
        continue;
      }

      const dispatch = await client.dispatchWorkflow(target.workflowFile, { enabled: true, ref: "main" });
      await coordinatorRequest(coordinator, "finish", {
        workflowFile: target.workflowFile, leaseId: reservation.leaseId, outcome: "accepted",
      });
      results.push({ workflowFile: target.workflowFile, outcome: "dispatch_accepted_not_verified", httpStatus: dispatch.httpStatus, sources: sourceDetails });
    } catch (error) {
      if (reservation?.granted) {
        try {
          await coordinatorRequest(coordinator, "finish", {
            workflowFile: target.workflowFile, leaseId: reservation.leaseId, outcome: "uncertain",
          });
        } catch {
          // A still-held lease fails closed until expiry.
        }
      }
      results.push({
        workflowFile: target.workflowFile,
        outcome: "dispatch_or_control_error",
        reasonCode: typeof error?.message === "string" && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "CONTROL_FAILED",
        httpStatus: Number.isInteger(error?.status) ? error.status : null,
        sources: sourceDetails,
      });
    }
  }

  if (results.length) {
    logFn(JSON.stringify({
      event: "workflow_dispatch_check",
      requestId: crypto.randomUUID(),
      repository: "RonnsenDD/lhh-data-hub",
      checkedAt: new Date(nowMs).toISOString(),
      outcome: "completed",
      results,
      note: "A dispatch acceptance is not evidence of a successful publication.",
    }));
  }
  return results;
}

/** SQLite-backed Durable Object storage is enabled by the operator's namespace binding. */
export class WatchdogDispatchCoordinator {
  constructor(ctx) {
    this.ctx = ctx;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const action = new URL(request.url).pathname.slice(1);
    if (!["reserve", "finish"].includes(action)) return new Response("Not found", { status: 404 });
    let input;
    try { input = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
    const allowed = DISPATCH_TARGETS.some((item) => item.workflowFile === input.workflowFile);
    if (!allowed) return new Response("Workflow not allowed", { status: 400 });

    return this.ctx.blockConcurrencyWhile(async () => {
      const key = "dispatch:" + input.workflowFile;
      const state = await this.storage.get(key) ?? {
        lastAttemptAt: 0, dayKey: "", attemptsToday: 0, sourceFingerprint: null, leaseId: null, leaseUntil: 0, lastOutcome: null,
      };
      const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
      if (action === "reserve") {
        if (![input.cooldownMs, input.maxPerUtcDay, input.leaseMs].every(Number.isFinite) || input.cooldownMs < 0 || !Number.isInteger(input.maxPerUtcDay) || input.maxPerUtcDay < 1 || input.leaseMs < 1 || typeof input.sourceFingerprint !== "string" || input.sourceFingerprint.length < 1 || input.sourceFingerprint.length > 2048) {
          return Response.json({ granted: false, reason: "invalid_reservation" }, { status: 400 });
        }
        if (state.leaseId && state.leaseUntil > now) return Response.json({ granted: false, reason: "reservation_active" });
        const dayKey = new Date(now).toISOString().slice(0, 10);
        const attemptsToday = state.dayKey === dayKey ? state.attemptsToday : 0;
        if (attemptsToday >= input.maxPerUtcDay) return Response.json({ granted: false, reason: "daily_limit" });
        if (state.lastAttemptAt && now - state.lastAttemptAt < input.cooldownMs) {
          return Response.json({ granted: false, reason: "cooldown" });
        }
        if (state.sourceFingerprint === input.sourceFingerprint) return Response.json({ granted: false, reason: "same_source_snapshot" });
        const leaseId = crypto.randomUUID();
        const next = {
          ...state, dayKey, attemptsToday: attemptsToday + 1,
          sourceFingerprint: input.sourceFingerprint,
          lastAttemptAt: now, leaseId, leaseUntil: now + input.leaseMs,
          lastOutcome: "reserved",
        };
        await this.storage.put(key, next);
        return Response.json({ granted: true, leaseId, expiresAt: next.leaseUntil });
      }
      if (typeof input.leaseId !== "string" || input.leaseId !== state.leaseId) {
        return Response.json({ completed: false, reason: "lease_mismatch" }, { status: 409 });
      }
      const allowedOutcomes = new Set(["accepted", "uncertain", "already_running"]);
      if (!allowedOutcomes.has(input.outcome)) return Response.json({ completed: false, reason: "invalid_outcome" }, { status: 400 });
      const next = { ...state, leaseId: null, leaseUntil: 0, lastOutcome: input.outcome };
      await this.storage.put(key, next);
      return Response.json({ completed: true, outcome: input.outcome });
    });
  }
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
export function formatScheduledStatus(report, event = {}) {
  return JSON.stringify({
    event: "feed_watchdog_check",
    requestId: crypto.randomUUID(),
    cron: event?.cron ?? null,
    scheduledAt: event?.scheduledTime
      ? new Date(event.scheduledTime).toISOString()
      : null,
    checkedAt: report.checkedAt,
    overallStatus: report.overallStatus,
    sources: report.sources.map(({
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
    })),
    ...(Array.isArray(report.diagnostics) ? { sourceTimings: report.diagnostics } : {}),
  });
}
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
    const diagnosticsEnabled = env?.WATCHDOG_DIAGNOSTICS_ENABLED === "true";
    const r = await collectDispatchStatus({ includeDiagnostics: diagnosticsEnabled });
    console.log(formatScheduledStatus(r, event));

    const readEnabled = env?.GITHUB_APP_READ_ENABLED === "true";
    const dispatchEnabled = env?.WORKFLOW_DISPATCH_ENABLED === "true";
    if (!readEnabled && !dispatchEnabled) {
      logDispatchObservation(r);
      return;
    }

    let client;
    try {
      client = createGitHubAppClient(env);
    } catch (error) {
      logGitHubError(error);
      return;
    }

    let observedSnapshot = null;
    if (readEnabled) {
      try {
        observedSnapshot = await client.getWorkflowSnapshot();
      } catch (error) {
        logGitHubError(error);
        observedSnapshot = { queryStatus: "ERROR", workflows: [] };
      }
      if (observedSnapshot) logWorkflowObservation(observedSnapshot);
    }

    if (!dispatchEnabled) {
      logDispatchObservation(r, observedSnapshot);
      return;
    }
    const namespace = env?.WATCHDOG_DISPATCH_COORDINATOR;
    if (!namespace) {
      console.log(JSON.stringify({
        event: "workflow_dispatch_check",
        requestId: crypto.randomUUID(),
        outcome: "disabled_missing_coordinator",
      }));
      return;
    }
    let coordinator;
    try {
      coordinator = dispatchCoordinatorStub(namespace);
    } catch {
      coordinator = null;
    }
    if (!coordinator || typeof coordinator.fetch !== "function") {
      console.log(JSON.stringify({
        event: "workflow_dispatch_check",
        requestId: crypto.randomUUID(),
        outcome: "disabled_invalid_coordinator_binding",
      }));
      return;
    }
    await dispatchStaleSources({
      report: r,
      client,
      coordinator,
      nowMs: Date.parse(r.checkedAt) || Date.now(),
      logFn: (line) => console.log(line),
    });
  },
};


