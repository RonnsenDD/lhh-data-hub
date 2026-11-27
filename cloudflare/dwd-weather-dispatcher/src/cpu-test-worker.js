/**
 * Isolated live CPU harness. This is deliberately not the dispatcher entrypoint:
 * it hard-codes disabled mode, performs no fetches, and cannot dispatch.
 * Invoke only through a Cloudflare Access-protected Preview after explicit approval.
 */
import { evaluateWeatherDispatcher } from "./worker.js";

const PATH = "/cpu-test";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== PATH) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    // Do not read request data or environment values. Invalid configuration,
    // query strings, headers, and bodies cannot enable observe or dispatch.
    const result = await evaluateWeatherDispatcher({ WEATHER_DISPATCH_MODE: "disabled" });
    return Response.json(result, {
      status: 200,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  },
};
