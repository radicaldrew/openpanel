# Testing strategy

The observability work adds one security boundary implemented as a string
(`op_project_id`), one type contract about to be produced by a second engine
(`FinalChart`, which has zero test coverage today), and one external Go service
we do not control (gigapipe). This document says which test file each of those
gets, what it asserts, which existing pattern in this repo it copies, whether it
runs on every push or nightly, and what a phase may not merge without. Three
things are load-bearing and everything else follows from them: **the tenancy
strip rule is *computed*, never looked up in a table of spellings** — gigapipe's
sanitizer collapses any non-`[a-zA-Z0-9_]` *rune* to `_`, so `op‑project‑id`
with en-dashes and `opіprojectііd` with Cyrillic separators are both real
aliases and no enumerated ASCII list can ever be complete; **the one end-to-end
isolation proof runs on every push and fails closed in CI**, in a Vitest project
that this document creates, because root-level `test/` is not currently
collected by anything; and **every absence assertion is preceded by a presence
assertion through the same read path**, because "project B sees nothing" is
satisfied by "nothing was ever written".

Every OpenPanel line number below was read at `247744a8`. Every gigapipe line
number was read at the working tree and the cited behaviour is present in the
pinned tag `v5.4.1`. Claims I could not settle from disk say `UNVERIFIED:` and
name the experiment. Where a reviewer's correction changed a decision, the
decision says so.

### Revision note — what this pass settled, and what other documents must now change

A cross-document review found this file asserting things two or three sibling
specs had already contradicted, and in three places turning a **known-broken**
construction into a required CI gate. Those are fixed here, against the source,
not split-the-difference. The settlements that other documents have to absorb
are collected in one place so nobody has to reverse-engineer them from a diff:

| Settled | Where it now lives | Documents that must change |
|---|---|---|
| `packages/gigapipe` for transport/labels/compilers; ingest codecs stay in `apps/api/src/telemetry/`; ClickHouse-side helpers in `packages/db/src/clickhouse/telemetry-client.ts` | **D18** (adopting `04-read-path.md` D1 as amended by 04's own reconciliation row 13) | `05-logs.md`'s file table; `03-metrics-engine.md:2113` |
| The strip predicate is `isReservedKey(key)` — **one argument**, three forms, `op_` prefix | **D7** (adopting `02-ingest-gateway.md` §6.0) | `01-tenancy-and-security.md` §5 (delete the `protocol` parameter) and its T1.2 traces row, which currently asserts the behaviour 02 argues is a bypass |
| The log write path is 05's decode-and-construct design, not 02's forward-in-place | **D17** | `01-tenancy-and-security.md` §4.4/§4.8's logs row; `02-ingest-gateway.md` §1's route table and its `type ∈ {1,2}` premise |
| One deletion function, `deleteTelemetryFromClickhouse`, non-throwing, called inside `deleteFromClickhouse`, **seven** tables, in **P1** | **D20** | `05-logs.md` §7.4 (`purgeTelemetry`/`TelemetryPurgeJob`); `06-traces-and-correlation.md` §11.6 (`deleteTelemetryForProjects`); `08-schema-changes.md` §4's phase heading |
| `getReplicatedTableName` is **never** applied to a gigapipe table; the helper is `gigapipeTable(name, 'read' \| 'mutate')` | **D20**, I14, failure-mode 10 | this document's own previous I14, which required the opposite |
| A wind-down-blocked ingest answers **403**, not 429 | **§3.3 A15** | this document's own previous A15; `05-logs.md` §4.3's 200/204/404 |
| One verification-cache shape: key on the client id, hash+digest in the value, TTL 60 s | **§3.3 A17/A18** (adopting `01-tenancy-and-security.md` §6.1) | `02-ingest-gateway.md` §2.2; `05-logs.md` §4.2 |
| `ADVANCED_OMIT_EMPTY_VALUES=true`, set explicitly in every gigapipe service including the test stack | **§2.3**, W7, gate 0.13 | `05-logs.md:1847` (`false`); `10-ops-retention-billing.md` §3 has no row for it at all |
| `CLOKI_LOGIN`/`CLOKI_PASSWORD` on the container, `GIGAPIPE_USER`/`GIGAPIPE_PASSWORD`/`GIGAPIPE_URL`/`GIGAPIPE_DB` on the OpenPanel side | **D19**, gate 0.14 | `02-ingest-gateway.md` §15 (`GIGAPIPE_LOGIN`, `GIGAPIPE_INTERNAL_URL`); `04-read-path.md` §3 (`GIGAPIPE_USERNAME`); this document's own `QRYN_*` compose and gate 1.7 |
| The test stack bootstraps with **migration 22**, not a `gigapipe-provision.sql` that `10-ops-retention-billing.md` D3 rejected | **D10**, W7 | this document's own previous D10 and Interfaces row |
| 11 is a **standards-and-harness** document; feature streams author their own unit suites | **D21**, § Effort | none — it removes ~12.5 d of double-counting from this document's budget |
| No `apps/start` Vitest project; an event-path `createCaller` regression pack instead | **D22**, §5.5 | `09-ui-surfaces.md` Q5 closes; its T3 extracts the pure fold, T5–T8 become a manual-QA checklist |

**There is no `00-blueprint.md`.** Several of the review's proposed fixes said
"record it in the blueprint"; `ls docs/observability/` returns `01` through `11`
and a `_drafts/` directory, and `grep -rn "00-blueprint" *.md` returns nothing.
Until such a document exists the settlements above live here, in the document
that has to test them, and the spike sheet the review asked for is § Open
questions' first table.

---

## Decisions

### D1. Four tiers, decided by what infrastructure the test needs

| Tier | Needs | Where it runs | Budget |
|---|---|---|---|
| **T0** pure | nothing | every push, in `pnpm test` | under ~1 s per file |
| **T1** infra | Postgres + Redis + ClickHouse (already CI service containers) | every push, in `pnpm test` | seconds |
| **T2** gigapipe | a gigapipe container + its own ClickHouse | **one suite** every push; the rest nightly | minutes |
| **T3** stack | the built images, full compose | a **new, non-blocking** `smoke-observability` job + nightly | ~10 min |

The tier is a property of the test's dependencies, not of its subject matter.
The tenancy strip is T0. Metadata `EXPLAIN` is T1. "Project B cannot see project
A's series through the real reader" is T2.

**Rejected:** a `unit` / `integration` / `e2e` split by intent. The repo does not
use those words anywhere, and the useful question at 3 a.m. is "what do I have to
have running", which is exactly the tier.

### D2. T2 suites live in their own Vitest project. Root `test/` is not collected today.

This corrects the draft, which placed every T2 suite at `test/telemetry/*.test.ts`
and assumed `pnpm test` would find them. It would not. `package.json:10` is
`"test": "vitest run"`; `vitest.workspace.ts` is exactly:

```ts
export default ['packages/*', 'apps/*', '!apps/start'];
```

Root `test/` matches neither glob, which is why `find test -name '*.test.ts'`
returns nothing today — `test/` holds only `fixtures.ts`, `global-setup.ts`,
`retention-fixtures.ts` and `test-setup.ts`. A security gate placed there would
collect zero tests, `pnpm test` would stay green, and the fail-closed guard would
never even be loaded. That is failure mode 1 of this document, shipped by the
document itself.

**The fix, specified concretely.** Two changes, both prerequisites for P1:

```ts
// vitest.workspace.ts
export default ['packages/*', 'apps/*', '!apps/start', 'test/telemetry'];
```

```ts
// test/telemetry/vitest.config.ts   (new)
import { getSharedVitestConfig } from '../../vitest.shared';

export default getSharedVitestConfig({ __dirname });
```

`getSharedVitestConfig` resolves `setupFiles` as
`path.resolve(__dirname, '../../test/test-setup.ts')` (`vitest.shared.ts:5`), and
from `test/telemetry/` that is exactly `<repo>/test/test-setup.ts`. The project
therefore inherits the shared connection cleanup and the pinned
`DATABASE_URL`/`CLICKHOUSE_URL`/`REDIS_URL`/`SELF_HOSTED` env (`vitest.shared.ts:20-27`)
with no special casing.

The nightly path exclusion goes in **that** config, not in `vitest.shared.ts`.
The draft put it in the shared factory, where each package instantiates it with
its own `__dirname`, so `'test/telemetry/{contract,retention,erasure}.*.test.ts'`
would resolve against `packages/db/`, `apps/api/` and so on, and match nothing
anywhere:

```ts
// test/telemetry/vitest.config.ts
import { getSharedVitestConfig } from '../../vitest.shared';

const base = getSharedVitestConfig({ __dirname });
export default {
  ...base,
  test: {
    ...base.test,
    // Only tenancy.isolation runs per push. The rest is nightly.
    exclude: process.env.TELEMETRY_NIGHTLY
      ? ['**/node_modules/**']
      : ['**/node_modules/**', '**/{contract,retention,erasure}.*.test.ts'],
  },
};
```

**Rejected: colocating T2 suites inside `packages/db` or `apps/api`.** It works,
but the nightly exclusion then has to be expressed inside a package that also
holds per-push suites, and the shared `test/telemetry/` fixtures would import
across a package boundary. A dedicated project keeps both legible.

**Rejected: vitest tag filtering.** A forgotten tag on a nightly-cost suite makes
every push five minutes slower; a forgotten tag on the security suite makes it
never run. Neither failure is visible. Path exclusion is one line in one file.

### D3. The isolation proof runs on every push, fails closed in CI, and its *collection* is itself gated

One T2 suite — `test/telemetry/tenancy.isolation.test.ts` — runs on every push.
A boundary verified once a day ships broken for up to a day; a nightly-only proof
is a report, not a gate.

**Rejected: the repo's existing skip-if-unreachable guard, applied verbatim.**
`packages/db/src/services/chart-sql.test.ts:68-76` defines an `itCH` that
`return`s early when ClickHouse is unreachable, which reports **PASS**, not SKIP.
A typo in `GIGAPIPE_TEST_URL` turns the tenancy proof into a permanently green
no-op.

**Rejected, and this corrects the draft: resolving reachability in `globalSetup`
and stashing it on `globalThis`.** `globalSetup` runs in the Vitest parent
process, not in the worker that collects and runs the file — the repo documents
exactly this at `test/global-setup.ts:12-13` ("globalSetup runs in the parent
process before vitest workers start, so vitest's `env` config is not applied").
`globalThis` does not cross that boundary. The flag would be `undefined` in every
worker, so the guard would take its `not ready` branch unconditionally: red in CI
even with a healthy container, `describe.skip` on a laptop with the stack up. The
guard would fail closed on itself.

**What is shipped instead** (§2.1): a two-channel decision. `run.sh up` performs
the health probe and exports `OP_GIGAPIPE_READY=1` (into `$GITHUB_ENV` in CI),
which is a plain environment variable and therefore inherited by every worker;
the guard reads it **synchronously at collection time**. A live probe then runs
in `beforeAll` and throws if the env says ready but the service is not, which is
the case env vars cannot catch. Both channels genuinely cross the process
boundary; neither is `globalThis`.

Because "the guard is correct" and "the file was collected" are different
properties, a third check exists: **gate 1.0**, a CI step that runs
`vitest list --project telemetry` and greps for `tenancy.isolation.test.ts`, and
asserts the JSON reporter recorded a non-zero test count for that file. Without
it, failure mode 1 is mitigated by assumption.

### D4. CI trigger: a new scoped workflow, not a deletion from `paths-ignore`

This reverses the draft's D3 on measured grounds. `docker-build.yml:5-30` lists
`"**/*.test.*"`, `"**/*.spec.*"`, `"**/__tests__/**"` and `"**/tests/**"` under
`paths-ignore`, so a push touching only test files triggers **no run at all** —
real, and unacceptable for a work-stream whose deliverable is largely tests.

But deleting those four globs does not merely re-run `lint-and-test`.
`build-api` (`:130`), `build-worker` (`:298`) and `build-dashboard` (`:417`) each
declare `needs: lint-and-test` with a **two-architecture matrix and no `if:`
guard**, and each pushes an image digest to ghcr; `smoke` (`:192`) then boots all
three. Only the `merge-*` jobs are gated on `github.ref == 'refs/heads/main'`
(`:282`, `:401`, `:520`). A test-only push under the deletion therefore triggers
seven extra jobs including six buildx builds and six registry pushes. The
draft rejected the cheaper option on a cost argument that was inverted.

**Shipped:** `.github/workflows/tests.yml`, a new workflow triggered on
`push` with `paths: ['**/*.test.*', '**/*.spec.*', 'test/**', 'vitest.*.ts',
'.github/gigapipe-pin.json']`, running exactly the `lint-and-test` steps plus
`run.sh up`. `docker-build.yml`'s `paths-ignore` is left alone. One extra job on
test-only pushes; zero extra image builds.

**Rejected:** deleting the globs and adding `if:` guards to the three build jobs.
It is the same outcome through a more fragile mechanism — a guard expression on
three jobs that a future edit can silently drop, versus a workflow whose entire
existence is the guard.

`**/docs/**` stays in `paths-ignore`, which is why **D14's pin file lives in
`.github/`, not in `docs/observability/`**.

### D5. Golden strings are literals in the test file. No snapshots, ever.

`grep -rn "toMatchSnapshot\|toMatchInlineSnapshot\|__snapshots__"` over the repo
returns **zero hits** (verified). The established pattern is a literal expected
string: `packages/db/src/clickhouse/query-builder.test.ts:20-27` and
`packages/db/src/services/filter-where.test.ts:57-62`.

For a PromQL compiler this is not a style preference. `vitest -u` silently
blesses a dropped `op_project_id` matcher; that is a cross-tenant read committed
by a keystroke.

### D6. Rewritten-query assertions are structural, over a re-parsed tree

`expect(out).toContain('op_project_id')` passes for
`up{op_project_id="p1"} or up`, which leaks everything. Every compiler test ends
with a shared helper (`packages/gigapipe/src/query/__test__/assert-scoped.ts`)
that parses the output with `@prometheus-io/lezer-promql`, walks **every**
`VectorSelector`, and requires each to carry exactly one `op_project_id` matcher
whose `MatchOp` is `=` and whose value is the project id. It also fails if the
parse produced any error node — lezer parsers are error-tolerant and never throw,
so a malformed expression otherwise "parses cleanly".

### D7. The tenancy strip rule is computed, not enumerated. This corrects the draft.

The draft specified a 169-entry alias table (`op<X>project<Y>id` over 13 ASCII
separators) and justified a byte-wise JS sanitizer on the grounds that "Go's
`regexp.ReplaceAllString` with a byte-class pattern operates on bytes". **That is
false**, and following it would have produced a live tenancy bypass. Go's
`regexp` is rune-oriented over UTF-8: `[^a-zA-Z0-9_]` matches one *rune*. I
compiled gigapipe's exact `SanitizeKey` (`writer/utils/unmarshal/otlplogs.go:105-117`)
and ran it:

```
"op_project_id"            -> "op_project_id"
"op.project.id"            -> "op_project_id"
"op project id"            -> "op_project_id"
"op project id"  -> "op_project_id"   (NBSP)
"op–project–id"  -> "op_project_id"   (en dash)
"op　project　id"  -> "op_project_id"   (ideographic space)
"opіprojectіid"  -> "op_project_id"   (Cyrillic і)
"op\U0001F600project\U0001F600id" -> "op_project_id"  (emoji, 4 bytes)
```

Every one of those is a working alias for `op_project_id`, none is in a
13-entry ASCII list, and on the logs path a record attribute is merged **last**
(`otlplogs.go:46`, map write at `:100`) so it overrides the resource stamp. A
gateway that strips by matching an enumerated table is bypassable with an
en-dash.

**The rule the gateway implements, and the only rule this suite accepts:**

```ts
// packages/gigapipe/src/labels.ts
import { TELEMETRY_RESERVED_LABEL_PREFIX } from '@openpanel/constants'; // 'op_'

/** Byte-for-byte replica of gigapipe SanitizeKey (otlplogs.go:107-117). */
export function sanitizeOtlpKey(key: string): string {
  const s = key.replace(/[^a-zA-Z0-9_]/gu, '_');
  return s.length === 0 || (s[0]! >= '0' && s[0]! <= '9') ? `_${s}` : s;
}

/** Replica of gigapipe sanitizeLabels' key rule (unmarshal.go:272-278). */
export function sanitizeWireKey(key: string): string {
  return key.replace(/^[^a-zA-Z_]|[^a-zA-Z0-9_]/gu, '_');
}

/**
 * THE strip predicate. One argument. Computed, never enumerated, and never
 * branched on the protocol. There is no alias list anywhere.
 */
export const isReservedKey = (key: string): boolean =>
  key.startsWith(TELEMETRY_RESERVED_LABEL_PREFIX) ||
  sanitizeOtlpKey(key).startsWith(TELEMETRY_RESERVED_LABEL_PREFIX) ||
  sanitizeWireKey(key).startsWith(TELEMETRY_RESERVED_LABEL_PREFIX);
```

**Two corrections to the draft of this decision, both forced by sibling specs
and both verified against gigapipe's source.**

*The predicate takes no `protocol`.* The draft's `isReservedKey(key, path)` and
`01-tenancy-and-security.md` §5's `isReservedKey(key, protocol)` are the same
mistake at different granularity, and `02-ingest-gateway.md` §6.0 is right about
where it bites: on **OTLP traces** gigapipe applies no sanitizer at all
(`writer/utils/unmarshal/otlp.go:135-151`), so a per-protocol predicate compares
the *raw* key there — and a span attribute literally named `op.project.id`
would not be stripped, would land in `tempo_traces_attrs_gin` under its raw name
and inside the `proto.Marshal`ed payload, which is precisely the lie the traces
strip exists to prevent. Testing all three forms unconditionally costs two regex
passes per attribute and deletes a whole class of "which sanitizer applies here"
reasoning from a security boundary. **This changes a decision
`01-tenancy-and-security.md` depends on:** its §5 must drop the `protocol`
parameter, and its **T1.2 must lose the row asserting
`isReservedKey('op.project.id','otlp-traces') === false`** — under the settled
predicate that row asserts a bypass.

*The reserved set is a prefix, not two literals.* The draft's two-element
`RESERVED` set would pass `op_organization_slug`, `op_session_id` and every
future reserved key. `01-tenancy-and-security.md:296`, `02-ingest-gateway.md`
§6.0 and `03-metrics-engine.md` §2 all test
`startsWith(TELEMETRY_RESERVED_LABEL_PREFIX)` (`'op_'`), and
`06-traces-and-correlation.md:573` reserves three keys in that namespace. The
prefix is the specification; the cost is the customer-visible `op_*` label
namespace, which is documented, not accidental.

*Name and home, settled:* `isReservedKey`, in
`packages/gigapipe/src/labels.ts` (D18). `02-ingest-gateway.md` currently
declares it as `isReserved` in `apps/api/src/telemetry/labels.ts` — a fourth
location for one security primitive — and imports it from
`apps/api/src/telemetry/rewrite/attrs.ts`. The rewrite modules stay in
`apps/api` (D18); the predicate they import does not.

A JS `String.prototype.replace` with a `u`-flagged `[^a-zA-Z0-9_]` class
**agrees** with Go, rune for rune. That agreement is what the parity property
test asserts; it is not something the implementation has to work around.

The 169-row table is demoted to what it is: **a regression corpus**, not the
specification. It is cut to a representative set (§3.1) and a **source-level
assertion is added that no hardcoded alias list exists in the strip path**,
because with the computed rule the alias set is closed by construction and an
exhaustive table over one equivalence class is 169 tests of the same thing.

### D8. The protobuf rewrite is tested with committed binary fixtures plus a mock upstream; no gigapipe needed

Two halves, both T0. **Input**: `apps/api/src/telemetry/__fixtures__/*.bin`, real
OTLP export bodies produced once by a checked-in generator and committed, each
with a `.json` sidecar recording what it contains in readable form. **Output**:
`startMockUpstream()`, a bare `node:http` server that records the request
(headers, raw body) and replays a canned response; the test decodes what the mock
received and asserts on the **decoded object**, never on bytes.

**Rejected: asserting on re-encoded bytes.** protobuf field ordering and
default-value elision are not stable across library versions, so byte assertions
break on a `protobufjs` bump for no semantic reason.

**Rejected: `nock` / `msw`.** Neither is a dependency of this repo, and the thing
under test is `undici`/`fetch` behaviour at the socket level — header allow-list,
`Content-Type` byte-exactness, body framing — which a request-interception
library abstracts away precisely where the bugs are.

### D9. gigapipe runs via `docker compose` from a workflow step, not as a service container

`initDB` calls `ctrl.Init`, which `panic(err)`s (`cmd/gigapipe/main.go:74-77`;
`ctrl/ctrl.go:31-34`). If ClickHouse is not accepting connections when gigapipe
boots, the process dies. GitHub service containers have `options: --health-cmd`
but no `depends_on: condition: service_healthy` between services, so ordering is
a coin flip. Compose gives health-gated ordering, exactly as gigapipe's own
`test/integration/` harness does.

**Rejected:** testcontainers. Not a dependency of this repo, and both precedents
(`.github/smoke/docker-compose.yml`, gigapipe's `test/integration/`) are plain
compose.

Both pinned images publish `linux/arm64` (verified against the registries:
`ghcr.io/metrico/gigapipe:v5.4.1` and `clickhouse/clickhouse-server:25.10.2.65`
are both OCI indexes carrying amd64 **and** arm64). `run.sh` therefore works on
darwin/arm64 without qemu, which settles the draft's platform gap.

### D10. `MODE=init_only` is the schema bootstrap in tests, exactly as in production

`cmd/gigapipe/main.go:306-312` runs `initDB` and returns **before**
`mux.NewRouter()`: no routes, no listener. That is what a test stack wants for
"create the schema, then exit 0", and it is what `10-ops-retention-billing.md` D3
specifies for production. Using it in the test stack means the test stack
exercises the production schema lifecycle. It writes no data and serves no
traffic — it is not a seeding mechanism.

**The pre-create step is migration 22, not a provision container. This corrects
the draft, which depended on an artifact ops explicitly rejected.** The draft
ordered `tg-provision → tg-init`, with a `tg-provision` container mounting
`self-hosting/clickhouse/gigapipe-provision.sql`, and had W7 assert the test copy
was byte-identical to the shipped one. **That file will never exist.**
`10-ops-retention-billing.md` D3 rejects "a third `op-gigapipe-provision`
container mounting `gigapipe-provision.sql`" by name, and
`08-schema-changes.md` S6 puts the pre-create DDL — `CREATE DATABASE`, plus
`samples_v3` and `metrics_15s` with `type` in the `PARTITION BY` — in
`packages/db/code-migrations/22-telemetry-database.ts`, run inside `op-api`'s
startup command (`08:1258`, `jiti ./code-migrations/migrate.ts
22-telemetry-database.ts`). W7 as drafted could never pass, and gate 0.2 would
have been proved by a mechanism that does not ship.

Worse, the draft's ordering did not match production's. Production is
`migration 22 (inside op-api) → op-gigapipe-init`; the draft's stack was
`tg-provision → tg-init`. The one-way door both `08-schema-changes.md` §10 and
`05-logs.md` §7.1 identify — migration 22 losing the race to gigapipe's
`CREATE TABLE IF NOT EXISTS`, after which the partition key is wrong forever —
was therefore untested by construction.

**Shipped instead:** `run.sh` brings the stack up in three stages, running the
**real** code-migration in the middle, exactly as production does:

```bash
docker compose up -d --wait tg-ch                     # 1. ClickHouse healthy
CLICKHOUSE_TELEMETRY_URL="http://localhost:9199/gigapipe" \
  pnpm --filter @openpanel/db exec \
  jiti ./code-migrations/migrate.ts 22-telemetry-database.ts   # 2. OUR DDL
docker compose up -d --wait tg-init tg-gigapipe       # 3. gigapipe's DDL, then serve
```

`CLICKHOUSE_TELEMETRY_URL`'s path segment wins over `CLICKHOUSE_TELEMETRY_DB`
(`08-schema-changes.md:73`), so one variable points the migration at the test
instance and the test database. There is no `provision.sql` and no
`tg-provision` service. W7 asserts **the migration ran** — `partition_key` on
`samples_v3` and `metrics_15s` contains `type` before `tg-init` first started —
not that two files are byte-identical.

**And the race gets its own test.** `contract.writer.test.ts` carries a
negative control (gate 0.2b, *should*): bring up a throwaway stack in the wrong
order — `tg-ch → tg-init → migration 22` — and assert the partition key comes
back **without** `type` and the migration reports that it could not fix it. That
is the only artifact in the plan that proves the ordering constraint is real
rather than asserted, and it costs one extra compose project in the nightly run.

### D11. Telemetry fixtures are seeded through our own gateway, with real `Client` rows, and one raw-gigapipe negative control

Seeding via `POST /api/telemetry/v1/metrics` on a real `apps/api` exercises
auth → strip → stamp → encode → forward, which is the thing under test.

**This corrects the draft's cited precedent.** The draft said fixtures mint
clients "with hashed secrets in the test Postgres — exactly as
`apps/api/src/routes/insights.router.test.ts:58-62` mints its read client". That
file mints nothing: it `vi.mock`s `@openpanel/db` to replace
`getClientByIdCached` with a `vi.fn()` (`:19-22`), stubs `verifyPassword` to
resolve `true` (`:25-29`), bypasses Redis `getCache` (`:32-48`), and `:58-62` is
two string constants plus an `AUTH` header object. It is a precedent for the
**opposite** technique, and against a mocked `verifyPassword` every row of the
auth matrix's "reject unless the secret verifies" passes for free.

There is **no repo precedent** for inserting real `Client` rows and
authenticating end to end. This is new harness work and it is costed as such
(§Effort). The concrete shape is in §2.4: `db.client.create` with
`secret: await hashPassword(secret)` from `@openpanel/common/server` (the same
helper `apps/api/src/controllers/manage.controller.ts:105` uses), and
`verifyPassword` left **unmocked** so `apps/api/src/utils/auth.ts:163-173` really
runs. Teardown is free: `Client.projectId` is `onDelete: Cascade`
(`schema.prisma:365`), so deleting the fixture projects removes the clients, and
`test/fixtures.ts:418-431`'s `teardownPostgresFixtures` already deletes project
then organization.

The one deliberate exception: `tenancy.isolation.test.ts` also writes **one**
series straight to gigapipe carrying `op_project_id="<project A>"` while
authenticated as nothing at all. That negative control proves the isolation
assertions would actually fail if the label were forgeable — without it, "B sees
nothing" is satisfied by "nothing was ever written".

### D12. Read-back is a polling protocol, never a `sleep`

gigapipe batches inserts (`BULK_MAX_AGE_MS`; production 2000 ms, test stack
100 ms). `await sleep(500)` is simultaneously too slow on a laptop and too short
on a loaded runner. Every seed is followed by `waitForSeries(...)`, which polls
until the expectation holds or throws a message naming expected-vs-found. A flaky
security gate gets `it.skip`'d within a month, which is the worst outcome this
document can produce.

### D13. Teardown calls the production deletion function, and a per-push gate proves the production deletion function is *reached*

`teardownTelemetryFixtures()` delegates to `deleteTelemetryFromClickhouse()`
(owned by `08-schema-changes.md` / `10-ops-retention-billing.md`). The GDPR delete
path is then exercised on every T2 run rather than shadowed by a divergent
implementation that resolves fingerprints differently and forgets `patterns`.

**The draft stopped there, and that was the largest gap in it.** Exercising a
function is not the same as proving anything calls it.
`apps/worker/src/jobs/cron.delete.ts:46-47` is the only place projects are
actually erased — `deleteFromClickhouse(projectIds)` then
`deleteProjects(projectIds)` — and `deleteFromClickhouse`
(`packages/db/src/services/delete.service.ts:39-56`) iterates a hard-coded
14-table list, every entry in the `openpanel` database. There is no test file for
`cron.delete.ts` or `delete.service.ts` today. Without a gate, a right-to-erasure
request or a lapsed-org reap deletes the Postgres project row while the logs —
arbitrary user-supplied strings, the highest-PII signal in the plan — stay in
ClickHouse forever, with the project row gone so nothing can enumerate them
again. The same cron runs hourly and also drives `deleteOrganization`.

Therefore: **gate 1.9**, a per-push T2 test that seeds telemetry, marks the
project `deleteAt`, runs the real `jobDelete()`, and asserts zero surviving rows
in every gigapipe table; plus a source-level assertion that the telemetry table
list is a **single exported constant** shared by the delete path, the retention
sweep and the T2 teardown. Three hand-maintained copies is the same bug class as
the three report-field whitelists the plan already calls out.

### D14. The gigapipe pin is a machine-readable file in `.github/`, and the digest is read from the container runtime

`.github/gigapipe-pin.json`, with the digests resolved from the registries:

```json
{
  "image": "ghcr.io/metrico/gigapipe",
  "tag": "v5.4.1",
  "digest": "sha256:ee688ba4fb99df7c5b3fae967a428f2b1d3f9c645634f181a8763bb26c5bf478",
  "platforms": ["linux/amd64", "linux/arm64"],
  "prometheusVersion": "0.314.0",
  "lezerPromqlVersion": "0.314.0",
  "clickhouseImage": "clickhouse/clickhouse-server:25.10.2.65",
  "clickhouseDigest": "sha256:e019438e1e0539b0d1ce8380b628f1c06c5a0e641f368fc746acf4a8cf48d2f2"
}
```

**This corrects the draft's K22.** The draft asserted the running digest by
reading `/api/status/buildinfo`. That endpoint is a stub: `shared/commonroutes/controller.go:28-33`
returns a hardcoded `{"version":"0.0.1","branch":"main"}` with a
`//TODO: Replace with actual version` comment. It carries no version and
certainly no digest. What is checkable is:

```bash
# run.sh, after `docker compose up -d`
docker inspect --format '{{index .RepoDigests 0}}' "$(docker compose ps -q tg-gigapipe)" \
  > test/telemetry/.running-digest
```

and the test compares that file, plus the compose file's image reference, against
the pin. The *running* image is only as trustworthy as what the runtime reports,
and the doc says so rather than implying an upstream attestation that does not
exist.

`prometheusVersion === lezerPromqlVersion` is asserted as a test (K21), but
honestly: **it is a pin-consistency check, not a skew detector.** In CI the
gigapipe source tree is not on disk, only the image, so both sides are
hand-maintained. It catches a lezer bump that forgot the pin; it cannot catch an
image bump whose vendored Prometheus moved. The upgrade procedure therefore
carries an explicit numbered step to read `go.mod:44` from the tag being adopted,
and the nightly job strengthens it by fetching the tagged `go.mod` over HTTPS and
comparing. (`@prometheus-io/lezer-promql@0.314.0` is real and published —
verified against the npm registry — and matches gigapipe's
`github.com/prometheus/prometheus v0.314.0`.)

### D15. Alert state-machine tests take `tick` as a parameter. No fake timers.

`vitest.shared.ts:34` sets `fakeTimers: { toFake: undefined }`, which hands
`@sinonjs/fake-timers` its own default rather than vitest's curated list.
**UNVERIFIED:** exactly which APIs that ends up faking. The alert design makes the
question moot: `07-alerting.md` carries `tick` in the BullMQ job payload and
states evaluators never call `Date.now()` for the evaluation instant. Every
state-machine case is `evaluate(row, sample, config, tick)` with `tick` a
literal, so restart, replay and clock-skew cases are ordinary function calls.

**Rejected:** `vi.setSystemTime`. It would make the state table's 16 rows depend
on a global and turn "restart mid-incident" into a test about vitest.

### D16. No front-end suite. Decision #4's risk is answered with `expectTypeOf` *plus a real typecheck gate*, and tRPC-level tests.

`apps/start` is explicitly excluded from `vitest.workspace.ts` and has no vitest
config, no jsdom environment and no setup file, despite declaring
`@testing-library/react`, `jsdom` and `vitest` as devDependencies. Standing that
up is a half-day-plus of config nobody budgeted, and the first thing it would
test (a component render) is not where the risk is.

**Two corrections to the draft here, both material.** First, the draft said
`expectTypeOf` "fails at `pnpm typecheck` time as well as at test time". It does
not fail at test time: type assertions are erased at runtime and Vitest only
surfaces them when `test.typecheck` is enabled, which `vitest.shared.ts` never
sets. Combined with `pnpm typecheck` being **commented out** in CI
(`docker-build.yml:127-128`, block `:124-128`), the entire answer to decision #4's
risk is currently enforced by nothing. So: `packages/db` and
`packages/validation` enable

```ts
test: { typecheck: { enabled: true, include: ['**/*.test-d.ts', '**/*.test.ts'] } }
```

**and** re-enabling `pnpm typecheck` as a required check is promoted from an open
question to a **blocking P2 prerequisite**.

Second, the draft's `format()` assertion was vacuous:

```ts
// WRONG — passes today, before 'metric' exists, and keeps passing if it is removed
expectTypeOf(format).parameter(1).items.toMatchTypeOf<{ type: 'event' | 'formula' | 'metric' }>();
```

`format`'s second parameter is `Array<{ id?: string; type: 'event' | 'formula'; … }>`
(`packages/db/src/engine/format.ts:18-30`); an item typed `'event' | 'formula'`
already matches a target typed with the wider union. Reversed, it gates the
change it exists for:

```ts
// RIGHT — red before 'metric' is added to the union, green after
expectTypeOf<{ type: 'metric'; metric: string }>()
  .toMatchTypeOf<Parameters<typeof format>[1][number]>();
```

D16 stands on the front-end suite, but it stopped one step short: it declined a
suite and proposed nothing in its place for the *shared analytics code the plan
mutates*. **D22 supplies that**, and it is a named deliverable rather than a
decision to skip.

### D17. The log write path is 05's decode-and-construct design. E12–E15 and E22–E24 are retargeted.

Two mutually exclusive log-ingest architectures were specified for the same
route, and this document's highest-value ingest rows were written against the
losing one.

- `02-ingest-gateway.md` §1/§6.2: rewrite the OTLP protobuf in place (strip
  `op_*` at resource, scope **and record**; stamp the resource) and forward the
  bytes to gigapipe `POST /v1/logs`.
- `05-logs.md` D1/D2/D3: decode OTLP in `apps/api`, discard gigapipe's OTLP
  label model entirely, build a closed allowlisted label set plus a fixed JSON
  envelope, and push Loki JSON to `POST /loki/api/v1/push`.

**05 wins, on evidence 02 does not answer.** gigapipe's OTLP log decoder turns
*every* attribute — resource, scope and record — into a **stream label**, and
adds `trace_id` and `span_id` as labels on top
(`writer/utils/unmarshal/otlplogs.go:22-58`); the fingerprint is computed over
the whole surviving label set (`unmarshal.go:250-270`). One trace id is one new
fingerprint, one `time_series` row per stream per day and one `time_series_gin`
row **per label** per stream per day. There is no setting that disables it. 02's
design ships a cardinality bomb on the shared instance and 02 offers no rebuttal;
05 also documents that `/v1/logs` registers a single protobuf parser with no
protojson branch (`writer/controller/insert.go:146-158`), so the forward-in-place
design requires a full protobuf **re-encode** outbound that the Loki-JSON design
replaces with `JSON.stringify`.

**Consequences this document must absorb, because a naive merge is worse than
either design.** If 02's route table is kept and 05's `pushLogs` is bolted on,
01's strip rules run over a payload that is then thrown away and rebuilt, and the
boundary ends up enforced somewhere nobody specified or tested.

1. **E12–E15 are retargeted, not deleted.** E12 was "the single highest-value
   test in the document" because a log **record** attribute is merged last and
   overrides the resource stamp. Under 05 that override does not exist — the
   record attribute never becomes a label at all — but the same attribute still
   travels into the envelope's `attr` map and is a candidate for label
   promotion, so the reserved-key deletion at 05 §3.2's rule 4 is now the
   enforcement point. E12 asserts on the **constructed stream label set and the
   stored line**, not on a forwarded protobuf.
2. **05's actual enforcement points get rows, which they had nowhere.**
   `sanitizeAttrKey`, the envelope's reserved-key deletion, and the closed label
   allowlist had zero test coverage in any document. E34–E36 (§3.2) fix that.
3. **`/telemetry/loki/api/v1/push` is customer-facing under 05, and
   `08-schema-changes.md` S13 / `10-ops-retention-billing.md` D10 build the
   per-signal TTL totality argument on `type ∈ {1,2}`.** 02 derived that from
   "we do not expose Loki push". That premise is now false, so the invariant has
   to be *enforced by our decoder* instead: E22c asserts the gateway never emits
   a three-element Loki value tuple, which is the only producer of `type = 0`
   (`unmarshal.go:144-165`). **This is the replacement premise 08 S13 must
   cite.** Without E22c the TTL argument has no support at all under 05's design.
4. Metrics and traces are unaffected: 02's forward-in-place design still owns
   `/v1/metrics`, `/v1/traces` and remote-write, so E1–E11 and E16–E21 stand
   unchanged.

**If the P1 owner reverses this**, E12–E15 revert to the record-attribute
override assertions as written in the previous revision, E22c becomes
unnecessary (02's "not exposed" premise returns), and E34–E36 are dropped. Say
so in the reversal PR; do not ship both.

### D18. Package homes, settled. This closes Q1 and unblocks every test path in this document.

`04-read-path.md` D1 chose `packages/gigapipe`, and its own cross-document
reconciliation row 13 amends itself: **`packages/gigapipe`, minus the ingest
rows**, because `02-ingest-gateway.md` D9's `apps/api/src/telemetry/` placement
is better argued and 04 does not defend its version. That is the answer this
document adopts, in full:

| Thing | Home | Source |
|---|---|---|
| `isReservedKey`, the two sanitizers, `compileSelector`/`compileAggregation`, the LogQL and TraceQL compilers, `assertPromqlScoped`/`assertLogqlScoped`/`assertTraceqlScoped` | `packages/gigapipe/src/` | 04 D1 layer 1 |
| transport, routes, errors, lease, killswitch, units, `read/*` | `packages/gigapipe/src/` | 04 D1 layer 2 |
| OTLP/PRW/Loki decode-rewrite-encode, the vendored `.proto` tree, `startMockUpstream` | `apps/api/src/telemetry/` | 02 D9; 04 reconciliation row 13 |
| `getTelemetryClient`, `TELEMETRY_TABLES`, `gigapipeTable` | `packages/db/src/clickhouse/telemetry-client.ts` | 08 S10/S11 — these need the existing ClickHouse client machinery |
| `zMetricQuery`, `zMetricLabelFilter`, `refineMetricQuery`, `REDUCER_TABLE` | `packages/validation/src/telemetry.validation.ts` | 03 §2 |

The dependency-direction argument is decisive and this document has its own
stake in it: `packages/db` is imported by `apps/api`, `apps/worker`,
`packages/trpc`, `packages/mcp`, the importer **and every vitest file in the
repo**. `05-logs.md`'s `packages/db/src/gigapipe/` layout drags `protobufjs`,
`long` and a vendored `opentelemetry-proto` tree into all of them, including the
test graph.

**Mechanical follow-up owed by others, in one commit:** `05-logs.md`'s file
table (`logql.ts`, `client.ts`, `envelope.ts`, `severity.ts`, `logs.ingest.ts`,
`table-name.ts`, `retention.ts`, `cardinality.ts`) and `03-metrics-engine.md:2113`
move to the homes above; `05-logs.md` open question 8 closes. Every path in this
document already assumes this answer.

### D19. One name per thing, and a gate that the compose-set name and the asserted name are the same string

Verified in gigapipe: `cmd/gigapipe/main.go:172-183` reads **both** `QRYN_*` and
`CLOKI_*` for basic auth, assigning `CLOKI_*` second so it wins; `:321-324`
installs `middleware.BasicAuthMiddleware` **only when both** username and
password are non-empty. Compose substitutes a missing `.env` key with the empty
string plus a warning. So a name mismatch between the compose service and the
boot assertion yields a **silently unauthenticated gigapipe** serving
`/loki/api/v1/push`, the Elastic `POST /_bulk` write routes and an always-on
cleartext-HTTP/2 gRPC OTLP receiver to anything on the compose network — with
every healthcheck green, because `apps/api` keeps sending an `Authorization`
header that is simply ignored.

| Side | Name | Authority |
|---|---|---|
| gigapipe container | `CLOKI_LOGIN` / `CLOKI_PASSWORD` | `10-ops-retention-billing.md` §3, verified at `main.go:172-183` — `CLOKI_*` is assigned after `QRYN_*` and wins |
| OpenPanel | `GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER` | `04-read-path.md` §3 declares itself the authority and enforces it with a CI grep; `10-ops` §3.1 concurs and writes them into `.env.template` |
| OpenPanel → ClickHouse (telemetry database) | `CLICKHOUSE_TELEMETRY_URL`, `CLICKHOUSE_TELEMETRY_DB` | `08-schema-changes.md` §3 |
| Tenancy label constant | `TELEMETRY_PROJECT_LABEL` | `01-tenancy-and-security.md:296`, consumed by `04-read-path.md:2403` |
| Ingest kill switch | `telemetry:disabled:{projectId}` / `telemetry:disabled:*`, presence means disabled, mandatory TTL | `02-ingest-gateway.md` §4, adopted by `10-ops` §10.3 |
| Read kill switch | the same namespace, separate key, per `04-read-path.md` reconciliation row 10 ("one namespace, with 04's read/ingest split") | 04 D15, being rewritten there — **this document does not invent the spelling**, it asserts the split behaviourally (gate 1.11) |

`GIGAPIPE_INTERNAL_URL` and `GIGAPIPE_LOGIN` (02 §15), `GIGAPIPE_USERNAME`
(04 §3's own body, 03), `GIGAPIPE_READ_URL`/`GIGAPIPE_WRITE_URL` (05) and this
document's previous `QRYN_LOGIN`/`QRYN_PASSWORD` compose block are all drift
against the table above and are corrected here (§2.3, gate 1.7).

**Two gates follow**, because a naming convention with no mechanical check is a
comment: **gate 0.14** greps the shipped compose files and the boot assertion for
the credential variable and fails unless they are the same string, and **gate
0.4b** promotes `10-ops`' smoke assertion — an unauthenticated `GET /ready`
against `op-gigapipe` returns **401** — from a smoke check to a blocking P0 gate.
It is the only detector for the empty-credential state.

### D20. One deletion function, one ledger, one table list, and it lands in P1

Three specs designed this three times, with three names, three ledgers, three
call sites and **opposite failure semantics** — `05-logs.md` §7.4 blocks the
Postgres delete on a successful purge, `08-schema-changes.md` §14 says the purge
must never propagate so the Postgres delete always runs. All three independently
found the same verified fact: `jobDelete()` (`apps/worker/src/jobs/cron.delete.ts:45-48`)
has no `try`/`catch`, so an unguarded throw stops **every project and
organization deletion on the deployment**, silently, on an hourly cron that the
wind-down lifecycle arms via `deleteAt`.

**08 owns it**, and its call site is right: **inside** `deleteFromClickhouse`
(`packages/db/src/services/delete.service.ts`), which is the only placement that
covers both `apps/worker/src/jobs/cron.delete.ts:46` and
`admin/src/commands/delete-organization.ts:191` — the interactive tool a GDPR
erasure actually travels through. 08's non-throwing contract wins over 05's
block-the-delete contract: a failed telemetry purge that stops all deletions is
strictly worse than orphaned telemetry plus a pending ledger row, and 08's
`TelemetryErasure` row *is* the retry handle.

| Element | Settled |
|---|---|
| Name | `deleteTelemetryFromClickhouse(projectIds)` (08). Delete 05's `purgeTelemetry` and 06's `deleteTelemetryForProjects`/`deleteTelemetryForProfile` |
| Call site | inside `deleteFromClickhouse`, guarded on `isTelemetryEnabled()`, wrapped in try/catch (08 S15) |
| Failure | caught and logged, **never propagated** |
| Ledger | `model TelemetryErasure` (08). Delete `TelemetryPurgeJob` (05) |
| Resumability | **folded in from 05** — its durable fingerprint set and `resumeJobId` are genuinely better than a bare ledger row, because the worker dying between fingerprint resolution and the mutations otherwise leaves the rows unreachable forever once the Postgres row is gone. `TelemetryErasure` carries the resolved fingerprint set and the submitted mutation ids |
| Per-profile erasure | 06's `deleteTelemetryForProfile` becomes a `subject`/`signals` argument on the one function, not a second function |
| Table list | one exported constant, `TELEMETRY_TABLES` (`08:1677`), imported by the delete path, the retention sweep and the T2 teardown (I14) |
| Table naming | `gigapipeTable(name, 'read' \| 'mutate')` (05 §7.2's semantics, in 08's file per D18). `getReplicatedTableName` is **never** applied to a gigapipe table |
| Phase | **P1**, gate 1.9. `08-schema-changes.md` §4 currently files the ledger under "P4/P5/P7" and prices the function with no phase; `10-ops` has no sweep row in P0 or P1. Move it |

**"Gate 1.9 green" is the literal precondition on enabling telemetry for any
tenant**, which is what `02-ingest-gateway.md` §17 already demands and what
nothing currently owns: `deleteFromClickhouse` deletes by
`WHERE project_id IN (…)` and **no gigapipe table has a `project_id` column**, so
without the sweep every project deletion silently leaves all telemetry behind
forever — including OTLP log bodies, the most PII-dense data the product will
ever store.

**On the naming helper, this document was the one that was wrong.** The previous
revision's I14 required that `deleteTelemetryFromClickhouse` route every target
through `getReplicatedTableName`. Verified in the repo:
`getReplicatedTableName` (`packages/db/src/clickhouse/client.ts:100-107`) returns
`` `${tableName}_replicated ON CLUSTER '{cluster}'` `` — an OpenPanel naming
convention. Verified in gigapipe: **there is no `_replicated` table.**
`grep -rn "_replicated" ctrl/ writer/ reader/` returns exactly one hit, a
ClickHouse *setting* name in `ctrl/maintenance/shared.go:33`. The clustered
layout is the inverse of OpenPanel's: the plain-named local table becomes
`ReplicatedMergeTree` and a Distributed companion carries `_dist`
(`ctrl/qryn/sql/log_dist.sql:7,18,25,40` — `ENGINE = Distributed('{{.CLUSTER}}',
'{{.DB}}', 'samples_v3', fingerprint)`). Following this document's own draft
would have emitted `ALTER TABLE gigapipe.samples_v3_replicated …` and failed with
`UNKNOWN_TABLE` on the GDPR erasure path, on Cloud, where the paying customers
are. `05-logs.md` §7.2 and `06-traces-and-correlation.md` §5 were both right and
this document was repeating a stale draft. I14 is rewritten accordingly.

### D21. This is a standards-and-harness document. Feature streams author their own unit suites.

The previous § Effort said "test-writing only; the code under test is costed in
the owning spec" and then priced suites the owning specs had already priced:
`02-ingest-gateway.md` P1a prices "Tests 1–15" at 4–6 d, `07-alerting.md` prices
"Tests A1–A44" at 3.0 d, `01-tenancy-and-security.md` prices an integration
suite at 0.8 w plus per-row test work inside four other rows, and
`03-metrics-engine.md` folds `compile.test.ts` / `grid.test.ts` / `rank.test.ts` /
`shape.test.ts` into its 5–6 w. Roughly 15–20 engineer-days appeared in two
budgets.

**Split:** this document owns the **harness, the workspace and CI wiring, the
sanitizer golden generator, and the cross-stream matrices and contracts** —
§3.1, §3.6, §5, §5.5, §6, §7.2, §7.3. It **specifies** §3.2, §3.3, §3.4, §4 and
§7.1 as normative row lists, and the owning work-stream **writes** them, in the
files this document names, to the conventions §1 sets. A row here is a
requirement on that stream, not a line item in this budget. The duplicated rows
are struck from § Effort below, not from the owning specs.

This is the reason the § Effort total moves from 28.5 d to 19.0 d without any
coverage being cut.

### D22. No `apps/start` suite — but an event-path regression pack, because nothing else proves the plan does not break the product that pays for it

D16 declined a front-end Vitest project and was right about the config cost.
It was wrong to stop there. Two verified facts frame the risk:
`vitest.workspace.ts` is exactly `export default ['packages/*', 'apps/*',
'!apps/start']`, so the dashboard is excluded from the test run entirely, and
`pnpm typecheck` is commented out in the repo's **only** workflow
(`.github/workflows/docker-build.yml:124-128`; `.github/workflows/` contains one
file). And the plan modifies a great deal of shared, currently-untested
analytics code: `ReportChartProps` gains `data`/`isLoading`/`error` across eight
`<ReportChart>` render sites (09 D2); `useRechartDataModel` is rewritten
(09 D21 — verified O(dates × series × points) with a spread-in-accumulator at
`apps/start/src/hooks/use-rechart-data-model.ts:19-52`, which also violates this
repo's own `CLAUDE.md` performance rule, and takes the x-axis from `series[0]`
alone); `Combobox`/`ComboboxAdvanced` gain controlled search (09 D22);
`useYAxisProps` gains `allowDecimals` (09 D23); `PureFilterItem` is extended
(09 D9); plus nine report-persistence whitelist sites (08 §3), `zReportInput`,
`validateExportRequest` (which also gates `/insights`), `cacheMiddleware` and
two notification unions. Any of these regressing silently degrades the existing
product, and a typecheck gate does not catch a behavioural change.

**Shipped: §5.5, an event-path regression pack**, in the projects that already
have a Vitest config — no new harness, no jsdom, no `apps/start` project. It
drives the **existing event** report paths through `createCaller` and the real
Fastify app and fails if a metric-shaped change alters an event-shaped result.
**This closes `09-ui-surfaces.md` Q5 with "no":** its T3 is satisfied by
extracting the pure recharts fold to a testable module and golden-testing it
there — 09 already offers that escape ("or extracted to `packages/common` and
tested there — the function is pure") — and its T5–T8 become a written
manual-QA checklist, which drops a week from 09's estimate. Make the choice
rather than leaving it implied.

---

## Design

### 1. Conventions this must match

Read before writing a line. These are the repo's, not invented here.

| Convention | Where it is established |
|---|---|
| Tests are colocated `*.test.ts` next to the source, never in a `__tests__/` dir | all **60** test files; e.g. `packages/db/src/services/filter-where.test.ts` beside `filter-where.service.ts` |
| `pnpm test` = `vitest run` from the root; per-package config is three lines re-exporting `getSharedVitestConfig` | `package.json:10`; `packages/db/vitest.config.ts` |
| Infra URLs are pinned to local Docker in config, never read from `.env` | `vitest.shared.ts:21-27` — "Always point at local Docker — never production, regardless of .env" |
| Global fixtures are seeded once per run by `globalSetup`, keyed by a per-suite project id | `vitest.config.ts:5`; `test/global-setup.ts`; `test/fixtures.ts` |
| Deterministic-blueprint fixtures use fixed absolute dates, not `new Date()` offsets | `test/retention-fixtures.ts:1-34` |
| A hostile-caller regression suite mocks `@openpanel/db` with `vi.hoisted` and drives the router through `createCaller` | `packages/trpc/src/routers/share.test.ts` |
| A Fastify route test builds the real app (`buildApp()`) and mocks only auth + Redis, leaving ClickHouse and Postgres real | `apps/api/src/routes/insights.router.test.ts:14-50` |
| A worker job test replaces `@openpanel/db`, `@openpanel/email` and `@openpanel/payments` wholesale with `vi.hoisted` mocks | `apps/worker/src/jobs/cron.wind-down.test.ts` |
| SQL correctness is proved by `EXPLAIN` against a live ClickHouse | `packages/db/src/services/chart-sql.test.ts:43-47` |
| Redis-backed code uses the real local Redis with a `beforeEach` key sweep | `packages/db/src/buffers/event-buffer.test.ts:24-29`; `packages/redis/cachable.test.ts` |
| Per-test env stubbing uses `vi.stubEnv` in `beforeEach` with `vi.unstubAllEnvs()` | `apps/api/src/hooks/subscription.hook.test.ts:40-44` |
| `it.each` for table-driven cases | `packages/trpc/src/access.test.ts:61`; `packages/db/src/services/filter-where.test.ts:119`; `apps/api/src/hooks/subscription.hook.test.ts:47` and `:66` |
| Connection cleanup is central; suites do not close the shared clients | `test/test-setup.ts`, registered as `setupFiles` for every package |
| Every test file opens with a block comment saying what it covers and what infra it needs | all of the above |

The draft claimed `it.each` was a convention this work-stream *introduces* and
that `grep -rn "it.each\|test.each" --include='*.test.ts'` "returns nothing". It
returns four hits, listed above, two of them in files this document cites as
models elsewhere. Corrected: `it.each` is existing precedent, which strengthens
the case for the table-driven matrices rather than weakening it.

Two conventions this work-stream genuinely adds, both load-bearing:

- **A guard that fails closed in CI** (D3). Today's only guard reports PASS.
- **A tier tag by path**: T2 suites live in the `test/telemetry` project, so the
  nightly exclusion is one line and colocated T0/T1 suites keep the repo
  convention.

One clarification the draft owed and did not give: the colocation convention
governs **test files**. Shared helpers and binary fixtures live in `__test__/`
and `__fixtures__/` precisely because they must *not* be matched by the
`**/*.test.*` include. The singular `__test__` is also deliberate — it avoids
`docker-build.yml`'s `**/__tests__/**` `paths-ignore` glob, which D4 leaves in
place.

### 2. What gets created

```
# workspace wiring (new / changed) — PREREQUISITE, see D2
vitest.workspace.ts                      # + 'test/telemetry'
test/telemetry/vitest.config.ts          # new project, owns the nightly exclude
packages/validation/vitest.config.ts     # new: 3 lines, re-exports getSharedVitestConfig
packages/gigapipe/vitest.config.ts       # new: same
packages/gigapipe/tsconfig.json          # must include **/*.test.ts or typecheck skips them
.github/workflows/tests.yml              # new: D4's scoped test-paths workflow
.github/workflows/nightly-telemetry.yml  # new: the nightly job
.github/gigapipe-pin.json                # D14

# harness (new)
test/telemetry/docker-compose.yml        # CH + init_only + gigapipe (NO provision container, D10)
test/telemetry/run.sh                    # 3-stage boot incl. the REAL migration 22, exports
                                         # OP_GIGAPIPE_READY, tears down
test/telemetry/guard.ts                  # describeGigapipe / assertGigapipeLive / waitForSeries
test/telemetry/fixtures.ts               # setupTelemetryFixtures / teardownTelemetryFixtures
test/telemetry/tools/gen-sanitizer-golden.go   # D7's golden producer
test/telemetry/__fixtures__/sanitizer-corpus.txt   # fixed, committed, seeded corpus
test/telemetry/__fixtures__/sanitizer-golden.json  # its expected output

# T2 suites (new, in the telemetry project)
test/telemetry/tenancy.isolation.test.ts # EVERY PUSH — the security gate
test/telemetry/erasure.test.ts           # gate 1.9 runs per push; the 100k-series part is nightly
test/telemetry/contract.reader.test.ts   # nightly + every image bump
test/telemetry/contract.writer.test.ts   # nightly + every image bump
test/telemetry/retention.test.ts         # nightly

# T0/T1 suites (new, colocated)
packages/gigapipe/src/labels.test.ts
packages/gigapipe/src/routes.test.ts
packages/gigapipe/src/transport.test.ts
packages/gigapipe/src/query/promql.test.ts
packages/gigapipe/src/query/logql.test.ts
packages/gigapipe/src/query/traceql.test.ts
packages/gigapipe/src/query/promql-rewrite.test.ts     # P6 only
packages/db/src/engine/final-chart.contract.test.ts    # write this FIRST
packages/db/src/engine/metrics/compile.test.ts
packages/db/src/engine/metrics/grid.test.ts
packages/db/src/engine/metrics/fetch.test.ts
packages/db/src/engine/dispatch.test.ts
packages/db/src/services/delete.service.test.ts        # D20: no test file exists today
packages/db/src/services/reports.service.test.ts       # extend the existing file
packages/db/src/engine/event-path.regression.test.ts   # D22 / §5.5
packages/trpc/src/routers/report.regression.test.ts    # D22 / §5.5
packages/validation/src/metric-query.test.ts
packages/validation/src/notification-rule.test.ts
packages/trpc/src/routers/observability.test.ts
packages/trpc/src/routers/notification.test.ts
apps/api/src/utils/auth.test.ts                        # NO test file exists today
apps/api/src/telemetry/rewrite/{otlp-metrics,otlp-traces,prom-write}.test.ts
apps/api/src/telemetry/logs/{decode,envelope,labels}.test.ts   # D17: 05's construct path
apps/api/src/telemetry/proto/codec.test.ts
apps/api/src/telemetry/admit.test.ts
apps/api/src/routes/telemetry.router.test.ts
apps/worker/src/jobs/alerts.{evaluate-metric,dispatch,outbox}.test.ts
apps/worker/src/jobs/notification.test.ts
apps/worker/src/jobs/cron.registration.test.ts         # D-gate for cron wiring
apps/worker/src/jobs/cron.telemetry-retention.test.ts

# fixtures / generators (new)
apps/api/src/telemetry/__fixtures__/*.bin + *.json     # committed OTLP bodies
apps/api/src/telemetry/__test__/mock-upstream.ts
apps/api/scripts/gen-otlp-fixtures.ts                  # regenerates them
packages/gigapipe/src/__fixtures__/*.json              # captured gigapipe responses
```

`packages/validation` and `packages/gigapipe` **must** get a `vitest.config.ts`.
Today only `apps/{api,worker}` and `packages/{importer,trpc,geo,mcp,common,db}`
have one (verified: nine files including the root). A directory matching
`packages/*` still becomes a Vitest project without a config, but it then does
**not** receive `vitest.shared.ts`'s `setupFiles` or its pinned `test.env` — so a
new test there that touches a client would read the developer's real `.env`.
`packages/redis` has the same gap today (`cachable.test.ts` with no config); if
this work-stream extends it, fix it in the same PR. This is **gate 0.11**.

**Package location: settled, no longer blocking.** The paths above are D18's:
`packages/gigapipe/src/` for labels, compilers, transport and the `assert*Scoped`
family; `apps/api/src/telemetry/` for the ingest codecs and rewrites;
`packages/db/src/clickhouse/telemetry-client.ts` for `getTelemetryClient`,
`TELEMETRY_TABLES` and `gigapipeTable`. `05-logs.md` and `03-metrics-engine.md`
owe the mechanical rename; nothing here waits on it. Q1 is closed.

### 2.1 `test/telemetry/guard.ts`

```ts
/**
 * Guard + polling helpers for T2 (gigapipe-backed) suites.
 *
 * Unlike packages/db/src/services/chart-sql.test.ts's `itCH`, an unreachable
 * dependency is NOT a silent pass. On a laptop it is a real it.skip; in CI it
 * throws, because the tenancy proof is a security gate and a green no-op gate
 * is worse than no gate.
 *
 * Readiness crosses the parent/worker boundary as a plain ENV VAR, set by
 * run.sh. It is NOT stashed on globalThis: globalSetup runs in the vitest
 * parent process (see test/global-setup.ts:12-13) and nothing it writes to
 * globalThis is visible to a worker.
 *
 * Boot the stack with:  ./test/telemetry/run.sh up
 */
import { beforeAll, describe, it } from 'vitest';

export const GIGAPIPE_TEST_URL =
  process.env.GIGAPIPE_TEST_URL ?? 'http://localhost:3199';

/** gigapipe applies basic auth to EVERY matched route, /ready included. */
export const gigapipeAuthHeader = () =>
  `Basic ${Buffer.from(
    `${process.env.GIGAPIPE_TEST_LOGIN ?? 'test'}:${process.env.GIGAPIPE_TEST_PASSWORD ?? 'test'}`,
  ).toString('base64')}`;

export async function gigapipeReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${GIGAPIPE_TEST_URL}/ready`, {
      headers: { authorization: gigapipeAuthHeader() },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const UNREACHABLE =
  `[telemetry] gigapipe unreachable at ${GIGAPIPE_TEST_URL}. ` +
  'This suite is a security gate and must not be skipped in CI. ' +
  'Boot it with ./test/telemetry/run.sh up.';

/**
 * describe() that skips locally and FAILS in CI.
 *
 * Channel 1 (collection time, synchronous): OP_GIGAPIPE_READY, exported by
 * run.sh after its own health probe. Env vars are inherited by workers.
 * Channel 2 (beforeAll, async): a live probe, because channel 1 cannot tell
 * you the container died after run.sh returned.
 */
export function describeGigapipe(name: string, fn: () => void) {
  const declaredReady = process.env.OP_GIGAPIPE_READY === '1';

  if (!declaredReady) {
    if (process.env.CI) {
      return describe(name, () => {
        it('gigapipe must be reachable in CI', () => {
          throw new Error(UNREACHABLE);
        });
      });
    }
    return describe.skip(name, fn);
  }

  return describe(name, () => {
    beforeAll(async () => {
      if (!(await gigapipeReachable())) {
        throw new Error(`${UNREACHABLE} (OP_GIGAPIPE_READY=1 but /ready failed)`);
      }
    });
    fn();
  });
}
```

`/ready` is behind gigapipe's global basic auth once `CLOKI_LOGIN`/`CLOKI_PASSWORD`
are set (D19; `main.go:172-183` reads `QRYN_*` first and `CLOKI_*` second, so
`CLOKI_*` wins when both are present): `cmd/gigapipe/main.go:321-325` applies
`middleware.BasicAuthMiddleware`
via `app.Use`, and gorilla/mux runs router middleware on every **matched** route
including `/ready`, `/config` and `/metrics`. A bare `curl /ready` returns 401,
which is why both the guard and the compose healthcheck carry the header. The
inverse is gate 0.4b: **without** the header `/ready` must be **401**, which is
the only detector for the empty-credential state D19 describes.

**Rejected: `provide()` / `inject()`.** It is the supported cross-process channel
and would work, but `inject()` would still have to be read at collection time to
choose `describe` vs `describe.skip`, so it buys nothing over an env var while
adding a second mechanism to understand. The env var is also what `run.sh` needs
to export for the human running one suite by hand.

### 2.2 `waitForSeries` — the read-back protocol (D12)

```ts
export async function waitForSeries(opts: {
  projectId: string;
  match: string;              // a full PromQL selector, already project-scoped
  minSeries: number;
  timeoutMs?: number;         // default 15_000
}): Promise<void>;
```

Poll `GET /api/v1/series?match[]=…&start=…&end=…` through the **production**
`packages/gigapipe` transport (not a raw `fetch`), every 200 ms. On timeout,
throw a message containing the selector, the expected count, the observed count
and the last raw response body. Using the production transport exercises the
outbound-header allow-list on every T2 run for free. `waitForLogLines` (over
`/loki/api/v1/query_range`) and `waitForTrace` (over `/api/traces/{id}`) are the
same shape.

### 2.3 `test/telemetry/docker-compose.yml`

Modelled on gigapipe's own `test/integration/docker-compose.yml` (health-gated
ordering, `BULK_MAX_AGE_MS: "100"`) and on `.github/smoke/docker-compose.yml` (no
`restart:`, everything inline, no `.env`). **There is no provision service**:
`run.sh` runs the real migration 22 between stage 1 and stage 3 (D10).

```yaml
# Telemetry test stack.
#
# Deliberately does NOT reuse the op-ch instance from `pnpm dock:up`: the T2
# suites truncate and re-provision the gigapipe database between runs, and a
# developer's analytics fixtures must not be in blast range.
#
# Ports are offset (CH on 9199, gigapipe on 3199) so this runs alongside
# `pnpm dock:up` and `.github/smoke` without a port fight.
services:
  tg-ch:
    image: clickhouse/clickhouse-server:25.10.2.65
    environment:
      - CLICKHOUSE_SKIP_USER_SETUP=1
    ports: ["9199:8123"]
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    healthcheck:
      test: ["CMD-SHELL", 'clickhouse-client --query "SELECT 1"']
      interval: 2s
      timeout: 3s
      retries: 30

  # OUR DDL is packages/db/code-migrations/22-telemetry-database.ts, run by
  # run.sh between `up --wait tg-ch` and `up --wait tg-init` -- the same code, in
  # the same order, as production (op-api's migrate:deploy -> op-gigapipe-init).
  # It creates the database and pre-creates samples_v3 and metrics_15s with
  # `type` in the PARTITION BY, because PARTITION BY cannot be ALTERed and
  # gigapipe's DDL is CREATE TABLE IF NOT EXISTS (ops D4, schema S6).
  # There is deliberately NO tg-provision service and no provision.sql:
  # 10-ops-retention-billing.md D3 rejects that container by name (D10).

  tg-init:
    image: ghcr.io/metrico/gigapipe:v5.4.1
    depends_on:
      tg-ch: { condition: service_healthy }
    environment: &gp_env
      MODE: init_only
      CLICKHOUSE_SERVER: tg-ch
      CLICKHOUSE_PORT: "9000"
      # MUST be set and must not be 'default': InitDB early-returns on '' and
      # 'default' (ctrl/qryn/maintenance/maintain.go:41-43).
      CLICKHOUSE_DB: gigapipe
      SAMPLES_DAYS: "7"
      ADVANCED_SAMPLES_ORDERING: "fingerprint, timestamp_ns"
      # D19: main.go:172-183 reads QRYN_* then CLOKI_*, so CLOKI_* wins. One name.
      CLOKI_LOGIN: test
      CLOKI_PASSWORD: test
      # 01 section 3.1's cross-stream decision, and it is a TENANCY setting, not a
      # tuning knob. When false, planner_stream_select.go:31-46 walks the selector
      # and silently REMOVES any `=`/`=~` matcher with an empty value and any
      # `=~".*"` matcher; when true it `break`s out of that loop on the first
      # iteration and keeps every matcher. The same planner is reused by the
      # PromQL optimiser, so this is not logs-only. Unset ships gigapipe's
      # default, which is the stripping behaviour. 05-logs.md:1847 pins "false"
      # and must be changed; 10-ops has no row for it at all.
      ADVANCED_OMIT_EMPTY_VALUES: "true"
      # CLUSTER_NAME deliberately unset: setting it flips Cloud=true and makes
      # every DDL `ON CLUSTER`, against a cluster that does not exist -> panic.
      # This means the T2 stack proves nothing about clustered ClickHouse. See
      # Failure modes row 10 and gate 1.10.

  tg-gigapipe:
    image: ghcr.io/metrico/gigapipe:v5.4.1
    depends_on: { tg-init: { condition: service_completed_successfully } }
    environment:
      <<: *gp_env
      MODE: all
      # lowercase: boolEnv (cmd/gigapipe/main.go:54-62) panics on "True"
      OMIT_CREATE_TABLES: "true"
      PORT: "3100"
      BULK_MAX_AGE_MS: "100"
      # Explicitly false, not unset. gigapipe's own Makefile:5 and its e2e
      # compose default it to TRUE, its rule routes carry no per-tenant auth,
      # and it accepts + stores + re-serves alerting rules it never evaluates.
      # 10-ops D23 requires the explicit value in the SHIPPED compose; the test
      # stack matches it so W7 can assert a value rather than an absence.
      QRYN_RULER_ENABLED: "false"
    ports: ["3199:3100"]
    healthcheck:
      test:
        - CMD-SHELL
        - "wget -q -O- --header='Authorization: Basic dGVzdDp0ZXN0' http://localhost:3100/ready || exit 1"
      interval: 2s
      timeout: 3s
      retries: 30
```

`contract.writer.test.ts` asserts this file's own invariants as a source-level
test (W7) — `OMIT_CREATE_TABLES` lowercase, `CLUSTER_NAME` absent,
`QRYN_RULER_ENABLED` present **and `"false"`**, `ADVANCED_OMIT_EMPTY_VALUES`
present **and `"true"`**, credentials named `CLOKI_*`, `CLICKHOUSE_DB` present
and not `default`, and **no service mounting a `provision.sql`** — because each
is a boot-time panic, a tenancy hazard or a silent security regression no
reviewer spots in a YAML diff.

**Three of those changed in this revision and the previous version would have
failed a gate.** W7 asserted `QRYN_RULER_ENABLED` was *absent*, which turns red
the moment `10-ops` D23's explicit `false` lands in the shipped compose — a must
gate failing on a correct change. It asserted `provision.sql` byte-identity
against a file `10-ops` D3 rejects, which can never pass. And it said nothing
about `ADVANCED_OMIT_EMPTY_VALUES`, whose two specified values are opposite
across `01:1857` (`true`) and `05:1847` (`false`) and which nothing sets today.

### 2.4 `test/telemetry/fixtures.ts`

Follows `test/retention-fixtures.ts`: fixed absolute timestamps, a hand-computed
blueprint exported as a const, per-suite project ids so suites can run
concurrently.

```ts
/**
 * Deterministic telemetry fixture for gigapipe-backed suites.
 *
 * Two projects, deliberately overlapping in every dimension that could leak:
 *
 *   PROJECT A = 'telemetry-a'          PROJECT B = 'telemetry-b'
 *   metric name    op_test_requests_total          (identical)
 *   label set      {service="api",code="200"}      (identical)
 *   trace id       0102...0f10                     (identical, on purpose)
 *   log stream     {service="api"}                 (identical)
 *   values         100, 200, 300                   7, 7, 7
 *
 * The identical label sets are the whole point. gigapipe's fingerprint is a
 * hash of the label key/value pairs (writer/utils/unmarshal/unmarshal.go:250-270),
 * so A and B differ by exactly one label: op_project_id. If enforcement is
 * broken anywhere, these two series MERGE and every assertion fails loudly. A
 * fixture whose two projects used different metric names would pass against a
 * completely broken implementation.
 */
export const TELEMETRY_FIXTURE = {
  projects: { a: 'telemetry-a', b: 'telemetry-b' },
  orgs: { a: 'telemetry-org-a', b: 'telemetry-org-b' },
  metric: 'op_test_requests_total',
  window: { start: '2026-03-04T00:00:00Z', end: '2026-03-04T00:05:00Z' },
  traceId: '0102030405060708090a0b0c0d0e0f10',
  blueprint: { aRate: [/* hand-computed, 15s step */] },
} as const;
```

Seeding, spelled out because there is **no repo precedent** (D11):

```ts
import { hashPassword } from '@openpanel/common/server'; // manage.controller.ts:105 uses this
import { db } from '@openpanel/db';

async function mintTelemetryClient(projectId: string, orgId: string) {
  const secret = `sec_${randomBytes(10).toString('hex')}`;
  const client = await db.client.create({
    data: {
      name: `telemetry-fixture-${projectId}`,
      type: 'telemetry',              // the new ClientType enum member
      secret: await hashPassword(secret),
      projectId,
      organizationId: orgId,
      ignoreCorsAndSecret: false,     // NEVER true here: auth.ts:133-135 would
                                      // return the client with no secret check
    },
  });
  return { clientId: client.id, clientSecret: secret };  // plaintext once, in memory
}
```

- `verifyPassword` is **not** mocked in this suite. `apps/api/src/utils/auth.ts:163-173`
  must really run, or D11 is pointless and A9–A13 pass for free.
- `getClientByIdCached` is **not** mocked either, for the same reason. This is the
  one place in the repo that differs from `insights.router.test.ts`, deliberately.
- Teardown is inherited: `Client.projectId` is `onDelete: Cascade`
  (`schema.prisma:365`), so `teardownPostgresFixtures`-style project deletion
  (`test/fixtures.ts:418-431`) removes the clients. `teardownTelemetryFixtures`
  additionally calls `deleteTelemetryFromClickhouse` — the one production
  function (D13, D20), never a divergent copy.

`setupTelemetryFixtures` boots `buildApp()` in process, mints one client per
project, POSTs the committed fixture bodies, then `waitForSeries` on both
projects before returning.

---

### 3. The tenancy enforcement matrix

This is the security boundary. Every ingest row is **T0** — decode the mock
upstream's recorded body and assert on the decoded object (D8). Every query row
is **T0** — compile and re-parse (D6). The T2 rows at the end are the end-to-end
proof.

#### 3.1 The two sanitizers, and the parity property test

Two sanitizers run on two different paths and they disagree. Both are replicated
in `packages/gigapipe/src/labels.ts`.

| Path | gigapipe function | Regex | Leading-char rule | Empty key | Value truncation |
|---|---|---|---|---|---|
| OTLP (logs, metrics, traces) | `SanitizeKey` — `writer/utils/unmarshal/otlplogs.go:107-117` | `[^a-zA-Z0-9_]` → `_` (`sanitizeKeyRe`, `:105`) | **prepends** `_` when empty or when `sanitized[0]` is `0`–`9` (`:112-114`) | → `_` | **none** — `SanitizeValue` (`:119`) does not truncate |
| Prometheus remote-write / Loki | `sanitizeLabels` — `writer/utils/unmarshal/unmarshal.go:272-278` | `(^[^a-zA-Z_]\|[^a-zA-Z0-9_])` → `_` | **replaces** the leading char | → `""` unchanged | values over **100 UTF-8 bytes** → first 100 bytes + `"..."` |

Both regexes are **rune**-oriented in Go, and a JS `String.prototype.replace`
with a `u`-flagged class agrees exactly (D7). The parity test asserts that
agreement; it is not a workaround for a disagreement.

**The near-miss table.** This is a *regression corpus*, not the specification —
the strip rule is `isReservedKey(key)`, one argument, three forms, `op_` prefix
(D7). The two sanitizer columns remain because the **stored** key still differs
by path (leading-digit handling, value truncation), and the parity golden and
K23 assert exactly that difference; they are not two predicates. Every OTLP column below was
produced by compiling gigapipe's exact `SanitizeKey` and running it; every
remote-write column by its exact `sanitizeRe`.

| input | OTLP result | remote-write result | strip? |
|---|---|---|---|
| `op_project_id` | `op_project_id` | `op_project_id` | **yes** |
| `op.project.id` | `op_project_id` | `op_project_id` | **yes** |
| `op project id` | `op_project_id` | `op_project_id` | **yes** |
| `op-project-id` | `op_project_id` | `op_project_id` | **yes** |
| `op:project;id` | `op_project_id` | `op_project_id` | **yes** |
| `op project id` (NBSP) | `op_project_id` | `op_project_id` | **yes** — no ASCII list contains it |
| `op–project–id` (en dash) | `op_project_id` | `op_project_id` | **yes** |
| `op　project　id` (ideographic space) | `op_project_id` | `op_project_id` | **yes** |
| `opіprojectіid` (Cyrillic і) | `op_project_id` | `op_project_id` | **yes** |
| `op\u{1F600}project\u{1F600}id` (emoji, 4 bytes) | `op_project_id` | `op_project_id` | **yes** — one `_` per rune, not per byte |
| `op_projectіd` (Cyrillic in place of `i`) | `op_project_d` | `op_project_d` | **no** — near miss, and it is one rune → one `_` |
| `op_project_іd` | `op_project__d` | `op_project__d` | **no** — near miss |
| `0op_project_id` | `_0op_project_id` | `_op_project_id` | no |
| `1x` | `_1x` | `_x` | — this pair **is** the parity test |
| `""` | `_` | `""` (unchanged) | no — the paths differ in a **second** way beyond the leading-char rule: remote-write has no empty-key handling at all, because `^[^a-zA-Z_]` requires one character to match |
| `operation_name` | `operation_name` | `operation_name` | no |
| `project_id` | `project_id` | `project_id` | no |

The draft asserted `""` → `_` on **both** paths, and justified the multi-byte
rows with a byte-wise rationale that would have produced `op___project___id` for
the emoji case and a replica diverging from gigapipe on every non-ASCII
character. Both are corrected above.

**The parity property test.** Named artifacts, because "10,000 pseudo-random
keys" with no producer named is a design task disguised as a spec:

- `test/telemetry/tools/gen-sanitizer-golden.go` — a `//go:build ignore` program
  that imports gigapipe's `SanitizeKey` from the checked-out tree at the pinned
  tag, reads the corpus, and writes the golden.
- `test/telemetry/__fixtures__/sanitizer-corpus.txt` — a **fixed, committed,
  seeded** corpus of 10,000 keys drawn from ASCII punctuation, digits, the
  separators above, multi-byte codepoints (Latin-1, CJK, emoji, combining
  marks), lone-surrogate-producing sequences and the empty string. Fixed, not a
  fresh RNG draw per run: a non-deterministic security-adjacent test is a flake
  generator.
- `test/telemetry/__fixtures__/sanitizer-golden.json` — the committed expected
  output, both paths.

`packages/gigapipe/src/labels.test.ts` (T0) asserts the JS replicas reproduce the
golden exactly, for both paths, plus the near-miss table above as named rows.
Regenerating the golden is **step 3 of the image-upgrade procedure** (§6);
there is no automated detection of a Go-side `SanitizeKey` change that does not
move a version string, and this document states that rather than implying
coverage that does not exist.

#### 3.2 Ingest matrix — `apps/api/src/telemetry/rewrite/*.test.ts` and `apps/api/src/telemetry/logs/*.test.ts`

**Written by the ingest work-stream (D21); specified here.** Two enforcement
shapes, because D17 settled two different write paths:

- **Metrics, traces, remote-write** — forward-in-place. The assertion in every
  row is: *the decoded upstream body contains **exactly one** `op_project_id` at
  each level that gets one; its value is **`P`**; and no other reserved-image key
  survives at any level.*
- **Logs** — decode and construct (D17, `05-logs.md` D1–D3). The assertion is:
  *the **constructed** Loki stream label set contains exactly one
  `op_project_id`, equal to `P`; every other label is a member of the closed
  allowlist; no reserved-image key survives in the label set **or** in the JSON
  envelope's `attr` map; and the value tuple has exactly two elements.*

`P` is the authenticated client's project.

| # | Signal | Level | Attack | Why it is here | Priority |
|---|---|---|---|---|---|
| E1 | metrics | resource | `op_project_id="victim"` | the obvious one | must |
| E2 | metrics | scope | same | scope attributes are merged | must |
| E3 | metrics | data point | same | the level a series label actually comes from | must |
| E4 | metrics | all three at once, three different values | | proves per-level strip, not "last one wins" | must |
| E5 | metrics | data point, **the §3.1 corpus rows** (17 rows, not 169) | `it.each` over the near-miss table | with the computed rule (D7) the alias set is closed by construction; a 169-row cross product is one equivalence class tested 169 times. The rows that earn their place are the **non-ASCII** ones and the near misses | must |
| E5b | — | source-level | grep the strip path for a hardcoded alias array, **and for a second parameter on `isReservedKey`** | asserts D7's rule is what shipped: one argument, three forms, no lookup table, no per-protocol branch. A `protocol`/`path` parameter is how the traces bypass gets reintroduced | must |
| E6 | metrics | two colliding aliases on one data point (`op.project.id` + `op-project-id`) | `mergeSanitizedAttrs` **concatenates** colliding keys with `";"` (`writer/utils/unmarshal/otlp_metrics.go:93-117`) rather than overwriting, so stamping alone does not rescue metrics — only the strip does. Assert no output label value contains `;` | must |
| E7 | metrics | resource, `op_organization_id` | reserved-never-stamped | must |
| E8 | metrics | data point, `__ttl_days__` | parsed into `MTTLDays` (`writer/utils/unmarshal/builder.go:333`); a dead letter in OSS today, but a future release could wire it | should |
| E9 | metrics | gauge / sum / histogram / exponential histogram / summary | every data-point type carries the stamp; a rewrite that only walks `Sum` is the likely bug | must |
| E10 | metrics | a metric with **zero** data points | no phantom series is emitted | should |
| E11 | metrics | resource with zero attributes | the stamp is still added — `target_info` binding depends on it | should |
| E12 | logs | log **record** attribute `op_project_id="victim"` | **still the single highest-value row, retargeted by D17.** Under the rejected forward-in-place design this was a working cross-tenant write, because gigapipe merges record attributes **last** (`otlplogs.go:46`, map write at `:100`) and they override the resource stamp. Under 05's construct design the attribute never becomes a label — so the assertion moves to the two places it can still surface: it is **absent from the constructed stream label set** and **deleted from the envelope's `attr` map** (05 §3.2 rule 4), and the pushed stream carries exactly one `op_project_id`, equal to `P` | must |
| E13 | logs | record attribute, the §3.1 corpus | E5 on the construct path. The corpus rows matter more here, not less: `sanitizeAttrKey` is applied to every `attr` key and a promoted key becomes a label | must |
| E14 | logs | scope and resource levels, and a **project-promoted** key colliding with a reserved one | completeness, plus the one interaction 05 D3's five-key promotion list creates | should |
| E15 | logs | record also sets `level`, `trace_id`, `span_id` | under 05 these are envelope/allowlist fields we compute, not fields gigapipe overwrites (`otlplogs.go:49-58` is on the path we no longer use); assert our own derivation and that the tenancy label is unaffected | should |
| E16 | traces | **span** attribute | resource wins today, but "today" is a pinned digest | must |
| E17 | traces | resource, several `ResourceSpans` in one request | every one stamped, not just `[0]` | must |
| E18 | remote-write | `TimeSeries.labels` already contains `op_project_id` | exactly one survives; a duplicate label is a malformed series | must |
| E19 | remote-write | corpus aliases | this path uses the **other** sanitizer | must |
| E20 | remote-write | 500 `TimeSeries` in one request | all stamped; the loop does not stop at the first | must |
| E21 | remote-write | a label named `__name__` set to a foreign metric name | not a tenancy break; assert it passes through unmodified so the compiler's assumptions hold | should |
| E22a | Loki push (customer-facing, `/telemetry/loki/api/v1/push`) | an entry carrying **both** `stream` and `labels` | two label sources into our decoder, exactly one tenancy label out | should |
| E22b | Loki push | an inbound entry array of `[ts, line, number]` | `decodeStreamValue` sets `SAMPLE_TYPE_LOG` from index 1 and `SAMPLE_TYPE_METRIC` from a numeric index 2, and `tp == 3 -> 0` (`unmarshal.go:144-165`) — the only producer of `type = 0` rows. **The draft conflated this with E22a; they are unrelated** | should |
| **E22c** | Loki push, **all** paths | **our outbound push never emits a three-element value tuple**, for any inbound shape, on any route, including `packages/logger`'s `loki` transport | **This is the replacement premise for `08-schema-changes.md` S13 and `10-ops-retention-billing.md` D10.** Their per-signal-TTL totality argument rests on `type ∈ {1,2}`, which `02-ingest-gateway.md` §1 derived from "the gateway does not expose Loki push". D17 makes that premise false — 05 exposes the route — so the invariant must be **enforced by our decoder and asserted here**, or the TTL design has no support at all. Assert on the serialised outbound body, not on intent | must |
| E23 | Loki push | corpus aliases on both label forms | | should |
| E24 | Loki push | multi-stream push | every stream stamped | must |
| E25 | all | header `X-CH-DSN: other-node` | `writer/controller/middleware.go:165` reads it, and `writer/chwrapper/factory.go:246-256` contains **unwired** caller-supplied-DSN dialing (`NewSmartDatabaseAdapterWithXDSN`). Strip it; do not trust it to be harmless — one upstream line turns it into a real DSN | must |
| E26 | all | `x-ch-dsn`, `X-Scope-Meta`, `X-Ttl-Days`, `X-Async-Insert`, a client `Authorization` | assert the outbound request carries **exactly** the allow-listed headers and nothing else — a positive assertion, not a set of negatives | must |
| E27 | all | body is `application/json` on an OTLP route | 415 from us. `/v1/logs` and `/v1/traces` register a single `"*"` parser ending in `proto.Unmarshal` — `writer/controller/insert.go:146` and `writer/controller/tempo.go:55`; only `/v1/metrics` has a protojson branch (`writer/controller/otlp_metrics.go:53-59`). **The draft cited `writer/utils/unmarshal/builder.go:520`, which is a different file and a generic helper** | must |
| E28a | metrics | **no** `Content-Type` header | a hard **400 from gigapipe**: `writer/controller/builder.go:134` matches with `strings.HasPrefix`, which never matches an empty string, and `/v1/metrics` registers no `"*"` fallback, so `:144` returns `New400Error("Content-Type not supported")`. We return 415 first | must |
| E28b | logs, traces | **no** `Content-Type` header | gigapipe's `"*"` fallback (`builder.go:139`) runs the proto parser **anyway**. Our 415 here is a **policy choice, not a shield** — say so, because the draft's "hard 400" rationale is metrics-only | must |
| E29 | all | payload over **our configured cap**, read from `02-ingest-gateway.md` §15's env block, **not** the 64 MiB upstream ceiling | The draft asserted "over 64 MiB", which passes while our own cap is unset — the test would be green with no bound in place. `02` owns these numbers and its reasoning is the best on offer (for two of three signals the gateway's decompressed cap is the only such bound in the system): `TELEMETRY_MAX_COMPRESSED_BYTES = 8 MiB` (OTLP), `TELEMETRY_MAX_COMPRESSED_BYTES_REMOTE_WRITE = 2 MiB`, `TELEMETRY_MAX_DECOMPRESSED_BYTES = 32 MiB`. Assert a protocol-correct 413 at each, **and** separately assert every configured cap is `<= 64 MiB` (`writer/controller/otlp_metrics.go:18-42`, `defaultOTLPMaxMessageSize = 64 << 20`). **`05-logs.md` §4.1's `OTLP_MAX_BODY = 4 MiB` and `06-traces-and-correlation.md` §4.2's 16 MiB are drift and must cite 02 §15 instead** | must |
| E30 | all | a gzip bomb over the decompress ratio | 413 without allocating the output | must |
| E31 | remote-write | a snappy body whose **decompressed** length exceeds the cap | gigapipe caps decompressed remote-write at 10 MiB (`middleware.go:122-124`) but its uncompressed fallback (`:134-137`) has **no** size check. Forwarding uncompressed to dodge a snappy dependency silently removes gigapipe's only body cap. Assert our own bound in **both** modes | must |
| E32 | all | route registration | **`/track`'s effective body limit is unchanged.** `apps/api/src/app.ts:88` sets `bodyLimit: 1_048_576 * 500` on the whole Fastify instance — the same instance that serves `/track`. Without a per-route limit, the telemetry routes buffer up to 500 MB of attacker protobuf on the event hot path before the gateway sees anything; and a naive fix that changes the instance limit changes `/track`, `/import` and `/export` too | must |
| E33 | all | 413 timing | the 413 is returned **before the full body is read** — assert the socket was closed early (or peak RSS stays bounded). "Returns 413" passes for an implementation that buffered the whole bomb first | should |
| **E34** | logs | `sanitizeAttrKey` | the **construct path's** key rule is `sanitizeRe` (`unmarshal.go:272`), **not** `SanitizeKey` (`otlplogs.go:107-117`): `sanitizeAttrKey('500ms') === '_00ms'`, not `'_500ms'`. 05 §3.2 rule 3 makes this choice deliberately, because it is the Loki-push rule that actually runs if the key is later promoted to a label. Had zero coverage in any document before D17 | must |
| **E35** | logs | the envelope builder | fixed key order; byte-identical output for identical input; the 64 KiB cap drops the largest `attr` first; **every reserved-image key deleted at rule 4**; a label value truncates to ≤ 100 **bytes** on a codepoint boundary; an empty-valued label is dropped | must |
| **E36** | logs | the closed label allowlist (05 D3) | a customer attribute that is not in the allowlist and not one of the ≤ 5 project-promoted keys **never becomes a label**, on either route; the promoted-key list cannot promote an `op_*` key; and the total label count per stream is bounded. This is the cardinality boundary D17 chose 05's design *for*, and it had no test row anywhere | must |

**The mechanism E29/E30/E32/E33 require, stated rather than implied:** a per-route
`bodyLimit` at or below 64 MiB set in the telemetry route options, plus a custom
content-type parser registered **on the telemetry routes only** that streams and
counts decompressed bytes, aborting past the bound. Fastify's default parser
cannot do E30 at all.

#### 3.3 Auth matrix — `apps/api/src/utils/auth.test.ts` (no test file exists today)

**Written by the ingest work-stream (D21); specified here.**
`apps/api/src/utils/` contains only `ids.test.ts` and `image-proxy.test.ts`.
Nothing anywhere exercises `validateSdkRequest`. Every row is new.

| # | Caller | Route | Expected | Why |
|---|---|---|---|---|
| A1 | `ClientType.write` / `read` / `root` | telemetry ingest | **reject** | allow-list, not deny-list |
| A2 | `ClientType.telemetry` | `POST /track`, `/event`, `/profile` | **reject** | these go through `validateSdkRequest` |
| A3 | `ClientType.telemetry` | `/export` | **reject** | |
| A4 | `ClientType.telemetry` | `/insights` | **reject** | `apps/api/src/routes/insights.router.ts:52` calls `validateExportRequest` in its own inline `preHandler`. Insights is the **larger** read surface — chart engine, event names, profiles, groups, saved reports |
| A5 | `ClientType.telemetry` | `/import` | **reject** | `import.controller.ts:13-27` pins `project_id` from the client, so the blast radius is one project — but it can insert hand-crafted `IClickhouseEvent` rows straight into `TABLE_NAMES.events`, bypassing the track pipeline, the bot hook and session logic |
| A6 | `ClientType.telemetry` | MCP | **reject** | `packages/mcp/src/auth.ts`. Note `packages/mcp/src/auth.test.ts:8` mocks `ClientType` as a plain object literal, so a new enum value can never break it — A6 must construct the value explicitly |
| A7 | `ClientType.telemetry` | `/manage` | **reject** | |
| A8 | `read` / `root` | all of the above | **accept** | the allow-list conversion must not break existing customers |
| A9 | telemetry client with `ignoreCorsAndSecret: true` | telemetry ingest | **reject unless the secret verifies** | `auth.ts:133-135` returns the client with **no** secret check. Client ids are public — they ship in web SDK bundles — so this path plus a public id **is** authentication |
| A10 | telemetry client, `Origin` matching `project.cors` | telemetry ingest | **reject unless the secret verifies** | `auth.ts:137-155` returns with no secret check, and `Origin` is freely settable from curl |
| A11 | telemetry client, `project.cors` contains `'*'` | telemetry ingest | **reject unless the secret verifies** | `auth.ts:158-160` |
| A12 | telemetry client with `secret: null` | telemetry ingest | **reject** | a credential with no secret cannot be the source of truth for `op_project_id` |
| A13 | credentials supplied in the JSON **body** | telemetry ingest | **ignored** | `auth.ts:52-58` pulls `clientId`/`clientSecret` out of `req.body` via ramda `path`. An OTLP protobuf body has no such fields, and reading the body before auth defeats admission control. `validateTelemetryRequest` must be **header-only** |
| A14 | telemetry client of org X | ingest whose body names a project of org Y | **the stamp is X's project** | the body never influences the stamp |
| A15 | org in `windDownStep` ∈ {`blocked`, `final_warning`} | telemetry ingest | **403 with a `google.rpc.Status` body** | see below — **this reverses the previous revision** |
| A16 | `SELF_HOSTED=true` | any wind-down case above | **no-op** | see below |

**A15 reverses this document's previous answer, and settles a four-way split.**
Four statuses were on disk for one condition: **403** (`02-ingest-gateway.md` §4
and `01-tenancy-and-security.md`'s "what the user sees" table, and
`10-ops-retention-billing.md` D15, which explicitly defers the choice to 02),
**200 `partialSuccess` / 204 + `X-OP-Blocked` / 404** (`05-logs.md` §4.3),
**202-and-drop** (`06-traces-and-correlation.md` §4.1 step 0), and **429 +
`Retry-After`** (this document, called "a deliberate divergence").

**02 owns the gateway's error semantics and 403 is right.** The part the
previous revision got right is that `/track`'s 202 is not the model: that test
does assert the opposite — `expect(status).toHaveBeenCalledWith(202)` and
`expect(send).toHaveBeenCalledWith({ blocked: true })`
(`apps/api/src/hooks/subscription.hook.test.ts:47-64`) — with an in-file comment
explaining that 202 exists because the OpenPanel SDKs retry everything but
401/2xx. The part it got wrong is picking 429. Wind-down is a **durable** state
lasting days: an OTel collector honouring `Retry-After` fills its sending queue,
drops the data anyway when the queue overflows, and hammers a blocked org's
gateway for a week meanwhile. 403 is what OTel exporters treat as **permanent** —
they stop retrying and surface it in their own error metrics, which is the signal
the customer needs. 429 + `Retry-After` and 503 + `Retry-After` remain correct
for the **transient** blocks, and `02` §4 already specifies 503 + `Retry-After:
900` for the per-project kill switch; that is where back-off semantics belong.

`05-logs.md` §4.3's 200/204 is rejected outright and this row is the regression
test for it: **a blocked ingest must never return 2xx**, because a 2xx makes a
blocked org look healthy to its collector — the exact failure `02` D7 and
`05` D13 otherwise both argue against.

A15 asserts three things: telemetry gets **403** with a well-formed
`google.rpc.Status`; the response is never 2xx and never 202; and `/track` still
gets 202, unchanged. Prefer parameterising the shared hook
(`subscriptionHook({ blockedStatus, blockedBody })`) so there is one wind-down
predicate rather than a copy, per `02` §4.

**A16 is not pedantry.** `vitest.shared.ts:26` pins `SELF_HOSTED: 'true'` for the
entire suite, and `subscriptionHook` no-ops when it is `'true'`. Any wind-down or
quota test written naively runs in the branch that does nothing and passes for
the wrong reason. Every such case uses `vi.stubEnv('SELF_HOSTED', 'false')` in
`beforeEach` with `vi.unstubAllEnvs()`, exactly as
`apps/api/src/hooks/subscription.hook.test.ts:40-44` already does.

Two credential-level rows:

| # | Assertion |
|---|---|
| **A17** | **the telemetry verification cache is keyed on the client id alone, with the stored hash and the presented digest in the VALUE.** Four shapes were specified across the document set; `01-tenancy-and-security.md` §6.1's is the only one that is rotatable, and its argument is decisive: keying on a digest of the presented secret — which `02-ingest-gateway.md` §2.2 (`telemetry:auth:${clientId}:${secretHash(clientSecret)}`, 300 s), `05-logs.md` §4.2 ("SHA-256 prefix of the secret as the cache key", 5 min) and `packages/mcp/src/auth.ts:106-108` all do — **makes the entry unaddressable at rotation time: no code path can reconstruct the key without the old plaintext, so nothing can clear it.** 02's own justification ("a rotated secret misses it") is inverted: the *new* secret misses, the *old* one hits its own warm entry and is granted for the full TTL. The settled shape: key `telemetry:auth:${clientId}`, TTL **60 s**, value `{ hash, digest }`, and on every hit re-verify with argon2 when `entry.hash !== client.secret \|\| entry.digest !== presented`, then drop the stale entry. Export `clearTelemetryAuth(clientId)`, called from `manage.controller.ts:327,368,394` **and** from tRPC `client.remove`. A17 asserts: an old secret is rejected within 60 s of rotation; a wrong secret never poisons the entry; and the plaintext appears in no Redis **key** |
| **A17b** | **the existing SDK path's cache key stops containing a reversible plaintext.** Verified: `apps/api/src/utils/auth.ts:164-165` builds `` getCache(`client:auth:${clientId}:${Buffer.from(clientSecret).toString('base64')}`, 60 * 5, …) `` — base64 is reversible, and the key lands in Redis key names, `SCAN`/`KEYS` output, the slowlog and any RDB dump. This matters more once `ClientType.telemetry` exists, because a telemetry ingest token is a long-lived server-side credential (an OTel collector config, a Kubernetes secret), not a public web-SDK id. **A prerequisite, not a test**: it is a code change to a shared path with a migration (a new `client:authv2:` prefix so old and new coexist and a deploy does not invalidate every cached verification at once). **Owner: the ingest work-stream, as a named P1a deliverable, before `ClientType.telemetry` reuses `getCache`** — `02-ingest-gateway.md` never touches `validateSdkRequest` today and must pick this up explicitly. A17b is the regression test for it |
| **A18** | **one revocation SLA — ≤ 60 s — and one verified bug that currently breaks it.** The previous revision published two numbers (≤ 60 s deletion, 5 min rotation) and told everyone to cite the larger. That is only true of the cache shapes A17 rejects; under `01` §6.1's shape both are ≤ 60 s, because the entry is addressable and `clearTelemetryAuth` can clear it. `01` §6.1's revocation table is the single source; `05-logs.md` §4.2's "5 minutes … the documented revocation SLA of a telemetry credential" and `02` §2.2's 300 s must cite it instead. **The verified bug, found by `02` and folded in here:** `packages/trpc/src/routers/client.ts:86-115` — `client.remove` deletes the `Client` row and **never calls `getClientByIdCached.clear(input.id)`**, unlike `apps/api/src/controllers/manage.controller.ts:134,206,327,368,394`, which do. So a dashboard-initiated revocation propagates only when `cacheable`'s 300 s Redis TTL expires, plus up to 60 s of other replicas' L1 LRU (`packages/redis/cachable.ts:155-156`) — **up to 360 s, not 60 s.** The one-line fix is a **P1a deliverable owned by the ingest work-stream**; A18 asserts the clear happens and that both paths converge on ≤ 60 s |

#### 3.4 Query matrix — `packages/gigapipe/src/query/*.test.ts`

| # | Input | Assertion | Priority |
|---|---|---|---|
| Q1 | a `zMetricMatcher` named `op_project_id` | rejected by **zod**, before compile | must |
| Q2 | `groupBy: ['op_project_id']` | rejected by zod | must |
| Q3 | a matcher named `op.project.id` / `op–project–id` / `opіprojectіid` | rejected — the validator runs `isReservedKey` (D7), matching the ingest rule. Includes non-ASCII rows | must |
| Q4 | matcher value containing `"`, `\`, `}`, `{`, `,`, `#`, newline, carriage return, tab, `U+001F`, a lone surrogate | compiles, then **re-parses with no error nodes**, and `assertPromqlScoped` passes | must |
| Q5 | matcher value over **100 UTF-8 bytes** with an `=` op, **remote-write-sourced series only** | typed **warning surfaced on the chart**, not a hard compile error — see below | should |
| Q6 | every `fn` × `metricType` × `aggregation` cell of `03-metrics-engine.md`'s compilation table | exactly one `op_project_id` `=` matcher per `VectorSelector`; the expression parses; goldens are literals | must |
| Q7 | `groupBy: []` | `sum(…)` with no `by`; `op_project_id` still in the selector | must |
| Q8 | `groupBy: ['service']` | `sum by (op_project_id, service) (…)` — the tenancy label is **carried through aggregation**, never `without` | must |
| Q9 | the user already grouped by `op_project_id` | de-duplicated to one occurrence | should |
| Q10 | `fn: 'histogram_quantile'` | `le` forced into the grouping set **ahead of** the user's labels; inner aggregation is `sum` regardless of `aggregation` | must |
| Q11 | a compiled expression hand-mangled to drop the matcher | `assertPromqlScoped` **throws** — the assertion itself is tested | must |
| Q12 | hand-mangled to `op_project_id=~"p1\|p2"` | throws (the op must be `=`) | must |
| Q13 | hand-mangled to a different project id | throws | must |
| Q14 | `projectId: ''` | throws before emitting anything | must |
| Q15 | `projectId` containing `"` or a newline | rejected by `assertProjectLabelValue` (`^[a-zA-Z0-9_-]{1,100}$`) | must |
| Q16 | a **negative** `offset` | rejected by us. `reader/router/prometheus_query_range.go:42` sets `EnableNegativeOffset: false`, so input stock Prometheus accepts is an error from gigapipe | should |
| Q17 | LogQL: an empty `stream` array | still emits a bound selector, never `{}` | must |
| Q18 | LogQL: an empty-value matcher supplied **first, middle and last** | rejected in all three positions. The last position is the one that panics gigapipe's planner rather than merely widening the query, so a single-position test passes for the wrong reason | must |
| Q19 | TraceQL: zero user conditions | `{resource.op_project_id="<p>"}` with no dangling `&&` | must |
| Q20 | TraceQL: user conditions containing `\|\|` | wrapped in parentheses, tenancy condition is the **head**; exact string asserted | must |
| Q21 | `filterTraceToProject` given a response mixing A's and B's spans | B's spans dropped; a trace with no matching spans returns empty (which the router maps to 404), never the raw response | must |
| Q22 | any label / series / values request | exactly **one** `match[]` (several become `UNION ALL` server-side), in the query string, with explicit `start` and `end` | should |
| Q23 | a route key not in `GIGAPIPE_ROUTES` | **compile error** — a path string cannot be passed at all | must |
| Q24 | `/api/v1/metadata`, `/api/v1/query_exemplars`, `/tempo/api/search/tags`, `/loki/api/v1/tail` | unreachable through the client. `/api/v1/metadata` in particular **cannot be project-scoped**: `reader/controller/prom_query_labels.go:82-121` reads only `metric`, `limit` and `limit_per_metric`, with no `match[]` | must |
| Q25 | the tRPC cache key | contains `projectId`. `packages/trpc/src/trpc.ts:206-208` keys the 60 s cache on `JSON.stringify(getRawInput())` with **no userId component**; it is project-scoped today only because `projectId` happens to be in the input | must |
| Q26 | a **cache hit** requested by a user without project access | `FORBIDDEN` — and see the stubbing requirement below | must |
| Q27 | any `observability.*` procedure given a `shareId` | `FORBIDDEN` | must |
| Q28 | a share caller passing `projectId: '<someone else>'` alongside a valid `shareId` | the **share's** project id wins | must |
| Q29 | a non-existent `shareId` | `FORBIDDEN`, not `INTERNAL_SERVER_ERROR`. `validateShareAccess` throws bare `new Error(...)` (`share.service.ts:148, 186, 214`), which tRPC maps to 500; a procedure cloned from `chartProcedure` (`packages/trpc/src/routers/chart.ts:83`) inherits that | should |
| Q30 | source-level: no resolver body in `observability.ts` references `input.projectId` | the project id is derived, never received | must |
| Q31 | a **`read`-level member of the correct project** calling every mutating `observability.*` and alert-rule procedure | `FORBIDDEN`, written as `it.each` over the procedure list so a new mutation cannot be added without a row. This is the one authorization control in the repo with a documented CVE — `packages/trpc/src/access.ts:36-39` warns that "a truthy result only proves membership, which is how a read-only member could delete reports and publish private analytics (GHSA-f9rx-pxgw-c6rg)". Leaving it to a manual PR checklist is exactly the enforcement that produced the CVE. `packages/trpc/src/access.test.ts:61` is the existing `it.each` model | must |

**Q5 is narrowed, and the draft's version was wrong in a way that would have
broken the primary ingest path.** The 100-char truncation lives in
`sanitizeLabels` (`unmarshal.go:274-276`), whose only callers are the Loki push
path, Influx, Loki protobuf and Prometheus remote-write. **OTLP never calls it** —
`SanitizeValue` (`otlplogs.go:119`) does not truncate at all. So a hard compile
error on any `=` matcher over 100 characters would reject every query against an
OTLP-ingested URL path or k8s resource name — the exact examples the draft cited,
on the plan's primary ingest path. Three corrections:

1. The bound is **UTF-8 bytes**, not characters: `lbls[i][1][:100]` slices a Go
   byte slice and can split a multi-byte rune. Use
   `Buffer.byteLength(value, 'utf8') > 100`, and add a golden with a multi-byte
   value straddling the boundary.
2. The rejection becomes a **typed warning surfaced in the chart**, never a hard
   error, and only where it applies.
3. The **real hazard the draft never mentioned** gets its own contract row
   (K23, §6): the same 150-byte value ingested via `/v1/logs` and via
   remote-write produces **two different stored values**, so one logical label
   matches or does not depending on which protocol wrote it. A service emitting
   via OTLP alongside a sidecar emitting via remote-write produces two series.
   The compiler cannot know a series' ingest protocol, so this is documented and
   asserted, not compiled around.

**Q26 must stub `NODE_ENV`, or it is vacuous.** `cacheMiddleware` **writes** the
cache unconditionally but **reads** it only under
`if (cache && process.env.NODE_ENV === 'production')` (`packages/trpc/src/trpc.ts:211`).
Under vitest `NODE_ENV` is `test`, so the second call re-executes the resolver,
the access check runs, and the test is green whether or not the vulnerability
exists — failure mode 2, in the row meant to catch a cross-tenant read. So Q26:

```ts
beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv('NODE_ENV', 'production'); });

it('a cache hit still runs the access check', async () => {
  const resolver = vi.spyOn(engine, 'execute');
  await callerA.observability.metricChart(INPUT);          // prime
  expect(resolver).toHaveBeenCalledTimes(1);
  await expect(callerB.observability.metricChart(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(resolver).toHaveBeenCalledTimes(1);               // proves it WAS a cache hit
});
```

The `toHaveBeenCalledTimes(1)` after the second call is what makes the assertion
mean something: without it, "the second call was forbidden" is satisfied by "the
cache was never read". `NODE_ENV !== 'production'` joins `SELF_HOSTED` in failure
mode 8.

#### 3.5 Response-side verification

| # | Given | Assertion |
|---|---|---|
| R1 | a matrix whose series carries **no** `op_project_id` | the fetch stage throws; the chart is an error, not a silent partial |
| R2 | a matrix whose series carries a **foreign** `op_project_id` | throws |
| R3 | a matrix with the correct label | the label is **stripped** from the series name before `format()` |
| R4 | a Loki stream with a foreign label | dropped |

R1 and R2 are the last line of defence: if the compiler is ever bypassed by a
code path nobody thought of, this is what catches it.

#### 3.6 End-to-end — `test/telemetry/tenancy.isolation.test.ts` (T2, every push)

**An absence assertion preceded by no presence assertion passes when nothing was
ingested.** `beforeAll` seeds both projects and asserts, through the same read
path, that A's count and B's count are both non-zero. Only then do the isolation
rows run.

| # | As | Surface | Assertion |
|---|---|---|---|
| I1 | A | `/api/v1/query_range` | A's values, none of B's |
| I2 | A | `/api/v1/series` | only A's series — the identical label sets are what make this meaningful |
| I3 | A | `/api/v1/label/__name__/values` | does not contain a metric name only B ingested |
| I4 | A | `/api/v1/label/service/values` | does not contain a label value only B ingested |
| I5 | A | `/loki/api/v1/query_range` | none of B's lines |
| I6 | A | `/api/search` (TraceQL) | none of B's spans |
| I7 | A and B | `/api/traces/{shared trace id}` | **each sees only its own spans of the same trace id.** The fixture uses one trace id for both projects specifically for this row; a trace id is attacker-chosen |
| I8 | — | ingest as A with a client `op–project–id="telemetry-b"` **and** `opіprojectіid="telemetry-b"` at every level of every protocol, then read as B | nothing appears. The non-ASCII spellings are the point (D7) |
| I9 | — | raw ClickHouse | `SELECT count() FROM gigapipe.time_series WHERE NOT simpleJSONHas(labels, 'op_project_id')` is `0` |
| I10 | — | raw ClickHouse | no fingerprint carries two distinct `op_project_id` values |
| I11 | — | raw ClickHouse | `time_series_gin` has rows with `key='op_project_id' AND val='telemetry-a'` for metrics and logs, and the same over `tempo_traces_attrs_gin` for traces. **This is the cross-stream contract with the retention and erasure sweeps**: if the tenancy work-stream moves where the label is stamped, the sweeps silently stop finding anything |
| I12 | — | negative control (D11): write one raw series straight to gigapipe, bypassing the gateway, labelled `op_project_id="telemetry-a"` | it **is** visible to A. Proves the isolation assertions are not vacuous |
| I13 | — | **the real `jobDelete()`** — see D13 and gate 1.9 | every A row gone from `time_series`, `samples_v3`, `time_series_gin`, `metrics_15s`, `patterns`, `tempo_traces`, `tempo_traces_attrs_gin`, `tempo_traces_kv`; B untouched |
| I14 | — | source-level | the telemetry table list is one exported constant, imported by the delete path, the retention sweep and the teardown; and `deleteTelemetryFromClickhouse` routes every target through `getReplicatedTableName` (`packages/db/src/clickhouse/client.ts:101-106`) — see Failure modes row 10 |

---

### 4. PromQL compiler — spec-in, string-out goldens

`packages/db/src/engine/metrics/compile.test.ts`. **T0.** Modelled on
`packages/db/src/services/filter-where.test.ts` (a pure builder, a small helper,
literal expectations) and `packages/db/src/clickhouse/query-builder.test.ts`
(escape and injection cases as first-class tests).

```ts
/**
 * Golden tests for zMetricQuery -> PromQL.
 *
 * Pure: no ClickHouse, no gigapipe, no network. Every expected string is a
 * literal. No snapshots -- `vitest -u` would silently bless a dropped
 * op_project_id matcher, which is a cross-tenant read committed by a keystroke.
 *
 * Every case additionally runs assertPromqlScoped(), which re-parses the output
 * with @prometheus-io/lezer-promql and requires exactly one `=` matcher on
 * op_project_id per VectorSelector. toContain('op_project_id') would pass for
 * `up{op_project_id="p1"} or up`.
 */
const PROJECT_ID = 'proj_1';
const GRID = buildGrid({
  interval: 'minute',
  startDate: '2026-03-04 00:00:00',
  endDate: '2026-03-04 01:00:00',
  timezone: 'UTC',
});

/** compile + the structural assertion in one call, so no case can forget it. */
const promql = (input: Partial<IMetricQuery>): string => {
  const out = compile(q(input), GRID, { projectId: PROJECT_ID });
  assertPromqlScoped(out.expr, PROJECT_ID);
  return out.expr;
};

it('rate, no groupBy', () => {
  expect(promql({})).toBe('sum(rate(http_requests_total{op_project_id="proj_1"}[1m]))');
});

it('groupBy carries the tenancy label through the aggregation', () => {
  expect(promql({ groupBy: ['service'] })).toBe(
    'sum by (op_project_id, service) (rate(http_requests_total{op_project_id="proj_1"}[1m]))',
  );
});

it('puts the tenancy matcher FIRST, ahead of every user matcher', () => {
  expect(promql({ matchers: [{ name: 'code', op: '=~', value: '5..' }] })).toBe(
    'sum(rate(http_requests_total{op_project_id="proj_1",code=~"5.."}[1m]))',
  );
});

it('drops a user matcher on the tenancy label rather than merging it', () => {
  // zod rejects this first (Q1); this asserts the compiler is also safe when a
  // row reaches it from a path that never ran the schema -- MCP create_report
  // and runReportFromConfig both write rows the schema never sees.
  expect(promql({ matchers: [{ name: 'op_project_id', op: '=', value: 'victim' }] as never }))
    .toBe('sum(rate(http_requests_total{op_project_id="proj_1"}[1m]))');
});

it('forces le into the grouping set ahead of user labels', () => {
  expect(promql({ metricType: 'histogram', fn: 'histogram_quantile', groupBy: ['service'] })).toBe(
    'histogram_quantile(0.95, sum by (op_project_id, le, service) ' +
      '(rate(http_requests_total_bucket{op_project_id="proj_1"}[1m])))',
  );
});

it('throws on an empty projectId before emitting anything', () => {
  expect(() => compile(q(), GRID, { projectId: '' })).toThrow(/project/i);
});
```

Escaping cases are `it.each` over a `[label, raw, quoted]` table covering `"`,
`\`, newline, carriage return, tab, `}`, `,`, `#` and a lone surrogate; each
re-parses cleanly and passes `assertPromqlScoped`.

#### 4.1 Grid tests — `grid.test.ts`

| # | Assertion |
|---|---|
| G1 | every `interval` in `packages/constants/index.ts:236-242` (`minute`, `hour`, `day`, `week`, `month`) maps to a step. There is **no sub-minute interval** in OpenPanel, and gigapipe floors/ceils every range query to a 15 s UTC boundary (`reader/controller/prom_query_range.go:55-56`), so the mapping is not the identity |
| G2 | the step always divides the calendar bucket |
| G3 | `range: '3m'` with `interval: 'minute'` — which the **server accepts**, only the UI blocks it — is roughly 130,000 points and must be **rejected by us** with a typed error. `prom_query_range.go:65-70` returns HTTP **500** for the 11,000-point cap, not 400, so leaving it to gigapipe produces an unclassifiable server error |
| G4 | a `week` bucket in `Pacific/Auckland` (UTC+13) covers the project's whole local week |
| G5 | a `day` bucket across a DST transition is 23 h or 25 h, not 24 |
| G6 | the emitted `start`/`end` land on 15 s boundaries **before** gigapipe quantises them, so our fold and gigapipe's grid agree rather than being off by up to 15 s at each end |
| G7 | the fold produces a **dense** grid — every bucket present, no gaps — for both `fill: 'zero'` and `fill: 'carry'` |
| G8 | the `date` strings are `yyyy-MM-dd HH:mm:ss`, naive, project-local (F1) |
| **G9** | **the previous window produces exactly the same point count as the current window**, across a DST boundary and across a non-15s-aligned start. See F10 — this is the gap that makes `format.ts:142` misalign |

---

### 5. FinalChart — fixture-in, chart-out

#### 5.1 Write the contract test first, against the existing engine

`packages/db/src/engine/final-chart.contract.test.ts`. **T1** (the event-engine
half needs ClickHouse). **This file must land before the metrics engine does** —
`grep -rn "FinalChart" --include='*.test.ts'` returns **zero** hits today, and
`packages/db/src/engine/` has exactly one test file (`formula.test.ts`, formula
arithmetic only).

```ts
export function assertFinalChartContract(chart: FinalChart, opts: {
  expectedDates: string[];   // the exact grid, in order
  minSeries: number;
  previous?: boolean;
}): void;
```

| # | Clause | Consumer that breaks |
|---|---|---|
| F1 | `series[].data[].date` matches `yyyy-MM-dd HH:mm:ss` — **naive, project-local, no `T`, no `Z`** | `apps/start/src/hooks/use-rechart-data-model.ts:19-52` matches by **exact string equality**, then does `new Date(date).getTime()`. ISO-with-`Z` passes the equality check and misplaces every point by the viewer's UTC offset — invisible in a diff |
| F2 | every series has the **same** `date` array, in the same order, densely | `use-rechart-data-model.ts:22` builds the x-axis from `series[0]` only; a ragged grid truncates every other series |
| F3 | `series` is sorted by descending `metrics.sum` | `format.ts:153`. Combined with F2, the largest-sum series is also the axis-defining series, so a sparse high-volume series that started recently would truncate the whole chart — which is why F2 says **dense** |
| F4 | `series[].id` is stable across two identical requests | `id` feeds a recharts `dataKey`, a React key **and** the persisted `visibleSeries` array on the `Report` row (`schema.prisma:446`). gigapipe emits labels in **Go map order** (`reader/controller/prom_query_range.go:258-266` ranges `s.Metric.Map()`), which Go randomises, so the metrics engine must impose a deterministic label ordering before building `names`/`id` |
| **F5** | **`series[].names` is a non-empty `string[]`** — the field is `names`, not `name` (`packages/validation/src/types.validation.ts:90`; `format.ts:102` returns `names: displayName`) | `serie-name.tsx`; `use-rechart-data-model.ts:38` reads `serie.names` |
| **F5b** | **`series[].event` is present with a non-empty `event.name`**, and for a metric series `event.name` is the metric identifier — never `unknown_event` | `IChartSerie.event` is required (`types.validation.ts:92-96`) and every renderer reads it. This is exactly the P1 failure story: a metric series that round-trips through Postgres and comes back as an event named `unknown_event` |
| F6 | `metrics.count` is `undefined` at the top level and a number per series | `format.ts:164`; `metric-card.tsx` documents the `N/A` this produces |
| F7 | no `NaN` or `Infinity` reaches `metrics.sum` / `min` / `max` | `packages/common/src/math.ts:20-33` — `sum`, `min` and `max` use a bare `filter(isNumber)` and propagate `NaN`; only `average` (`:8-18`) guards with `Number.isFinite`. gigapipe returns the literal strings `NaN`, `+Inf`, `-Inf`, so the mapper must coerce before `format()` |
| F8 | a fully-aggregated result with an **empty label set** still produces one series | `groupByLabels` drops any group whose label array is empty (`group-by-labels.ts:62`). `sum(rate(http_requests_total[5m]))` — the most common observability query there is — has an empty label set and would vanish |
| F9 | dates sort lexicographically | `packages/mcp/src/tools/analytics/reports.ts:71-85` sorts the pivot's date axis with a plain `dates.sort()` |
| **F10** | **when `previous` is requested: every series' `data[].previous` array is the same length as `data[]` and index-aligned to it, and `metrics.previous` is present on every series or on none** | `format.ts:142` pairs previous samples **by array index** — `previousSerie?.data[index]` — so a previous window yielding a different number of points shifts every delta by one bucket and shows a plausible wrong number with no error. Trivially produced on the metrics path: gigapipe floors `start` and ceils `end` to 15 s, so a previous window at a different offset returns one more or fewer point; a `day` bucket across a DST transition does the same. `packages/db/src/engine/index.ts:49-73` fetches the second window; `use-rechart-data-model.ts:34-36` renders it |

F8 and F10 are the clauses most likely to be argued away in review. Both are
tests, not comments, because both failures are a plausible-looking chart with no
error. F10 also has a **cost** the plan does not currently budget: a metric report
with `previous: true` is a **second gigapipe range query per report**, against the
fixed 30 s engine timeout and the 11,000-point cap. Gate 2.10 asserts it renders.

#### 5.2 The mapper test — `packages/db/src/engine/metrics/fetch.test.ts`

**T0.** Input is a captured gigapipe response
(`packages/gigapipe/src/__fixtures__/query-range-*.json`); output is
`ConcreteSeries[]` → `format()` → `FinalChart` → `assertFinalChartContract`.

| fixture | contains |
|---|---|
| `query-range-basic.json` | two series, dense, integer values |
| `query-range-sparse.json` | two series with different first-sample times (the Prometheus 5 m lookback case) |
| `query-range-nonfinite.json` | `"NaN"`, `"+Inf"`, `"-Inf"` as string values |
| `query-range-empty-labels.json` | an empty `metric` object — the F8 case |
| `query-range-histogram.json` | `le` present in the input, absent from the output labels |
| `query-range-previous.json` | a previous window one point shorter than the current one — the F10 case |
| `query-range-truncated.json` | a 200 whose body stops mid-array. `writeResponse` flushes the success prelude **before** streaming the matrix, so an upstream failure halfway through is a **200 with a truncated body** |
| `query-range-11k.json` | the literal error body for the 11,000-point cap |
| `error-transpile.json` / `error-engine.json` | both HTTP 500 with different messages; the classifier must tell them apart, or the test documents that it cannot |

| # | Assertion |
|---|---|
| M1 | float-second timestamps (`prom_query_range.go:277` writes `float64(v.T)/1000`) convert to ms exactly: `1772000000.5` → `1772000000500` |
| M2 | string values parse; `"0.30000000000000004"` round-trips |
| M3 | `"NaN"`, `"+Inf"`, `"-Inf"` become the fill policy's value, never `NaN` in the output (F7) |
| M4 | a payload containing a `histograms` key parses and yields **no** points from it. gigapipe never writes one — `writeMatrix` iterates only `s.Floats` — so this pins the parser's tolerance and makes the "no native histograms" decision safe |
| M5 | label ordering is imposed by us, not taken from the response (F4). Shuffle the fixture's key order; assert the produced `id` is unchanged |
| M6 | `op_project_id` is stripped from the series name after verification (R3) |
| M7 | the truncated fixture raises `GigapipePartialResponseError`; the partial data is never returned |
| M8 | **small gauge values are not flattened.** The metrics path applies the compile result's `valueScale`/`scaledUnit`. The draft anchored this on "the event path's fixed two-decimal rounding (`compute.ts:158`)", which is wrong twice: the line is `:160`, and it is inside the **formula** series builder — plain event counts are not rounded there. The rounding that actually flattens a small gauge is on **`average`**: `format.ts:81` and `:161` both do `round(average(...), 2)`, so a CPU fraction of `0.00123` averages to `0` in `metrics.average` and in the metric card. Combined with `allowDecimals: false` on the y-axis, that is a wrong chart. *Rejected:* widening the rounding to six decimals globally — it changes every existing event chart's tooltip for no reason |
| M9 | previous-window alignment (F10): the shorter-previous fixture produces either a padded, index-aligned `previous` array or a typed error — never a silently shifted one |

#### 5.3 Type-level assertions (D16)

In `packages/db/src/engine/final-chart.contract.test.ts`, with
`test.typecheck.enabled` turned on for `packages/db`:

```ts
it('MetricsChartEngine.execute produces FinalChart', () => {
  expectTypeOf(MetricsChartEngine.execute).returns.resolves.toEqualTypeOf<FinalChart>();
});

it('IMetricQuery is a member of IChartEventItem', () => {
  expectTypeOf<IMetricQuery>().toMatchTypeOf<IChartEventItem>();
});

// Direction matters: red before 'metric' joins the union, green after.
it('format() accepts a metric definition', () => {
  expectTypeOf<{ type: 'metric'; metric: string }>()
    .toMatchTypeOf<Parameters<typeof format>[1][number]>();
});
```

#### 5.4 The persistence round-trip — the item most likely to be forgotten

Extend `packages/db/src/services/reports.service.test.ts` (which today covers only
`mergeGlobalFilters`):

| # | Assertion |
|---|---|
| P1 | a metric series survives `transformReportEventItem` (`reports.service.ts:56`) with `metric`, `metricType`, `fn`, `aggregation`, `groupBy`, `matchers`, `window` and `displayName` intact, and `type` still `'metric'` |
| P2 | an event item and a formula item are unchanged |
| P3 | the metrics discriminator survives `transformReport` (`:83`) and `listReportsCore` (`:154`) |
| P4 | `report.create`, `report.update` and `report.duplicate` each persist and return it — three literal `data` objects, three assertions, because these are three **separate** hand-written whitelists (`packages/trpc/src/routers/report.ts:54, 97, 225`) |
| P5 | `transformReport` on a metrics report with an empty `events` array does not throw |

P1 is the regression test for the worst failure mode in the plan. Without it a
metric report renders correctly in the unsaved editor and comes back from
Postgres as an event series named `unknown_event` — an **empty chart, not an
error**, on every share, every dashboard tile and every MCP read.

---

### 6. Contract tests — catching a gigapipe upgrade under you

`test/telemetry/contract.reader.test.ts` and `contract.writer.test.ts`. Nightly,
and **an image digest bump does not land until they pass against the new digest**
(§7.3).

| # | Behaviour | Cited at | Assertion | Priority |
|---|---|---|---|---|
| K1 | `POST /api/v1/query_range` requires the exact `content-type` byte string `application/x-www-form-urlencoded` | `reader/controller/prom_query_range.go:122` | posting `…;charset=UTF-8` returns **400 "query is undefined"** | must |
| K2 | `start` floored and `end` ceiled to 15 s | `prom_query_range.go:55-56` | request non-boundary bounds; assert returned first/last timestamps | must |
| K3 | the 11,000-point cap returns **HTTP 500**, not 400, with an exact message | `:65-70` | the literal string appears verbatim and `UPSTREAM_STRINGS.TOO_MANY_POINTS` matches it | must |
| K4 | matrix timestamps are float **seconds**; values are **strings** | `:246-284` | shape assertion against a live response | must |
| K5 | `s.Histograms` is never written | `:274` | ingest a source that would produce a native histogram; assert no `histograms` key | should |
| K6 | the success prelude is flushed **before** the matrix | `:170-192` | **UNVERIFIED: how to induce this reliably against a live server.** Candidate: a matrix exceeding the socket buffer with the client aborting after the first chunk. Falls back to `query-range-truncated.json`, which tests our parser but not the upstream behaviour | should |
| K7 | Loki read routes are **GET-only** | `reader/router/query_range.go:20-23` | a POST returns 405 | must |
| K8 | Loki `start`/`end` are parsed as `float64` | `reader/controller/utils.go:21-34` | a nanosecond `start` round-trips within 512 ns (the float64 mantissa limit at 1.7e18) | must |
| K9 | `direction` honours only the literal `forward` | `query_range.go:58` | `Forward` behaves as `backward` | should |
| K12 | `EnableNegativeOffset` is false | `reader/router/prometheus_query_range.go:42` | a negative offset returns an error | should |
| K13 | the PromQL engine timeout is a fixed 30 s and is not configurable | `:32` | one assertion inside a suite already standing the server up; it bounds our client timeout and our worst-case dashboard query, and F10's second query doubles it | should |
| K14 | `/ready`, `/config`, `/metrics` and `/api/status/buildinfo` are behind basic auth once credentials are set | `cmd/gigapipe/main.go:321-325`; `shared/commonroutes/routes.go:11-18` | each returns 401 without the header and 200 with it. `/config` returns the literal `Not supported`, so it leaks nothing | must |
| K15 | `type` has **three** values (0 = UNDEF/both, 1 = LOG, 2 = METRIC), and reader predicates are `type IN (n, 0)` | `writer/model/insert_request.go:8-12`; `reader/logql/logql_transpiler/clickhouse_planner/sql_misc.go:213-220` | a Loki push carrying **both** a line and a numeric value produces a `type = 0` row (`unmarshal.go:163-165`), visible to **both** a LogQL and a PromQL query. This is what the retention TTL clauses (`type != 1` / `type = 1`) are written against | must |
| K16 | `samples_v3` gets no `type` in its sort key; `time_series`, `time_series_gin` and `metrics_15s` do | `ctrl/qryn/sql/log.sql:32, 115-128` | `SELECT sorting_key FROM system.tables` over the four tables | must |
| K17 | the **deployed** `samples_v3` DDL — read it, do not assume it. `log.sql:25-32` creates the table **without** `type`; the column is added by an `ALTER` in the maintenance path | `ctrl/qryn/maintenance/update.go` | assert `type` exists and record the full `create_table_query` in the test output, because the conditional TTL is written against it | must |
| K18 | `tempo_traces.oid` is `'0'` for every span — `writer/service/insert/tempo.go:86-93` lists nine columns and `oid` is not among them | | `SELECT DISTINCT oid FROM gigapipe.tempo_traces` returns only `'0'`, so the leading sort-key column and first partition component are degenerate and project-scoped trace lookups fall to `tempo_traces_attrs_gin` | should |
| K19 | `metrics_15s_mv` has **no `WHERE`** and rolls up log rows too | `log.sql:146-158` | a log-only push produces `metrics_15s` rows. This is why `metrics_15s` must not be recreated with `WHERE type != 1`: LogQL `rate()`/`count_over_time()` read the rollup with no fallback and dropping log rows returns **zeros, not an error** | must |
| K21 | `@prometheus-io/lezer-promql` version equals `.github/gigapipe-pin.json`'s `prometheusVersion` | | a plain equality assertion. **A pin-consistency check, not a skew detector** (D14). The nightly job additionally fetches `go.mod` from the pinned tag over HTTPS and compares `github.com/prometheus/prometheus` | must |
| K22 | the running image's digest equals the pin | | from `test/telemetry/.running-digest`, written by `run.sh` from `docker inspect --format '{{index .RepoDigests 0}}'`, **not** from `/api/status/buildinfo` (a stub, D14). Also asserts the compose file's image reference equals the pin's `image@digest`; the running image is only as trustworthy as what the runtime reports, and this document says so | must |
| **K23** | **the 100-byte truncation is remote-write-only** | `unmarshal.go:274-276` vs `otlplogs.go:119` | ingest one 150-byte label value via `/v1/logs` and the same value via remote-write; assert the two stored values **differ** (OTLP intact, remote-write truncated to 100 UTF-8 bytes + `"..."`). Documents the cross-protocol label-identity hazard behind Q5 | must |

**Cut from the draft, with reasons.** K10 (label-endpoint GET defaults "so we
know what we are avoiding") and K11 (gorilla/mux 301 on a doubled slash we never
emit) are assertions about behaviour we deliberately never invoke; they are prose
in the read-path spec, not tests. **K20** — standing up a second throwaway compose
stack with `QRYN_RULER_ENABLED=true` to prove that a component we never call does
nothing — is replaced by a T0 source-level assertion in
`packages/gigapipe/src/routes.test.ts`: **no ruler path is reachable through
`GIGAPIPE_ROUTES`, and if ruler CRUD is ever proxied, a rule with a non-empty
`alert` field is rejected at the OpenPanel gateway.** That is the thing that
actually protects us; gigapipe accepts, stores and re-serves alerting rules it
never evaluates, so relying on it to reject them is the footgun. Cost: about a
day off the §8 estimate and one fewer compose stack to maintain.

Writer-side rows (`contract.writer.test.ts`):

| # | Assertion |
|---|---|
| W1 | each committed fixture is accepted by the real `/v1/metrics`, `/v1/logs`, `/v1/traces`, the remote-write route and `/loki/api/v1/push`, with a 2xx |
| W2 | after `waitForSeries`, `SELECT labels FROM gigapipe.time_series` contains `op_project_id` with our value |
| W3 | a **delta**-temporality sum produces a `partial_success` with a non-zero rejected count and a message naming the metric. `checkTemporality` (`writer/utils/unmarshal/otlp_metrics.go:224-233`) rejects it **as a 200**, so the exporter's own error metrics stay at zero and the customer sees an empty chart with no signal anywhere. This is what makes our `metrics.rejected` counter meaningful |
| W4 | our forwarded `Content-Type` is accepted, and a request with **no** `Content-Type` gets a 400 from gigapipe on `/v1/metrics` and is parsed anyway on `/v1/logs` — pinning E28a/E28b against the real server |
| W5 | `application/json` on `/v1/logs` is rejected but on `/v1/metrics` is accepted. This asymmetry is what makes protobuf **encode** mandatory for two of three signals, and deserves an explicit test because a reader of gigapipe's own docs would conclude the opposite |
| W6 | a histogram round-trips with the `+Inf` bucket equal to `_count`. gigapipe puts the running cumulative sum in `+Inf` on purpose, so an inequality means a lossy producer, not a gigapipe bug — and the test records which |
| W7 | the compose file's own invariants as a source-level assertion (§2.3), plus `provision.sql` byte-identical to `self-hosting/clickhouse/gigapipe-provision.sql` and containing `CREATE DATABASE IF NOT EXISTS gigapipe` (D10) |

**The upgrade procedure this buys**, as numbered steps:

1. Change `.github/gigapipe-pin.json` (`tag`, `digest`, `clickhouseDigest`).
2. Change the two compose files' image references.
3. **Read `go.mod:44` from the gigapipe tag being adopted** and update
   `prometheusVersion`; if it moved, bump `@prometheus-io/lezer-promql` in the
   same PR (K21).
4. **Regenerate the sanitizer golden** (`test/telemetry/tools/gen-sanitizer-golden.go`
   against the newly checked-out tree) and commit the diff. There is no automated
   detection of a Go-side `SanitizeKey` change that does not move a version
   string.
5. Run the full nightly set as a required check on that PR (§7.3).
6. If an `UPSTREAM_STRINGS` constant moved, update it in the same PR. Anything
   else red is a design conversation, not a version bump.

---

### 7. Alerts, cron wiring, and CI

#### 7.1 Alert state machine

`apps/worker/src/jobs/alerts.evaluate-metric.test.ts`. **T0** — every dependency
mocked, in the style of `apps/worker/src/jobs/cron.wind-down.test.ts`.
`07-alerting.md`'s 16-row "evaluated in order, first match wins" table is
transcribed as `it.each`, one case per row:

```ts
const CASE = (
  row: number,
  from: StoredState | null,
  sample: { active: boolean; present: boolean },
  cfg: Partial<MetricAlertConfig>,
  want: { to: State; event: EventKind | null; notified: boolean },
) => [row, from, sample, cfg, want] as const;

it.each([
  CASE(1, firing(), { active: true,  present: true }, { mutedUntil: FUTURE }, { to: 'suppressed', event: null,      notified: false }),
  CASE(2, null,     { active: true,  present: true }, { forSeconds: 0 },      { to: 'firing',     event: 'firing',  notified: true  }),
  CASE(3, null,     { active: true,  present: true }, { forSeconds: 300 },    { to: 'pending',    event: 'pending', notified: false }),
  CASE(4, null,     { active: false, present: true }, {},                     { to: 'inactive',   event: null,      notified: false }),
  // rows 5 through 16
])('state table row %i', (_row, from, sample, cfg, want) => {
  const next = evaluate(from, sample, config(cfg), TICK);
  expect(next.state).toBe(want.to);
  expect(next.event?.kind ?? null).toBe(want.event);
  expect(notifySpy).toHaveBeenCalledTimes(want.notified ? 1 : 0);
});
```

Plus the cases that are **not** rows of the table, where the bugs live:

| # | Case |
|---|---|
| S1 | **first-match-wins between rows 9 and 10**: a firing series past `repeatSeconds` notifies, one before it does not. Two cases differing only in the tick, to prove ordering rather than assume it |
| S2 | **the `for` boundary**: fires at exactly `pendingSince + forSeconds` **and** only after `ceil(forSeconds / everySeconds)` contiguous active evaluations. A 40-minute gap containing two active samples does **not** satisfy a 10-minute `for` |
| S3 | **row 8 preserves `resolvedAt`**: firing → resolved → (cooldown elapses) → pending → not active must leave `resolvedAt` intact. Assert the **next** breach is still blocked by cooldown, not merely that the column is non-null — the weaker assertion passes against the bug |
| S4 | only a row that has never fired is deleted — row 7 versus row 8 |
| S5 | two successive fire/resolve cycles on one series carry **different** `incidentId`s |
| S6 | two breaching series produce two incidents and two notifications |
| S7 | `maxSeries + 1` samples produce one `cardinality_exceeded` event, **zero** per-series transitions, and do **not** resolve existing rows |
| S8 | a sample missing `op_project_id` **aborts the evaluation as `bad_query`** and transitions nothing |
| S9 | a sample whose `op_project_id` differs from the rule's project does the same |
| S10 | `"NaN"` / `"+Inf"` / `"-Inf"` values are dropped, not compared. `NaN > threshold` is `false` and `-Inf < threshold` is `true`, so a `lt` rule pages on garbage |
| S11 | a changed `configFingerprint` closes out every state row with `rule_changed` and sends nothing |
| S12 | `mutedUntil` in the future: state still transitions, no notification is sent |
| S13 | a `lt` rule does **not** fire on a partially-ingested newest bucket when `evaluationDelaySeconds` is honoured |
| S14 | gigapipe unavailable: firing rows stay firing, `lastEvaluatedTick` is **not** advanced, no notification before the third consecutive failure, and `consecutiveErrors` resets on the next success |

Idempotency, one test per layer:

| # | Layer | Case |
|---|---|---|
| X1 | BullMQ `jobId` | enqueueing `alert:{ruleId}:{tick}` twice adds one job. **T1**, real Redis, following `packages/db/src/buffers/event-buffer.test.ts:24-29` |
| X2 | `lastEvaluatedTick` | calling `evaluate` twice with the same `tick` produces exactly one `firing` event and one notification, **with X1 bypassed**. This is the actual guard; X1 only holds while the completed job is retained |
| X3 | level-triggered transitions | re-running against already-updated state produces no transition and no event |
| X4 | the outbox | three crash points. **Before commit**: nothing happened; the next tick re-evaluates cleanly. **After commit, before enqueue**: the sweep delivers late, exactly once. **After enqueue, before the `notifiedAt` stamp**: at most one duplicate, carrying the **same** `incidentId` — a duplicate page beats a missed one, a second *incident* is a bug. `db.$transaction` is mocked to throw at a configurable point and the **real** drain then runs against the resulting state |
| X5 | worker restart mid-incident | a `firing` row whose `nextEvaluationAt` is 40 minutes in the past is dispatched on the next tick, `missedTicks` is incremented, and the row does **not** spuriously resolve |
| X6 | redeploy during a lock hold | a stale `op:alert:lock:{ruleId}` expires within 60 s; a second evaluator that cannot acquire it bails **without writing** |
| X7 | clock skew | a source-level assertion that the evaluator never references `Date.now`, **plus** a behavioural case with a mocked `Date.now` ten minutes off and nothing changing |

Delivery — `apps/worker/src/jobs/notification.test.ts` (new; there is no
behavioural coverage of this path today, and both existing tests that touch it
mock `checkNotificationRulesForEvent` away):

| # | Assertion |
|---|---|
| N1 | a `metric` payload reaches webhook, Discord and Slack |
| N2 | a **null** payload returns without throwing — documents the `isValidJson(payload)` gate at `notification.ts:79`, which is why a metric alert **must** emit a non-null payload or it silently no-ops for three integrations while completing its BullMQ job |
| N3 | in the **default** webhook mode the body is title and message only (`notification.ts:99-106`); the raw payload is posted only when `mode === 'javascript'` (`:87`). A metric alert carrying a value, threshold and deep link therefore requires touching the body builder — assert current behaviour so that change is deliberate |
| N4 | the metric notification email template compiles and renders a label interpolation |
| N5 | delivery concurrency is 1 per replica by default (`apps/worker/src/boot-workers.ts:231-235`, `getConcurrencyFor('notification')` at `:94`, tunable via `NOTIFICATION_CONCURRENCY`). A one-line config assertion in a file already open |
| N6 | rule-cache staleness: `createOrUpdateRule` clears the cache **before** the write (`packages/trpc/src/routers/notification.ts:81` vs `:96`/`:120`), and `deleteRule` never clears at all. Assert current behaviour, then fix it in the same PR. Acceptable for "a signup happened"; a real problem for "CPU above 90 %" |
| N7 | `Notification.integration` is `onDelete: Cascade` (`schema.prisma:610-611`), so deleting an integration deletes its notification history |

#### 7.2 Cron and queue registration — the silent-failure gate the draft omitted

`apps/worker/src/jobs/cron.registration.test.ts`. **T0.** Two wiring paths fail
silently today:

1. `apps/worker/src/jobs/cron.ts:26-87` is a `switch` on `job.data.type` with
   **no `default` case** and no exhaustiveness assert. An unhandled type falls
   through, returns `undefined`, and BullMQ marks the job **completed**.
2. `apps/worker/src/boot-cron.ts:146-155` reaps every job scheduler whose key is
   not in the local `jobs` array, so a scheduler registered anywhere else is
   deleted on the next worker boot.

The plan adds at least a telemetry-retention cron and an alert evaluation tick.
Added to `CronQueuePayload` and `boot-cron.ts` but not to the `cron.ts` switch, it
runs forever and does nothing, green. Registered outside `boot-cron.ts`'s list, it
is deleted on the next deploy. Consequences: ClickHouse grows unbounded because
the TTL sweep never runs; telemetry volume is never metered so nobody is billed;
alerts never fire. None produces a failed job, a log line or a red test.

```ts
it.each(Object.values(CronQueueType))('%s is dispatched and registered', async (type) => {
  const handler = vi.fn();
  // (a) cronJob routes it somewhere
  await expect(cronJob({ data: { type } } as never)).resolves.not.toBe(undefined);
  // (b) bootCron schedules it
  expect(BOOT_CRON_JOBS.map((j) => j.type)).toContain(type);
});
```

and, as part of this work-stream, `cron.ts` gains
`default: assertNever(job.data.type)` so the compiler catches the next omission.

#### 7.3 CI versus nightly

**Every push.** `docker-build.yml`'s `lint-and-test` job (and the new
`tests.yml`, D4) gains:

```yaml
      # gigapipe cannot be a service container: initDB panics when ClickHouse is
      # not yet accepting connections (cmd/gigapipe/main.go:74-77 ->
      # ctrl/ctrl.go:31-34) and service containers give no health-gated
      # ordering. Compose does.
      - name: Boot the telemetry test stack
        run: ./test/telemetry/run.sh up     # exports OP_GIGAPIPE_READY=1 to $GITHUB_ENV

      - name: Run tests
        run: pnpm test
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres?schema=public
          CLICKHOUSE_URL: http://localhost:8123/openpanel
          REDIS_URL: redis://localhost:6379
          GIGAPIPE_TEST_URL: http://localhost:3199

      # Gate 1.0: the security suite must have been COLLECTED and have run
      # assertions. A fail-closed guard is worthless if the file is never loaded.
      - name: Assert the tenancy gate ran
        run: ./test/telemetry/run.sh assert-collected

      - name: Tear down
        if: always()
        run: ./test/telemetry/run.sh down
```

**T3 does not gate deploys.** The draft hung four gates on the existing `smoke`
job. `merge-api` (`:243`), `merge-worker` (`:362`) and `merge-dashboard` (`:481`)
all declare `needs: [build-*, smoke]`, so a gigapipe registry outage, a slow boot
or a flaky authenticated healthcheck would block publishing the api, worker and
dashboard images for pushes with nothing to do with observability. The document
worries at length about flake muting the security gate and never about flake
blocking all deploys.

**Shipped:** a separate `smoke-observability` job with
`needs: [build-api, build-worker, build-dashboard]` and **no** `merge-*` dependency
on it. It is a required check on PRs but not a deploy blocker. **The escape
hatch, named:** `OP_SMOKE_OBSERVABILITY=0` in the workflow env removes the
gigapipe service from `.github/smoke/docker-compose.yml` via a compose profile;
using it requires a repo admin and a linked issue. Without a stated escape hatch,
the first outage produces an improvised one.

**Nightly** — `.github/workflows/nightly-telemetry.yml`, `cron: '0 3 * * *'` plus
`workflow_dispatch`, with `TELEMETRY_NIGHTLY=1`:

| suite | why nightly |
|---|---|
| `contract.reader.test.ts`, `contract.writer.test.ts` | ~forty assertions against a live server; the thing they catch (an upstream change) cannot happen between two of our pushes |
| `retention.test.ts` | seeds 40 days across two projects and two tiers, runs the cron, asserts the tier matrix on **both** `samples_v3` and `metrics_15s`. Minutes, and mutation-heavy |
| `erasure.test.ts` — the 100k-series scale half only | the correctness half (gate 1.9) is per-push |
| the codec against the built bundle | needs `pnpm --filter api build` first |
| the load test | owned by `10-ops-retention-billing.md`; five phases of twenty minutes |

**Resource envelope, stated:** the nightly job runs on `ubuntu-latest` (14 GB
disk, 16 GB RAM). `retention.test.ts` seeds ~40 days × 2 projects × 2 tiers at
15 s resolution ≈ 460k samples; `erasure.test.ts` seeds 100k series. Both are
well inside a single runner, but each suite carries an explicit
`testTimeout: 600_000` and the job carries `timeout-minutes: 45` (without the
load test). If either is exceeded the job fails rather than hanging until the
six-hour default.

**Nightly failures open an issue rather than blocking — with one stated
exception, and the draft contradicted itself here.** §12 of the draft opened "a
phase does not merge until every row is green in CI", while several P0 rows lived
in nightly-only suites. Both cannot be true. **The mechanism:** the PR that closes
a phase triggers the nightly workflow as a **required check** via its `paths:`
trigger (which already includes `.github/gigapipe-pin.json`) plus an explicit
`workflow_dispatch` run whose run id is pasted into the phase-close checklist.
Gates 0.2, 0.5, 0.6, 0.7 and the contract rows are green **in that run**, not in
the ordinary per-push run.

**Cost:**

| job | added time | added cost |
|---|---|---|
| every push (`lint-and-test`) | ~90 s (one image pull, one `init_only` run, one T2 suite) | ~1.5 runner-minutes |
| `smoke-observability` (new, non-blocking) | ~3 min (image pull + boot + assertions) | ~3 runner-minutes on pushes that build images |
| nightly | ~25 min without the load test; ~2 h with | one run per day |

**UNVERIFIED: the per-push figure.** It is an estimate; Q2 says how to settle it.
Above roughly three minutes the answer is a cheaper variant (a pre-pulled image,
or the job moved into a container), not abandoning the gate.

**Flake policy, because "review pressure" is not a mechanism.** The
observability work-stream lead triages every nightly failure within one working
day and either fixes it or files an issue linked from the nightly run. A red
`tenancy.isolation.test.ts` on a per-push run **blocks merge and is debugged**;
the retry budget is **zero** — no `rerun-failed-jobs` on that suite without a
written root cause in the PR. Quarantining it requires the same approval as
disabling a required check. And, for the record: the repo installs a `pre-push`
hook running `pnpm typecheck && pnpm test` for every developer
(`package.json:33-35`); T2 suites `describe.skip` there because
`OP_GIGAPIPE_READY` is unset, **by design** — pushing does not require Docker.

---

## Interfaces

### What this work-stream needs from others

| Need | From | Status |
|---|---|---|
| The `packages/gigapipe` versus `packages/db/src/gigapipe` decision | read-path + metrics + logs owners | **blocking** — Q1 |
| `assertPromqlScoped` / `assertLogqlScoped` / `assertTraceqlScoped`, exported from a `testing` entry point | tenancy | §3.4, §4 |
| `isReservedKey(key, path)` — the **computed** strip predicate (D7), exported from `packages/gigapipe/src/labels.ts`, with no alias table anywhere in the strip path | ingest | §3.1, §3.2 (E5b asserts it) |
| `deleteTelemetryFromClickhouse(projectIds)`, **plus the single exported telemetry-table constant it shares with the retention sweep and the T2 teardown**, **plus a call from `deleteFromClickhouse` or `jobDelete`** | schema / ops + ingest | D13, gate 1.9 — the call site is the part currently owned by nobody |
| A **new** `validateTelemetryRequest`: header-only, requires non-null `client.secret`, verifies it, never consults `project.cors`, allow-lists `ClientType.telemetry` | ingest | §3.3 A9–A13 |
| The SHA-256 verification cache key change with a **new key prefix** | ingest | A17 — a prerequisite, not a test |
| A telemetry-specific wind-down hook returning **429 + `Retry-After`**, leaving `subscriptionHook`'s 202 untouched | ingest | A15 |
| Per-route `bodyLimit` ≤ 64 MiB and a streaming decompressed-byte counter on the telemetry routes only | ingest | E29–E33 |
| `self-hosting/clickhouse/gigapipe-provision.sql`, **containing `CREATE DATABASE IF NOT EXISTS gigapipe`** | ops | copied to `test/telemetry/provision.sql`; W7 asserts they are identical |
| `startMockUpstream` under `apps/api/src/telemetry/__test__/` | ingest | this document specifies the signature |
| The final `zMetricQuery` shape | metrics | §4's goldens are written against `03-metrics-engine.md` as of this writing |
| The `MetricAlertState` / `MetricAlertEvent` shape and the 16-row state table | alerting | §7.1 transcribes it; a row change there is a row change here |
| `default: assertNever(job.data.type)` in `apps/worker/src/jobs/cron.ts` | alerting / ops | §7.2 |
| `pnpm typecheck` re-enabled in CI (`docker-build.yml:124-128`) | whoever owns the workflow | **promoted from an open question to a blocking P2 prerequisite** — D16 |

### What this work-stream exposes

| Name | Location | Consumer |
|---|---|---|
| `describeGigapipe`, `gigapipeReachable`, `waitForSeries`, `waitForLogLines`, `waitForTrace` | `test/telemetry/guard.ts` | every T2 suite |
| `setupTelemetryFixtures`, `teardownTelemetryFixtures`, `TELEMETRY_FIXTURE` | `test/telemetry/fixtures.ts` | every T2 suite |
| `assertFinalChartContract` | `packages/db/src/engine/final-chart.contract.test.ts` | both engines, and any future one |
| `sanitizer-corpus.txt` + `sanitizer-golden.json` + `gen-sanitizer-golden.go` | `test/telemetry/__fixtures__/`, `test/telemetry/tools/` | `packages/gigapipe/src/labels.test.ts`; step 4 of the upgrade procedure |
| `.github/gigapipe-pin.json` | | both compose files, K21, K22, the upgrade procedure |
| `./test/telemetry/run.sh` (`up` \| `down` \| `assert-collected`) | | CI, and a developer running one T2 suite locally — **arm64 works**, both pinned images publish `linux/arm64` |
| `test/telemetry/vitest.config.ts` + the `'test/telemetry'` workspace entry | | anyone adding a T2 suite |

---

## Failure modes

The suite itself can fail in ways that leave the boundary unproven. Ranked by how
invisible the failure is.

| # | Failure | Detection | Mitigation |
|---|---|---|---|
| 1 | **The security suite silently stops running** — not collected by any Vitest project, a typo'd `GIGAPIPE_TEST_URL`, a container that failed to boot, or a `paths-ignore` glob | none, by construction | D2's workspace entry, D3's fail-closed guard **plus gate 1.0's collected-count check**, D4's scoped workflow, K22's digest assertion. The collected-count check is the one that closes this rather than assuming it away |
| 2 | **An absence assertion passes because nothing was ingested.** "B sees zero series" is satisfied by an empty database | none | every isolation row is preceded by a `beforeAll` presence assertion through the same read path, plus the I12 negative control |
| 3 | **The fixture makes the test vacuous.** Two projects with different metric names would pass against a completely broken implementation | code review only | the fixture uses **identical** metric names, label sets and trace ids; the two projects differ by exactly `op_project_id` |
| 4 | **A test passes because an environment gate short-circuits it.** `NODE_ENV=test` means `cacheMiddleware` never reads the cache (`trpc.ts:211`); `SELF_HOSTED='true'` (`vitest.shared.ts:26`) means `subscriptionHook` no-ops; a mocked `verifyPassword` means every secret check passes | none | Q26 stubs `NODE_ENV=production` **and** asserts a resolver spy was called exactly once; A16 stubs `SELF_HOSTED=false`; the T2 fixture leaves `verifyPassword` and `getClientByIdCached` unmocked (D11) |
| 5 | **Flake drives `it.skip`.** A gate that fails one run in twenty gets muted within a month | the CI flake rate | D12's polling protocol, no `sleep` anywhere, `BULK_MAX_AGE_MS=100`, **and the stated policy in §7.3**: named triage owner, zero retry budget, quarantine requires the same approval as disabling a required check |
| 6 | **The golden gets blessed.** `vitest -u` on a compiler whose output silently lost a matcher | none | D5 (no snapshots) **and** D6 (structural re-parse). Both are needed: literals stop the accidental bless, the re-parse stops a hand-edited literal |
| 7 | **Sanitizer drift.** gigapipe changes `SanitizeKey` and our replica stops matching | K22 catches the version change, not the behaviour change | the parity golden is regenerated from gigapipe's source as step 4 of the upgrade procedure. **There is no automated detection of the Go-side change**, stated plainly because it is true |
| 8 | **Telemetry survives project deletion.** The Postgres row is gone, the ClickHouse rows are not, and nothing can enumerate them again | none — no test file exists for `cron.delete.ts` or `delete.service.ts` today | gate 1.9 runs the **real** `jobDelete()` per push; I14 asserts one shared table constant |
| 9 | **The contract suite drifts into a change-detector.** Assertions on upstream strings become things to update on every bump | review pressure | every `UPSTREAM_STRINGS` constant lives in one file; a bump that changes one is a one-line diff plus a test update in the same PR. A bump that changes five is a signal the PR must explain. The draft's K10/K11/K20 — assertions about behaviour we never invoke — are **cut** rather than mitigated |
| 10 | **Clustered ClickHouse is uncovered, and the design branches on it.** The T2 stack leaves `CLUSTER_NAME` unset (it must — setting it makes every DDL `ON CLUSTER` against a cluster that does not exist). But `isClickhouseClustered()` defaults to **true** whenever `SELF_HOSTED` is not set (`packages/db/src/clickhouse/client.ts:83-93`), and `getReplicatedTableName` (`:101-106`) rewrites every mutation target as `<table>_replicated ON CLUSTER '{cluster}'`. So on a clustered install the telemetry delete, the retention sweep and the conditional TTL must all be `ON CLUSTER` and target the `_replicated` names — **and no suite here exercises that.** A GDPR erasure executing on one replica is a half-completed delete that reports success | none | **Stated, not fixed.** The must-have is I14's source-level assertion that `deleteTelemetryFromClickhouse` routes through `getReplicatedTableName`. A nightly two-replica variant is a *should* (Q8). Before telemetry is enabled on any clustered install, an operator runs the manual verification in `10-ops-retention-billing.md` and records the result |
| 11 | **The T2 stack drifts from the production stack** | none | W7 asserts the test compose's invariants and that `provision.sql` is byte-identical to the shipped one. Neither covers everything — an ops-owned diff review at each image bump is the remainder |
| 12 | **A new cron type is added and never dispatched, or is reaped on the next deploy** | none — BullMQ marks the undispatched job **completed** | §7.2's exhaustive registration test plus `assertNever` in `cron.ts` |

---

## Test requirements

A phase does not merge until every **must** row is green — in the per-push run for
per-push suites, and in the phase-close nightly run whose id is pasted into the
checklist for nightly suites (§7.3).

### P0 — stack

| # | Gate | Where | Pri |
|---|---|---|---|
| 0.1 | compose boots on all surfaces; provision and init exit 0; gigapipe reaches healthy | `smoke-observability` | must |
| 0.2 | `SELECT partition_key FROM system.tables WHERE database='gigapipe' AND name IN ('samples_v3','metrics_15s')` shows `type` in both | `contract.writer.test.ts` (phase-close nightly) | must |
| 0.3 | **stopping gigapipe does not affect anything else** — `op-api`, `op-dashboard`, `op-worker` stay healthy and `/track` still returns 2xx. The regression test for the no-`depends_on` decision | `smoke-observability` | must |
| 0.4 | the healthcheck authenticates: right password → healthy, wrong password → unhealthy | `smoke-observability` | must |
| 0.5 | K14 — `/ready` is 401 without the header | `contract.reader.test.ts` | must |
| 0.6 | K17 — the deployed `samples_v3` DDL is read and recorded | `contract.writer.test.ts` | must |
| 0.7 | **`TTL <expr> DELETE WHERE <cond>` parses on `clickhouse/clickhouse-server:25.10.2.65`**, in **two** forms: a single rule with `WHERE`, and **two comma-separated rules each with its own `WHERE`**. ClickHouse's published grammar is `TTL expr [DELETE\|…][, …] [WHERE conditions]`, which shows the `WHERE` after the rule list and does **not** unambiguously grant a per-rule `WHERE`; the two-tier retention design needs the per-rule form. The single load-bearing unverified premise of the retention design | `retention.test.ts` | must |
| 0.8 | `get_latest_images apply` run twice leaves `ghcr.io/metrico/gigapipe` byte-identical | shell test in `smoke-observability` | must |
| 0.9 | the quiz matrix: {bundled, bring-your-own ClickHouse} × {observability accepted, declined} | a `jiti` script beside `self-hosting/` | should |
| 0.10 | **`.github/workflows/tests.yml` exists and runs on a test-only push** (D4) | the workflow file | must |
| 0.11 | **every package receiving a new test file has a `vitest.config.ts`** — `packages/validation` and `packages/gigapipe` are new; `packages/redis` is a pre-existing gap. Without one, a suite there gets no `setupFiles` and no pinned `test.env`, so it reads the developer's real `.env` | a source-level assertion over `vitest.workspace.ts` and the package dirs | must |
| 0.12 | `packages/gigapipe/tsconfig.json` includes `**/*.test.ts`, or `pnpm typecheck` skips every assertion in §3.4 and §4 | typecheck | must |

### P1 — ingest

| # | Gate | Pri |
|---|---|---|
| 1.0 | **the collected-count meta-gate**: `vitest list` names `tenancy.isolation.test.ts` and the JSON reporter records a non-zero test count for it | must |
| 1.1 | the ingest matrix E1–E33, **must** rows green | must |
| 1.2 | the auth matrix A1–A18, green, in the new `apps/api/src/utils/auth.test.ts` | must |
| 1.3 | sanitizer parity in both directions against the committed golden, including every non-ASCII row and both near-miss rows | must |
| 1.4 | codec C1 (uint64 exactness), C3 (`Export*ServiceRequest` vs bare `*Data` wire compatibility), C4 (documented unknown-field drops), C5 (snappy decompressed once, no `Content-Encoding` forwarded). C2 (against the built `dist/`) is nightly | must |
| 1.5 | `tenancy.isolation.test.ts` I1–I6, I8, I9, I11, I12 green in CI (metrics and logs; traces at P4) | must |
| 1.6 | `/healthcheck` returns **200** while the gigapipe probe is failing — stops a gigapipe outage from restarting `op-api` | must |
| 1.7 | `pnpm dev` with `GIGAPIPE_INTERNAL_URL` unset registers no telemetry routes | must |
| 1.8 | error semantics: every row of the status table — upstream 503/401/403/413/415/429/500 each produces a protocol-correct `google.rpc.Status`, **not** app-level JSON | must |
| **1.9** | **the real `jobDelete()` erases telemetry.** Seed telemetry for a project, mark it `deleteAt`, run `jobDelete()`, assert zero rows in all eight gigapipe tables and B untouched (I13), plus I14's single-constant and `getReplicatedTableName` source assertions | must |
| 1.10 | E32 — `/track`'s effective body limit is unchanged by telemetry route registration | must |

### P2 — metrics

| # | Gate | Pri |
|---|---|---|
| 2.0 | **`pnpm typecheck` is a required check** (`docker-build.yml:124-128` uncommented), and `test.typecheck.enabled` is on for `packages/db` and `packages/validation`. Without this D16 is enforced by nothing | must |
| 2.1 | **`final-chart.contract.test.ts` green against the EVENT engine.** A prerequisite for *starting* P2 | must |
| 2.2 | the §4 compiler goldens, every `fn` × `metricType` × `aggregation` cell | must |
| 2.3 | query matrix Q1–Q31, **must** rows | must |
| 2.4 | mapper tests M1–M9 against captured fixtures | must |
| 2.5 | `final-chart.contract.test.ts` green against the **metrics** engine, including F10 | must |
| 2.6 | persistence round-trip P1–P5 | must |
| 2.7 | `dispatch.test.ts`: each executor call site routes `dataSource: 'events'` exactly as it does today — a before/after assertion per site. Without this, every existing bar and pie report silently changes engine | must |
| 2.8 | Q25 and Q26, with the `NODE_ENV` stub and the resolver-spy assertion | must |
| 2.9 | the subscription chart-end-date clamp is applied on the metrics path too. Otherwise a lapsed subscription hides events and leaks metrics | must |
| 2.10 | **a metric report with `previous: true` renders**, and G9 (previous point count equals current across DST and a non-15s-aligned start) is green | must |
| 2.11 | Q31 — a `read`-level member is FORBIDDEN on every mutating `observability.*` procedure | must |

### P3 — logs

| # | Gate | Pri |
|---|---|---|
| 3.1 | LogQL compiler invariants including Q17 and Q18 (the empty-value matcher in **all three** positions) | must |
| 3.2 | envelope, severity, stream-parse and pagination suites | must |
| 3.3 | `tenancy.isolation.test.ts` I5 green | must |
| 3.4 | K7–K9 (GET-only, float64 bounds, `direction`) | must |
| 3.5 | K15 (`type = 0` visible to both signals) and K19 (`metrics_15s_mv` rolls up logs) | must |
| 3.6 | K23 — the remote-write-only 100-byte truncation, asserted as a cross-protocol asymmetry | must |

### P4 — traces and correlation

| # | Gate | Pri |
|---|---|---|
| 4.1 | TraceQL compiler Q19 and Q20 | must |
| 4.2 | `filterTraceToProject` Q21 | must |
| 4.3 | `tenancy.isolation.test.ts` **I7** — the shared-trace-id case. Cannot be deferred: a trace id is attacker-chosen | must |
| 4.4 | K18 (`oid` is `'0'`) | should |
| 4.5 | correlation: a span carrying a session id resolves to the right OpenPanel session, and a span carrying a **foreign** project's session id resolves to nothing | must |

### P5 — alerts

| # | Gate | Pri |
|---|---|---|
| 5.1 | every row of the §7.1 state table | must |
| 5.2 | S1–S14 | must |
| 5.3 | X1–X7 | must |
| 5.4 | N1–N7 | must |
| 5.5 | `packages/trpc/src/routers/notification.test.ts` — a `ruleId` belonging to another project is rejected by **every** read procedure; Q31 over the alert-rule mutations | must |
| 5.6 | the Prisma JSON `path` filter behaves on 6.14 (T1, in `packages/db`). No precedent anywhere in this repo | must |
| 5.7 | **`pnpm typecheck` passes with the widened `zNotificationRuleConfig`** — the only mechanical check that every `config.events` site was found. There are **12 references across 3 files** (`add-notification-rule.tsx`, `rule-card.tsx`, `notification.service.ts`), not the four the draft claimed; `rule-card.tsx:21` types itself as `NotificationRule['config']['events'][number]`, a hard compile error the moment a union member lacks an `events` array | must |
| 5.8 | §7.2's cron registration test, with the telemetry-retention and alert-tick types added to `CronQueueType` | must |

### P6 — raw PromQL and the rest

| # | Gate | Pri |
|---|---|---|
| 6.1 | the rewrite fixture set: bare selectors, brace selectors, quoted metric names, `offset`, `@`, subqueries, binary and set operators, `absent()`, nested parens, comments before and inside braces, 200 selectors in one expression, and every parse-error case — each asserting the exact output string | must |
| 6.2 | refusals: `label_replace` / `label_join` targeting `op_project_id` or with a non-literal destination; a pre-existing `op_project_id` matcher; over-length; unparseable; an empty selector | must |
| 6.3 | `assertPromqlScoped` negatives (Q11–Q13) | must |
| 6.4 | **the differential corpus**: at least 200 expressions including Prometheus's own `promql/parser` testdata, every one rewritten and submitted to a live gigapipe. A Go-side **parse** error on a JS-rewritten query **is** the skew signal. With two projects loaded, every response contains only the querying project's series | must |
| 6.5 | K21 as a required check | must |
| 6.6 | a 24 h green canary before the flag flips. Merged is not enabled | must |
| 6.7 | quota and metering: a quota-exceeded ingest returns the documented status, the meter advances on a successful ingest, and does **not** advance on a rejected one | must |

---

## Open questions

| # | Question | What would settle it | By when |
|---|---|---|---|
| Q1 | **`packages/gigapipe` or `packages/db/src/gigapipe`?** Three sibling specs disagree. Every path here containing `packages/gigapipe/` depends on the answer | a conversation between the read-path, metrics and logs owners | before anyone writes a test file |
| Q2 | **What does `./test/telemetry/run.sh up` cost on `ubuntu-latest`?** The 90 s per-push figure is an estimate | run it once in a scratch workflow. Above roughly three minutes, D3 needs a cheaper variant — a pre-pulled image, or the job in a container — not abandonment | before D3 is implemented |
| Q3 | **Does `TTL <expr> DELETE WHERE <cond>` parse on `clickhouse/clickhouse-server:25.10.2.65`, including two comma-separated rules each with its own `WHERE`?** ClickHouse's published grammar shows `[WHERE conditions]` after the rule list, which is ambiguous on the per-rule form the two-tier design needs. No ClickHouse is installed on this machine and neither repo vendors a grammar | run both DDL forms against that image. **Gate 0.7** | P0 |
| Q4 | **What is the exact PromQL escape for a C0 control character in a double-quoted label value?** §4 rejects rather than escapes, deliberately, so the test does not encode a guess | round-trip through `@prometheus-io/lezer-promql` and a live gigapipe. If escaping is well-defined, the rejection can relax | P2 |
| Q5 | **Can K6 (a truncated response) be induced against a live server reliably?** | a spike. Falls back to the recorded fixture, which tests our parser but not the upstream behaviour — an honest partial | P2 |
| Q6 | **Which timer APIs does `fakeTimers: { toFake: undefined }` (`vitest.shared.ts:34`) actually fake?** | one `vi.useFakeTimers()` probe after an install. D15 sidesteps it entirely, so this matters only if another suite wants fake timers | any time |
| Q7 | **Does the ClickHouse version matter for the conditional TTL?** `docker-build.yml` runs `26.1.3.52`; `.github/smoke` and self-hosting run `25.10.2.65`. The telemetry stack pins `25.10.2.65` to match production | run gate 0.7 against both images | P0 |
| Q8 | **Is a nightly two-replica clustered ClickHouse variant worth a day?** Failure mode 10 is real, and the source-level assertion (I14) is a proxy, not a proof | a decision at P1 once the telemetry delete lands. Deferred rather than dropped because the observability feature is not enabled on any clustered install yet | P1 |
| Q9 | **How are the captured gigapipe response fixtures kept honest?** They are committed, so they can rot | proposal: `contract.reader.test.ts` re-captures them nightly into a temp dir and diffs against the committed copies, failing on a difference. Turns fixture rot into a contract failure rather than a mystery | P2 |
| Q10 | **Is one T2 suite per push enough?** Today `tenancy.isolation.test.ts` covers all three signals in one file, so the answer is "yes, because the file is the unit". If it is ever split, the split must not demote traces to nightly | a decision at P4, when I7 lands | P4 |
| Q11 | **What is the rolling-deploy story for the `ClientType.telemetry` enum value?** `ClientType` is a Postgres enum with exactly `read \| write \| root` (`schema.prisma:353-357`). During a rolling deploy or a rollback, an older Prisma client reading a `Client` row with `type='telemetry'` may fail to deserialize, and `pnpm migrate:deploy` runs before tests in CI so nothing exercises the mixed-version window. **The Prisma deserialization behaviour is asserted from general knowledge, not verified in this repo** | a spike: generate an older client, insert a `telemetry` row, read it. If it throws, the migration must be split (add the value in release N, use it in release N+1) and a gate added | P1 |
| Q12 | **What disables telemetry in a running production deployment, and what does a saved metric report render when it is off?** Gate 1.7 covers only `pnpm dev` with the URL unset; gate 6.6 names a flag no gate exercises in the *off* direction | the ingest and read-path owners naming the kill switch; then two gates — ingest returns a documented status with the flag off, and a saved dashboard containing a metric tile renders an explicit "unavailable" state rather than an empty chart | P1 |
| Q13 | **What happens if OpenPanel's retention sweep is mid-`ALTER TABLE … DELETE` when a `MODE=all` gigapipe restarts and runs `ctrl.Rotate`?** Rotate alters TTL and table definitions on boot | a deliberate-collision test in `retention.test.ts`: start the sweep, restart the container, assert the conditional TTL survives and no mutation is left half-applied | P3 |
| Q14 | **What is the decommissioning path if the gigapipe decision is reversed at P2 or P3?** ~200 assertions, a pinned image, a compose stack and a Vitest project | not a test question, but it belongs somewhere: the T2 project and `.github/gigapipe-pin.json` are deletable as a unit; the T0 matrices (§3.2 ingest, §3.4 query, §5 FinalChart) survive any storage decision because they assert *our* behaviour. State that in the reversal PR rather than discovering it | if it happens |

---

## Effort

Engineer-days for one engineer already familiar with the repo, excluding review
latency. Test-writing only; the code under test is costed in the owning spec.
Rows are tagged with the priority of what they buy, so a budget cut is a decision
rather than "whatever got written first survives".

| Item | Days | ± | Pri |
|---|---|---|---|
| Workspace wiring: the `test/telemetry` project, three `vitest.config.ts` files, `tests.yml`, the collected-count gate | 0.5 | — | must |
| Harness: `guard.ts`, `fixtures.ts` (**including the first real-`Client`-row seeding in the repo**, D11), `docker-compose.yml`, `provision.sql`, `run.sh`, the nightly workflow | 3.0 | ±50 % | must |
| §3.1 sanitizer parity: the Go golden generator, the committed corpus, `labels.test.ts` | 1.5 | — | must |
| §3.2 ingest matrix, including the OTLP fixture generator and the mock upstream | 3.5 | **±50 %, and the one I expect to overrun** | must |
| §3.3 auth matrix — a new file for a module with no tests at all | 1.5 | — | must |
| §3.4 query matrix Q1–Q31 | 2.0 | — | must |
| §3.6 `tenancy.isolation.test.ts` (T2) incl. gate 1.9's real `jobDelete()` run | 2.5 | — | must |
| §4 compiler goldens plus the grid, incl. G9 | 2.0 | — | must |
| §5.1 `final-chart.contract.test.ts` against the event engine, incl. F10 | 1.5 | — | must |
| §5.2 mapper plus captured fixtures | 1.5 | — | must |
| §5.4 persistence round-trip | 0.5 | — | must |
| §7.1 codec tests including the built-bundle case | 1.0 | — | must |
| §6 contract suites (K1–K23, K10/K11/K20 cut) | 2.0 | ±50 % | should |
| §7.1 alert state machine, idempotency and delivery | 3.5 | ±50 % | must |
| §7.2 cron registration | 0.5 | — | must |
| §7.3 CI wiring, exclusion config, cost measurement, `smoke-observability` split | 1.5 | — | must |
| **Total** | **28.5** | | |

**The irreducible security core, if the budget halves.** These rows and nothing
else still leave the boundary proven, at the cost of every contract and
FinalChart guarantee:

> Workspace wiring · harness · §3.1 parity (golden + corpus) · E5/E5b/E6/E12/E13/E16/E17/E18/E20/E24/E25/E26/E32 · A1/A2/A4/A9–A13 · Q1/Q2/Q3/Q11–Q15/Q25/Q26/Q31 · I1/I2/I5/I7/I8/I9/I11/I12/I13/I14 · F1/F2/F5/F5b/F8 · gate 1.0 · gate 1.9

≈ 11 days. Everything else — the contract suite, the compiler goldens, the alert
state machine, the mapper fixtures — is deferrable **as a decision**, with the
phase gates amended in the same PR that defers them.

**What could make it bigger.** The ingest matrix is the row I would expect to
overrun: the fixture generator has to produce five OTLP metric data-point types,
snappy-compressed remote-write bodies and both Loki push forms, and the streaming
decompressed-byte counter for E30/E33 is not something Fastify hands you. The
alert state machine's X4 (three configurable crash points, then the **real** drain)
is the second. The contract suite is the row most likely to be *cut* rather than
overrun, now that K10/K11/K20 are gone.

**Not included, owned elsewhere:** the load test
(`10-ops-retention-billing.md`), the P6 differential corpus (~2 days, gating raw
PromQL), and an `apps/start` component harness (explicitly cut, D16).

**Order matters more than size for three items.** The workspace wiring must land
before anything else, or every suite in this document can be merged without ever
having run. `final-chart.contract.test.ts` must land before the metrics engine
starts. And A17's cache-key change is a prerequisite for `ClientType.telemetry`
existing at all, not a test to be written afterwards.
