# Isolated Cloudflare CPU test (prepared, not deployed)

This test harness is separate from the dispatcher entrypoint. It uses the code from PR #21, hard-codes WEATHER_DISPATCH_MODE=disabled, has no scheduled handler, reads no environment values, performs no fetches, and cannot dispatch.

## Deployment gate

Do not proceed until the account owner has confirmed the active Workers plan and remaining allowance in the Cloudflare dashboard. The API connection exposes the Workers usage model but not the subscription or remaining billable allowance. If the account is Paid/Standard or the free allowance cannot be confirmed, do not deploy under the no-additional-cost requirement.

The supplied config is fail-closed:
- Worker name: lhh-dwd-dispatcher-test
- no triggers.crons
- workers_dev: false
- preview_urls: false
- no GitHub app variables or secrets
- no bindings, storage, or production routes

Deployment itself requires separate approval. It creates only this isolated script. Existing Workers and schedules remain untouched.

## Controlled live CPU test

A real HTTP invocation needs a Preview URL. Cloudflare documents Preview URLs as publicly reachable unless protected by Cloudflare Access. Before enabling a Preview URL, verify that an existing Access policy is set to allow only the account owner. If no such policy exists or this would require an unapproved configuration change, stop; do not expose the endpoint.

Once the owner has separately approved deployment and the access policy is verified:

1. Deploy with npx wrangler deploy --config wrangler.cpu-test.jsonc. The config leaves both production workers.dev and Preview URLs disabled and declares no Cron.
2. In the Cloudflare dashboard, verify the new Worker has no Cron, no production route, no secrets, and no bindings. Verify Access protection for Preview traffic before enabling a version URL.
3. Enable the Preview URL only after the Access policy is active. Use the Preview URL, not workers.dev.
4. Send exactly 30 serial POST /cpu-test requests from the authenticated owner session. Do not use loops or parallel calls. Each response must report reason=disabled, dispatch=false, and errorStatus=none.
5. Export the 30 matching invocations from Workers Observability and calculate CPU p50, p90, p95, p99, maximum, outcomes, and errors. Exclude any requests that do not match the test Worker/version.
6. Disable Preview URLs immediately after the sample, then verify they are inaccessible.

The harness accepts only POST on exactly /cpu-test; all other methods and paths return 404. It ignores headers, query parameters, and request bodies. It does not read env, call fetch, invoke the dispatcher observe path, or read GitHub credentials. Thus this measures only the Cloudflare runtime overhead of the disabled path. It is not evidence for the Observe-mode CPU cost.

## Observe-mode prerequisite

Observe requires the public DWD sidecar and GitHub Actions read history in the current dispatcher design. GitHub authentication requires a separate worker-scoped GITHUB_APP_PRIVATE_KEY; existing secrets are not inherited. Do not copy or read the existing Watchdog secret. Setting a new secret requires an independent approval and must be done manually by the account owner. Observe must be tested separately; the disabled CPU result does not qualify.

## Rollback

1. Disable Preview URLs and verify the Preview endpoint is inaccessible.
2. After separate approval, delete only lhh-dwd-dispatcher-test.
3. Verify the existing Watchdog, CPU-test Worker, and Pegel pilot still exist with unchanged schedules.
