import { cpuUsage } from "node:process";
import { performance } from "node:perf_hooks";

const before = cpuUsage();
const started = performance.now();
await import(`./worker.js?init-profile=${Date.now()}`);
const wallMs = performance.now() - started;
const used = cpuUsage(before);
console.log(JSON.stringify({
  profile: "Local Node module-load CPU; includes ESM loader; not Cloudflare isolate CPU",
  node: process.version,
  moduleLoadCpuMs: Number(((used.user + used.system) / 1000).toFixed(4)),
  moduleLoadWallMs: Number(wallMs.toFixed(4)),
}));
