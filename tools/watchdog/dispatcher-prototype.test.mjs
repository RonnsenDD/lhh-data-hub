import test from "node:test";
import assert from "node:assert/strict";
import { dispatcherPrototypeConfig, planInternalDispatch } from "./dispatcher-prototype.mjs";

const now = Date.parse("2026-11-02T00:00:00Z");
const t = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const guards = { workflowActive: false, cooldownClear: true, quotaAvailable: true, leaseAcquired: true };
const weatherComponents = (minutesAgo = 20, forecastMinutesAgo = 60, usablePointCount = 12) => Object.fromEntries([
  ["temperatureHumidity", { status: "success", sourceTime: t(minutesAgo) }],
  ["stationPressure", { status: "success", sourceTime: t(minutesAgo) }],
  ["wind", { status: "success", sourceTime: t(minutesAgo) }],
  ["windGust", { status: "success", sourceTime: t(minutesAgo) }],
  ["precipitation", { status: "success", sourceTime: t(minutesAgo) }],
  ["mosmix", { status: "success", sourceTime: t(forecastMinutesAgo), usablePointCount }],
]);
const radarComponents = (ryMinutesAgo = 5, konradMinutesAgo = 8) => ({
  radolanRY: { status: "success", sourceTime: t(ryMinutesAgo) },
  konrad3D: { status: "success", sourceTime: t(konradMinutesAgo) },
});
const input = (overrides = {}) => ({ source: "weather", fetchStatus: "success", components: weatherComponents(), ...guards, ...overrides });

test("prototype is private/default-off and allowlists fixed workflows", () => {
  assert.equal(dispatcherPrototypeConfig.publicRoute, false);
  assert.equal(dispatcherPrototypeConfig.dispatchEnabledByDefault, false);
  assert.deepEqual(dispatcherPrototypeConfig.allowedWorkflows, ["update-dwd-weather.yml", "update-radolan-ry.yml"]);
});

test("fresh observations and MOSMIX do not produce a candidate", () => {
  assert.equal(planInternalDispatch(input(), now).reason, "source_current");
});

test("stale observation produces only an allowlisted weather candidate", () => {
  const result = planInternalDispatch(input({ components: weatherComponents(50, 60) }), now);
  assert.equal(result.action, "candidate_only");
  assert.equal(result.workflow, "update-dwd-weather.yml");
  assert.deepEqual(result.staleComponents, ["temperatureHumidity", "stationPressure", "wind", "windGust", "precipitation"]);
  assert.equal(result.oldestStaleSourceTime, t(50));
});

test("MOSMIX uses its independent 12-hour issue-time threshold", () => {
  assert.equal(planInternalDispatch(input({ components: weatherComponents(20, 11 * 60) }), now).reason, "source_current");
  const result = planInternalDispatch(input({ components: weatherComponents(20, 13 * 60) }), now);
  assert.equal(result.workflow, "update-dwd-weather.yml");
  assert.deepEqual(result.staleComponents, ["mosmix"]);
});

test("forecast without a usable point fails closed", () => {
  assert.equal(planInternalDispatch(input({ components: weatherComponents(20, 60, 0) }), now).reason, "forecast_has_no_usable_points");
});

test("RADOLAN-RY and KONRAD3D are grouped into one radar workflow candidate", () => {
  const result = planInternalDispatch(input({ source: "radar", components: radarComponents(5, 40) }), now);
  assert.equal(result.workflow, "update-radolan-ry.yml");
  assert.deepEqual(result.staleComponents, ["konrad3D"]);
  assert.equal(result.oldestStaleSourceTime, t(40));
});

test("failed or unavailable source/component never creates a candidate", () => {
  assert.equal(planInternalDispatch(input({ fetchStatus: "error" }), now).reason, "source_fetch_not_successful");
  const components = weatherComponents(80, 60);
  components.wind.status = "unavailable";
  assert.equal(planInternalDispatch(input({ components }), now).reason, "component_not_successful");
});

test("missing, malformed, or future source timestamps fail closed", () => {
  const missing = weatherComponents(); delete missing.wind.sourceTime;
  assert.equal(planInternalDispatch(input({ components: missing }), now).reason, "source_time_invalid");
  const malformed = weatherComponents(); malformed.wind.sourceTime = "bad";
  assert.equal(planInternalDispatch(input({ components: malformed }), now).reason, "source_time_invalid");
  const future = weatherComponents(); future.wind.sourceTime = new Date(now + 5 * 60_000).toISOString();
  assert.equal(planInternalDispatch(input({ components: future }), now).reason, "source_time_in_future");
});

test("unknown sources, component sets, and incomplete guard state fail closed", () => {
  assert.equal(planInternalDispatch(input({ source: "__proto__" }), now).reason, "source_not_allowlisted");
  assert.equal(planInternalDispatch(input({ components: {} }), now).reason, "component_set_invalid");
  assert.equal(planInternalDispatch(input({ leaseAcquired: undefined }), now).reason, "guard_state_incomplete");
  assert.equal(planInternalDispatch(input(), Number.NaN).reason, "clock_invalid");
});

test("active workflow, cooldown, quota, and lease each block a candidate", () => {
  const stale = weatherComponents(50, 60);
  for (const [key, value, expected] of [
    ["workflowActive", true, "workflow_already_active"],
    ["cooldownClear", false, "cooldown"],
    ["quotaAvailable", false, "daily_quota"],
    ["leaseAcquired", false, "lease_not_acquired"],
  ]) assert.equal(planInternalDispatch(input({ components: stale, [key]: value }), now).reason, expected);
});
