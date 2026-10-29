import { runWatchdog } from "./watchdog.mjs";

export default {
  async scheduled(controller, env, ctx) {
    const id = env.WATCHDOG_COORDINATOR.idFromName("lhh-data-hub-singleton");
    const coordinator = env.WATCHDOG_COORDINATOR.get(id);
    ctx.waitUntil(coordinator.fetch("https://watchdog.internal/tick", { method: "POST" }));
  },

  async fetch() {
    // The deployment has no route. This fallback also exposes no status or control API.
    return new Response("Not Found", { status: 404 });
  },
};

export class WatchdogCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/tick") {
      return new Response("Not Found", { status: 404 });
    }
    return this.state.blockConcurrencyWhile(async () => {
      try {
        const report = await runWatchdog({
          token: this.env.GITHUB_TOKEN,
          owner: this.env.GH_OWNER || "RonnsenDD",
          repo: this.env.GH_REPO || "lhh-data-hub",
          storage: this.state.storage,
        });
        return Response.json({ ok: true, checkedAt: report.checkedAt, sourceCount: report.sources.length });
      } catch (error) {
        // Do not log headers, request bodies, or secret bindings.
        console.error(JSON.stringify({ type: "watchdog-fatal", name: error?.name || "Error" }));
        return new Response("Watchdog tick failed", { status: 500 });
      }
    });
  }
}
