const WORKFLOWS = Object.freeze({
  weather: "update-dwd-weather.yml",
  radar: "update-radolan-ry.yml",
});

const COMPONENTS = Object.freeze({
  weather: Object.freeze({
    temperatureHumidity: 45 * 60_000,
    stationPressure: 45 * 60_000,
    wind: 45 * 60_000,
    windGust: 45 * 60_000,
    precipitation: 45 * 60_000,
    mosmix: 12 * 60 * 60_000,
  }),
  radar: Object.freeze({ radolanRY: 15 * 60_000, konrad3D: 15 * 60_000 }),
});
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure, side-effect-free prototype for the internal Monitor -> Dispatcher handoff.
 * It deliberately cannot call GitHub, Cloudflare storage, or any network endpoint.
 */
export function planInternalDispatch(input, now = Date.now()) {
  const blocked = (reason) => ({ action: "none", reason });

  if (!input || typeof input !== "object" || Array.isArray(input)) return blocked("invalid_input");
  const { source, fetchStatus, components, workflowActive, cooldownClear, quotaAvailable, leaseAcquired } = input;
  if (typeof source !== "string" || !Object.hasOwn(WORKFLOWS, source)) return blocked("source_not_allowlisted");
  if (!Number.isFinite(now)) return blocked("clock_invalid");
  if (fetchStatus !== "success") return blocked("source_fetch_not_successful");
  if (!components || typeof components !== "object" || Array.isArray(components)) return blocked("components_missing");
  if (![workflowActive, cooldownClear, quotaAvailable, leaseAcquired].every((v) => typeof v === "boolean")) {
    return blocked("guard_state_incomplete");
  }

  const expected = COMPONENTS[source];
  const actualKeys = Object.keys(components);
  if (actualKeys.length !== Object.keys(expected).length || actualKeys.some((key) => !Object.hasOwn(expected, key))) {
    return blocked("component_set_invalid");
  }

  const stale = [];
  for (const [name, freshnessLimitMs] of Object.entries(expected)) {
    const item = components[name];
    if (!item || item.status !== "success") return blocked("component_not_successful");
    if (name === "mosmix" && (!Number.isInteger(item.usablePointCount) || item.usablePointCount < 1)) {
      return blocked("forecast_has_no_usable_points");
    }
    const timestamp = validTimestamp(item.sourceTime);
    if (timestamp === null) return blocked("source_time_invalid");
    if (timestamp > now + MAX_CLOCK_SKEW_MS) return blocked("source_time_in_future");
    const ageMs = now - timestamp;
    if (ageMs > freshnessLimitMs) stale.push({ name, timestamp, ageMs });
  }

  if (stale.length === 0) return { action: "none", reason: "source_current" };
  if (workflowActive) return { action: "none", reason: "workflow_already_active" };
  if (!cooldownClear) return { action: "none", reason: "cooldown" };
  if (!quotaAvailable) return { action: "none", reason: "daily_quota" };
  if (!leaseAcquired) return { action: "none", reason: "lease_not_acquired" };

  const oldest = stale.reduce((a, b) => (a.timestamp < b.timestamp ? a : b));
  return {
    action: "candidate_only",
    workflow: WORKFLOWS[source],
    source,
    staleComponents: stale.map(({ name }) => name),
    oldestStaleSourceTime: new Date(oldest.timestamp).toISOString(),
    note: "No dispatch is performed by this prototype.",
  };
}

export const dispatcherPrototypeConfig = Object.freeze({
  publicRoute: false,
  dispatchEnabledByDefault: false,
  allowedWorkflows: Object.freeze(Object.values(WORKFLOWS)),
  requires: Object.freeze(["successful_source_fetch", "valid_component_source_times", "inactive_workflow", "cooldown_clear", "quota_available", "lease_acquired"]),
});
