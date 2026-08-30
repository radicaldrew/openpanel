# The telemetry ingest gateway

One encapsulated Fastify plugin in `apps/api` — **the telemetry chassis** — owns every
`/telemetry/*` route: it authenticates against a new `ClientType.telemetry` credential, enforces
the CORS deny, the rate limit, the admission bound, the decompression caps, the structural
limits, the timestamp window, the kill switch and the redacted error handler, and forwards to an
internal gigapipe writer that is never reachable from the network. It is the write half of
load-bearing decision #2.

**P1 opens two of the four routes: `/telemetry/v1/metrics` and `/telemetry/api/v1/write`.** The
logs route opens in P3 with the shaping rules `05-logs.md` owns, and the traces route in P4 with
the correlation rules `06-traces-and-correlation.md` owns (D18). Opening a route before the
work-stream that owns its per-signal shaping has shipped writes rows that
`01-tenancy-and-security.md`'s Effort and `06` T21 both describe as unrepairable — not
deletable-and-retryable, *unrepairable* — so the routes are opened by the phases that can shape
what goes through them.

The single most important thing in this document is
[The payload rewrite](#6-the-payload-rewrite): **the tenancy rule is different for each of the
three OTLP signals**, and getting it wrong is not a bug, it is a tenancy breach. Stamping only
the resource attribute — the obvious reading of "overwrite an `op_project_id` resource
attribute" — is a **complete no-op for metrics** and is **client-overridable for logs**; both
are proved from gigapipe source below. For logs the conclusion goes further still: the payload
is not forwarded at all but decoded and rebuilt (D17). The work is split into **P1a** (routes,
auth, the two P1 rewrites, structural limits, error semantics — the parts that are load-bearing
for tenancy and cannot be retrofitted) and **P1b** (admission, breaker, cardinality observation,
metering, the crude volume ceiling).

Status: **SPEC**, nothing implemented. Every citation was read from disk in this session.
`node_modules` is not installed in this checkout, so nothing about a JS library's runtime
behaviour could be executed; those points are marked `UNVERIFIED:` with what would settle them.

---

## Revision note — decisions changed here that other documents depend on

This pass reconciles the gateway against the ten sibling specifications. The following are
**changes to previously-published decisions**, not clarifications. Each names the documents that
must be edited to match. Nothing else in this document was weakened.

| # | Change | Was | Now | Documents that must follow |
|---|---|---|---|---|
| R1 | **Log ingest topology.** `apps/api` decodes OTLP/Loki logs itself and pushes a reconstructed Loki JSON body; it never forwards an OTLP log payload to gigapipe (D17). | 02 §6.2 rewrote the OTLP protobuf in place and forwarded to gigapipe `/v1/logs` | `05-logs.md` D1 wins on evidence I re-verified myself (`writer/utils/unmarshal/otlplogs.go:22-58`) | `01` §4.4/§4.8's logs row and T1.5/T1.6; `11` E12–E15/E22–E24 retarget to `buildEnvelope`/`sanitizeAttrKey`/the label allowlist |
| R2 | **The `type ∈ {1,2}` invariant is re-derived.** It no longer rests on "the gateway does not expose `/loki/api/v1/push`" — it rests on *no customer-authored Loki entry is ever forwarded verbatim, and OpenPanel's own push writer emits strictly two-element `[ns, line]` entries* (§1). | "safe **only because** this gateway does not expose `/loki/api/v1/push`" | an invariant on our own writer, with a named regression test | `08` S13/§13 and `10` D10 restate the premise; `05` adds the writer-side assertion |
| R3 | **P1's route table is metrics + remote-write only** (D18). | P1 accepted all three OTLP signals | logs open in P3 (05), traces in P4 (06) | `11` §3.2's P1 gate rows; `06`'s P1/P4 split; `05` P3.3/P3.4 |
| R4 | **The reserved namespace has a closed exception list**, restored by the gateway after the strip (D22, §6.0). | `scrubAttrs` dropped every `op_*` attribute unconditionally, on every signal | snapshot → strip → restore, for `op_session_id`, `op_profile_id`, `op_root`, `op_exception_*`, at the levels `06` §4.1 step 2 specifies | `01` D2/D7 and §5 must carry the same list; `11` §3.2 adds the span-keeps / log-record-strips pair |
| R5 | **The strip predicate is `isReservedKey(key)`, unconditional, three forms, no `protocol` parameter**, and it lives in `packages/gigapipe/src/labels.ts`. | 01 §5 `isReservedKey(key, protocol)`, returning **false** for `op.project.id` on traces; 02 declared `isReserved` in `apps/api/src/telemetry/labels.ts` | one function, one home | `01` §5 and its T1.2 traces row (which asserts the behaviour this document argues is the bug); `11` E5b |
| R6 | **Config names are 10's.** `GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`; container side `CLOKI_LOGIN`/`CLOKI_PASSWORD` (§15). | 02 used `GIGAPIPE_INTERNAL_URL`, `GIGAPIPE_LOGIN`, `→ QRYN_LOGIN` | `10-ops-retention-billing.md` §3.1 owns the surface because it owns `.env.template`, `coolify.yml` and `quiz.ts` | `11` gate 1.7 (`GIGAPIPE_INTERNAL_URL` → `GIGAPIPE_URL`); `04` §3's table (`GIGAPIPE_USERNAME`, `GIGAPIPE_CLUSTER_NAME`, `TELEMETRY_CLICKHOUSE_DATABASE`); `05` §"Bootstrap" (`GIGAPIPE_READ_URL`/`GIGAPIPE_WRITE_URL`) |
| R7 | **One kill-switch namespace with a read/ingest split** (§4). | 02 `telemetry:disabled:{projectId}`; 04 D15 `op:gp:off`; 01 §11 `telemetry:ingest:enabled` (opposite polarity); 06 §15 env vars | `telemetry:disabled:ingest:*` / `:{projectId}` and `telemetry:disabled:read:*` / `:{projectId}` | `04` D15; `01` §11 (delete); `06` §15 (delete); `10` §10.3 publishes the four-key runbook table |
| R8 | **The verification cache is keyed on the client id alone** (D21, §2.2), value `{hash, digest}`, TTL 60 s, cleared by `clearTelemetryAuth(clientId)`. | 02 keyed `telemetry:auth:${clientId}:${secretHash(secret)}` at 300 s | `01-tenancy-and-security.md` §6.1's shape is right and its rotation argument is decisive | `05` §4.2 (delete its variant and its 5-minute SLA); `11` A18 cites the one number |
| R9 | **Wind-down-blocked telemetry ingest is 403**, everywhere, including remote-write. | four statuses across four documents | 403 + `google.rpc.Status`; reasoning in §4 now includes the remote-write argument that settles it | `11` A15 (429 → 403); `05` §4.3 (200/204 → 403); `06` §4.1 step 0 (202 → 403) |
| R10 | **`/telemetry` is CORS-*denied*, not added to `corsPaths`** (D16, adopting `05-logs.md` D11 verbatim). | D16 claimed membership in `corsPaths` blocks browsers; verified at `apps/api/src/app.ts:109-125` that it does the opposite | a third `corsDeniedPaths` branch returning `{ origin: false }`, evaluated first | `01` §6's "added to `corsPaths` (D16)" reference |
| R11 | **The telemetry table list is `TELEMETRY_TABLES` in `08-schema-changes.md`**, and `tempo_traces_kv` is **not** a delete target (§17). | 02 §17 enumerated seven tables including `tempo_traces_kv` and omitting `patterns` | one exported constant, seven delete targets | `11` I13 (drop `tempo_traces_kv`, making it seven); `05` §7.4 |
| R12 | **`GET /telemetry/health` is deleted** (§10.4). | an unauthenticated endpoint returning circuit-breaker state | breaker state is a Prometheus gauge only | none; `11` if it asserted the route |

Two placement decisions ratified rather than changed: `packages/gigapipe` is the shared package
(`04-read-path.md` D1) and holds `labels.ts`; the gateway itself stays in
`apps/api/src/telemetry/` (D9), so `04` D1's layer table should drop its `src/ingest/*.ts` and
`vendor/opentelemetry-proto/**` rows — `02` D9 argues that placement at length and `04` does not
defend its version.

---

## Decisions

| # | Decision | Rejected alternative, and why |
|---|---|---|
| **D1** | Mount at `/telemetry`; OTLP at `/telemetry/v1/{metrics,logs,traces}`, remote-write at `/telemetry/api/v1/write` | An `/otlp` prefix. An OTel exporter appends `/v1/<signal>` to its configured `endpoint`, so the base path must be the *parent* of `v1/`. `/telemetry` is the only prefix that lets a user paste one `endpoint` and have all three signals work. |
| **D2** | New `ClientType.telemetry` enum value + a dedicated `validateTelemetryRequest(headers)` that verifies a secret **unconditionally** | Reusing `validateSdkRequest` (`apps/api/src/utils/auth.ts:42-176`). It returns an authenticated client with **no secret check at all** on three paths: `client.ignoreCorsAndSecret` (`:133`), an `Origin` matching `project.cors`, and `project.cors.includes('*') && origin`. Client IDs are public — they ship in web SDK bundles and are read out of the request *body* (`:51-56`). `Origin` is a header anyone can set from curl. Since `op_project_id` is derived from the authenticated token, reusing that function makes the entire tenancy boundary bypassable with a public id. |
| **D3** | **The strip is computed on gigapipe's *sanitized* key as well as the raw key**, and `op_project_id` is stamped **per signal with a different rule**: metrics → every data point's attributes *and* the resource; logs → the label set is *constructed*, not stamped (D17); traces → resource attributes, strip at scope + span + span-event + span-link level, with the closed correlation exception of D22 | One uniform "overwrite the `op_project_id` resource attribute". Proved wrong three ways in §5: it is a no-op for metrics (`writer/utils/unmarshal/otlp_metrics.go:236-267` never reads resource attrs into a series), it is overwritten by a log record attribute (`otlplogs.go:36-46`), and on every signal it is defeated by punctuation, because a client attribute `op.project.id` becomes the label `op_project_id` after `SanitizeKey` (`otlplogs.go:105-118`). |
| **D4** | Decode → mutate → re-encode with **`protobufjs` static-module codegen** over **vendored `opentelemetry-proto` and upstream `prometheus/prompb`**, with `protobufjs`, `long` and `snappy` as direct deps of `apps/api` and in `tsdown`'s `external` array | (a) `@opentelemetry/otlp-transformer` — its published surface is `serializeRequest` + `deserializeResponse`; there is no *request* decoder, so it cannot do the gateway's job. (b) Byte-level surgical patching — appending a `KeyValue` inside `Resource` requires rewriting every enclosing length prefix, i.e. writing a protobuf editor. (c) Vendoring **gigapipe's** minimal `prompb.proto` (`writer/utils/proto/prompb.proto`, read in full: `TimeSeries` is `labels`=1 and `samples`=2 only) — it has no `exemplars` and no `histograms`, so re-encoding through it would silently drop data we should be dropping *loudly*. |
| **D5** | Remote-write is forwarded snappy-compressed with **no `Content-Encoding` header** | Forwarding `Content-Encoding: snappy`. gigapipe then runs two decompression stages in series — `WithOverallContextMiddleware` (`writer/controller/middleware.go:164-201`) and `withUnsnappyRequest` (`middleware.go:111-144`) — and only survives because the second one *fails* into a fallback (`:133-136`). Argued in §5.4. |
| **D6** | The gateway does its own gzip/deflate/snappy decompression in a `preValidation` hook with a hard decompressed-size cap and a ratio cap; `@fastify/compress` is not used for requests | `@fastify/compress` request decompression. It is registered `{ global: false }` at `apps/api/src/app.ts:135`, and it offers no decompressed-size bound — a 1 MB gzip bomb becomes 1 GB of heap in the process that also serves `/track`. `UNVERIFIED:` its exact v8 request-decompression API (no `node_modules`); the size-bound argument rejects it regardless. |
| **D7** | Upstream failure → **503 with `Retry-After`**; hard quota → **429**; malformed payload → **400**; oversize → **413**. Never 200-with-`partial_success` for an upstream failure | 200 + `partial_success`. An OTLP client treats a 200 as delivered and will not retry; the batch is lost. `partial_success` is reserved for data *we deliberately dropped* (structural limits, timestamp window) and must never mean "we couldn't reach storage". |
| **D8** | **P1 cardinality is observation only.** Structural limits (§6) are enforced inline and always; series cardinality is recorded into a Redis HyperLogLog fire-and-forget and read by a cron. **No `SADD`, no `SMISMEMBER`, no refusal, no budget.** | The draft's two-tier tripwire with exact-set admission. Rejected for P1 on three grounds proved below: (a) the gateway's series hash **undercounts stored series by the histogram/summary fan-out factor** (`otlp_metrics.go:373,379,386,391,472,477,481` emit one series per bucket/quantile plus `_sum`/`_count`), so it would enforce a budget against a number that is wrong by 10× or more; (b) `budget(project)` does not exist and would be an invented global constant; (c) an unbounded `SADD` against a `--maxmemory-policy noeviction` Redis (`self-hosting/docker-compose.template.yml:48-52`) that also runs BullMQ and the session store is how the gateway takes down `/track`. Enforcement moves to P6 and is sized from the distributions P1 records. |
| **D9** | The gateway lives in one directory, `apps/api/src/telemetry/`, and touches Prisma through exactly one file, `telemetry/deps.ts`. The **shared** label primitives (`isReservedKey`, the two sanitizers, `assertProjectLabelValue`) live in `packages/gigapipe/src/labels.ts` because the read path's compilers need the identical predicate | Spreading it across `routes/` + `controllers/` + `hooks/` + `utils/` like the rest of `apps/api`. That is the repo convention, but it turns the later lift-out into `apps/otel-gateway` from a `git mv` into a rewrite. **Also rejected: doing the lift-out in P1.** It adds a service to four deployment surfaces, a service-to-service auth hop and a k8s/coolify/compose change, to solve an event-loop-occupancy problem that async zlib plus the admission cap already bounds. |
| **D10** | gigapipe health is **informational only** and never enters `/healthcheck`'s 200/503 decision | Adding a `gigapipe` key to `dependencies` in `apps/api/src/controllers/healthcheck.controller.ts:17-21`; `status` is computed over the whole object (`:35`). Plain `docker compose` does not restart an unhealthy container — `restart: always` fires on process exit — but marking `op-api` unhealthy blocks `condition: service_healthy` dependents from starting and, under Swarm/k8s liveness probes/some PaaS, restarts the process serving `/track`. A gigapipe outage must not do that. |
| **D11** | The plugin installs its **own `setErrorHandler`**, and registers **its own `@fastify/rate-limit`** rather than calling `activateRateLimiter` | Falling through to the app-level handler at `apps/api/src/app.ts:397-444`: it logs `headers: request.headers` (`:420`) — including `openpanel-client-secret` — and `body` (`:421-423`) — a multi-megabyte `Buffer` — at `warn` on **4xx as well as** `error` on 5xx, for any error whose code is not in `SKIP_LOG_ERRORS` (`:392-396`). And `activateRateLimiter` hard-codes `errorResponseBuilder` to a JSON object (`apps/api/src/utils/rate-limiter.ts:19-25`) with no override parameter, so a 429 could never carry a `google.rpc.Status`. |
| **D12** | **OTLP/JSON is rejected 415 on every route that forwards a re-encoded payload** — in P1 that is `/telemetry/v1/metrics`, and from P4 `/telemetry/v1/traces`. It is *not* a rule on `/telemetry/v1/logs`, which under D17 reconstructs the body rather than forwarding it, so a JSON decoder there costs a second decoder and not a second copy of the security boundary; `05-logs.md` §4.1 accepts `application/json` on the logs routes and that is consistent with this decision, not a violation of it. | Accepting `application/json` on `/v1/metrics` (gigapipe does have a real protojson parser there, `writer/controller/otlp_metrics.go:56-58`). Accepting it means either forwarding the body unmodified — which is a tenancy hole, since a client's own `op_project_id` data-point attribute would reach `protojson` with `DiscardUnknown: true` intact — or building **a second full rewrite implementation inside the security boundary**, with its own hazards (`timeUnixNano` vs `time_unix_nano` key spellings, 64-bit-as-string, bytes-as-base64, protobufjs `fromObject`/`toObject` round-tripping). No default exporter emits OTLP/JSON. Deferred to P6 with a dedicated rewrite subsection or not at all. |
| **D13** | The gateway **rejects a request whose project id fails `^[a-zA-Z0-9_-]{1,100}$`** with 403 `reason="invalid_project_id"`, per request, and refuses to mint a telemetry client for such a project | Asserting the value is a UUID at boot. **`Project.id` is not a UUID.** The `@default(dbgenerated("gen_random_uuid()"))` at `packages/db/prisma/schema.prisma:258` is dead — every creation path sets the id explicitly to `getId('project', name)` (`apps/api/src/controllers/manage.controller.ts:110`, `packages/trpc/src/routers/project.ts:175`, `packages/trpc/src/routers/onboarding.ts:113`), which is `slug(name)` (`packages/db/src/services/id.service.ts:9` → `packages/common/src/slug.ts:17`, slugify `{lower:true, strict:true}`), and the name has no maximum length (`zCreateProject` is `z.string().min(1)`, `manage.controller.ts:16`; `zOnboardingProject.project` is `z.string().min(3)`, `packages/validation/src/index.ts:384`). A boot-time assertion cannot run on a per-request value. See §3. |
| **D14** | **Timestamps are clamped to a window during the rewrite walk.** Outside `[now − TELEMETRY_MAX_BACKFILL_HOURS, now + TELEMETRY_MAX_SKEW_MINUTES]` the element is dropped and counted, not the batch failed | Trusting the client. gigapipe bounds nothing: `acceptTimestamp` (`writer/utils/unmarshal/otlp_metrics.go:277-287`) rejects only a **zero** timestamp, and the logs decoder defaults a missing timestamp to `now` (`otlplogs.go:68-75`). A future-dated row is permanently stored (a TTL relative to the row timestamp never fires), unbillable by a wall-clock metering window, and invisible to retention. |
| **D15** | **Delivery is at-least-once and duplicates are accepted.** No idempotency key, no dedup window | Pretending otherwise. gigapipe's ingest is synchronous — `IngestParsed` pushes with `INSERT_MODE_SYNC` and waits on every promise (`writer/controller/builder.go:228-256`) — so a timeout or a mid-forward `process.exit()` can mean the ClickHouse insert landed while the client saw nothing and retried. `samples_v3` is a plain `MergeTree` (`ctrl/qryn/sql/log.sql:25-32`) with no deduplication. Making this idempotent would require a gateway-side write-ahead log; the cost is not justified for telemetry. Consequences are stated in §12 and routed to the read-path and billing work-streams. |
| **D16** | **`/telemetry` is CORS-*denied* by a new third branch** — `corsDeniedPaths = ['/telemetry']`, evaluated **before** the `corsPaths` check, returning `{ origin: false }`. Adopted verbatim from `05-logs.md` D11 | **This reverses the previous D16, which was factually wrong** (R10). It said adding `/telemetry` to `corsPaths` blocks browsers. Re-read at `apps/api/src/app.ts:109-125` in this pass: membership in `corsPaths` is the **restricted** branch — `{ origin: <matching dashboard origin>, credentials: true }` — and *everything else* falls through to `return callback(null, { origin: '*', maxAge: 86_400 * 7 })` at `:124`. So adding `/telemetry` would have made the dashboard origin an *allowed* credentialed cross-origin caller, and omitting it leaves the route open to every origin on the internet, exactly like `/track`. Neither reading is a block. The telemetry secret is the sole input to `op_project_id` and there is no legitimate browser caller; the preflight is answered by the cors plugin **before** the plugin's own `onRequest` hooks, so this cannot be fixed later behind auth. `01-tenancy-and-security.md` §6 cites the old D16 as a settled control and must be corrected. |
| **D17** | **Logs are decoded and *rebuilt*, never forwarded.** `apps/api` decodes OTLP-logs (and Loki-JSON) itself, constructs the closed allowlisted label set plus the JSON envelope `05-logs.md` D2/D3 specify, and pushes Loki JSON to gigapipe's `/loki/api/v1/push`. **This reverses the previous §6.2** (R1). | Rewriting the OTLP protobuf in place and forwarding to gigapipe's `/v1/logs`. `05-logs.md` D1 is right and I re-verified its evidence line by line in this pass: `writer/utils/unmarshal/otlplogs.go:26-58` folds resource, scope **and record** attributes into one `attrsMap`, then appends `level`, `trace_id` and `span_id`, then turns the whole map into the stream's label set — and the fingerprint is computed over that surviving set (`unmarshal.go:250-270`). One trace id is therefore one `time_series` row and one `time_series_gin` row **per label** per stream per day. There is no configuration that disables it. A stamp-and-forward gateway would be tenancy-correct and operationally fatal. The security consequence of the reversal is stated in §6.2: under D17 the boundary is the **envelope writer**, not the strip, so the strip rules move to the constructed label set and the tests move with them. |
| **D18** | **P1 opens `/telemetry/v1/metrics` and `/telemetry/api/v1/write` only.** `/telemetry/v1/logs` and `/telemetry/loki/api/v1/push` open in P3 (owned by `05-logs.md`); `/telemetry/v1/traces` opens in P4 (owned by `06-traces-and-correlation.md`). All four register **inside this plugin** (D23). | Opening all three OTLP routes in P1 with `op_project_id` stamping only, and adding the per-signal shaping later. Rejected because the rows written in between cannot be repaired: `06` T11/T12/T17 (strip the correlation keys from metric and log labels, zero `LogRecord.SpanId`, keep correlation ids only on a local root under a per-trace cap) are gateway rules **costed inside `06`'s P4**, and the words `op_session_id`, `op_root` and `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE` appeared **zero times** in this document before this revision. A trace-id label written into `time_series_gin` at 10k/s for the six weeks between P1 and P3 is not a backlog item, it is a permanent cost on a shared instance. Restricting the route table is free; the alternative is a rewrite nobody scheduled. |
| **D19** | **`10-ops-retention-billing.md` §3.1 owns the config surface.** This document uses its names: `GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`; on the container, `CLOKI_LOGIN`/`CLOKI_PASSWORD` | The previous `GIGAPIPE_INTERNAL_URL` / `GIGAPIPE_LOGIN` / `QRYN_LOGIN` set, and every other spelling in the document set (`GIGAPIPE_READ_URL`/`GIGAPIPE_WRITE_URL`, `GIGAPIPE_USERNAME`, `GIGAPIPE_CLUSTER_NAME`, `CLICKHOUSE_CLUSTER_NAME`, `TELEMETRY_CLICKHOUSE_DATABASE`). 10 owns `.env.template`, `coolify.yml` and `quiz.ts` — the files an operator actually fills in — so its names are the ones that reach a running container, and any other document's name is a variable nobody sets. The failure mode is not cosmetic: verified at `cmd/gigapipe/main.go:321-324`, gigapipe installs its basic-auth middleware **only when both** username and password are non-empty, and Compose substitutes a missing `.env` key with the empty string plus a warning. A name mismatch between the compose service and the boot assertion is a **silently unauthenticated gigapipe** serving the Elastic `_bulk` write routes and the always-on cleartext gRPC OTLP receiver to anything on the network, with every healthcheck green. `CLOKI_*` beats `QRYN_*` on the container because `portEnv` assigns `CLOKI_*` second (`main.go:172-183`), so it wins when both are set. |
| **D20** | **One kill-switch namespace, `telemetry:disabled:{surface}:{scope}`**, with `surface ∈ {ingest, read}` and `scope ∈ {*, projectId}`. Per-project keys carry a **mandatory TTL**; the two global keys carry **none** | Five mechanisms for one lever, two of opposite polarity: `01` §11's `telemetry:ingest:enabled`/`telemetry:read:enabled` (a value means *enabled*), `04` D15's `op:gp:off`, this document's old `telemetry:disabled:{projectId}`, `06` §15's `GIGAPIPE_TRACES_*_ENABLED` env vars, and `05` D12's "unset `GIGAPIPE_READ_URL`". An on-call engineer reading any one of them pulls a lever the other four do not observe. The split between read and ingest is kept because `04` D15's reasoning is right — a read-path enforcement bug must not stop correctly-stamped ingest. The TTL split is kept because both sides were right about different keys: a per-project block is an emergency measure that must expire rather than be forgotten, and a global block is a deliberate operator action that must not un-pull itself at 3 a.m. |
| **D21** | **The verification cache is keyed on `telemetry:auth:${clientId}` alone**, with `{ hash, digest }` in the value, a 60 s TTL, a re-verify on any mismatch, and an exported `clearTelemetryAuth(clientId)` | Keying on `${clientId}:${sha256(secret)}` (this document's previous §2.2, and `packages/mcp/src/auth.ts:106-108`, and `05-logs.md` §4.2). `01-tenancy-and-security.md` §6.1's argument is decisive and this document's old justification was inverted: a rotated secret does not "miss the cache" in the way that matters — the **new** secret misses, while the **old** secret hits *its own* entry and is granted for the full TTL, and no code path can reconstruct that key without the old plaintext, so nothing can clear it. |
| **D22** | **The reserved namespace has a closed, named exception list that the gateway re-attaches after the strip**: `op_session_id`, `op_profile_id`, `op_root`, `op_exception_type`, `op_exception_message` — traces only, at the levels `06` §4.1 step 2 specifies, under `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE` | Stripping every `op_*` key unconditionally on every signal, which is what the previous `scrubAttrs` did. It would have silently deleted the session and profile correlation ids — the one thing the plan says no Grafana stack can offer — on every span, and no test in the set would have caught it because the assertion everyone wrote is "exactly one `op_project_id`". The ordering is part of the contract: **snapshot, then strip, then restore.** The exception is *not* extended to metrics or logs: `06` T11/T12 require those keys to be stripped there, because on those signals an attribute *is* a label and a per-session label is ~10⁵ new series/day. |
| **D23** | **Every `/telemetry/*` route registers inside this plugin.** A route added by another work-stream contributes a handler and a per-signal rewrite; it does not get its own router, its own rate limiter, its own body limits or its own error handler | `05-logs.md` §4.1's separate `apps/api/src/routes/telemetry.router.ts` with its own `activateRateLimiter`, its own `OTLP_MAX_BODY` and no `setErrorHandler`. Three of this document's controls are load-bearing and all three are absent from a sibling router: the rate-limit key must be `tel:${trustedIp}:${clientId}` and not the attacker-chosen client id alone (D11, §9.1); the failed-auth lockout must run **before** argon2; and the error handler must not log `request.headers`, because the app-level one does (`app.ts:420`) and `openpanel-client-secret` is in it on every 413/415/400 a logs route generates. A second router is a second, quieter copy of the security boundary. |

---

## Design

### 1. Route table

All routes come from one encapsulated Fastify plugin registered in the **Public API** scope of
`apps/api/src/app.ts` — the `fastify.register(async (instance) => {...})` block at `app.ts:343-391`
that already carries `/track`, `/export`, `/insights` — as:

```ts
instance.register(telemetryRouter, { prefix: '/telemetry' });
```

**P1 (this document, D18):**

| OpenPanel route | Method | `Content-Type` accepted | `Content-Encoding` accepted | Forwards to | gigapipe route source |
|---|---|---|---|---|---|
| `/telemetry/v1/metrics` | POST | `application/x-protobuf` only | absent, `identity`, `gzip`, `deflate` | `POST {GIGAPIPE_URL}/v1/metrics` | `writer/router/insert.go:15` |
| `/telemetry/api/v1/write` | POST | `application/x-protobuf` (**PRW 1.0 only**) | `snappy` **required** | `POST .../api/v1/prom/remote/write` | `writer/router/prom.go:10` |
| `/telemetry/api/v1/write` | GET | — | — | not forwarded, answered locally `200 "OK"` | mirrors `WriteStreamProbeV2`, `writer/controller/prom.go:49-52` |

**Opened by a later phase, inside this plugin (D18, D23):**

| OpenPanel route | Phase / owner | `Content-Type` accepted | Forwards to | What the owning document must ship with it |
|---|---|---|---|---|
| `/telemetry/v1/logs` | **P3**, `05-logs.md` | `application/x-protobuf`, `application/json` (D12) | `POST .../loki/api/v1/push` — **reconstructed**, never the client's body (D17) | the label allowlist, `buildEnvelope`, `sanitizeAttrKey`, `06` T11/T12 (`op_session_id`/`op_profile_id` stripped, `LogRecord.SpanId` zeroed) |
| `/telemetry/loki/api/v1/push` | **P3**, `05-logs.md` | `application/json`; block-snappy protobuf from P3.4b | same, reconstructed | same, plus the two-element-entry assertion below |
| `/telemetry/v1/traces` | **P4**, `06-traces-and-correlation.md` | `application/x-protobuf` only | `POST .../v1/traces` | `06` §4.1's seven ingest-side mutations, of which §6.3 here is steps 1 and 6 |

Every one of them is registered by `telemetryRouter` and inherits the chassis: auth (§2), the
CORS deny (D16), the rate limiter and lockout (§9.1), admission (§10.1), decompression and the
body caps (§5.2/§5.3), the structural limits and timestamp window (§7), the kill switch (§4), the
metering counters (§13) and the redacted error handler (§11.3). None of that is re-implemented
per signal, and a route that wants its own copy of any of it is rejected in review (D23).

Every route carries `schema: { hide: true }`. The Public API scope registers
`fastifyZodOpenApiPlugin` + `fastifySwagger` + `fastifySwaggerUI` (`app.ts:344-368`) with a
`transform` that hides only `/metrics`; every other undocumented route in that scope passes
`schema: { hide: true }` explicitly (`app.ts:383-388`). Without it the telemetry routes land in
the published OpenAPI document and `/documentation`, and the swagger transform is handed a route
whose body is a raw protobuf `Buffer`. The plugin also does not use the app's global
`setValidatorCompiler`/`setSerializerCompiler` (`app.ts:96-97`) — it validates protobuf, not zod.

`application/json` is rejected 415 on every route that forwards a re-encoded payload — in P1
that is `/telemetry/v1/metrics`, from P4 `/telemetry/v1/traces` (D12). `zstd`, which the
`otlphttp` exporter offers, is rejected 415 with an explicit message naming the accepted set — it
is not silently swallowed.

#### The `type ∈ {1,2}` invariant, re-derived (R2)

The old version of this section told the schema work-stream that `type = 0` can never occur
"because this gateway does not expose `/loki/api/v1/push`". Under D17 that premise is gone: the
Loki push route exists, gigapipe's Loki push route is the one we write to, and `08-schema-changes.md`
S13/§13 and `10-ops-retention-billing.md` D10 build the per-signal conditional-TTL totality
argument on it. The invariant survives, but it has to be stated as a property of **our writer**
rather than of a missing route.

Verified in this pass, `writer/utils/unmarshal/unmarshal.go`. A Loki entry's type is computed
positionally: index 1 (the line) sets `SAMPLE_TYPE_LOG = 1`, index 2 (a JSON *number*) sets
`SAMPLE_TYPE_METRIC = 2`, and `if tp == 3 { tp = 0 }` (`:163`, and `:225` for the object form
with both `line` and `value`). **`type = 0` is reachable only from an entry that carries a line
and a numeric value in the same tuple.**

So the invariant is:

> **I-TYPE.** No customer-authored Loki entry is ever forwarded verbatim. `pushLogs`
> (`05-logs.md` §4.4) is the only writer of a Loki body in this system and it emits strictly
> two-element `["<ns>", "<line>"]` entries. Therefore every row it writes has `type = 1`, and
> `type = 2` comes only from the metrics paths.

That is a stronger guarantee than the old one — it holds even if someone later adds an Influx or
Datadog route — but it is an *invariant on code*, not on a route table, so it needs a test that
the old formulation did not: a unit assertion that `pushLogs`' serialised body contains no
three-element value tuple and no `"value"` key, plus the monitored `count() WHERE type = 0`
assertion `08` already specifies. Both are listed in Test requirements.

#### Explicitly not exposed in P1

| Not exposed | Why |
|---|---|
| **Forwarding a client's Loki body to gigapipe's `/loki/api/v1/push`** (`writer/router/insert.go:9`) | Not the route — the *pass-through*. gigapipe's Loki JSON decoder is the one path that can emit `type = 0` samples (`unmarshal.go:163,225`), and it is also the path with no attribute-to-label discipline at all. `05-logs.md` D2/D3's reconstruction is what keeps both problems out. A customer-supplied `["<ns>","<line>",<value>]` tuple arriving at `/telemetry/loki/api/v1/push` is decoded, its numeric value discarded, and re-emitted as a two-element entry. **This replaces the previous "the route is not exposed" formulation** (R2); the route exists from P3. |
| `/influx/api/v2/write`, `/api/v2/series`, `/api/v2/logs`, `/cf/v1/insert` (`insert.go:10-13`) | Datadog/Influx/Cloudflare ingest. Each is a distinct rewrite surface with its own attribute model. No demand, unbounded work. |
| `/tempo/spans`, `/api/v2/spans` (Zipkin JSON, `writer/router/tempo.go:9,11`) | Zipkin's flat tag model has no resource concept, so the tenancy stamp would have to go on every span's tags. Rejected for P1. |
| `/v1development/profiles` (`writer/router/profile.go:12`) | Continuous profiling is out of scope, and the profiles table family gets no TTL and no rotation at all (ops work-stream). |
| **OTLP/gRPC** | gigapipe multiplexes the OTLP/gRPC receiver onto the same `PORT` as OTLP/HTTP with **no way to disable it** (`gigapipe/docs/otlp-grpc.md:5-13`), using cleartext HTTP/2 prior-knowledge. We are not proxying it: an HTTP/1.1 hop silently breaks gRPC while leaving OTLP/HTTP working. This is load-bearing for decision #1 — **the compose template must not publish gigapipe's port**, because the gRPC receiver is on it whether we want it or not. |

The GET probe: Prometheus does not probe, but Grafana Agent and some remote-write UIs do a `GET`
against the write URL. gigapipe registers the probe only at `/prom/remote/write` (`prom.go:14`),
**not** at `/api/v1/prom/remote/write`. Rather than forward, we answer `200 "OK"` locally: it
costs nothing and it means a probe does not require gigapipe to be up.

---

### 2. Authentication

#### 2.1 `ClientType.telemetry`

```prisma
// packages/db/prisma/schema.prisma:353-357
enum ClientType {
  read
  write
  root
  telemetry   // new
}
```

A Prisma enum add is `ALTER TYPE "ClientType" ADD VALUE 'telemetry'`. Nine such migrations
already exist in this repo, so the pattern is established — but note two things that matter at
3am: **it is irreversible in PostgreSQL** and it **cannot run in a transaction with other DDL**.
The deploy sequence is therefore: migration and API build ship together or the API ships first;
a rollback to a build without `telemetry` is only safe while no `clients` row holds that value,
because the older code's `z.enum(['read','write','root'])` (`manage.controller.ts:34-38`) and the
older generated Prisma enum will meet an unknown variant on read. Client creation with
`type: 'telemetry'` is therefore gated on `TELEMETRY_ENABLED`, so a rolled-back deploy cannot
have left rows behind.

**Adding an enum value is a fail-open change, and three existing validators are deny-lists.**
Each must be inverted to an allow-list in the *same* PR, or `telemetry` silently inherits those
surfaces:

| File | Today | Must become |
|---|---|---|
| `apps/api/src/utils/auth.ts:202-204` (`validateExportRequest`, spans `:178-211`) | `if (client.type === ClientType.write) throw` | `if (client.type !== ClientType.read && client.type !== ClientType.root) throw` |
| `apps/api/src/utils/auth.ts:237-239` (`validateImportRequest`, spans `:213-246`) | same shape | same shape |
| `packages/mcp/src/auth.ts:99-104` | `if (client.type === ClientType.write) throw` | allow-list `read`/`root` |

`validateExportRequest` guards **four** surfaces, not three: `/export` (`export.router.ts:20`)
and **the Insights API** (`apps/api/src/routes/insights.router.ts:52`, an inline `preHandler`).
So the allow-list must live *inside* `validateExportRequest`, not be duplicated at call sites.

Why the inversion is not abstract: `apps/api/src/controllers/export.controller.ts:26-34` gates
cross-project access on `request.client?.type === ClientType.read`. A `telemetry`-typed client
falls through that check, so a forgotten inversion means an ingest credential can export **any
project in the organization**.

`validateManageRequest` (`auth.ts:272-274`) is already an allow-list (`!== ClientType.root`) and
needs no change.

Write surfaces that must learn the new value — four, not two:

- `zCreateClient` (`apps/api/src/controllers/manage.controller.ts:34-38`)
- tRPC `client.create` input (`packages/trpc/src/routers/client.ts:58`)
- the dashboard create-client form (`apps/start/src/modals/add-client.tsx:24`)
- the success panel's prop type (`apps/start/src/components/clients/create-client-success.tsx:8`)

Without the last two there is **no UI path to mint a telemetry token** and P1 ships a credential
obtainable only by hand-calling the Manage API. Both mint a `sec_`-prefixed secret and hash it
(`manage.controller.ts:314-324`, `client.ts:70-77`); `client.create` already gates on
`requireOrganizationAdmin` (`client.ts:64-68`), which is the right tier for an ingest credential.

#### 2.2 `validateTelemetryRequest`

Lives in `apps/api/src/telemetry/auth.ts`, **not** in `apps/api/src/utils/auth.ts` (D9). It is
modelled on `validateExportRequest` (`utils/auth.ts:178-211`) — header-only, secret required —
and deliberately shares nothing with `validateSdkRequest`.

```ts
// apps/api/src/telemetry/auth.ts
import { createHash } from 'node:crypto';
import { verifyPassword } from '@openpanel/common/server';
import { LRUCache, getRedisCache } from '@openpanel/redis';
import type { RawRequestDefaultExpression } from 'fastify';
import { ClientType, getClientByIdCached, type IServiceClientWithProject } from './deps';
import { assertProjectLabelValue } from './labels';

// 01-tenancy-and-security.md §1.2. Not a UUID test - see D13.
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

// D21 / 01-tenancy-and-security.md §6.1. The KEY is the client id alone; the
// stored hash and the presented digest live in the VALUE. Keying on the
// presented secret - which the previous draft of this section did, and which
// packages/mcp/src/auth.ts:106-108 and 05-logs.md §4.2 still do - makes the
// entry unaddressable at rotation time: nothing can reconstruct the key
// without the OLD plaintext, so nothing can clear it, and the old secret keeps
// hitting its own warm entry for the full TTL.
//
// The one deliberate deviation from 01 §6.1: it calls getCache(), whose L1 is a
// single 5000-entry process-global LRU shared with /track and /mcp
// (packages/redis/cachable.ts:11-14) and which caches `false` unconditionally
// (`:55`), so a wrong-secret flood would evict /track's own auth results. We
// keep 01's key and value shape and run our own LRU. Same key string, so
// clearTelemetryAuth() from either side clears the Redis tier for both.
type VerifyEntry = { hash: string; digest: string };
const VERIFY_TTL_SEC = 60;
const verifyCache = new LRUCache<string, VerifyEntry>({
  max: 2000,
  ttl: VERIFY_TTL_SEC * 1000,
});

const FAIL_WINDOW_SEC = 300;
const FAIL_THRESHOLD = 20;

export class TelemetryAuthError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, status = 401, reason = 'unauthenticated') {
    super(message);
    this.name = 'TelemetryAuthError';
    this.status = status;
    this.reason = reason;
  }
}

const secretHash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex').slice(0, 16);

export async function validateTelemetryRequest(
  headers: RawRequestDefaultExpression['headers'],
  trustedIp: string,
): Promise<IServiceClientWithProject & { projectId: string }> {
  const clientId = headers['openpanel-client-id'] as string | undefined;
  const clientSecret = (headers['openpanel-client-secret'] as string) || '';

  if (!clientId) throw new TelemetryAuthError('Telemetry: missing client id');
  if (!clientSecret) throw new TelemetryAuthError('Telemetry: missing client secret');

  const client = await getClientByIdCached(clientId);
  if (!client) throw new TelemetryAuthError('Telemetry: invalid client id');

  // Allow-list. read/write/root credentials are handed out far more freely and
  // must never be able to write telemetry.
  if (client.type !== ClientType.telemetry) {
    throw new TelemetryAuthError(
      'Telemetry: client is not a telemetry client', 403, 'wrong_client_type',
    );
  }
  if (!client.secret) throw new TelemetryAuthError('Telemetry: client has no secret');
  if (!client.projectId) {
    throw new TelemetryAuthError('Telemetry: client has no project', 403, 'no_project');
  }

  // D13. Per-request, because the value is per-request. A boot assertion cannot
  // see it. Project ids are user-derived slugs, not UUIDs.
  if (!PROJECT_ID_RE.test(client.projectId)) {
    throw new TelemetryAuthError(
      'Telemetry: project is not eligible for telemetry ingest',
      403, 'invalid_project_id',
    );
  }

  const presented = secretHash(clientSecret);
  const key = telemetryAuthKey(clientId);           // `telemetry:auth:${clientId}`
  const redis = getRedisCache();

  // A hit is only a hit when BOTH the stored hash and the presented digest
  // match. A rotated secret changes client.secret, so the entry is stale and we
  // fall through to argon2; a different wrong secret presented against a warm
  // entry does not match `digest`, so it can never ride someone else's success.
  const cached =
    verifyCache.get(key) ??
    (JSON.parse((await redis.get(key)) || 'null') as VerifyEntry | null);
  if (cached && cached.hash === client.secret && cached.digest === presented) {
    verifyCache.set(key, cached);
    return client as never;
  }
  if (cached) verifyCache.delete(key);

  // Lockout BEFORE argon2. verifyPassword is deliberately expensive and runs on
  // the event loop that also serves /track; a wrong secret must cost a Redis
  // read, not a KDF. Two counters: per client id and per trusted IP.
  const failKeys = [
    `telemetry:authfail:c:${clientId}`,
    `telemetry:authfail:i:${trustedIp}`,
  ];
  const fails = await redis.mget(failKeys);
  if (fails.some((n) => Number(n) >= FAIL_THRESHOLD)) {
    throw new TelemetryAuthError(
      'Telemetry: too many failed authentication attempts', 429, 'auth_lockout',
    );
  }

  const ok = await verifyPassword(clientSecret, client.secret);
  if (!ok) {
    const pipe = redis.pipeline();
    for (const k of failKeys) pipe.incr(k).expire(k, FAIL_WINDOW_SEC);
    pipe.exec().catch(() => undefined);
    throw new TelemetryAuthError('Telemetry: invalid client secret');
  }

  // Only successes are cached. A negative result never enters either tier.
  const entry: VerifyEntry = { hash: client.secret, digest: presented };
  verifyCache.set(key, entry);
  redis.setex(key, VERIFY_TTL_SEC, JSON.stringify(entry)).catch(() => undefined);
  return client as never;
}

/**
 * Called by every path that deletes a client or changes its secret:
 * manage.controller.ts:327,368,394 and tRPC client.remove / client.update.
 * Deletes the Redis tier immediately; other replicas' LRU expires within
 * VERIFY_TTL_SEC, which is what makes 60 s the published number.
 */
export async function clearTelemetryAuth(clientId: string) {
  verifyCache.delete(telemetryAuthKey(clientId));
  await getRedisCache().del(telemetryAuthKey(clientId));
}
```

Notes that matter:

- **No secret material in a Redis key, and the key is addressable.** Verified again in this
  pass: `validateSdkRequest` builds
  `` `client:auth:${clientId}:${Buffer.from(clientSecret).toString('base64')}` ``
  (`apps/api/src/utils/auth.ts:163-169`) — reversible plaintext, in a key name that appears in
  `SCAN`, `MONITOR`, the slowlog and any RDB dump. `packages/mcp/src/auth.ts:106` hashes it,
  which fixes the disclosure but not the addressability. D21 fixes both: the key is
  `telemetry:auth:${clientId}` and the digest is in the value.
- **`11-testing-strategy.md` A17's `client:authv2:` migration is owned here, and it is a
  prerequisite rather than a test.** 11 assigns it to "the ingest work-stream" and the previous
  version of this document never touched `validateSdkRequest`, so it was unowned. It is adopted:
  this work-stream is already editing `apps/api/src/utils/auth.ts` for the three allow-list
  inversions (§2.1), and the change is to build the existing SDK cache key as
  `` `client:authv2:${clientId}` `` with `{hash, digest}` in the value — the same shape as D21,
  under a **new prefix** so old and new coexist and a deploy does not invalidate every cached
  verification at once. Costed in P1a at 0.5 d. It does not change `validateSdkRequest`'s
  semantics and telemetry does not use it; it removes a plaintext credential from the keyspace of
  the surface that has by far the most of them.
- **Nothing is read from the body.** `validateSdkRequest` pulls credentials out of `req.body`
  with ramda `path` (`auth.ts:51-56`). Our body is a protobuf `Buffer`.
- **No `project.cors`, no `ignoreCorsAndSecret`, no IP/profile filters.** Those are browser-SDK
  concepts. `client.project.filters` is not consulted.
- **The client id is not required to be a UUID.** The draft's `UUID_V4` regex was a cheap
  pre-filter, but `Client.id` has no format guarantee in the schema and rejecting on shape would
  be a second, undocumented validity rule. The lockout counter is what makes a bad id cheap.

##### Revocation SLA — one number, ≤ 60 s, and the one-line fix it depends on

**The published number is ≤ 60 s for both client deletion and secret rotation.** It is stated
here, once; `01-tenancy-and-security.md` §6.1's table, `05-logs.md` (which currently publishes
5 minutes) and `11-testing-strategy.md` A18 should cite this row rather than restate it. The
number is only true if the two fixes below ship, so they are P1a deliverables and not
observations.

`getClientByIdCached = cacheable(getClientById, 60 * 5)`
(`packages/db/src/services/clients.service.ts:37`). `cachedFn.clear()`
(`packages/redis/cachable.ts:275-279`) deletes the Redis key **and the local LRU only**; the
file's own comment (`:155`, `:233`) says other nodes may serve stale from their 60 s L1 for that
long.

The REST manage path clears on create/update/delete (`manage.controller.ts:327`, `:368`, `:394`).
**The dashboard path does not.** `client.remove` (`packages/trpc/src/routers/client.ts:86-114`)
calls `db.client.delete(...)` at `:109` and returns. So today, deleting a telemetry token in the
UI leaves it valid for the full 300 s Redis TTL, plus up to 60 s of L1 on other replicas — a
**360 s worst case**, not 60 s.

**P1a deliverable 1 — owner: this work-stream, file owned by tenancy.** Add
`await getClientByIdCached.clear(input.id)` to `client.remove`, next to the existing
`db.client.delete`. One line. Without it the docs must say 360 s. This is the finding
`01-tenancy-and-security.md` §6.1's revocation table does not have and should absorb: 01 reasons
correctly about the *verification* cache and assumes the *client-record* cache is cleared on
delete, which is true for `manage.controller.ts` and false for the dashboard.

**P1a deliverable 2 — owner: this work-stream.** Call `clearTelemetryAuth(input.id)` from the
same three `manage.controller.ts` sites (`:327`, `:368`, `:394`) and from tRPC `client.remove`
and `client.update`. Without it a rotated secret is honoured for the Redis TTL on every replica.

Two related facts, both verified:

- Creating a client needs no `clear()`. `cacheable`'s `shouldCache` returns `false` for `null`
  (`cachable.ts:116-120`), so a lookup miss is never cached and a brand-new id is never negative-cached.
- **The old claim that the verify cache needs no invalidation was wrong, and it is corrected
  here.** The previous text said "it is keyed on the secret hash, so a rotated secret misses it".
  The *new* secret misses; the **old** secret hits its own entry and is granted for the full TTL,
  which is exactly the case rotation exists to close. Under D21 the entry is addressable and
  `clearTelemetryAuth` clears it. What remains true is the second half: a *deleted* client is
  rejected at the `getClientByIdCached` lookup, before the verify cache is consulted, so
  deletion is bounded by that cache and not by this one.

**There is no secret rotation in the product.** `zUpdateClient` (`manage.controller.ts:40-42`)
and tRPC `client.update` change only `name`. Rotation therefore means delete-and-recreate, and
the docs say so. Adding `client.rotateSecret` is **routed to the tenancy work-stream, not done
here** — it touches the shared client CRUD surface that three other client types use, and the
gateway's correctness does not depend on it.

#### 2.3 Timing

Auth runs in **`onRequest`**, before Fastify parses the body. That is not a style preference:
Fastify materialises the body between `onRequest` and `preValidation`, so authenticating in
`preHandler` (as `/track` and `/export` do) would let an unauthenticated caller make the process
allocate a full-size `Buffer` first. The admission `Content-Length` gate runs in the same phase,
before auth, so an oversize declared body is 413'd without a DB or Redis read.

---

### 3. The project label value

This is the correction that most changes the draft. **`Project.id` is not a UUID.**

| Claim | Reality |
|---|---|
| `@default(dbgenerated("gen_random_uuid()"))` at `schema.prisma:258` | Dead code. No application path relies on it. |
| Actual value | `slug(name)` via `getId('project', name)` — `manage.controller.ts:110`, `packages/trpc/src/routers/project.ts:175`, `packages/trpc/src/routers/onboarding.ts:113`; `packages/db/src/services/id.service.ts:9`; `packages/common/src/slug.ts:17` (slugify `{lower:true, strict:true}`), with a `-NNNN` suffix appended on collision |
| Length bound | **None.** `zCreateProject.name` is `z.string().min(1)` (`manage.controller.ts:16`); `zOnboardingProject.project` is `z.string().min(3)` (`packages/validation/src/index.ts:384`) |

Three concrete failure modes, all verified in gigapipe:

1. **Truncation asymmetry.** `sanitizeLabels` (`writer/utils/unmarshal/unmarshal.go:272-282`)
   rewrites any label *value* over 100 bytes to `value[:100] + "..."` — on the **remote-write**
   path only. OTLP values go through `SanitizeValue` with no length bound. A project whose id
   exceeds 100 characters would have its tenancy label silently rewritten on remote-write and
   left intact on OTLP, splitting one tenant across two label values so the read path's mandatory
   matcher misses half its data.
2. **Cross-tenant conflation.** Two projects whose slugs share their first 100 characters collapse
   to the *same* truncated `op_project_id` on remote-write. That is a breach of exactly the
   boundary decision #2 exists to enforce.
3. **The empty slug.** `slug('***')` is `''`. `op_project_id=""` in PromQL is indistinguishable
   from "label absent", i.e. it matches every other tenant's series.

**Resolution.** The tenancy work-stream already specifies the right rule
(`01-tenancy-and-security.md` §1.2): charset `^[a-zA-Z0-9_-]{1,100}$`, enforced as a
**precondition at enablement time** with `assertProjectLabelValue` as the fail-closed backstop.
This gateway implements the per-request half of it (D13, the `PROJECT_ID_RE` test in
`validateTelemetryRequest`) and emits
`op_telemetry_rejected_total{reason="invalid_project_id"}` so an ineligible project is visible
rather than mysterious.

Two things to route out (see [Interfaces](#interfaces)):

- **To tenancy:** `01-tenancy-and-security.md:355` states "The value is `Project.id` verbatim —
  `gen_random_uuid()`". That sentence is wrong and should be replaced with the provenance above.
  The three constraints it derives from it are still correct and still needed.
- **To tenancy / product:** add a `.max()` to `zCreateProject.name` and `zOnboardingProject.project`
  so new project ids cannot exceed the bound. Existing over-long projects stay ineligible for
  telemetry until renamed, and the 403 message says so.

**A derived fixed-width token** (stamp `sha256(project.id).slice(0,32)` and keep the mapping in
Postgres) was considered and rejected for P1: it removes the length, emptiness and asymmetry
problems in one move, but it makes every stored series unreadable without a Postgres join, breaks
the "paste the project id into a PromQL matcher" debugging path the read-path spec relies on, and
would have to be decided *before* any telemetry is written because `op_project_id` participates
in gigapipe's series fingerprint (`unmarshal.go:250-270`) and cannot be rewritten in place. If
the precondition proves unworkable in practice, this is the fallback and it must be taken before
the flag is turned on, never after.

---

### 4. Wind-down, subscription gating, and the kill switch

`subscriptionHook` (`apps/api/src/hooks/subscription.hook.ts:28-79`) transfers as-is in
mechanism: it reads only `req.client?.projectId`, no-ops when `SELF_HOSTED === 'true'`, and
answers `202 {blocked:true}` for `windDownStep ∈ {blocked, final_warning}`. Three adjustments:

1. Its `FastifyRequest<{ Body: ITrackHandlerPayload | DeprecatedPostEventPayload }>` type
   parameter must be widened (it never reads the body).
2. **`202` is wrong for telemetry.** The comment at `subscription.hook.ts:19-23` explains that
   202 exists because the OpenPanel SDKs retry everything but 401/2xx. OTLP and remote-write
   clients are the opposite: a 2xx means "delivered, drop it", so 202 would silently discard a
   blocked org's telemetry with no client-side signal. Telemetry answers **403** with a
   `google.rpc.Status` body. OTel exporters treat 403 as permanent and stop retrying, and it
   shows up in the customer's own exporter metrics.

**Settling the four statuses (R9).** The document set currently answers a wind-down-blocked
telemetry ingest four different ways: **403** here, in `01`'s "What the user sees" table and in
`10` D15; **200 with `partialSuccess`** for OTLP and **204 + `X-OP-Blocked`** for Loki in `05`
§4.3; **202-and-drop** in `06` §4.1 step 0; and **429 + `Retry-After`** in `11` A15, described
there as a deliberate divergence. This document owns the gateway's error semantics, so it
decides: **403**, on every route, for every signal.

- `05`'s 200/204 is the one option that is not defensible, and `05` D13 argues against it itself
  two decisions later: a 2xx makes a blocked org look healthy to its own collector while its data
  is discarded. `06`'s 202 is the same failure wearing a different number.
- 429 is defensible and `11` A15's reasoning — back off, keep the data, deliver it if the block
  lifts — is a real argument. It loses on one verified fact: Prometheus's `remote_write`
  `queue_config` sets `retry_on_http_429: false` by **default** (§9.2), so on
  `/telemetry/api/v1/write` a 429 is *dropped* and counted in
  `prometheus_remote_storage_samples_dropped_total`. A status whose whole purpose is "preserve
  the data" that silently discards it on one of the two P1 routes is worse than the honest 403.
  The second argument is duration: wind-down is measured in days, and no exporter queue survives
  that, so 429's preservation is theoretical while its retry traffic is not.
- 403 is permanent in the OTLP retry table, stops the retries, and appears in the customer's own
  exporter error metrics — which is where they will notice, because the OpenPanel UI they would
  otherwise notice it in is the one the wind-down has locked them out of.

`11` A15, `05` §4.3 and `06` §4.1 step 0 change to 403. The 429s in §11.1 stay: rate limit, quota
and auth lockout are genuinely transient and are not wind-down.
3. `apps/api/src/hooks/subscription.hook.test.ts` exists and must be updated when the hook gains
   a status parameter.

Prefer parameterising the shared hook (`subscriptionHook({ blockedStatus, blockedBody })`) so
there is one wind-down predicate rather than a copy.

#### The per-project kill switch

`TELEMETRY_ENABLED` is read at plugin-register time, so flipping it needs a process restart —
which restarts `/track` for everyone. The circuit breaker only reacts to *upstream* health. When
one tenant is melting the shared ClickHouse instance there is otherwise no lever. So the
`quotaHook` — which already does one cached Redis read — also checks:

**One namespace, one polarity, four keys (D20).** `telemetry:disabled:{surface}:{scope}`.
Presence of a key means *disabled* — a positive signal read from Redis, never inferred from an
absence. The full table, with operator commands, belongs in `10-ops-retention-billing.md` §10.3,
which is the document an on-call engineer opens; it is reproduced here because this document
defines two of the four keys.

| Key | Effect | TTL | Owner |
|---|---|---|---|
| `telemetry:disabled:ingest:*` | every `/telemetry/*` route → 503 + `Retry-After: 900`, `reason="global_disabled"` | **none** | this document |
| `telemetry:disabled:ingest:{projectId}` | that project's ingest → 503 + `Retry-After: 900`, `reason="project_disabled"` | **mandatory** (support tooling sets 1 h, max 24 h) | this document |
| `telemetry:disabled:read:*` | every `observability.*` procedure returns its empty shape with `status.degraded = 'disabled'` | **none** | `04-read-path.md` |
| `telemetry:disabled:read:{projectId}` | same, one project | **mandatory** | `04-read-path.md` |

Three reconciliations, all of which replace something (R7):

- **The read/ingest split is `04-read-path.md` D15's and it is right.** A read-path enforcement
  bug must not stop correctly-stamped ingest; a tenant melting ClickHouse with writes must not
  cost every other tenant their dashboards. `04`'s key names (`op:gp:off`, `op:gp:off:<projectId>`)
  are replaced by the shape above, because `10` §10.3 already writes the `telemetry:disabled:`
  prefix and one prefix beats two.
- **The TTL split resolves the direct contradiction** between this document ("a mandatory TTL, so
  an emergency block expires rather than being forgotten") and `04` D15 ("no TTL — a brake that
  un-pulls itself at 3 a.m. is not a brake"). Both are right about different keys. A per-project
  block is an emergency lever pulled at speed against one tenant and forgotten by Tuesday; the
  global block is a deliberate operator decision that must survive the night.
- **`01-tenancy-and-security.md` §11's `telemetry:ingest:enabled` / `telemetry:read:enabled` and
  `06-traces-and-correlation.md` §15's `GIGAPIPE_TRACES_READ_ENABLED` /
  `GIGAPIPE_TRACES_INGEST_ENABLED` are deleted.** 01's keys have the opposite polarity — a value
  means *enabled*, so a Redis flush disables the feature — and 06's are env vars, which need a
  restart of the process that also serves `/track`.

503 rather than 403 on all four because a kill switch must be recoverable and exporters must back
off rather than drop. That is the opposite choice from wind-down above, deliberately: wind-down is
a state the *customer* must act on, a kill switch is a state *we* must act on.

#### Redis failure policy, stated per check

The draft committed to two contradictory policies for the same dependency. Resolved:

| Check | Redis error | Why |
|---|---|---|
| wind-down / subscription | **fail open** | Inherited verbatim from `subscription.hook.ts:65-72`: "Dropping a paying customer's events because Redis or Postgres hiccuped is far worse." |
| kill switch | **fail open** | "Disabled" must be a *positive* signal read from Redis, never inferred from the absence of one. |
| cardinality recording | **fail open**, fire-and-forget | It is observation only in P1 (D8). |
| metering | **fail open**, fire-and-forget | Losing a counter is a billing annoyance; losing telemetry is an outage. |
| auth verify cache | **fail closed on the KDF path only** | A Redis error skips the cache and runs `verifyPassword`; it never grants access. |
| failed-auth lockout | **fail open** | An unavailable counter is not evidence of abuse. The argon2 cost is then the only brake, which is the pre-Redis status quo. |

The invariant, worth writing in the code: **every fail-closed decision must be justified by a
value successfully read from Redis.** A Redis outage never changes admission for a project that
is under budget and not disabled, and there is a test for exactly that.

---

### 5. Fastify wiring, hook order, body handling, bundling

#### 5.1 Hook order actually executed

Root hooks, from `apps/api/src/app.ts:130-133`:

```
onRequest : requestIdHook   (app.ts:130)  → sets request-id header from req.id
onRequest : timestampHook   (app.ts:131)  → request.timestamp = Date.now()
onRequest : ipHook          (app.ts:132)  → request.clientIp / clientIpHeader
onResponse: requestLoggingHook (app.ts:133)
```

All three are cheap and useful: `request.timestamp` gives the gateway its own latency number
without a second `Date.now()`, and `request.clientIp` is what the lockout counter and the auth
failure log key on. Nothing in them touches the body.

Then, inside `telemetryRouter` (an encapsulated plugin, so all of this is scoped):

```
 1. await fastify.register(import('@fastify/rate-limit'), {...})   // its own onRequest hook
 2. addContentTypeParser('application/x-protobuf', {parseAs:'buffer'}, passthrough)
 3. addHook('onRequest',     shutdownHook)      // isShuttingDown() → 503 + Retry-After
 4. addHook('onRequest',     contentGate)       // Content-Type / Content-Encoding / Content-Length → 415 or 413
 5. addHook('onRequest',     admissionHook)     // in-flight counter; 503 when full
 6. addHook('onRequest',     telemetryAuthHook) // validateTelemetryRequest
 7. addHook('onRequest',     windDownHook)      // wind-down + kill switch
 8. addHook('preValidation', decompressHook)    // gzip/deflate/snappy, decompressed-size cap
 9. addHook('onResponse',    releaseAdmission)
10. addHook('onRequestAbort',releaseAdmission)
11. addHook('onTimeout',     releaseAdmission)
12. setErrorHandler(telemetryErrorHandler)      // D11
13. route(...)                                  // each with schema:{hide:true}, bodyLimit
```

Order 1-before-3 is forced: `@fastify/rate-limit` installs its hook at *register* time, so
anything registered after it runs after it. That matches `export.router.ts:16` and
`insights.router.ts:48`. It also means the rate limiter cannot see `req.client` — see §8.

Two corrections to the draft's mechanism, both about Fastify's scoping rules:

- **Content-type parsers are per-encapsulation-context, not per-route.** Registering a JSON
  parser here would apply to all three OTLP routes, so D12's 415 could never have been enforced
  by parser registration. It is enforced in `contentGate`, an explicit `onRequest` check. (Moot
  in P1 since JSON is rejected everywhere, but the mechanism note stays because P6 may revisit it
  and would need a *nested* plugin scoped to the metrics route.)
- **Decompression is a `preValidation` hook**, which is a phase that actually exists in the
  executed order. The draft said `preValidation` in prose while its hook list ended at
  `onRequest`.

#### 5.2 Content-type parser and body limits

Fastify has no built-in `application/x-protobuf` parser, and its default JSON parser would try to
`JSON.parse` a protobuf buffer. The parser is registered *inside* the plugin so it does not leak
to `/track`:

```ts
// apps/api/src/telemetry/plugin.ts
const PROTO = 'application/x-protobuf';

// NOTE: deliberately NO bodyLimit here. A content-type parser that declares its
// own bodyLimit takes precedence over the route's, which would silently make
// the tighter 2 MiB remote-write cap dead and give every route 8 MiB.
// UNVERIFIED: node_modules is absent, so Fastify 5's contentTypeParser.js could
// not be read. Settle it with the inject test in "Test requirements" #7 before
// relying on either cap; until then the Content-Length gate below is the cap
// that is actually written down.
fastify.addContentTypeParser(
  PROTO,
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),   // raw Buffer, decompressed later
);
```

Size is therefore bounded in three places, deliberately redundant:

| Bound | Where | Value |
|---|---|---|
| declared `Content-Length` | `contentGate` (`onRequest`), before a byte is read | per-route `MAX_COMPRESSED_BYTES` |
| actual received bytes | per-route `bodyLimit` on `fastify.route({...})` | same |
| decompressed bytes | `decompressHook` (`preValidation`) | `TELEMETRY_MAX_DECOMPRESSED_BYTES` |

`Fastify({ bodyLimit: 1_048_576 * 500 })` at `apps/api/src/app.ts:88` is a **500 MB** global
limit. That is fine for the importer and far too much for an endpoint anyone with a token can
POST to.

```ts
const COMPRESSED_LIMIT = {
  '/v1/metrics': MAX_COMPRESSED_BYTES,            // 8 MiB, TELEMETRY_MAX_COMPRESSED_BYTES
  '/v1/logs':    MAX_COMPRESSED_BYTES,
  '/v1/traces':  MAX_COMPRESSED_BYTES,
  '/api/v1/write': MAX_COMPRESSED_BYTES_REMOTE_WRITE, // 2 MiB, own env var
} as const;
```

Remote-write gets its own env var (`TELEMETRY_MAX_COMPRESSED_BYTES_REMOTE_WRITE`) because snappy
typically achieves 3-5× on remote-write payloads and gigapipe's own decompressed cap on that path
is 10 MiB (`middleware.go:122-125`); 8 MiB of snappy would blow past it and turn a clean local
413 into a wasted round trip and an upstream 400.

#### 5.3 Decompression

```ts
// apps/api/src/telemetry/decompress.ts
import { gunzip, gunzipSync, inflate, inflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import { HttpError } from '@/utils/errors';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

export const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;               // TELEMETRY_MAX_COMPRESSED_BYTES
export const MAX_COMPRESSED_BYTES_REMOTE_WRITE = 2 * 1024 * 1024;  // ..._REMOTE_WRITE
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;            // TELEMETRY_MAX_DECOMPRESSED_BYTES
export const MAX_RATIO = 100;                                      // TELEMETRY_MAX_DECOMPRESS_RATIO
const SYNC_FAST_PATH = 256 * 1024;                                 // TELEMETRY_SYNC_INFLATE_MAX

function assertBounds(out: Buffer, inLen: number): Buffer {
  if (out.length > MAX_DECOMPRESSED_BYTES) {
    throw new HttpError('Decompressed body too large', { status: 413 });
  }
  if (inLen > 0 && out.length / inLen > MAX_RATIO) {
    throw new HttpError('Decompression ratio exceeded', { status: 413 });
  }
  return out;
}

/** OTLP routes: absent | identity | gzip | deflate. Nothing else. */
export async function decompressOtlp(buf: Buffer, enc: string | undefined): Promise<Buffer> {
  const e = (enc ?? '').toLowerCase().trim();
  if (e === '' || e === 'identity') return assertBounds(buf, buf.length);
  if (e !== 'gzip' && e !== 'deflate') {
    throw new HttpError(
      `Unsupported Content-Encoding: ${e}. Accepted: identity, gzip, deflate`,
      { status: 415 },
    );
  }
  const opts = { maxOutputLength: MAX_DECOMPRESSED_BYTES }; // zlib throws ERR_BUFFER_TOO_LARGE
  // Small bodies inflate synchronously: the async round trip costs more than
  // the work. Anything larger goes to the threadpool so a 32 MiB batch cannot
  // block the event loop that also serves /track.
  if (buf.length <= SYNC_FAST_PATH) {
    const out = e === 'gzip' ? gunzipSync(buf, opts) : inflateSync(buf, opts);
    return assertBounds(out, buf.length);
  }
  const out = e === 'gzip'
    ? await gunzipAsync(buf, opts)
    : await inflateAsync(buf, opts);
  return assertBounds(out as Buffer, buf.length);
}

/** Remote-write: snappy raw block, REQUIRED. */
export function decompressRemoteWrite(buf: Buffer, enc: string | undefined): Buffer {
  if ((enc ?? '').toLowerCase().trim() !== 'snappy') {
    throw new HttpError(
      'Prometheus remote-write requires Content-Encoding: snappy',
      { status: 415 },
    );
  }
  // Bound BEFORE decoding, the same shape as gigapipe's middleware.go:118-125:
  // read the varint-declared output length and refuse rather than allocate.
  // node `snappy` exposes no maxOutputLength; snappyjs' uncompressedLength()
  // (or a 5-byte varint read) serves the same purpose.
  const declared = uncompressedLength(buf);
  if (declared > MAX_DECOMPRESSED_BYTES) {
    throw new HttpError('Decompressed body too large', { status: 413 });
  }
  return assertBounds(uncompressSync(buf), buf.length);
}
```

Two corrections to the draft:

- **`snappy` was missing entirely.** The draft's `decompress()` threw 415 on anything but
  gzip/deflate/identity, which would have rejected **every** Prometheus remote-write request
  before the rewrite ever ran, on a route the same document declares requires
  `Content-Encoding: snappy`.
- **"We accept a superset locally (`deflate`)" was false.** gigapipe accepts `gzip` and `snappy`
  and 400s on anything else (`middleware.go:178-200`). Our OTLP set (identity/gzip/deflate) is a
  superset in one direction and a subset in the other. There is no superset; there is a per-route
  set, and the table above is it.

**Why 32 MiB and not 64.** The draft justified 64 MiB as "matching gigapipe's own OTLP ceiling
exactly". That ceiling is `OTLPMaxMessageSize()` (`writer/controller/otlp_metrics.go:34-41`,
default `64 << 20`), and a repo-wide grep shows it is referenced in exactly two places:
`otlp_metrics.go:74` (the `/v1/metrics` HTTP handler) and `writer/grpc/server.go:111`
(`MaxRecvMsgSize`). **`/v1/logs` and `/v1/traces` have no bound at all** — logs buffer through
`withBufferedBody`'s bare `io.ReadAll(ctx.bodyReader)` (`writer/utils/unmarshal/builder.go:506`)
and traces through a bare `io.ReadAll(r.Body)` (`writer/controller/tempo.go:43`). So for two of
three signals **the gateway's cap is the only decompressed-size bound in the system**, and it
must be chosen for gigapipe's memory budget rather than aligned to a ceiling that does not exist
there. 32 MiB it is, in `decompress.ts`, in the env block and in the admission arithmetic, all
three agreeing. The metrics path additionally 413s above `OTLPMaxMessageSize()` upstream; that is
a second bound, not the design input.

#### 5.4 tsdown

`apps/api/tsdown.config.ts` bundles everything except four packages. Three new entries:

```ts
external: [
  '@hyperdx/node-opentelemetry',
  'pino',
  'pino-pretty',
  '@node-rs/argon2',
  'protobufjs',   // new — see the Long trap, §6.8
  'long',         // new
  'snappy',       // new — native addon, must not be bundled
],
```

- **`snappy`** is a native module. `@node-rs/argon2` is already external for exactly this reason
  (`tsdown.config.ts:12`), and `apps/api/Dockerfile:71` sets `npm_config_build_from_source=true`
  in the prod stage while `pnpm-workspace.yaml`'s `allowBuilds` block sets every entry to
  `false`. `UNVERIFIED:` whether `snappy@^7` ships prebuilt binaries for `linux/amd64` +
  `linux/arm64` under pnpm with build scripts disabled. Settle it by adding the dep and running
  the `apps/api` Docker build for both platforms. **If it does not resolve, the fallback is
  `snappyjs` (pure JS)**, decided before P1a ships, not discovered in CI.
- **`protobufjs` + `long`** are external because of the `Long` trap (§6.8). `protobufjs` is
  already in the lockfile at `7.4.0` (`pnpm-lock.yaml:16344`) and `long@5.2.3` at `:14514`, but
  only transitively — and under pnpm's isolated `node_modules` a transitive package is **not**
  importable from `apps/api`. Both must be *direct* dependencies of `apps/api/package.json`; a
  missing declaration is an immediate `MODULE_NOT_FOUND`, not a latent risk.

#### 5.5 Generated protobuf code checked in, not built

`pbjs`/`pbts` run at codegen time, not build time, and the output is committed:

```
apps/api/src/telemetry/proto/
  vendor/                            # verbatim .proto files, with a SOURCE.md pinning versions
    opentelemetry/proto/common/v1/common.proto
    opentelemetry/proto/resource/v1/resource.proto
    opentelemetry/proto/metrics/v1/metrics.proto
    opentelemetry/proto/logs/v1/logs.proto
    opentelemetry/proto/trace/v1/trace.proto
    opentelemetry/proto/collector/{metrics,logs,trace}/v1/*_service.proto
    google/rpc/status.proto
    prometheus/remote.proto
    prometheus/types.proto
  otlp.js      # pbjs --target static-module --wrap es6 --force-long
  otlp.d.ts    # pbts
  prompb.js
  prompb.d.ts
```

Pin `opentelemetry-proto` to **v1.11.0**, matching gigapipe's `go.opentelemetry.io/proto/otlp
v1.11.0` (`gigapipe/go.mod:51`), and `prompb` to the `prometheus/prometheus` v0.314.0 tree
(`gigapipe/go.mod:44`). A `pnpm codegen:proto` script regenerates; CI asserts the working tree is
clean after running it, which is how a proto bump gets noticed.

**Why pinned to gigapipe's version and not newer:** protobufjs discards unknown fields on decode,
so anything a client sends that our schema does not know is dropped on re-encode. Pinning *at*
gigapipe's version means we drop what gigapipe would have dropped anyway. Pinning *ahead*
preserves fields gigapipe then ignores — harmless. Pinning *behind* silently truncates. The rule
is: our proto version ≥ gigapipe's, and the bump is part of the gigapipe image bump.

**One exception, and it is real: traces.** gigapipe decodes with `google.golang.org/protobuf`,
which retains unknown fields, and the traces path re-marshals the span —
`payload, err := proto.Marshal(span)` at `writer/utils/unmarshal/otlp.go:85` — into the stored
`payload` column. So an unknown span field sent by a client on a newer OTLP than the pin
**survives into storage today** and would be destroyed by the gateway's protobufjs
decode/re-encode. "Our version ≥ gigapipe's" does not close this, because the client can be ahead
of both. We accept the loss, document it in the customer docs, and the golden-file test (Test
requirements #3) runs against a payload carrying an unknown field so the gap is *measured* rather
than assumed.

#### 5.6 A gigapipe bump is a contract change, and CI must say so

Every rule in §6 is read off gigapipe internals: `mergeSanitizedAttrs`' `;` concatenation, the
`otel_scope_` prefix, the `target_info` emission rule, the 100-character remote-write truncation,
the two sanitizers, the nil-`Resource` deref. The CI proto-cleanliness check covers the `.proto`
files and **none of that behaviour**. So:

1. The compose template and CI pin gigapipe by **image digest**, not tag (the ops work-stream
   pins `ghcr.io/metrico/gigapipe:v5.4.1`; the testing work-stream already uses
   `@sha256:<pinned>`).
2. A **contract test suite runs against a live pinned gigapipe** in CI (testing work-stream owns
   the harness): ingest a fixture through the real gateway, then assert against ClickHouse that
   the stored label set is exactly what §6 predicts — including `target_info` carrying
   `op_project_id`, the histogram fan-out count, and the remote-write 100-char truncation.
3. Bumping the digest without a green contract run is a blocked merge. That is the mechanism
   that fails loudly when a gigapipe release changes a decoder.

---

### 6. The payload rewrite

This is the security-critical section. The label name is `op_project_id`
(`TELEMETRY_PROJECT_LABEL` in `packages/constants`, but treat it as a constant — changing it
orphans all stored data because it participates in gigapipe's series fingerprint,
`writer/utils/unmarshal/unmarshal.go:250-270`).

#### 6.0 Two sanitizers, and why the strip runs on both the raw and the sanitized key

gigapipe rewrites keys before they become labels, and it does it **differently per path**:

| Path | Function | Regex | Effect on `op.project.id` |
|---|---|---|---|
| OTLP logs, OTLP metrics | `SanitizeKey` (`writer/utils/unmarshal/otlplogs.go:105-118`) | `[^a-zA-Z0-9_]` → `_`; prefix `_` if it starts with a digit | → `op_project_id` |
| remote-write, Loki push, Influx | `sanitizeLabels` (`writer/utils/unmarshal/unmarshal.go:272-282`) | `(^[^a-zA-Z_]\|[^a-zA-Z0-9_])` → `_` | → `op_project_id` |
| OTLP traces | **none** — `initAttributesMap` writes the raw key (`writer/utils/unmarshal/otlp.go:154-160`) | — | stays `op.project.id` |

So a client attribute named `op.project.id`, `op-project-id`, `op project id` or `op/project/id`
all become the label `op_project_id` on the metrics and logs paths. A naive exact-match strip on
the raw key is defeated by a hyphen.

**Rule: one predicate, used everywhere, testing the raw key *and* both sanitized forms.** The
draft's rule ("using the sanitizer that matches the destination path") produced an internal
contradiction on traces: the traces path has no sanitizer, so under a literal reading a span
attribute `op.project.id` would *not* be stripped — it starts with `op.`, not `op_` — and would
land in the trace tag index under the raw name and inside the `proto.Marshal`ed `payload`
(`otlp.go:85`), which is exactly the lie the traces strip exists to prevent. Over-stripping is
free and safe, so:

**Name and home, settled (R5).** The function is `isReservedKey(key)`, it takes **no `protocol`
parameter**, and it lives in **`packages/gigapipe/src/labels.ts`** — not
`apps/api/src/telemetry/labels.ts`, which is where the previous version of this section declared
it and which would have been a fourth location. The read path's compilers must reject exactly the
keys the gateway strips (`11-testing-strategy.md` Q3), so the predicate is shared code; the
package is `04-read-path.md` D1's, ratified here (D9). `apps/api/src/telemetry/labels.ts` remains,
holding only what is gateway-local: `stamped()`, the correlation whitelist, and the counters.

**`01-tenancy-and-security.md` §5's per-protocol form is withdrawn, and its T1.2 asserts the bug.**
01 §5 defines `isReservedKey(key, protocol)` which, for `protocol === 'otlp-traces'`, compares the
**raw** key — and 01 T1.2 asserts that `isReservedKey('op.project.id','otlp-traces')` is *false*
("keys stored verbatim"). That is precisely the case argued against above: the key would survive
into the trace tag index under its raw name and inside the `proto.Marshal`ed `payload`
(`otlp.go:85`), which is the lie the traces strip exists to prevent. 01's own comment concedes
the unconditional form "is also correct and removes the per-protocol branch; either is fine, but
they must not disagree" — they do disagree, and this is the resolution: the unconditional form,
the `protocol` parameter deleted, and 01 T1.2's traces row inverted. Over-stripping costs two
regex passes per attribute.

```ts
// packages/gigapipe/src/labels.ts
export const PROJECT_LABEL = 'op_project_id';
export const RESERVED_PREFIX = 'op_';

// gigapipe SanitizeKey — otlplogs.go:105-118
const OTLP_BAD = /[^a-zA-Z0-9_]/g;
export function sanitizeOtlpKey(key: string): string {
  const s = key.replace(OTLP_BAD, '_');
  return s.length === 0 || (s[0]! >= '0' && s[0]! <= '9') ? `_${s}` : s;
}

// gigapipe sanitizeLabels — unmarshal.go:272
const PROM_BAD = /(^[^a-zA-Z_]|[^a-zA-Z0-9_])/g;
export const sanitizePromLabel = (n: string) => n.replace(PROM_BAD, '_');

/**
 * THE strip predicate. Used for every attribute on every signal, including
 * OTLP traces, where gigapipe applies no sanitizer at all. Testing all three
 * forms costs two regex passes per attribute and removes a whole class of
 * "which sanitizer applies here" reasoning from the security boundary.
 *
 * No `protocol` parameter, and no alias table anywhere in the strip path
 * (11-testing-strategy.md E5b asserts the absence of an alias array at source
 * level). The predicate is COMPUTED.
 */
export const isReservedKey = (k: string): boolean =>
  k.startsWith(RESERVED_PREFIX) ||
  sanitizeOtlpKey(k).startsWith(RESERVED_PREFIX) ||
  sanitizePromLabel(k).startsWith(RESERVED_PREFIX);
```

##### The closed exception list inside the reserved namespace (D22)

The strip as written above deletes `op_session_id` and `op_profile_id` — the two attributes
`06-traces-and-correlation.md` T4 names as **the** correlation keys, and therefore the mechanism
behind the plan's stated differentiator. The previous version of this document, and
`01-tenancy-and-security.md` §5's `enforceLabelPairs`, both drop every reserved key
unconditionally with no restore hook. `06` §4.1 is the only place in the set that handles it, and
it does so with an explicit ordered sequence. That sequence is adopted here as a contract on
`scrubAttrs`, because `scrubAttrs` is this document's function:

```ts
// apps/api/src/telemetry/labels.ts — gateway-local, NOT in packages/gigapipe
export const CORRELATION_KEYS = ['op_session_id', 'op_profile_id'] as const;
export const TRANSPORT_MARKERS = ['op_root'] as const;             // never persisted
export const LIFTED_KEYS = ['op_exception_type', 'op_exception_message'] as const;
```

| Key | Where it may exist after the gateway | Value cap |
|---|---|---|
| `op_session_id` | span attributes, on a local root or an `op_root`-marked span only | 64 bytes |
| `op_profile_id` | same | 256 bytes |
| `op_root` | **nowhere** — a transport marker, read in step 2 and dropped | — |
| `op_exception_type` / `op_exception_message` | span attributes, written *by us* from the first `exception` span event | 256 bytes |

**The ordering is the contract:** snapshot → strip → restore. `scrubAttrs` therefore takes an
optional snapshot sink, and the traces walk (§6.3) is the only caller that passes one:

```ts
const snap = snapshotCorrelation(span);      // 1. read op_session_id/op_profile_id/op_root
span.attributes = scrubAttrs(span.attributes, c);   // 2. strip everything op_*
restoreCorrelation(span, snap, ctx);         // 3. re-attach, bounded by T17
```

Three things this list is **not**:

- It is **not** extended to metrics or logs. `06` T11 requires `op_session_id`/`op_profile_id` to
  be stripped from metric data-point attributes, metric resource attributes and log record
  attributes, and T12 requires `LogRecord.SpanId` to be zeroed, because on those two signals an
  attribute *becomes a label* and a per-session label is ~10⁵ new series/day. The two signals
  genuinely differ, and `11-testing-strategy.md` §3.2 needs the pair of rows that says so: a span
  arriving with `op_session_id` keeps it; a log record arriving with `op_session_id` loses it.
- It is **not** an escape hatch for `op_project_id`. That key is stripped from every level on
  every signal and re-stamped from the token, always, with no snapshot.
- It is **not** unbounded. `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE = 4` (`06` T17) caps the
  spans per `trace_id` per request that may carry the restored keys; the rest are counted on
  `telemetry_span_attrs_dropped_total{reason}`.

`RESERVED_PREFIX = 'op_'` costs customers the `op_*` label namespace. That is a documented
restriction, not an accident, and far cheaper to defend than an ever-growing exact-match list. It
collides with nothing in the OTel semantic conventions.

**This is now a permanent commitment, not a measurement.** `01-tenancy-and-security.md` Q6 leaves
open whether the reserved namespace should later narrow from the `op_` prefix to an exact set, and
schedules the evidence as "measure `openpanel_telemetry_ingest_stripped_total` by sanitized key
over the first 60 days of real traffic … narrow **before GA**". A 60-day window that starts when
ingest opens cannot produce an answer before the data it would protect exists, and D22 has just
added a *closed set inside* the prefix — which is the flexibility narrowing was supposed to buy,
obtained without a breaking change. **Decision: the `op_` prefix is permanent.** Q6 closes. The
counter still ships, because "which benign keys did we strip" is a good support answer, but no
decision depends on it.

The **value** is not sanitized; it is *validated* at auth time against
`^[a-zA-Z0-9_-]{1,100}$` (§3, D13). The 100-byte bound is not decorative: `sanitizeLabels`
truncates longer values on remote-write only.

#### The shared walk

All four rewrites share one attribute-list transform, which is where the structural limits (§7)
and the nil-`KeyValue` guard live:

```ts
// apps/api/src/telemetry/rewrite/attrs.ts
import { isReservedKey } from '@openpanel/gigapipe';   // packages/gigapipe/src/labels.ts
import { PROJECT_LABEL } from '@openpanel/gigapipe';
import type { Counters } from '../limits';

/**
 * Strip reserved keys, drop valueless KeyValues, apply structural limits.
 * Returns a NEW array only when something changed (the common case is a
 * no-op scan, and allocating on every element is the whole cost of §6.1).
 */
export function scrubAttrs(
  attrs: IKeyValue[] | null | undefined,
  c: Counters,
): IKeyValue[] | undefined {
  if (!attrs || attrs.length === 0) return attrs ?? undefined;
  let dirty = false;
  const out: IKeyValue[] = [];
  for (const kv of attrs) {
    // gigapipe's OTLP metrics decoder guards this (otlp_metrics.go:101-103,
    // `if kv.Value == nil { continue }`). The LOGS and TRACES decoders do not:
    // initAttributesMap (otlp.go:154-160) does kv.Value.Value with no guard, so
    // a KeyValue with an absent value nil-derefs inside gigapipe. Legal on the
    // wire, and producible by our own re-encode. Drop it here for all signals.
    if (!kv.value) { dirty = true; c.droppedNullAttr++; continue; }
    // D22: the caller has already taken the correlation snapshot if it wants
    // one. This loop strips unconditionally; restoreCorrelation() puts back the
    // closed set afterwards. Never add an exception INSIDE this loop - the
    // ordering contract is what makes the strip auditable.
    if (isReservedKey(kv.key)) { dirty = true; c.strippedReserved++; continue; }
    if (out.length >= MAX_ATTRS) { dirty = true; c.truncatedAttrs++; continue; }
    out.push(clampKeyValue(kv, c));   // MAX_KEY_LEN / MAX_VALUE_LEN, counts truncations
  }
  return dirty ? out : attrs;
}

export const stamped = (attrs: IKeyValue[] | undefined, pid: string): IKeyValue[] => [
  ...(attrs ?? []),
  { key: PROJECT_LABEL, value: { stringValue: pid } },
];
```

#### 6.1 OTLP metrics — stamp **every data point**, not just the resource

The proof, read top-down through `writer/utils/unmarshal/otlp_metrics.go`:

- `Decode` splits resource attributes: `service.name`, `service.namespace`, `service.instance.id`
  become `job`/`instance`; **everything else goes into `rs.targetAttrs`**.
- `seriesLabels` (`:239-267`) — the function that builds the stored label set — merges
  `rs.scopeLabels`, then `mergeSanitizedAttrs(merged, "", pointAttrs)` (`:245`), then `__name__`,
  `job`, `instance`, extras (`le`, `quantile`), `__metric_type__`, `__metric_help__`,
  `__metric_unit__`. **`rs.targetAttrs` is never read here.**
- `rs.targetAttrs` is used only by `emitTargetInfo` (`:495-516`), which emits a separate
  `target_info` gauge series.

So a resource attribute lands on a `target_info` series and on **nothing else**. A query
`sum(rate(http_requests_total[5m]))` scoped by `{op_project_id="…"}` would match zero series if
we only stamped the resource.

```
for each resource_metrics rm:
  ensure rm.resource exists                       (see §6.5)
  rm.resource.attributes := stamped(scrubAttrs(rm.resource.attributes))
  for each scope_metrics sm:
    if sm.scope: sm.scope.attributes := scrubAttrs(sm.scope.attributes)
       # scope attrs are prefixed "otel_scope_" by gigapipe so they can never
       # collide with op_*, but strip anyway — that prefix is gigapipe's choice
       # and could change on a version bump.
    for each metric m, for each data point dp in
        (gauge|sum|histogram|exponential_histogram|summary).data_points:
      dp.attributes := stamped(scrubAttrs(dp.attributes))
      clampTimestamp(dp)                          (see §6.9)
```

Stamping the resource *as well* is not redundant: it makes `target_info{op_project_id="…"}`
selectable, which the read path needs for resource-attribute joins, and it is what makes the
delete-by-project sweep total (every stored series, including `target_info`, carries the label —
verified: `emitTargetInfo` copies `rs.targetAttrs` into `merged` at `:499-501`).

**A consequence to state, not to fix.** `emitTargetInfo` early-returns when
`len(rs.targetAttrs) == 0` (`:496`). Stamping the resource makes `targetAttrs` non-empty for
*every* export, so **every OTLP metrics export now emits a `target_info` series** — one extra
series per `(job, instance, project)`, and a metric name that appears in the scoped `__name__`
enumeration. The tenancy work-stream already records this
(`01-tenancy-and-security.md:140-144`) and the metric picker hides `target_info` the way it hides
`op_project_id`.

**Cost.** This is O(data points) and the most expensive of the four rewrites. A 10k-point batch
means 10k array pushes. The alternative — translating OTLP metrics into remote-write on the
gateway so only one label per *series* is added — was rejected: it would reimplement OTel→Prometheus
histogram bucketization, exponential-histogram conversion and temporality handling, and would
throw away the `__metric_type__` / `__metric_help__` / `__metric_unit__` metadata gigapipe
derives (`otlp_metrics.go:257-263`).

**Free correctness win to document, not to implement:** gigapipe rejects non-cumulative
temporality outright (`checkTemporality`) and reports it in `partial_success`. The gateway does
not duplicate that — it must simply not *swallow* gigapipe's `partial_success` when relaying
(§10).

#### 6.2 OTLP logs — **withdrawn**: the payload is rebuilt, not rewritten (D17, R1)

`writer/utils/unmarshal/otlplogs.go:22-46`, per log record:

```go
resourceAttrs := map[string]string{}
if resLog.Resource != nil { e.initAttributesMap(resLog.Resource.Attributes, "", &resourceAttrs) }
...
attrsMap := make(map[string]string)
for k, v := range resourceAttrs { attrsMap[k] = v }   // resource
for k, v := range scopeAttrs    { attrsMap[k] = v }   // ← overrides resource
e.initAttributesMap(logRecord.Attributes, "", &attrsMap)  // ← overrides both
```

Last write wins, and the record is last. A client that sets `op_project_id` on a log record
overwrites a resource stamp and writes into another tenant's label space. Also worth knowing:
`level` (from `SeverityText`), `trace_id` and `span_id` are stamped **after** the merge and
genuinely do clobber any client attribute of the same name.

**But the decisive line is the next one, and it is not a tenancy problem.** Every key in
`attrsMap` becomes a stream label (`otlplogs.go:59-61`), and the label set *is* the fingerprint
(`unmarshal.go:250-270`). So a stamp-and-forward gateway is tenancy-correct and operationally
fatal: one `trace_id` is one new fingerprint — one `time_series` row and one `time_series_gin` row
**per label** per stream per day — and at 10k lines/s with trace context that is ~10k new series/s
on an instance every tenant shares. There is no configuration that disables it. `05-logs.md` D1
found this and is right; I re-read the decoder in this pass to confirm it rather than take it on
report.

**So the walk below is withdrawn.** `/telemetry/v1/logs` does not forward. It decodes, and
`05-logs.md` D2/D3's constructed label set plus JSON envelope is what reaches gigapipe, over
`/loki/api/v1/push`. The rewrite specified here is deleted from P1a's four-rewrites line item and
its cost moves to `05`'s P3.4, where the decode already exists.

<details>
<summary>The withdrawn rewrite, kept because two other documents were written against it</summary>

```
# WITHDRAWN — see D17. 01 §4.4/§4.8's logs row and 11 E12-E15 are written
# against this shape and must be retargeted to the constructed-stream model.
for each resource_logs rl:
  ensure rl.resource exists
  rl.resource.attributes := stamped(scrubAttrs(rl.resource.attributes))
  for each scope_logs sl:
    if sl.scope: sl.scope.attributes := scrubAttrs(sl.scope.attributes)
    for each log_record lr:
      lr.attributes := scrubAttrs(lr.attributes)
      clampTimestamp(lr)
```

</details>

**What the gateway still owes the logs path, and what moves.** The boundary does not disappear
with the rewrite; it moves from the strip to the writer, and that relocation is the part a naive
merge of the two documents would get wrong — applying this document's strip rules to a payload
that `05` then throws away and rebuilds enforces the boundary in a place nobody specified or
tested. Stated explicitly, so it is specified somewhere:

| Rule | Enforced by | Owner |
|---|---|---|
| `op_project_id` in the constructed label set comes from `req.client.projectId` and from nowhere else | `buildEnvelope` / the label allowlist | `05-logs.md` |
| No customer-supplied key can enter the label set — it is an **allowlist**, so `isReservedKey` is a second line and not the first | the allowlist | `05-logs.md` |
| Reserved keys are deleted from the **envelope body** too, not just the labels: the envelope is rendered in the log detail UI and a forged `op_project_id` there is the same display lie §6.3 closes for spans | envelope rule 4 | `05-logs.md`, using `isReservedKey` |
| `op_session_id` / `op_profile_id` stripped from log record attributes; `LogRecord.SpanId` zeroed | the decoder | `05-logs.md`, required by `06` T11/T12 |
| Every entry is a two-element `["<ns>","<line>"]` tuple (I-TYPE, §1) | `pushLogs` | `05-logs.md` |
| Auth, CORS deny, rate limit, lockout, admission, body caps, decompression caps, kill switch, timestamp window, metering, error redaction | **the chassis** (D23) | this document |

`11-testing-strategy.md`'s E12 — "the single highest-value test in the document" — tests a log
*record-attribute override* that does not exist under this design, and `05`'s actual enforcement
points have no test rows anywhere. That swap is the single most important consequence of R1 and it
is listed in Test requirements.

#### 6.3 OTLP traces — the resource wins, but strip everywhere anyway (P4; `06` owns the rest)

**Scope note (D18).** `/telemetry/v1/traces` opens in P4. What follows is the *tenancy* half of
the traces walk — steps 1 and 6 of `06-traces-and-correlation.md` §4.1's seven ingest-side
mutations — and it is written here because `scrubAttrs` and the stamp are this document's code.
`06` §4.1 stays authoritative for the correlation-specific steps (snapshot/restore bounds,
exception lifting, the per-trace cap) and this document does not restate them, so neither budget
carries them twice. The two documents disagreed on three numbers and §7 settles all three.

`writer/utils/unmarshal/otlp.go:79-85`:

```go
for _, span := range scope.Spans {
    span.Attributes = append(span.Attributes, res.Resource.Attributes...)  // :81
    attrsMap := map[string]string{}
    populateServiceNames(span)                                             // :83
    d.initAttributesMap(span.Attributes, "", &attrsMap)                    // :84
    payload, err := proto.Marshal(span)                                    // :85
```

Resource attributes are appended **after** the span's own, and `initAttributesMap` →
`writeAttrValue` does `(*res)[prefix+key] = …` (`otlp.go:135-151`) — last write wins. So on the
traces path the resource genuinely does win and a resource-only stamp *would* be sufficient for
the index.

We still strip at span level, and at span-event and span-link level, for two reasons: (1) the
ordering above is an implementation detail of a dependency we do not control, and (2)
`proto.Marshal(span)` at `:85` writes the whole span — attributes, events and links — into the
stored `payload` column, which the trace-detail UI renders. A span whose *event* attributes carry
a forged `op_project_id` would display exactly the lie the strip exists to prevent. It is a
display-integrity gap, not a tenancy breach, and it is free to close because the walk already
visits every attribute.

```
for each resource_spans rs:
  ensure rs.resource exists                        # ← not optional, see §6.5
  rs.resource.attributes := stamped(scrubAttrs(rs.resource.attributes))
  for each scope_spans ss:
    if ss.scope: ss.scope.attributes := scrubAttrs(ss.scope.attributes)
    for each span sp:
      snap := snapshotCorrelation(sp)              # D22 step 1 — BEFORE the strip
      sp.attributes := scrubAttrs(sp.attributes)
      for each ev in sp.events: ev.attributes := scrubAttrs(ev.attributes)
      for each ln in sp.links:  ln.attributes := scrubAttrs(ln.attributes)
      restoreCorrelation(sp, snap, ctx)            # D22 step 3 — 06 §4.1 step 2
      clampTimestamp(sp)                           # 06 §4.1 step 3
      # 06 §4.1 steps 4 (lift exceptions) and 5 (per-span caps) run here, owned
      # by 06 and costed in its P4. Step 6 (strip X-CH-DSN / X-Ttl-Days /
      # X-Scope-Meta from the proxied request) is chassis work and is done once
      # in upstream.ts for every signal, not per span.
```

Without `snapshotCorrelation`/`restoreCorrelation` the walk above deletes `op_session_id` and
`op_profile_id` from every span, silently, and the P4 differentiator ships broken with a green
tenancy suite. That is D22, and it is the reason this walk is written out here rather than left
implicit in `06`.

**Correction to the draft on what gigapipe reserves here.** Two different behaviours were
conflated:

- **Genuinely clobbered after the merge:** `name`, `status`, `kind` (`otlp.go:89-109`), set into
  `attrsMap` after `initAttributesMap` returns. A client cannot influence these.
- **Only defaulted, not clobbered:** `service.name` and `remoteService.name`.
  `populateServiceNames` (`otlp.go:60-78`) is called at `:83`, *before* `initAttributesMap` at
  `:84`, and each branch appends only when `getOtlpAttr(...) == nil`. It fills in a default; a
  client- or resource-supplied `service.name` wins. These are **not** a reserved namespace the
  gateway can lean on.

#### 6.4 Prometheus remote-write

Two independent problems: what we do to the payload, and how we frame it on the wire.

**Payload.** `writer/utils/unmarshal/metrics_protobuf.go:24-33` reads only `ts.GetLabels()` and
`ts.GetSamples()`, then runs `sanitizeLabels`. So:

```
for each timeseries ts in WriteRequest.timeseries:
  ts.labels := [l for l in ts.labels if !isReservedKey(l.name)]
             ∪ { name: "op_project_id", value: pid }
  ts.labels.sort by name           # Prometheus requires sorted labels; we changed the set
  ts.samples := [s for s in ts.samples if inTimestampWindow(s.timestamp)]
  drop ts.exemplars                # gigapipe has no field for them
  drop ts.histograms               # ditto
  drop the whole ts if it has 0 samples after the above
drop WriteRequest.metadata         # gigapipe has no field for it
```

**Native histograms, exemplars and metadata are dropped loudly.** gigapipe's vendored
`writer/utils/proto/prompb.proto` — read in full — defines `TimeSeries` as exactly
`repeated Label labels = 1` and `repeated Sample samples = 2`, and `WriteRequest` as exactly
`repeated TimeSeries timeseries = 1`. No `exemplars`, no `histograms`, no `metadata`. Unknown
fields are skipped by `proto.Unmarshal`, so gigapipe already discards them silently today.
Because *we* decode with the full upstream schema we can see them: the gateway drops them
explicitly and increments
`op_telemetry_rejected_total{signal="remote_write",reason="native_histogram"|"exemplar"|"metadata"}`.
That turns a silent data loss into an operator-visible one.

**Remote-write 2.0 is rejected, not forwarded.** PRW 2.0 sends
`Content-Type: application/x-protobuf;proto=io.prometheus.write.v2.Request` and
`X-Prometheus-Remote-Write-Version: 2.0.0`.

> `UNVERIFIED:` neither checkout vendors the v2 proto (gigapipe has only the v1-shaped
> `writer/utils/proto/prompb.proto`, and `github.com/prometheus/prometheus` is not in this
> machine's Go module cache). From the remote-write 2.0 specification,
> `io.prometheus.write.v2.Request` **reserves fields 1–3** — precisely so a v2 message decoded as
> a v1 `WriteRequest` cannot be misread — and uses `repeated string symbols = 4;` /
> `repeated TimeSeries timeseries = 5;`. Re-check against
> `prometheus/prometheus@v0.314.0`'s `prompb/io/prometheus/write/v2/types.proto` before
> implementing.

The consequence is the opposite of the draft's, and stronger: a v1 decoder does not error and
does not produce garbage — it decodes a `WriteRequest` with **zero** timeseries, ingests nothing,
and returns 204. **Silent total data loss with a success status.** That is the argument for the
hard 415, and it is worth writing down because an implementer looking for a parse error would
never find one.

Detection, in order:

1. Primary: the `proto=io.prometheus.write.v2.Request` parameter on the `Content-Type`. → 415.
2. Secondary: `X-Prometheus-Remote-Write-Version` starting with `2.` → 415.
3. **A missing version header is treated as PRW 1.0**, not rejected. The draft's rule ("reject
   unless the version starts with `0.1.` or `1.`") would 415 any sender that omits the header,
   and no real PRW 1.0 sender uses `1.` — Prometheus sends `0.1.0`.

**Wire framing (D5).** Two decompression stages run in series on gigapipe's remote-write route:

```go
// writer/writer.go — every writer route gets WithExtraMiddlewareDefault
// writer/controller/dev.go:3-5 — which is [WithOverallContextMiddleware]
// WriteStreamV2, writer/controller/prom.go:39-47:
Build(append(cfg.ExtraMiddleware,      // 1. WithOverallContextMiddleware
    withTSAndSampleService,
    withUnsnappyRequest,               // 2.
    withSimpleParser("*", Parser(unmarshal.UnmarshallMetricsWriteProtoV2)),
    withOkStatusAndBody(204, nil))...)
```

`WithOverallContextMiddleware` decodes `Content-Encoding: snappy` into `r.Body`
(`middleware.go:186-196`). `withUnsnappyRequest` (`middleware.go:111-144`) then reads that body
and tries to snappy-decode it *again*.

If we forward `Content-Encoding: snappy`, stage 2 receives already-decoded protobuf. A protobuf
`WriteRequest` begins `0x0a` (field 1, wire type 2), so `snappy.DecodedLen` reads a varint of
`10`, passes the 10 MiB guard at `:122-125`, and `snappy.Decode` then fails on the trailing bytes
— at which point `:133-136` falls back to passing the *original* (already-decoded) bytes through.
It works. It works **because a decode failed**, which is not a property to build on across a
version bump.

If we forward **snappy bytes with no `Content-Encoding`**, stage 1 hits `case "":` (`:178-179`)
and does nothing, and stage 2 does the one correct decode. That is D5.

The cost of the alternative is worth naming: gigapipe's only remote-write body cap lives in
stage 2 (`:122-125`, 10 MiB decompressed). Forwarding **uncompressed** would take the `case "":`
branch too, then fail `snappy.DecodedLen`, then fall through the same fallback — bypassing that
cap entirely. Sending snappy keeps it, as a second bound under our own.

Snappy here is the **raw block format** (`github.com/golang/snappy`'s `Encode`/`Decode`, not the
framed `snappy.NewWriter` stream format). The node `snappy` package's `compressSync`/
`uncompressSync` are documented as raw-block. `UNVERIFIED:` confirm on the first integration test
that `snappy.compressSync(Buffer)` round-trips through `golang/snappy.Decode` — a framed/raw
mismatch is the most likely first-day bug on this route.

#### 6.5 Nil-pointer guards the gateway closes for free

`writer/utils/unmarshal/otlp.go:81` does `res.Resource.Attributes...` — **direct field access on
a possibly-nil pointer**, not a generated getter. An `ExportTraceServiceRequest` whose
`ResourceSpans` entry has no `resource` field (legal OTLP, and what a hand-rolled client
produces) nil-derefs inside gigapipe's decoder. It does not crash the process — `tamePanic`
(`writer/utils/unmarshal/builder.go:213-219`) is deferred in the parse goroutine and converts it
to an error — but it is a 500 for the customer and a stack trace in gigapipe's log for every
batch.

There is a **second nil-deref of the same class on the same path** that the draft missed:
`initAttributesMap` (`otlp.go:154-160`) calls `d.writeAttrValue(kv.Key, kv.Value.Value, …)` with
no nil guard, unlike the metrics path which does `if kv.Value == nil { continue }`
(`otlp_metrics.go:101-103`). A `KeyValue` with an absent `value` — legal on the wire, and
producible by our own re-encode if protobufjs decodes a valueless entry — panics identically.

Because the gateway is walking every resource and every attribute anyway, it fixes both for free:

- **If `resource` is absent, create it.** Applies to `ResourceSpans`, `ResourceMetrics` and
  `ResourceLogs` — the latter two are nil-safe today (`otlplogs.go:26-28` guards) but should not
  depend on staying so.
- **Drop any `KeyValue` whose `value` is absent**, on all three signals. This lives in
  `scrubAttrs`, above.

#### 6.6 Worked example (OTLP logs, protobuf)

In (abbreviated JSON view of the protobuf a client sent), client authenticated as project
`acme-checkout`:

```json
{"resourceLogs":[{
  "resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"checkout"}},
    {"key":"op.project.id","value":{"stringValue":"someone-elses-project"}}]},
  "scopeLogs":[{
    "scope":{"name":"checkout","attributes":[
      {"key":"op_project_id","value":{"stringValue":"also-not-yours"}}]},
    "logRecords":[{
      "timeUnixNano":"1756500000000000000",
      "severityText":"ERROR",
      "body":{"stringValue":"payment declined"},
      "attributes":[
        {"key":"order_id","value":{"stringValue":"A-1"}},
        {"key":"op-project-id","value":{"stringValue":"nope"}},
        {"key":"dangling"}]}]}]}]}
```

Out:

```json
{"resourceLogs":[{
  "resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"checkout"}},
    {"key":"op_project_id","value":{"stringValue":"acme-checkout"}}]},
  "scopeLogs":[{
    "scope":{"name":"checkout","attributes":[]},
    "logRecords":[{
      "timeUnixNano":"1756500000000000000",
      "severityText":"ERROR",
      "body":{"stringValue":"payment declined"},
      "attributes":[{"key":"order_id","value":{"stringValue":"A-1"}}]}]}]}]}
```

All three hostile attributes were removed by `isReservedKey` — `op.project.id`, `op_project_id` and
`op-project-id` all sanitize to `op_project_id`, which starts with `op_`. The valueless
`dangling` entry was dropped by the nil guard (§6.5) rather than nil-dereffing inside gigapipe.
The stored label set gigapipe derives is
`{service_name="checkout", op_project_id="acme-checkout", order_id="A-1", level="ERROR"}`.

#### 6.7 Removing data points, and the empty-container rule

Three rules can remove an element mid-tree: the timestamp window (§6.9), a structural
per-request element cap (§7), and — in P6 — cardinality refusal. Removal is **surgery inside the
protobuf tree**, and the draft never specified it. It is specified here once, because getting it
wrong produces an `ExportMetricsServiceRequest` with an empty `Metric` whose `data` oneof is set,
which is legal but useless, or an empty `ScopeMetrics`, which some decoders dislike:

```
after filtering data_points / log_records / spans:
  if a metric's data-point list is empty   → remove the metric from scope_metrics.metrics
  if scope_metrics.metrics is empty        → remove the scope_metrics entry
  if resource_metrics.scope_metrics empty  → remove the resource_metrics entry
  (identically for logs: log_records → scope_logs → resource_logs,
   and traces: spans → scope_spans → resource_spans)
  if the top-level list is empty           → do NOT forward; answer 200 with a
                                             partial_success naming every rejection
```

The last line matters: forwarding an empty `ResourceMetrics` list is a wasted round trip, and
answering 200-with-`partial_success` is exactly the case `partial_success` is for (we dropped it
deliberately), unlike an upstream failure (D7).

#### 6.8 The `Long` trap (D4)

OTLP timestamps are `fixed64` nanoseconds — currently ~1.77 × 10¹⁸, far past
`Number.MAX_SAFE_INTEGER` (9.007 × 10¹⁵). protobufjs represents 64-bit fields as `Long` objects
**only if it can resolve the `long` module**, which it does via `util.inquire("long")` — a
deliberately obfuscated `require` that bundlers routinely fail to resolve. If it fails,
protobufjs silently falls back to JS numbers, and decode → re-encode **rounds every timestamp**,
scattering samples across the wrong seconds.

Three belts:

1. `protobufjs` and `long` are direct deps and in `tsdown`'s `external` array (§5.4), so the
   `inquire` is a real runtime `require` against a real `node_modules`.
2. The proto module sets it explicitly at load time and the generated code is built with
   `--force-long`:

```ts
// apps/api/src/telemetry/proto/configure.ts — imported first by index.ts
import Long from 'long';
import protobuf from 'protobufjs/minimal.js';

protobuf.util.Long = Long;
protobuf.configure();

// Fail at boot, not at 3am: if the wiring is wrong, every timestamp is silently
// rounded and nobody notices for weeks.
if (protobuf.util.Long !== Long) {
  throw new Error('telemetry: protobufjs Long wiring failed — refusing to start');
}
```

3. A unit test that is not optional (Test requirements #2).

#### 6.9 The timestamp window (D14)

Nothing downstream bounds timestamps. `acceptTimestamp` (`otlp_metrics.go:277-287`) rejects only
a **zero** `TimeUnixNano`; the logs decoder defaults a missing timestamp to `time.Now()`
(`otlplogs.go:68-75`); the traces and remote-write paths bound nothing at all. A Prometheus
draining a week-old WAL, a container with a skewed clock, or a mobile SDK replaying a queue all
write into old ClickHouse partitions — forcing merges over data retention had already settled —
or into the **future**, where a TTL expressed relative to the row timestamp never fires. A
future-dated row is permanently stored, unbillable by a wall-clock metering window, and invisible
to retention. Nobody notices until the disk fills.

Enforced during the same walk, so it is free:

```ts
const MAX_BACKFILL_MS = TELEMETRY_MAX_BACKFILL_HOURS * 3_600_000;   // default 24
const MAX_SKEW_MS     = TELEMETRY_MAX_SKEW_MINUTES   *    60_000;   // default 5

const inWindow = (ms: number, now: number) =>
  ms >= now - MAX_BACKFILL_MS && ms <= now + MAX_SKEW_MS;
```

- Out-of-window **elements are removed**, never clamped to a legal value — a clamped sample is a
  fabricated one, and it would collide with a real sample at that instant.
- A removed element is counted into `partial_success` and
  `op_telemetry_rejected_total{signal,reason="timestamp_backfill"|"timestamp_skew"}`. It never
  fails the batch: one skewed host must not lose a 10k-point export.
- `now` is captured **once per request** (`request.timestamp`, set by `timestampHook`,
  `app.ts:131`) so every element in one batch is judged against the same instant.
- Both bounds are env-tunable and both are raisable per deployment; a customer legitimately
  backfilling gets `TELEMETRY_MAX_BACKFILL_HOURS` raised, which is a support decision with a
  known cost (ClickHouse merges over old partitions).

---

### 7. Structural limits (always on, no I/O)

Enforced during the rewrite walk, so they cost nothing extra. Defaults are env-tunable but the
env names are one-way ratchets — raising them is a support decision, not a config knob.

| Limit | Default | Env | Scope | On violation |
|---|---|---|---|---|
| attributes per data point / log record / span / event / link | 64 | `TELEMETRY_MAX_ATTRS` | per element | truncate, count |
| label name length | 128 | `TELEMETRY_MAX_KEY_LEN` | per attribute | truncate, count |
| label value length | 1024 | `TELEMETRY_MAX_VALUE_LEN` | per attribute | truncate, count |
| distinct series per request | 20 000 | `TELEMETRY_MAX_SERIES_PER_REQUEST` | per request | **413** |
| data points / records / spans per request | 100 000 | `TELEMETRY_MAX_ELEMENTS_PER_REQUEST` | per request | **413** |
| timestamp backfill | 24 h | `TELEMETRY_MAX_BACKFILL_HOURS` | per element | drop element, count |
| timestamp skew | 5 min | `TELEMETRY_MAX_SKEW_MINUTES` | per element | drop element, count |

Truncations go into `partial_success`, not into a request failure: a single over-long attribute
value should not lose a 10k-point batch. The two per-request caps are **413**, because they
indicate a client that is not batching sanely, and 413 is permanent in the OTLP retry table so
the client stops rather than hammering.

`TELEMETRY_MAX_VALUE_LEN = 1024` is above gigapipe's own 100-character truncation on the
remote-write path (`unmarshal.go:274-279`) and unbounded on the OTLP paths. That asymmetry is
real and belongs to the read work-stream: **a label value over 100 characters survives OTLP
ingest intact but is truncated on remote-write ingest**, so the same logical series ingested both
ways gets two different fingerprints.

---

### 8. Cardinality: observation only in P1 (D8)

Structural limits stop one bad *element*. They do nothing about a customer who puts a request id
in a label and creates 40 million series overnight — which lands in `time_series`,
`time_series_gin` and `metrics_15s`, and which nobody can undo.

P1 records the problem and does not act on it. Three reasons, in order of how much they matter:

**1. The gateway cannot count stored series.** The draft claimed the gateway hashes "the same set
gigapipe will store". For OTLP metrics it is not the same set and cannot be without
reimplementing the decoder §6.1 explicitly refuses to reimplement:

| Input | Stored series |
|---|---|
| one histogram data point, 12 buckets | 12 `_bucket{le=…}` + 1 `_bucket{le="+Inf"}` + `_sum` + `_count` = **15** (`otlp_metrics.go:373,379,386,391`) |
| one exponential-histogram data point | same shape (`:427,442,447,452`) |
| one summary data point, 5 quantiles | 5 `{quantile=…}` + `_sum` + `_count` = **7** (`:472,477,481`) |
| one resource per export | **+1** `target_info` (`:495-516`), now always emitted because we stamp the resource |

`seriesLabels` also injects `__name__`, `job`, `instance`, `__metric_type__`, `__metric_help__`,
`__metric_unit__` (`:246-262`), none of which the gateway sees as data-point attributes. A
100 000-series budget measured on gateway-side hashes would admit well over a million real
series — the exact irreversible outcome the section exists to prevent.

**2. `budget(project)` does not exist.** It comes from the billing work-stream. Enforcing an
invented global constant, on a route that ships with `TELEMETRY_ENABLED=false`, before the read
path exists to look at any of it, is work with no consumer.

**3. The enforcement machinery is the expensive half.** `SADD` of up to 20 000 members plus
`SMISMEMBER` of up to 20 000 members per request, against a `--maxmemory-policy noeviction` Redis
(`self-hosting/docker-compose.template.yml:48-52`) shared with BullMQ and the session store, is
how the gateway takes down `/track`.

What P1 ships:

```
per request, per signal, fire-and-forget, off the response path, .catch()ed:
  PFADD  telemetry:card:{projectId}:{signal}:{yyyy-mm}  ...seriesHashes
  EXPIRE telemetry:card:{projectId}:{signal}:{yyyy-mm}  45d
```

`seriesHashes` is a stable hash of the sorted, sanitized, post-rewrite label set, computed with
`fast-json-stable-hash` (already an `apps/api` dependency, `apps/api/package.json`). We do **not**
replicate gigapipe's cityhash fingerprint (`unmarshal.go:250-270`) — it depends on
`config.Cloki.Setting.FingerPrintType` and matching it exactly is a maintenance trap. Collisions
across projects do not matter because every key is project-scoped.

The number this produces is a **proxy that undercounts stored series by the fan-out factor
above**, and it is labelled as such everywhere it appears. It exists to give P6 real
distributions to size a budget from.

The authoritative count — used by billing, by the eventual budget, and by the ops dashboard — is
a ClickHouse query the billing work-stream owns:

```sql
SELECT
  visitParamExtractString(labels, 'op_project_id') AS project_id,
  count(DISTINCT fingerprint) AS series
FROM gigapipe.time_series
WHERE date >= today() - 30
GROUP BY project_id;
```

P6 enforcement, when it lands, should be built on that number, not on the gateway's hash.

---

### 9. Rate limiting and quota

#### 9.1 Request rate — `@fastify/rate-limit` registered inside the plugin (D11)

The draft reused `activateRateLimiter` (`apps/api/src/utils/rate-limiter.ts:5-59`). That wrapper
cannot work here for two reasons, both verified:

- Its `errorResponseBuilder` is hard-coded to a JSON object (`:19-25`) and the wrapper's
  parameter list is `{fastify, max, timeWindow, keyGenerator}` — there is no override. Since
  `@fastify/rate-limit` sends that reply itself, neither the plugin's `setErrorHandler` nor the
  `Retry-After` policy below is ever reached, so a 429 could never carry a `google.rpc.Status`.
- Its `keyGenerator` fallback (`:31-42`) prefers the **`openpanel-client-id` header** before the
  trusted IP. Client ids are public. An attacker rotating that header value mints unlimited fresh
  600/min buckets.

So the plugin registers the limiter itself:

```ts
await fastify.register(import('@fastify/rate-limit'), {
  max: Number(process.env.TELEMETRY_RATE_MAX ?? 600),
  timeWindow: '1 minute',
  redis: process.env.NODE_ENV !== 'test' ? getRedisCache() : undefined,
  // Trusted IP FIRST, header second. The header alone is attacker-chosen and
  // would let one attacker mint unbounded buckets; the tuple keeps per-client
  // fairness for honest callers while bounding an attacker to their own IP.
  keyGenerator: (req) => {
    const { ip } = getTrustedIpFromHeaders(req.headers, req.socket?.remoteAddress);
    const id = req.headers['openpanel-client-id'];
    return `tel:${ip}:${Array.isArray(id) ? id[0] : (id ?? '-')}`;
  },
  errorResponseBuilder: (req, ctx) => {
    // Signal-aware: google.rpc.Status on OTLP routes, plain text on remote-write.
    // Returned as a Buffer with the reply content-type set by onExceeded.
    return encodeRateLimitBody(req, ctx);
  },
  onExceeded: (req) => {
    req.log.warn({ url: req.url, clientId: req.headers['openpanel-client-id'] },
      'telemetry rate limit exceeded');
  },
});
```

The `tel:` prefix matters: without it a telemetry client and an export client sharing an id would
share a bucket, and the telemetry limit (600/min) and the export limit (100/10 s,
`export.router.ts:16`) would fight over one Redis key.

Keying on the header at all is forced to be *secondary* — `@fastify/rate-limit` registers its
hook before ours (§5.1), so `req.client` is not populated yet.

The **failed-auth lockout** in `validateTelemetryRequest` (§2.2) is the second half of this, and
it is the one that matters: without it, each request with a *fresh wrong secret* is a guaranteed
cache miss that costs one deliberately-expensive argon2 `verifyPassword` on the event loop that
also serves `/track`. The lockout makes a wrong secret cost a Redis `MGET` instead. The telemetry
verify cache is also plugin-local (§2.2) rather than the process-global 5000-entry
`globalLruCache` (`packages/redis/cachable.ts:11-14`), so a wrong-secret flood cannot evict
`/track`'s own auth results.

600 requests/minute is sized off the OTel Collector's default `batch` processor with a few
pipelines: 5 req/s/signal × 3 signals = 900/min at the extreme, so 600 is deliberately a little
tight and expected to be raised. It is a per-client-per-IP limit; a customer with many collectors
should mint many clients.

#### 9.2 Volume quota — `429 + Retry-After`, and the Prometheus footgun

Quota is checked in `quotaHook` (`onRequest`, after auth) against the metering counters from §13.
It is a *soft* read: the counter is only accurate to the current window, and a request that
crosses the line is admitted; the next one is not.

```ts
reply
  .header('Retry-After', String(retryAfterSeconds))   // integer seconds, RFC 9110
  .status(429)
  .send(encodeStatusFor(request, 'quota exceeded'));
```

`retryAfterSeconds = min(secondsUntilWindowReset, 300)` with ±10% jitter, so a fleet of
collectors does not resynchronise into a thundering herd.

**The footgun:** Prometheus's `remote_write` `queue_config` has `retry_on_http_429: false` by
default. A 429 is therefore *dropped* by an out-of-the-box Prometheus and counted in
`prometheus_remote_storage_samples_dropped_total`. Consequences:

- The paste-in Prometheus config (§16.3) sets `retry_on_http_429: true` explicitly.
- **Backpressure never uses 429 on the remote-write route** — it uses 503, which Prometheus
  always retries with its own backoff.
- `UNVERIFIED:` whether Prometheus honours `Retry-After` (as opposed to its own
  `min_backoff`/`max_backoff`) when `retry_on_http_429` is on. Doc text only; no design change.

OTLP is the well-behaved side: the OTLP/HTTP spec makes 429/502/503/504 retryable and
400/401/403/404/413 permanent, and the OTel Collector's `otlphttp` exporter honours `Retry-After`.

---

### 10. Backpressure, timeouts, shutdown, and the upstream client

#### 10.1 Admission — a plain counter, and a permit that cannot leak

The draft specified a waiter queue (`MAX_QUEUED=64`, 2 s fair wait) whose permits were acquired
in `onRequest` and released in `onResponse`. Two problems, one of them fatal:

- **Fastify does not run `onResponse` when a client aborts before the reply is sent.** That is
  precisely why `onRequestAbort` exists. OTLP and remote-write clients abort constantly — the
  OTel Collector's default `timeout: 30s` (which §16.1's paste-in config sets explicitly) fires
  while we are still inside an admission wait plus an upstream forward. Every aborted upload
  leaks a permit permanently, and after `MAX_IN_FLIGHT` aborts the gateway 503s **forever** until
  the API process is restarted — which restarts `/track`. It presents as "telemetry stopped
  working after a few days" and is very hard to diagnose.
- The waiter queue's only benefit over a plain counter is smoothing a 2-second burst, while
  adding 2 s of latency to a request the client may already be about to abandon.

So: **no waiter queue in P1.** A plain counter, an immediate 503 when full, and an idempotent
release wired to three hooks plus a watchdog:

```ts
// apps/api/src/telemetry/admission.ts
const MAX_IN_FLIGHT = Number(process.env.TELEMETRY_MAX_IN_FLIGHT ?? 16);
const REQUEST_TIMEOUT_MS = Number(process.env.TELEMETRY_REQUEST_TIMEOUT_MS ?? 12_000);

let inFlight = 0;
const held = new Map<string, { at: number; abort: AbortController }>();

export function acquire(req: FastifyRequest): AbortController | null {
  if (inFlight >= MAX_IN_FLIGHT) return null;      // caller answers 503 + Retry-After: 5
  inFlight++;
  const abort = new AbortController();
  held.set(req.id, { at: Date.now(), abort });
  return abort;                                     // threaded into forward()
}

/** Idempotent. Wired to onResponse, onRequestAbort AND onTimeout. */
export function release(req: FastifyRequest): void {
  const entry = held.get(req.id);
  if (!entry) return;                               // already released — no-op
  held.delete(req.id);
  inFlight--;
  entry.abort.abort();                              // frees the upstream socket too
}

// Last resort. A permit older than the end-to-end budget is a bug we want to
// SEE, not a wedged gateway. Runs every 5s, unref()'d.
setInterval(() => {
  const cutoff = Date.now() - REQUEST_TIMEOUT_MS * 2;
  for (const [id, entry] of held) {
    if (entry.at < cutoff) {
      held.delete(id);
      inFlight--;
      entry.abort.abort();
      permitLeaked.inc();                           // op_telemetry_permit_leaked_total
    }
  }
}, 5_000).unref();
```

The `AbortController` returned by `acquire` **is** the end-to-end budget enforcement the draft's
`TELEMETRY_REQUEST_TIMEOUT_MS` env var promised and nothing implemented: it is armed in
`onRequest`, threaded into `forward()`, and fired by `release` or by the watchdog.

A `Content-Length` pre-check in `contentGate` (which runs *before* `admissionHook`) rejects an
oversize declared body with 413 without reading a byte or taking a permit.

**Per-replica, and say so.** `MAX_IN_FLIGHT` and the circuit breaker are per-process. With N API
replicas the real concurrency against gigapipe is **16 N**, and the memory bound is
`16 N × TELEMETRY_MAX_DECOMPRESSED_BYTES` = 512 MiB per replica at the shipping defaults. Both
numbers must be sized against the container memory limit and against what the shared ClickHouse
can absorb, not read as global.

**No per-tenant fairness in P1.** The permits are process-global, so one noisy tenant 503s
everyone else on that replica. `op_telemetry_inflight` is labelled by signal only, so the metric
cannot even attribute it. That is a stated P1 limitation; the per-project kill switch (§4) is the
operator's lever until P6 adds per-project admission.

#### 10.2 Graceful shutdown

`apps/api/src/utils/graceful-shutdown.ts` sleeps `SHUTDOWN_GRACE_PERIOD_MS` (default 5000,
`:59`), then closes Fastify and every client, with a hard `process.exit()` at
`SHUTDOWN_FORCE_EXIT_MS` (default 15000, `:48`). The draft's 20 s upstream timeout plus 2 s
admission wait cannot finish inside the remaining 10 s, so `process.exit()` would fire mid-forward
on **every deploy** — and because gigapipe's ingest is synchronous
(`writer/controller/builder.go:228-256`), the ClickHouse insert may well have landed while the
client received nothing and retries. Silent duplication on every rolling restart.

The drain window is `SHUTDOWN_FORCE_EXIT_MS − SHUTDOWN_GRACE_PERIOD_MS` = **10 s** at the
defaults. Three changes:

1. **The timeout budget is cut to fit inside it**: `TELEMETRY_REQUEST_TIMEOUT_MS = 8000`,
   `GIGAPIPE_TIMEOUT_MS = 6000`. That leaves 2 s of headroom and keeps the deploy budget
   untouched for every other route. Raising `SHUTDOWN_FORCE_EXIT_MS` instead was rejected: it
   slows every deploy of a process that mostly serves `/track`, to accommodate a route that is
   off by default.
2. A **boot assertion** refuses to start when
   `TELEMETRY_REQUEST_TIMEOUT_MS >= SHUTDOWN_FORCE_EXIT_MS − SHUTDOWN_GRACE_PERIOD_MS`, so
   nobody re-introduces the mismatch by tuning one env var.
3. A `shutdownHook` (`onRequest`, first) answers **503 + `Retry-After: 30`** when
   `isShuttingDown()` (`graceful-shutdown.ts:25`) returns true. The helper already exists and
   `readiness` already uses it.

6 s upstream is still well under the OTel Collector's `timeout: 30s` default, so the client sees
*our* error rather than its own client-side timeout, which is far easier to support.

#### 10.3 The upstream client

```ts
// apps/api/src/telemetry/upstream.ts
export interface ForwardResult {
  status: number;
  body: Buffer;
  contentType: string | null;
}

export async function forward(
  path: '/v1/metrics' | '/v1/logs' | '/v1/traces' | '/api/v1/prom/remote/write',
  body: Buffer,
  contentEncoding: 'snappy-unlabelled' | 'none',
  signal: AbortSignal,
): Promise<ForwardResult>;
```

Plain `undici`-backed global `fetch` (Node 20+). Not `safeFetch`
(`apps/api/src/utils/safe-fetch.ts`) — that is the SSRF guard for *user-supplied* URLs and it
blocks private IPs, which is exactly where gigapipe lives.

`forward()` builds the outbound header object **from scratch**. It is a whitelist, not a
blacklist:

```
Content-Type: application/x-protobuf
Content-Length: <n>
Authorization: Basic base64(GIGAPIPE_LOGIN:GIGAPIPE_PASSWORD)
(and nothing else — in particular no Content-Encoding, ever; see D5)
```

Never forwarded, whether or not the customer sent them: `X-CH-DSN` / `x-ch-dsn`, `X-Scope-Meta`,
`X-Ttl-Days`, `X-Async-Insert`, `X-Scope-OrgID`, `Content-Encoding`, `Authorization`, every
`openpanel-*`. `X-CH-DSN` selects a boot-configured ClickHouse node by name with a **fail-open
random fallback** (`writer/service/registry/static.go:55-68`), and `writer/chwrapper` carries
dormant caller-supplied-DSN dialing primitives (`factory.go:246-268`) that are unwired today and
could be wired in one line upstream. `X-Ttl-Days` is parsed (`middleware.go:167-174`) and never
persisted in OSS, so it is inert — but "inert today" is not a reason to pass it through.

**Basic auth is conditional upstream, so it is mandatory here.** The draft said gigapipe "applies
`middleware.BasicAuthMiddleware` globally via `app.Use`". It does not, unconditionally:
`cmd/gigapipe/main.go:321-325` wraps the `app.Use` in
`if cfg.Setting.AUTH_SETTINGS.BASIC.Username != "" && …Password != ""`. If `QRYN_LOGIN` /
`QRYN_PASSWORD` are unset — the default, and what a self-hoster who skips a line in the
hand-added compose service will get — **gigapipe runs with no auth on any route**, on a port the
OTLP/gRPC receiver is also multiplexed onto. So:

- The gateway **refuses to start** when `TELEMETRY_ENABLED=true` and `GIGAPIPE_LOGIN` or
  `GIGAPIPE_PASSWORD` is empty.
- The ops work-stream's compose template sets them, and the gigapipe container's healthcheck
  **must carry the credentials** — a bare `curl /ready` will 401 once they are set, because
  `app.Use` covers `/ready`, `/config` and `/metrics` too.

#### 10.4 Circuit breaker

Per-signal (a metrics outage should not fail logs), in-process (each replica learns
independently, which is fine because they all talk to the same gigapipe):

- **closed** → normal.
- **open** after 10 consecutive upstream failures within 30 s. All requests answer **503 +
  `Retry-After: 30`** without a socket.
- **half-open** after 30 s: one probe request; success closes, failure re-opens.

Open state is a `warn` log and a gauge, never an error log — a 30-minute gigapipe outage must not
write 100k error lines. Health is exposed at `GET /telemetry/health` (unauthenticated, no data,
mirrors the `/healthz/*` convention at `app.ts:385-386`, `schema: { hide: true }`) and is
**excluded from `/healthcheck`** per D10.

---

### 11. Error semantics

#### 11.1 OTLP

| Situation | Status | Body |
|---|---|---|
| success | 200 | `Export{Metrics,Logs,Trace}ServiceResponse`, empty or with `partial_success` |
| we dropped elements (structural truncation, timestamp window) | 200 | `partial_success { rejected_data_points, error_message }` |
| gigapipe reported `partial_success` | 200 | **relayed** — its counts merged with ours |
| everything we would have forwarded was dropped | 200 | `partial_success`, nothing forwarded (§6.7) |
| undecodable protobuf / wrong schema | 400 | `google.rpc.Status` |
| missing / bad credentials | 401 | `google.rpc.Status` |
| wrong client type, org blocked by wind-down, ineligible project id | 403 | `google.rpc.Status` |
| unsupported `Content-Type` (incl. JSON) / `Content-Encoding` / PRW 2.0 | 415 | `google.rpc.Status` |
| body over cap, decompression ratio, too many elements | 413 | `google.rpc.Status` |
| rate limit, quota, auth lockout | 429 + `Retry-After` | `google.rpc.Status` |
| gigapipe down, circuit open, admission full, shutting down, project disabled | 503 + `Retry-After` | `google.rpc.Status` |
| gigapipe timed out | 504 | `google.rpc.Status` |

The response is encoded in the **request's** content type, matching what gigapipe itself does
(`writeOTLPMessage`, `writer/controller/otlp_metrics.go:113-127`). Since P1 accepts protobuf
only, that is always protobuf — but the encoder is written signal-aware so P6's JSON decision
does not have to touch it. Our proto bundle includes `google/rpc/status.proto` for this.

**We synthesize the success body for logs and traces; we do not relay it.** gigapipe answers
`/v1/logs` with `204` and a body it is not allowed to send (`WriteHeader(204)` then
`Write([]byte("Ok"))`, `writer/controller/insert.go:142-152` — Go drops the body and logs a
warning), and `/v1/traces` with `200` + an empty `ExportTraceServiceResponse` and **no
`Content-Type` header** (`writer/controller/tempo.go:57-62`). Only `/v1/metrics` returns a
properly typed, `partial_success`-capable response. So: for logs and traces the gateway maps any
gigapipe 2xx to `200` + a correctly typed empty response (plus our own `partial_success` if we
dropped anything); for metrics it decodes gigapipe's `ExportMetricsServiceResponse` and merges
`rejected_data_points` with ours.

**Never 200 on an upstream failure.** This is D7 and it is the single easiest thing to get wrong,
because `partial_success` looks like the polite way to report a problem. It is not: an OTLP
client that receives 200 deletes the batch.

**gigapipe's error bodies are not relayed.** `writeErrorResponse`
(`writer/controller/builder.go:118-124`) emits `{"success":false,"message":…}` and — because it
calls `w.WriteHeader` *before* `w.Header().Set` — never actually sends the `Content-Type` it
sets. An OTLP client parsing that as `google.rpc.Status` gets garbage. The gateway logs
gigapipe's body (truncated to 2 KiB) and returns its own well-formed `Status`.

#### 11.2 Remote-write

| Situation | Status | Notes |
|---|---|---|
| success | 204, empty | matches gigapipe (`prom.go:46`) and PRW 1.0 |
| bad snappy / bad protobuf | 400 | plain-text body |
| PRW 2.0, non-snappy encoding | 415 | plain-text body |
| auth, wind-down, ineligible project | 401 / 403 | |
| oversize | 413 | |
| hard quota | 429 + `Retry-After` | dropped unless `retry_on_http_429: true` — §9.2 |
| **backpressure, circuit open, gigapipe down, shutting down, project disabled** | **503 + `Retry-After`** | never 429; Prometheus always retries 5xx |
| gigapipe timeout | 504 | |

Remote-write has **no partial-success mechanism**. Series we drop are simply not forwarded, and
the only signal is our own metrics and a `warn` log sampled at 1-in-1000. That asymmetry with
OTLP belongs in the customer docs.

#### 11.3 Error-body redaction (D11)

```ts
fastify.setErrorHandler((error, request, reply) => {
  const { status, message } = normalizeError(error);   // @/utils/errors
  request.log[status >= 500 ? 'error' : 'warn'](
    {
      err: error,
      req: {
        id: request.id,
        url: request.url,
        method: request.method,
        clientId: request.headers['openpanel-client-id'],
        projectId: request.client?.projectId,
        contentType: request.headers['content-type'],
        contentLength: request.headers['content-length'],
        // deliberately: no headers object, no body
      },
    },
    'telemetry request error',
  );
  return replyForRoute(request, reply, status, message);
});
```

`replyForRoute` picks the `google.rpc.Status` or plain-text encoder from §11.1/§11.2.

The app-level handler this replaces (`app.ts:397-444`) logs `headers: request.headers` (`:420`)
and `body` (`:421-423`) at **`warn` on 4xx as well as `error` on 5xx**, for any error whose code
is not in `SKIP_LOG_ERRORS` (`:392-396`). So a plain 401 from a mistyped secret on `/export` or
`/insights` already writes `openpanel-client-secret` to the log today. That is a pre-existing,
repo-wide credential-in-logs issue that this plugin works around locally and does not fix; it is
routed out in [Interfaces](#interfaces).

`requestLoggingHook` (`apps/api/src/hooks/request-logging.hook.ts:52-62`) is already safe: it
attaches `request.body` only for URLs starting with `/track`, and its header `pick` list does not
include `openpanel-client-secret`. Only the error path needed fixing.

---

### 12. Delivery semantics (D15)

One paragraph that the read-path, billing and schema work-streams all need:

**Ingest is at-least-once and duplicates are possible.** gigapipe's `IngestParsed` pushes with
`INSERT_MODE_SYNC` and waits on every promise (`writer/controller/builder.go:228-256`), so a 504
from us, a mid-forward `process.exit()` on deploy, or a client abort after gigapipe committed all
mean **the ClickHouse insert may have landed while the client saw a failure and retried**. The
entire error design (D7, §11) exists to make clients retry, which maximises this. There is no
idempotency key, no dedup window, and `samples_v3` is a plain `MergeTree`
(`ctrl/qryn/sql/log.sql:25-32`, `ORDER BY (timestamp_ns)` plus `type` added by ALTER at
`:119-120`) with no deduplication — a retried batch inserts every sample again.

Consequences to be established, not assumed (Open question Q1):

- Whether `sum`/`rate` over `samples_v3` double-counts a duplicated sample, or whether the read
  path's `GROUP BY fingerprint, timestamp_ns` collapses it. → **read path / metrics engine.**
- Whether `metrics_15s`, an `AggregatingMergeTree` fed by an insert-triggered MV
  (`log.sql:146-158`), double-counts. It has no retraction, so a duplicate insert is a duplicate
  aggregate. → **schema.**
- What the billing `SELECT count()` counts. → **billing.**

The gateway's own metering counters (§13) count *requests it accepted*, so a retry after a 504 is
counted twice there too. Reconciliation against ClickHouse is the billing work-stream's job.

---

### 13. Volume metering

#### 13.1 What is counted

Only what the gateway can observe first-hand:

| Field | Metrics | Logs | Traces | Remote-write |
|---|---|---|---|---|
| `requests` | ✓ | ✓ | ✓ | ✓ |
| `ingress_bytes` (decompressed) | ✓ | ✓ | ✓ | ✓ |
| `metric_points` | data points | | | samples |
| `log_records` | | records | | |
| `log_bytes` | | `sum(len(body))` | | |
| `spans` | | | spans | |
| `series_seen` | distinct hashes (proxy — §8) | distinct hashes | | distinct hashes |
| `rejected` | dropped, by reason | dropped | dropped | dropped |

**Explicitly not counted: billable `samples_v3` rows.** The fan-out arithmetic in §8 is exactly
why. Re-deriving it in TypeScript produces a hand-copied mirror of another repo's private
decoder, feeding a billing number, with no test that can detect drift on a gigapipe bump. The
authoritative billable count is a `SELECT count()` against `gigapipe.samples_v3` grouped by
`op_project_id`, owned by the billing work-stream. Gateway counters are the *live* view (quota,
kill-switch triage, abuse detection) and are reconciled daily.

#### 13.2 Storage — P1 ships the Redis half only

```
key   telemetry:usage:{projectId}:{yyyy-MM-dd}      (UTC day)
type  hash
ops   HINCRBY field n   (pipelined, one MULTI per request)
      EXPIRE key 40*86400   (only when the pipeline created the key)
```

Fire-and-forget with `.catch()`, exactly like `cacheable`'s Redis write
(`packages/redis/cachable.ts:264-268`). **Metering must never fail a request** — losing a counter
is a billing annoyance, losing a customer's telemetry is an outage.

**Deferred out of P1: the Postgres rollup.** The draft specified a daily
`apps/worker/src/jobs/cron.telemetry-usage.ts` writing into a Postgres table with **no Prisma
model anywhere in the document, no retention and no owner**. That table belongs to the billing
work-stream, which also owns the authoritative ClickHouse count it must reconcile against. P1
ships the Redis hash with its 40-day TTL, which is long enough that the rollup can be added later
without losing data. The env block does not ship a `budget` (§8), so nothing in P1 reads the hash
except the kill-switch triage tooling.

Rejected: writing usage rows straight to ClickHouse per request. One insert per ingest request is
exactly the small-parts pattern the existing event pipeline batches through BullMQ to avoid.

#### 13.3 Gateway self-metrics

`apps/api` registers `fastify-metrics` at `/metrics` (`app.ts:372`, skipped under
`testing: true`). New counters live in `apps/api/src/telemetry/metrics.ts`:

```
op_telemetry_requests_total{signal,status}
op_telemetry_ingress_bytes_total{signal}
op_telemetry_elements_total{signal}           # points | records | spans | samples
op_telemetry_rejected_total{signal,reason}    # structural | timestamp_backfill | timestamp_skew
                                              # | native_histogram | exemplar | metadata
                                              # | invalid_project_id | prw2
op_telemetry_auth_failures_total{reason}      # bad_secret | wrong_type | lockout | no_project
op_telemetry_rewrite_seconds{signal}          # histogram
op_telemetry_upstream_seconds{signal}         # histogram
op_telemetry_upstream_failures_total{signal,kind}
op_telemetry_inflight                         # gauge (per replica — §10.1)
op_telemetry_permit_leaked_total              # counter — must stay at 0
op_telemetry_breaker_open{signal}             # gauge 0/1
op_telemetry_decompress_seconds{signal}       # histogram — feeds Q3
```

`UNVERIFIED:` `apps/api/package.json` declares `fastify-metrics@^12.1.0` and **no `prom-client`**
(verified: the dependency block has neither), so whether a bare `new client.Counter(...)`
registers into the registry `fastify-metrics` exposes could not be checked (`node_modules`
absent). `apps/worker/src/metrics.ts:14-16` builds its own explicit `new Registry()`, which is
the pattern to copy if `fastify-metrics` does not expose the default registry. Settle by reading
`fastify-metrics` v12's `register`/`client` export after an install.

---

### 14. Module boundary (D9)

```
apps/api/src/telemetry/
  index.ts            # export default telemetryRouter
  plugin.ts           # route registration, hooks, content-type parser, error handler
  deps.ts             # THE ONLY file that imports @openpanel/db
  auth.ts             # validateTelemetryRequest, failed-auth lockout
  admission.ts        # counter + idempotent release + watchdog
  decompress.ts
  labels.ts           # sanitizers, isReservedKey, PROJECT_LABEL, project-id validation
  limits.ts           # structural limits, timestamp window, Counters
  cardinality.ts      # PFADD only (P1)
  metering.ts
  upstream.ts         # forward(), circuit breaker
  metrics.ts          # prom counters
  responses.ts        # google.rpc.Status / Export*ServiceResponse encoders
  rewrite/
    attrs.ts          # scrubAttrs, stamped, clampKeyValue, prune-empty-containers
    metrics.ts
    logs.ts
    traces.ts
    remote-write.ts
  proto/
    configure.ts
    vendor/**.proto
    otlp.js  otlp.d.ts  prompb.js  prompb.d.ts
```

`deps.ts` is the entire Prisma seam:

```ts
// apps/api/src/telemetry/deps.ts
export {
  ClientType,
  getClientByIdCached,
  getOrganizationByProjectIdCached,
  type IServiceClientWithProject,
} from '@openpanel/db';
```

Four symbols. In a standalone `apps/otel-gateway` this file becomes an HTTP call to
`GET /telemetry/internal/client/:id` on `apps/api`, and nothing else in the directory changes.

**May import:** `@openpanel/redis`, `@openpanel/common`, `@openpanel/common/server`,
`@openpanel/logger`, `@openpanel/constants`, `fastify`, `zod`, `protobufjs`, `long`, `snappy`,
`@/utils/errors`, `@/utils/graceful-shutdown`.

**Must not import:** `@openpanel/trpc`, `@openpanel/queue`, `@openpanel/mcp`, `@openpanel/auth`,
`@openpanel/payments`, `@openpanel/integrations`, `@openpanel/db` (except in `deps.ts`), and
anything under `@/controllers/`, `@/agents/`, `@/routes/`.

The rule is documented in a header comment in `plugin.ts` and enforced by review. No Biome
`overrides` rule and no grep test: `biome.json` has no `overrides` key today and the rules come
from the `ultracite` preset, so adding an import-restriction rule is unverified work to preserve
an option nobody has scheduled. The single-seam design is what buys the option; the lint rule
would only buy enforcement of it.

`@openpanel/validation` is *not* on the may-import list even though zod is: the gateway validates
protobuf, not JSON, and the one schema it needs (env parsing) is local.

---

### 15. Configuration

```bash
# --- gigapipe, internal only. Never published in the compose template. ---
GIGAPIPE_INTERNAL_URL=http://op-gigapipe:3100
GIGAPIPE_LOGIN=openpanel               # → QRYN_LOGIN on the gigapipe service
GIGAPIPE_PASSWORD=<generated>          # → QRYN_PASSWORD.  BOTH REQUIRED when
                                       # TELEMETRY_ENABLED=true; gigapipe's own
                                       # auth middleware is conditional on them
                                       # being non-empty (main.go:321-325).
GIGAPIPE_TIMEOUT_MS=6000

# --- gateway ---
TELEMETRY_ENABLED=false                # off until P1 lands; see §17
TELEMETRY_MAX_COMPRESSED_BYTES=8388608               # 8 MiB, OTLP routes
TELEMETRY_MAX_COMPRESSED_BYTES_REMOTE_WRITE=2097152  # 2 MiB, snappy expands 3-5x
TELEMETRY_MAX_DECOMPRESSED_BYTES=33554432            # 32 MiB — the ONLY bound on
                                                     # gigapipe's logs/traces paths
TELEMETRY_MAX_DECOMPRESS_RATIO=100
TELEMETRY_SYNC_INFLATE_MAX=262144      # <=256 KiB inflates synchronously
TELEMETRY_MAX_IN_FLIGHT=16             # PER REPLICA. Real bound is 16 x replicas.
TELEMETRY_REQUEST_TIMEOUT_MS=8000      # must be < SHUTDOWN_FORCE_EXIT_MS
                                       #            - SHUTDOWN_GRACE_PERIOD_MS
TELEMETRY_RATE_MAX=600
TELEMETRY_MAX_ATTRS=64
TELEMETRY_MAX_KEY_LEN=128
TELEMETRY_MAX_VALUE_LEN=1024
TELEMETRY_MAX_SERIES_PER_REQUEST=20000
TELEMETRY_MAX_ELEMENTS_PER_REQUEST=100000
TELEMETRY_MAX_BACKFILL_HOURS=24
TELEMETRY_MAX_SKEW_MINUTES=5
```

Gone from the draft's block, deliberately: `TELEMETRY_MAX_QUEUED` and
`TELEMETRY_ADMISSION_WAIT_MS` (no waiter queue, §10.1), `TELEMETRY_SERIES_BUDGET` and
`TELEMETRY_MAX_KNOWN_SERIES` (no enforcement in P1, D8 — shipping a finite budget while §8 says
self-hosted gets `Infinity` was a contradiction in the draft).

Two things that are **not** env-configurable on purpose: `PROJECT_LABEL` (`op_project_id`) and
`RESERVED_PREFIX` (`op_`). Changing either orphans every row already written and silently opens
the strip. They are constants in `packages/constants` with a comment saying so.

Boot assertions, all of which refuse to start rather than warn:

```ts
if (TELEMETRY_ENABLED) {
  assert(GIGAPIPE_LOGIN && GIGAPIPE_PASSWORD,
    'telemetry: GIGAPIPE_LOGIN/PASSWORD required — gigapipe auth is conditional on them');
  assert(TELEMETRY_REQUEST_TIMEOUT_MS < SHUTDOWN_FORCE_EXIT_MS - SHUTDOWN_GRACE_PERIOD_MS,
    'telemetry: request budget exceeds the deploy drain window');
  assert(GIGAPIPE_TIMEOUT_MS < TELEMETRY_REQUEST_TIMEOUT_MS, 'telemetry: upstream > budget');
  assert(protobuf.util.Long === Long, 'telemetry: protobufjs Long wiring failed');
}
```

**Self-hosted defaults, in one place** (the draft scattered them across three sections and
contradicted itself once):

| Behaviour | `SELF_HOSTED=true` | Cloud |
|---|---|---|
| wind-down / subscription gate | skipped (`subscription.hook.ts:34-36`) | enforced, 403 |
| volume quota (§9.2) | **not evaluated** — there is no plan | evaluated |
| cardinality recording (§8) | recorded, never enforced | recorded, never enforced |
| metering Redis hash | written | written |
| per-project kill switch | available | available |
| rate limit | same defaults | same defaults |

Docs deliverables that ship with this:
`apps/public/content/docs/self-hosting/environment-variables.mdx` gains the block above; the
gigapipe service follows the existing `apps/public/content/docs/self-hosting/high-volume.mdx:16-70`
pattern for hand-adding a service to a generated compose (it does exactly this for
`op-pgbouncer`), which is the only delivery path that reaches existing installs since the
generated `docker-compose.yml` is gitignored and `./update` pulls the `self-hosting` branch.

---

### 16. Client configuration to paste

Cloud base URL: `https://api.openpanel.dev/telemetry`.

**Self-hosted base URL is different and this is the first thing everyone gets wrong.**
`self-hosting/caddy/Caddyfile.template` routes the API under a *stripped* prefix
(`handle_path /api* { reverse_proxy op-api:3000 }`), so a self-hoster's values are:

| | Cloud | Self-hosted |
|---|---|---|
| OTLP base (`endpoint`) | `https://api.openpanel.dev/telemetry` | `https://$DOMAIN_NAME/api/telemetry` |
| remote-write `url` | `https://api.openpanel.dev/telemetry/api/v1/write` | `https://$DOMAIN_NAME/api/telemetry/api/v1/write` |

Getting it wrong produces a 404 **from the dashboard app**, not from the API, so the error
message points at the wrong service. The docs page says this in a callout.

#### 16.1 OpenTelemetry Collector

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
    timeout: 5s
    send_batch_size: 8192
    send_batch_max_size: 16384          # keep a request under TELEMETRY_MAX_ELEMENTS_PER_REQUEST
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15
  resource:
    attributes:
      # op_* is reserved by OpenPanel; the gateway strips anything that
      # sanitizes into that namespace. Delete them here so the drop is visible
      # in your own pipeline rather than silent at the edge.
      - key: op_project_id
        action: delete

exporters:
  otlphttp/openpanel:
    # The exporter appends /v1/metrics, /v1/logs, /v1/traces to this base.
    endpoint: https://api.openpanel.dev/telemetry
    encoding: proto                     # REQUIRED: JSON is rejected 415 on all signals
    compression: gzip                   # gzip or none. zstd is rejected 415.
    timeout: 30s
    headers:
      openpanel-client-id: <client id>
      openpanel-client-secret: sec_xxxxxxxxxxxxxxxxxxxx
    sending_queue:
      enabled: true
      num_consumers: 4
      queue_size: 1000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 60s
      max_elapsed_time: 600s

service:
  pipelines:
    metrics: { receivers: [otlp], processors: [memory_limiter, resource, batch], exporters: [otlphttp/openpanel] }
    logs:    { receivers: [otlp], processors: [memory_limiter, resource, batch], exporters: [otlphttp/openpanel] }
    traces:  { receivers: [otlp], processors: [memory_limiter, resource, batch], exporters: [otlphttp/openpanel] }
```

Four things a user will get wrong and the docs must call out:

- **Delta temporality is rejected.** gigapipe stores cumulative only (`checkTemporality`,
  `otlp_metrics.go`) and reports the rejection in `partial_success`. Any SDK configured with
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (the default for some .NET and Go
  setups) sees every data point rejected. Leave it `cumulative`, or add a `deltatocumulative`
  processor.
- **`encoding: proto`** — the default is already proto, but people copy `encoding: json` from
  debugging snippets and then get a 415.
- **`compression: zstd` is rejected 415.** The `otlphttp` exporter offers it; we do not accept it.
- **Backfill beyond 24 h is dropped**, reported in `partial_success`. A collector restarted after
  a long outage with a persistent queue will lose the oldest of it.

#### 16.2 SDK direct (no collector)

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.openpanel.dev/telemetry"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
# Per the OTel spec, values in this variable are URL-encoded.
export OTEL_EXPORTER_OTLP_HEADERS="openpanel-client-id=<id>,openpanel-client-secret=sec_xxxx"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="cumulative"
export OTEL_SERVICE_NAME="checkout"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

**Browser-side OTel is not supported.** `/telemetry` is in `corsPaths` (D16), so a cross-origin
preflight is refused. The credential is a server-side secret and must never reach a bundle.

#### 16.3 Prometheus

```yaml
remote_write:
  - url: https://api.openpanel.dev/telemetry/api/v1/write
    remote_timeout: 30s
    headers:
      openpanel-client-id: <client id>
      openpanel-client-secret: sec_xxxxxxxxxxxxxxxxxxxx
    queue_config:
      capacity: 10000
      max_shards: 10
      max_samples_per_send: 2000
      batch_send_deadline: 5s
      min_backoff: 100ms
      max_backoff: 10s
      # OpenPanel answers 429 for a hard volume quota. Prometheus drops 429s by
      # default; turn this on so a quota breach backs off instead of losing data.
      retry_on_http_429: true
    write_relabel_configs:
      # op_* is reserved by OpenPanel and stripped at the edge. Dropping it here
      # keeps your own metrics honest about what was sent.
      - regex: 'op_.*'
        action: labeldrop
    # Native histograms and exemplars are not stored — see the docs.
    send_native_histograms: false
```

Remote-write 2.0 is **not** supported and is answered 415. Do not set
`protobuf_message: io.prometheus.write.v2.Request`.

#### 16.4 Grafana Alloy / Agent

Same as Prometheus (`prometheus.remote_write` component) — endpoint, headers and
`retry_on_http_429` carry over verbatim. Not repeated.

---

### 17. Rollout, flag behaviour, and backout

**Merge order inside P1a.** The `ClientType.telemetry` enum migration widens
`validateExportRequest` (Export **and** Insights), `validateImportRequest` and MCP the moment it
merges. So the three allow-list inversions and the migration land in **one PR**, and that PR is
merged before or with the routes.

**What `TELEMETRY_ENABLED=false` does.** `telemetryRouter` registers nothing, so every
`/telemetry/*` path 404s from the Public API scope with the app's standard JSON error body — not
a `google.rpc.Status`, because no telemetry error handler is installed. That is correct and
should be documented: an exporter pointed at a disabled deployment sees a 404, which the OTLP
retry table treats as permanent, so it stops rather than hammering. Client creation with
`type: 'telemetry'` is gated on the same flag.

**Backout.** Three layers, and only two of them revert:

| Layer | Reverts? |
|---|---|
| routes, hooks, rewrite | yes — flip the flag, or revert the PR |
| minted `clients` rows with `type = 'telemetry'` | **no** — `ALTER TYPE ... ADD VALUE` is irreversible in PostgreSQL, and a build without the enum value meets an unknown variant on read. This is why creation is flag-gated: with the flag off, no such row exists and a rollback is clean. |
| telemetry already written to `gigapipe.*` in ClickHouse | **no** — see below |

**Deletion is an exit criterion, not a nicety.** `apps/worker/src/jobs/cron.delete.ts:44-47`
calls `deleteFromClickhouse(projectIds)` (`packages/db/src/services/delete.service.ts:39-72`): a
fixed table list, every one deleted with `WHERE project_id IN (…)`. **gigapipe's tables have no
`project_id` column** — the tenancy key is a label inside `time_series` and sample rows join by
fingerprint — so a by-column delete is impossible. Without a sweep, every project deletion
(including the one the wind-down cron arms via `deleteAt`) silently leaves all telemetry behind
forever, including OTLP log bodies, which will be the most PII-dense data the product has ever
stored.

This gateway owes the sweep three things, and the ops/retention work-stream owns the
implementation:

1. **A contract:** `op_project_id` is present on **every** stored series, including `target_info`
   (verified — `emitTargetInfo` copies `rs.targetAttrs`, which now always contains the stamp,
   `otlp_metrics.go:499-501`). There is no series the sweep cannot find by label.
2. **The table list:** `time_series`, `time_series_gin`, `samples_v3`, `metrics_15s`,
   `tempo_traces`, `tempo_traces_attrs_gin`, `tempo_traces_kv`.
3. **The shape:** resolve fingerprints from `time_series` by label, then
   `ALTER TABLE … DELETE WHERE fingerprint IN (…)`; traces are addressed by their own
   `op_project_id` attribute rows in `tempo_traces_attrs_gin`. Note
   `packages/db/src/services/delete.service.ts:61` already runs a cluster-aware
   `ALTER TABLE … DELETE WHERE` and is the helper to extend.

**Gate:** the sweep must exist and pass a test before `TELEMETRY_ENABLED` is turned on for any
tenant. It is not a gate on merging P1a behind the flag.

**Per-profile deletion is out of scope and stated as such.** Decision #5's `profile.id`
correlation makes per-subject erasure newly relevant for logs, and nothing in the plan covers it.
Say so before logs ship (P3), not after the first erasure request. → **ops / retention.**

---

## Interfaces

### Consumed from other work-streams

| From | What | Where it is used |
|---|---|---|
| **tenancy** (`01-tenancy-and-security.md`) | `TELEMETRY_PROJECT_LABEL = 'op_project_id'`, `TELEMETRY_RESERVED_LABEL_PREFIX = 'op_'` as `packages/constants` exports | `labels.ts` |
| **tenancy** | the project-id charset rule `^[a-zA-Z0-9_-]{1,100}$` and `assertProjectLabelValue` | `validateTelemetryRequest` (D13) |
| **tenancy** | the `subscriptionHook` status parameter (403 for telemetry, 202 for SDK routes) | `windDownHook` |
| **tenancy** | `client.rotateSecret`, if it is ever built | docs only; P1 documents delete-and-recreate |
| **ops / P0 stack** | `GIGAPIPE_INTERNAL_URL`, `QRYN_LOGIN`/`QRYN_PASSWORD` set on the gigapipe service, the port **not** published, gigapipe pinned by image digest | `upstream.ts`, boot assertions |
| **ops / retention** | the delete-by-project sweep | gate on enabling the flag |
| **billing** | `budget(project)`, the Postgres usage rollup, the authoritative ClickHouse `count()` | deferred out of P1 (§8, §13.2) |
| **testing** | a live-gigapipe contract harness and a pinned digest | §5.6 |

### Exposed to other work-streams

| To | What this work-stream guarantees |
|---|---|
| **read path, metrics engine** | Every stored series carries exactly one `op_project_id` equal to the authenticated project id. No customer-supplied label sanitizes into `op_*`. The value is a **user-derived slug**, `^[a-zA-Z0-9_-]{1,100}$` — **not a UUID** (§3). |
| **read path** | `target_info` is emitted for every OTLP metrics export and carries `op_project_id`. Hide it from metric pickers. |
| **read path** | Label values over 100 characters are truncated on remote-write and intact on OTLP, so the same logical series ingested both ways gets two fingerprints (§7). |
| **read path** | Native histograms, exemplars and remote-write metadata are never stored (§6.4). Do not offer native-histogram functions. |
| **read path / schema / billing** | Ingest is at-least-once; duplicate samples are possible and nothing dedupes them (§12). |
| **schema** | `type ∈ {1,2}` is safe **only because** this gateway does not expose `/loki/api/v1/push`. That is an enforced constraint, not an assumption (§1). |
| **schema, ops** | Timestamps are bounded to `[now−24h, now+5m]`, so no row is written into a partition retention has settled or into the future (§6.9). |
| **ops / retention** | Every stored series is findable by `op_project_id`, including `target_info`. Table list and sweep shape in §17. |
| **ui-surfaces** | `op_telemetry_rejected_total{reason}` is the only place a customer learns about delta temporality, backfill drops, native histograms and ineligible project ids. Surface it or they will report "my metrics are missing". |
| **ops, ui-surfaces** | `op_telemetry_permit_leaked_total` must stay at zero; a non-zero value is a bug in the admission wiring, not load. |

### Findings routed out (not fixed here)

1. **The compose template must not publish gigapipe's port.** The OTLP/gRPC receiver is
   multiplexed onto `PORT` and cannot be disabled (`gigapipe/docs/otlp-grpc.md:5-13`). It is the
   one place decision #1 can silently fail. → **ops / P0.**
2. **gigapipe's basic auth is conditional** (`cmd/gigapipe/main.go:321-325`). Unset credentials =
   an unauthenticated internal service, on the port the gRPC receiver shares. The compose
   healthcheck must carry the credentials, because `app.Use` covers `/ready`. → **ops / P0.**
3. **`01-tenancy-and-security.md:355` is factually wrong** — "The value is `Project.id` verbatim —
   `gen_random_uuid()`". Project ids are `slug(name)` (§3). The three constraints it derives are
   still right. → **tenancy.**
4. **`zCreateProject.name` and `zOnboardingProject.project` have no maximum length**, so new
   project ids can exceed the 100-byte label bound. → **tenancy / product.**
5. **`packages/trpc/src/routers/client.ts:86-114` never calls `getClientByIdCached.clear()`**, so
   dashboard revocation takes 300 s + 60 s rather than 60 s. One line. Listed as a P1a deliverable
   here but the file belongs to tenancy. → **tenancy.**
6. **There is no secret rotation in the product.** `zUpdateClient` and tRPC `client.update` change
   only `name`. → **tenancy.**
7. **`ClientType` deny-lists must become allow-lists**, and `validateExportRequest` guards the
   **Insights** API as well as Export (`apps/api/src/routes/insights.router.ts:52`) — and
   `export.controller.ts:26-34` gates cross-project access on `type === read`, so a forgotten
   inversion hands an ingest token org-wide export. Three docs pages enumerate exactly three
   client types: `apps/public/content/docs/api/authentication.mdx`, `docs/mcp/index.mdx`,
   `features/mcp.json`. `docs/api/track.mdx:13` also claims track requires a write/root client,
   which is false today. → **tenancy / docs.**
8. **The app-level error handler logs all request headers** (`apps/api/src/app.ts:420`), including
   `openpanel-client-secret`, at `warn` on **4xx** and `error` on 5xx, for every route whose error
   code is not in `SKIP_LOG_ERRORS`. A 401 from a mistyped secret on `/export` writes the secret
   to the log today. The telemetry plugin works around it locally (D11); it is not fixed globally.
   → **someone should fix it globally.**
9. **`subscriptionHook` answers 202 by design**, right for the SDKs and wrong for OTLP (§4). Needs
   a status parameter, and `apps/api/src/hooks/subscription.hook.test.ts` needs updating. →
   **tenancy.**
10. **Telemetry rows outlive their project** and per-profile deletion is unaddressed (§17). →
    **ops / retention.**
11. **Blast radius on the shared ClickHouse.** gigapipe writes synchronously into the same
    ClickHouse the event pipeline uses. Nothing today gives gigapipe its own ClickHouse user with
    `max_concurrent_queries_for_user` or a memory quota, and nothing states what happens to
    telemetry while the retention or delete crons run a heavy `ALTER TABLE … DELETE`. →
    **ops / P0.**
12. **Delta temporality rejection is only visible in OTLP `partial_success`.** → **ui-surfaces.**

---

## Failure modes

| # | Failure | Detection | What the user sees | Blast radius |
|---|---|---|---|---|
| F1 | **A reserved-key spelling escapes the strip** (a sanitizer changes upstream, or `isReservedKey` is edited) | Tenancy fuzz test (Test #1); the live-gigapipe contract test (§5.6) asserting the stored label set | Nothing — data silently lands in another tenant's label space, or an unqueryable one | **Tenancy breach.** Unrecoverable without rewriting fingerprints. This is the failure the whole document exists to prevent. |
| F2 | **`protobufjs` cannot resolve `long`** | Boot assertion (§6.8) + round-trip test (Test #2) | Nothing at first; weeks later, samples scattered across wrong seconds | Silent, wide corruption. The boot assertion is what makes it loud. |
| F3 | **`snappy` is framed, not raw-block** | Snappy interop test (Test #4); first integration run | Every remote-write 400s | Route-wide, immediate, obvious. Best-case failure. |
| F4 | **Admission permit leak** (a release path is missed) | `op_telemetry_permit_leaked_total > 0`; `op_telemetry_inflight` never returns to 0; abort test (Test #8) | "Telemetry stopped working after a few days" — every request 503s | Telemetry only. `/track` unaffected. Recovers on restart; the watchdog recovers it without one. |
| F5 | **gigapipe down / unreachable** | Breaker gauge `op_telemetry_breaker_open`, `op_telemetry_upstream_failures_total`, one `warn` per state change | 503 + `Retry-After: 30`. OTel and Prometheus both retry and buffer | Telemetry only. `/healthcheck` unaffected (D10), so `/track` keeps serving. |
| F6 | **Redis outage** | Existing Redis alerting | Ingest **continues** — every telemetry Redis read fails open (§4). Rate limiting degrades to `@fastify/rate-limit`'s in-process counter; metering and cardinality silently lose the window | Billing counters lose a window. No data loss, no false rejection. |
| F7 | **Deploy mid-forward** | `op_telemetry_upstream_failures_total{kind="abort"}` spike at deploy time | 503, client retries | Duplicate samples (§12), bounded by the drain budget (§10.2). |
| F8 | **A tenant creates 40M series** | `PFCOUNT` on the cardinality HLL, read by the ops dashboard cron | Nothing, in P1 — the gateway does not refuse | **ClickHouse-wide.** `time_series` / `time_series_gin` / `metrics_15s` grow unboundedly and cannot be undone. The only lever is the per-project kill switch (§4). This is the accepted P1 trade (D8) and the reason the flag ships off. |
| F9 | **Ineligible project id** (over 100 chars, or empty slug) | `op_telemetry_rejected_total{reason="invalid_project_id"}`; refused at token-mint time too | 403 with an explicit message naming the project id rule | One project. No data written, so nothing to clean up — which is the point of failing here rather than at read time. |
| F10 | **Auth brute force** | `op_telemetry_auth_failures_total{reason="lockout"}` | 429 after 20 failures in 5 min, per client id and per trusted IP | Bounded. The lockout runs before argon2, so `/track`'s event loop is not the victim. |
| F11 | **A 32 MiB gzip batch blocks the event loop** | `op_telemetry_decompress_seconds` p99; `/track` p99 regression | `/track` latency spike | Async inflate above 256 KiB (§5.3) is the mitigation. Q3 is the measurement that confirms it. |
| F12 | **PRW 2.0 sender** | `op_telemetry_rejected_total{reason="prw2"}` | 415 with a message naming PRW 1.0 | One sender. Without the 415 it would be a **204 with zero rows stored** — silent total loss (§6.4). |
| F13 | **A gigapipe bump changes a decoder** | The live-gigapipe contract suite (§5.6) fails; the digest bump is blocked | Nothing, because it never ships | This is the only mechanism that catches it. Without it, F1 by another route. |
| F14 | **Backfill/skew clamp is too tight for a legitimate client** | `op_telemetry_rejected_total{reason="timestamp_backfill"}` | `partial_success` naming the dropped count | One customer. Fixed by raising `TELEMETRY_MAX_BACKFILL_HOURS`, a support decision with a known ClickHouse-merge cost. |

### Alerting and the on-call runbook

Nine metric families is not a runbook. These four page or ticket; the rest are dashboard-only.

| Condition | Severity | First action |
|---|---|---|
| `op_telemetry_permit_leaked_total > 0` over 15 min | **page** | This is F4 and it is a code bug, not load. Restart the affected replica to clear it, then find the missing `release()` path. The watchdog should have made the restart unnecessary — if it did not, the watchdog is broken too. |
| `op_telemetry_breaker_open == 1` for > 5 min on any signal | **page** | gigapipe is down or unreachable (F5). Check the gigapipe container, then its ClickHouse connection. Customers are buffering and retrying; nothing is lost yet, but OTel Collector queues and Prometheus WALs are finite. |
| `rate(op_telemetry_requests_total{status="503"}) / rate(op_telemetry_requests_total)` > 0.2 for 10 min, with the breaker closed | **ticket** | Sustained admission rejection: `MAX_IN_FLIGHT` is too low for the offered load, or one tenant is monopolising the permits (§10.1 has no per-tenant fairness in P1). Identify the tenant from the metering hash and use the per-project kill switch (§4) if it is one. |
| A project's `PFCOUNT` crosses 10× its 7-day median | **ticket** | F8. The gateway will not refuse in P1. Contact the customer; if the instance is at risk, set `telemetry:disabled:{projectId}` with a TTL and tell them why. |

Dashboard-only, but the first things to look at during any of the above:
`op_telemetry_rejected_total` by reason (a spike in `timestamp_backfill` means someone is
draining a queue, in `invalid_project_id` means a project was renamed),
`op_telemetry_upstream_seconds` p99 (gigapipe slow rather than down),
`op_telemetry_decompress_seconds` p99 (F11, and the input to Q4), and
`op_telemetry_auth_failures_total{reason="lockout"}` (F10).

**What never pages:** anything on gigapipe's own health that is not the breaker. gigapipe is
deliberately outside `/healthcheck` (D10), and a gigapipe outage must never be able to restart
the process that serves `/track`.

---

## Test requirements

`apps/api` already has the right harness and the draft pointed at the wrong one. `createCaller`
is a tRPC construct; these are Fastify routes. The precedent is
**`apps/api/src/routes/insights.router.test.ts`** — it boots `buildApp({ testing: true })`, mocks
exactly the three things telemetry auth needs (`getClientByIdCached`, `verifyPassword`,
`getCache`/`getRedisCache`) and asserts on auth outcomes. Fixtures live in
`apps/api/src/tests/setup.ts` and `test/global-setup.ts`. Note `testing: true` skips
`metricsPlugin` (`app.ts:371-373`) and `@fastify/rate-limit` falls back to in-memory storage under
`NODE_ENV=test`. `packages/trpc/src/routers/share.test.ts` stays as the precedent for the
*assertion shape* of an access-control regression test, not the mechanism.

**Must pass before P1a merges:**

1. **Tenancy fuzz — the test that makes decision #2 real.** Table-driven, one case per hostile
   shape × placement × signal. Keys: `op_project_id`, `op.project.id`, `op-project-id`,
   `op project id`, `op/project/id`, `OP_PROJECT_ID`, `0op_project_id`, `op_anything_else`.
   Placements: resource, scope, data point, log record, **span**, **span event**, **span link**,
   remote-write label. Assertion: the rewritten payload contains **exactly one** `op_project_id`
   and its value is the authenticated project. Explicitly include `op.project.id` on a **span**
   — that is the case the draft's per-path sanitizer rule would have missed (§6.0).
2. **64-bit round-trip.** Decode → encode → decode a `timeUnixNano` of `1756500000123456789`;
   assert byte equality of the re-encoded buffer. Plus the boot assertion in `configure.ts`.
3. **Golden-file re-encode, including an unknown field.** Capture a real OTLP batch from a
   collector, run it through the rewrite with a no-op stamp, decode both and deep-equal. Run one
   case whose span carries a field absent from the pinned proto, and **assert what is lost** —
   §5.5 says traces lose it (gigapipe would have kept it in `payload`); the test measures the gap
   rather than assuming it.
4. **Snappy interop.** `snappy.compressSync(buf)` → a checked-in fixture produced by
   `golang/snappy.Encode`, and the reverse. Raw-block vs framed is the likely first bug.
5. **Auth matrix**, via `fastify.inject()` against `buildApp({ testing: true })`: wrong client
   type → 403; missing secret → 401; wrong secret → 401 then 429 after the lockout threshold;
   valid → 200; **deleted client rejected within the documented window** (with
   `getClientByIdCached.clear()` wired); ineligible project id (>100 chars, empty) → 403
   `invalid_project_id`.
6. **Allow-list inversions.** `apps/api/src/utils/auth.ts` has **no test file today** (only
   `ids.test.ts` and `image-proxy.test.ts` exist in that directory), so each inversion ships with
   a new negative test: a `telemetry`-typed client is rejected by `validateExportRequest`,
   `validateImportRequest` and `packages/mcp/src/auth.ts`. Note `packages/mcp/src/auth.test.ts:8`
   mocks `ClientType` as a plain object literal, so it will **not** catch a missing case.
7. **Body-limit precedence.** POST 3 MiB of snappy to `/telemetry/api/v1/write`, expect **413**.
   This is the test that settles the `UNVERIFIED:` claim in §5.2 about content-type-parser
   `bodyLimit` overriding the route's. Run it before relying on either cap.
8. **Abort releases the permit.** Send `MAX_IN_FLIGHT` requests, abort each mid-body, assert
   `op_telemetry_inflight` returns to 0 and the next request is admitted. Then a variant where
   the release hook is deliberately unwired, asserting the watchdog reclaims and
   `op_telemetry_permit_leaked_total` increments.
9. **Upstream-down.** `forward()` mocked to reject: assert 503, `Retry-After` present, and — the
   assertion that matters — **no 200 and no `partial_success`**.
10. **Redis outage does not change admission.** With every Redis call rejecting, a request from a
    project that is under budget and not disabled still returns 200. This is the test for the §4
    fail-open/fail-closed invariant.
11. **Shutdown.** `setShuttingDown(true)` → 503 + `Retry-After`, not a hung request. Plus the boot
    assertion that the timeout budget fits inside the drain window.
12. **429 content type.** Exceed the rate limit on an OTLP route and assert the body is a
    `google.rpc.Status` with `Content-Type: application/x-protobuf`, not JSON. This is what proves
    the plugin-local limiter (§9.1) actually replaced `activateRateLimiter`.
13. **415 matrix.** `application/json` on all three OTLP routes; `Content-Encoding: zstd`;
    `Content-Encoding` absent on remote-write; `proto=io.prometheus.write.v2.Request`.
14. **Timestamp window.** A data point 48 h old and one 1 h in the future are dropped and counted;
    a point 23 h old survives; the enclosing metric/scope/resource is pruned when it empties
    (§6.7); an all-dropped batch answers 200 + `partial_success` **without forwarding**.
15. **Nil guards.** A `ResourceSpans` with no `resource` and a `KeyValue` with no `value` both
    survive the rewrite and produce a well-formed payload — these are the two nil-derefs inside
    gigapipe (§6.5) and the gateway is what prevents them.

**Must exist before `TELEMETRY_ENABLED` is turned on for any tenant:**

16. **Live-gigapipe contract suite** (§5.6, testing work-stream harness): ingest a fixture through
    the real gateway into a pinned gigapipe, then assert against ClickHouse that the stored label
    set is exactly what §6 predicts — including the histogram fan-out count, `target_info`
    carrying `op_project_id`, and the remote-write 100-character truncation.
17. **Delete-by-project sweep** (§17): write telemetry for two projects, delete one, assert zero
    rows remain for it across all seven gigapipe tables and that the other project is untouched.
18. **Load / soak.** `/track` p50 and p99 measured with the gateway at `MAX_IN_FLIGHT` with
    maximum-size gzip bodies, against the same numbers with the gateway idle. This is the number
    that decides the sync-vs-async inflate question (Q3), and nothing else does.

---

## Open questions

| # | Question | What would settle it | Blocks |
|---|---|---|---|
| **Q1** | Does a retried batch double-count in the read path? `samples_v3` is a plain `MergeTree` with no dedup (`ctrl/qryn/sql/log.sql:25-32`), and `metrics_15s` is an insert-triggered `AggregatingMergeTree` (`:146-158`) with no retraction. | Insert the same batch twice into a live gigapipe; run the metrics engine's own `rate()` and the billing `count()` over it. Owned by read-path + schema. | Nothing in P1a. Billing accuracy and the read path's aggregation contract. |
| **Q2** | Does `snappy@^7` install from prebuilt binaries under pnpm with `allowBuilds` disabled, on both `linux/amd64` and `linux/arm64`? | Add the dep, run `apps/api`'s Docker build for both platforms. Fallback is `snappyjs` (pure JS). | **P1a start.** Decide the fallback before writing `remote-write.ts`. |
| **Q3** | Is `snappy.compressSync` raw-block or framed? | Test #4. | **P1a start** — it changes which library is used. |
| **Q4** | What is `/track`'s p99 regression with the gateway at `MAX_IN_FLIGHT` under maximum-size gzip bodies? | Test #18. Explicitly **not** "p99 of one `gunzipSync`", which cannot detect the shared-event-loop problem the sync path creates. | The 256 KiB sync fast-path threshold, and whether D9's lift-out gets scheduled at all. |
| **Q5** | Does `fastify-metrics@12` expose a registry a bare `new client.Counter()` lands in? `apps/api` declares no `prom-client`. | Read its exports after an install; otherwise copy `apps/worker/src/metrics.ts:14-16`'s explicit `new Registry()`. | P1b metrics only. |
| **Q6** | Does a content-type parser's `bodyLimit` override the route's in Fastify 5? | Test #7. Until then the `Content-Length` gate in `contentGate` is the cap that is written down. | Nothing — the design already does not rely on the parser limit. |
| **Q7** | Is PRW 2.0's `Request` really `reserved 1 to 3; symbols = 4; timeseries = 5`? Neither checkout vendors the v2 proto and `prometheus/prometheus` is not in this machine's Go module cache. | Read `prometheus/prometheus@v0.314.0`'s `prompb/io/prometheus/write/v2/types.proto`. | Only the *explanation* in §6.4. The 415 is correct either way. |
| **Q8** | Does Prometheus honour `Retry-After` when `retry_on_http_429: true`? | Read the pinned Prometheus version's `remote_write` docs. | Doc text only. |
| **Q9** | Where does per-plan `budget(project)` come from, and what is the authoritative series count? | Billing work-stream, using the `time_series` query in §8. | P6 enforcement. Nothing in P1. |
| **Q10** | Org-level telemetry tokens (one collector, many projects)? | Every existing ingest surface is project-scoped (`validateSdkRequest` requires `client.project`, `auth.ts:94-96`). An org token means a **request-supplied** `projectId`, which reopens the exact trust question decision #2 closes by taking it from the token. **Recommendation: no. Mint one token per project.** | Nothing. Recorded so it is not re-litigated. |
| **Q11** | Does the ClickHouse user gigapipe connects as need its own quota (`max_concurrent_queries_for_user`, memory) so telemetry cannot starve the event pipeline? | Ops work-stream, against the self-hosting ClickHouse config. | Enabling the flag on a shared instance. |

---

## Effort

Sized for one engineer already familiar with `apps/api`. Ranges are p50–p80.

### P1a — the tenancy boundary. Nothing here can be retrofitted.

| Work | Size |
|---|---|
| `ClientType.telemetry` migration + three allow-list inversions + four write surfaces (`zCreateClient`, tRPC `client.create`, `add-client.tsx`, `create-client-success.tsx`) + `client.remove` cache clear + negative tests | 2–3 d |
| Proto vendoring: pick versions, `pbjs`/`pbts` codegen, `configure.ts`, the `codegen:proto` CI clean-tree check, `tsdown` externals, direct deps | 2–4 d |
| Plugin skeleton: routes, hook chain, content-type parser, `contentGate`, decompression (incl. snappy), error handler, response encoders (`google.rpc.Status` + three `Export*ServiceResponse`) | 3–4 d |
| `validateTelemetryRequest` + lockout + plugin-local verify cache + project-id validation | 1–2 d |
| The four rewrites + `scrubAttrs` + structural limits + timestamp window + empty-container pruning + nil guards | 4–6 d |
| Error semantics: the full status table, `partial_success` merging, gigapipe response synthesis for logs/traces | 2 d |
| Tests 1–15 | 4–6 d |
| **P1a total** | **≈ 3.5–5.5 weeks** |

**The one test that proves P1a is done is Test #1**, the tenancy fuzz matrix. If it passes on all
three OTLP signals and remote-write, at every placement, for every hostile spelling, the
load-bearing half of this work-stream is finished.

### P1b — reliability and observation. Useful, deferrable, retrofittable.

| Work | Size |
|---|---|
| Admission counter + idempotent release + watchdog + shutdown hook + boot assertions | 2 d |
| Circuit breaker + `/telemetry/health` | 1–2 d |
| Plugin-local `@fastify/rate-limit` with signal-aware 429 bodies | 1 d |
| Cardinality `PFADD` recording + metering Redis hash + kill switch | 2 d |
| 12 Prometheus metric families | 1 d |
| Tests 8, 10, 11, 12, 18 | 2–3 d |
| **P1b total** | **≈ 1.5–2 weeks** |

### Not in P1, and named so nobody assumes them

Cardinality **enforcement** (D8), the Postgres usage rollup and its Prisma model (§13.2),
`budget(project)` (Q9), OTLP/JSON (D12), Loki push / Influx / Datadog / Zipkin ingest (§1),
OTLP/gRPC (§1), per-project admission fairness (§10.1), secret rotation (§2.2), per-profile
deletion (§17), the `apps/otel-gateway` lift-out (D9).

### Three things that must be resolved before P1a starts

Q2 (snappy prebuilds), Q3 (snappy framing) and the proto version pin. Each can independently cost
a week if discovered mid-implementation, and all three are cheap to settle first: add the deps,
run the Docker build for both platforms, write the interop fixture.

### What could make this bigger

| Risk | Cost if it lands |
|---|---|
| `snappy` has no usable prebuilds and `snappyjs` is too slow at 2 MiB | +3–5 d, or a native-build stage in `apps/api/Dockerfile` |
| protobufjs static-module output does not tree-shake and `apps/api`'s bundle or cold start regresses meaningfully | +2–4 d to switch to hand-written encoders for the handful of messages we mutate |
| The live-gigapipe contract harness (§5.6) does not exist yet in the testing work-stream | +4–6 d to build it here, and it is not optional — it is the only defence against F13 |
| Q4 shows a `/track` p99 regression the async fast path does not fix | +2–3 w for the `apps/otel-gateway` lift-out (D9), across four deployment surfaces |
| The delete-by-project sweep (§17) turns out to need a fingerprint index the schema does not have | ops work-stream, but it **gates enabling the flag**, so it lands on this critical path |
| Project-id preconditions prove unworkable and the derived-token fallback (§3) is taken | +1 w, and it must happen **before** any telemetry is written, because `op_project_id` is baked into gigapipe's fingerprint |
