# 16 — Querying metrics

How to write a metric panel: the three functions that matter, the shapes worth
copying, and the two substitutions the server makes before your query runs.

---

## 1. rate, increase, quantile

**A counter only ever climbs.** `http_requests_total` is 4,812,003 now and
4,812,061 in a minute; charting it draws a line that goes up and tells you
nothing. `rate(http_requests_total[5m])` is the per-second slope over a
five-minute window — requests per second, which is the number you meant.
Anything ending in `_total`, `_count` or `_sum` is a counter and wants a rate.

**`increase` is the same measurement in different units.** `increase(x[1h])` is
how much the counter grew in the hour, rather than its per-second slope: 4,200
requests rather than 1.17/s. Use it when the question is "how many", and `rate`
when it is "how fast". Both need a window at least four times the chart's step
— narrower than that and the window samples the gaps between buckets, drawing a
sawtooth that reads as real instability. `$__rate_interval` does this for you.

**A quantile is taken over rated buckets, never raw ones.** A histogram is a set
of cumulative `_bucket` counters, one per `le`. The p95 is
`histogram_quantile(0.95, sum by (le) (rate(x_bucket[$__rate_interval])))` —
rate each bucket, sum the rates by `le`, then interpolate. Summing the buckets
themselves and calling that a latency is the single most common mistake here,
and it produces a plausible-looking sawtooth rather than an error.

---

## 2. Query patterns

Pick one from the "Query patterns" dropdown beside the query rows and it fills
in the metric you have chosen. Each compiles to:

| Pattern | PromQL |
|---|---|
| Request rate | `sum(rate(M[$__rate_interval]))` |
| Request rate by service | `sum by (service_name)(rate(M[$__rate_interval]))` |
| Error rate | `sum(rate(M{status=~"5.."}[$__rate_interval]))` |
| p50 / p95 / p99 latency | `histogram_quantile(0.5\|0.95\|0.99, sum by (le)(rate(M[$__rate_interval])))` |
| Saturation | `max by (service_name)(M)` |
| Top 5 series | `topk(5, sum by (service_name)(rate(M[$__rate_interval])))` |
| Increase per interval | `sum(increase(M[$__interval]))` |

Two notes. `topk` is re-evaluated at every step, so a line can appear and
disappear as its rank changes — that is ranking, not missing data. The error-rate
pattern assumes a `status` label; adjust the matcher if your instrumentation
names it something else.

---

## 3. What the server substitutes

Before a query runs, three built-ins are resolved against the chart's own step
and window:

| Variable | Resolves to |
|---|---|
| `$__interval` | the step the chart is drawn at, e.g. `1h` |
| `$__rate_interval` | `max(4 × step, 4 × scrape)`, floored at 60s — always safe for a `rate` |
| `$__range` | the full window being charted, e.g. `1d` |

Dashboard variables substitute the same way. `$name` and `${name}` both work; a
multi-value selection becomes `(a|b)` and "All" becomes `.+`, so **write a
variable behind a regex matcher** — `job=~"$service"`, not `job="$service"`.
Values are regex-escaped and string-escaped, so a value can never break out of
the literal it sits in. A variable with no value is left as written and the
query is then rejected as unparseable, which is deliberate: a typo should look
like a typo rather than silently widen the selection.

**You never write `op_project_id`.** The server parses every query with
Prometheus's own grammar and injects the project matcher into every selector,
adds it to every `by (…)` grouping, and refuses a query that tries to remove it
with `without (op_project_id)`. `label_replace`, `label_join` and `count_values`
are rejected outright — each can forge that label on a result.

---

## 4. Units

The unit is per query, not per panel, so a request rate and a p95 can share a
chart and each read correctly.

| Unit | Input | Renders |
|---|---|---|
| `none` | any number | `1,234.5` |
| `short` | any number | `1.5 K`, `2.5 M` |
| `ops` | per-second rate | `12.35 ops/s` |
| `seconds` | seconds | `34 ms`, `1.5 s`, `2 h` |
| `ms` | milliseconds | `500 µs`, `1.5 s` |
| `bytes` | bytes | `2 KiB`, `3 GiB` |
| `percent` | already 0–100 | `42.5%` |
| `percentunit` | a ratio 0–1 | `50%` |

`percentunit` is what a PromQL division gives you (`errors / total`);
`percent` is for a metric that already counts in percent. Getting these the
wrong way round is a factor of 100.

Only `none`, `short` and `ops` are additive. When no visible query is additive
the report table drops its Sum column and shows Last instead — the total of
every p95 sample in a window is not a latency anyone can act on.

---

## 5. Deploy annotations

Mark a deploy on every metric chart in the project with the same client id and
secret your SDK uses (the client must be `write` or `root`):

```bash
curl -X POST https://api.openpanel.dev/annotations \
  -H 'content-type: application/json' \
  -H 'openpanel-client-id: YOUR_CLIENT_ID' \
  -H 'openpanel-client-secret: YOUR_CLIENT_SECRET' \
  -d '{
        "text": "Deployed api v2.14.0",
        "tags": ["deploy", "api"]
      }'
```

`time` defaults to now, which is what a deploy hook means. Pass `timeEnd` for a
span (an incident, a migration window) and `dashboardId` to scope the marker to
one dashboard; omit it and the annotation shows on every dashboard in the
project. The project comes from the secret and is not a body field.

---

See also: [15 — PromQL panels](./15-promql-panels.md) for the build plan and the
decisions behind this, and [03 — Metrics engine](./03-metrics-engine.md) for the
step, downsampling and series-cap behaviour.
