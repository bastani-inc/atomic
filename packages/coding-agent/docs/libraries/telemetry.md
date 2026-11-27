---
title: "@bastani/atomic-telemetry"
sidebarTitle: "@bastani/atomic-telemetry"
description: "Vendor-neutral telemetry contracts, no-op and in-memory contexts, metrics, trace rendering, and typed telemetry schemas."
---

Vendor-neutral telemetry contracts and typed schema utilities for Atomic's libraries. This package contains no exporter and sends nothing on its own; you supply the adapter for OpenTelemetry, Sentry, logs, or another backend. See [Standalone libraries](/libraries) for all standalone packages.

Key capabilities:

- Explicit, callback-based `TelemetryContext` and `TelemetrySpan` contracts with zero ambient global state.
- Shared `NOOP_TELEMETRY_CONTEXT`, `NOOP_TELEMETRY_METRICS`, and `NOOP_TELEMETRY_PROPAGATION`.
- Opaque cross-process propagation (`TelemetryCarrier`) and span links.
- Counters, up-down counters, histograms, and compile-time typed metric and span schemas.
- Reference `InMemoryTelemetryContext` adapter, `TelemetryStore` queries, trace tree renderer, and conformance test suite.

## Installation

```bash
npm install @bastani/atomic-telemetry
```

## Quick start

```typescript
import {
  InMemoryTelemetryContext,
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from "@bastani/atomic-telemetry";
import { renderTrace } from "@bastani/atomic-telemetry/render";

const accounts = new Map<string, { id: string; plan: string }>([["acct-1", { id: "acct-1", plan: "pro" }]]);

async function loadAccount(accountId: string, telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT) {
  return telemetry.startSpan(
    {
      name: "example.account.load",
      attributes: { "example.account.id": accountId },
    },
    async (span) => {
      const account = accounts.get(accountId);
      span.setAttributes({ "example.account.found": account !== undefined });
      return account;
    },
  );
}

const recorder = new InMemoryTelemetryContext();
await loadAccount("acct-1", recorder);

const { traces } = await recorder.findTraces();
if (traces[0]) console.log(renderTrace(traces[0].spans));
```

## Telemetry concepts

| Concept | Plain-language meaning |
| --- | --- |
| **Span** | A timed record of one operation, starting before the work and ending when it settles. |
| **Parent and child spans** | Operations can nest inside one another, forming a tree showing where time was spent. |
| **Attribute** | A named fact attached to a span, such as `provider: "openai"` or `cache.hit: true`. |
| **Event** | A point-in-time occurrence inside a span (such as `retry.scheduled`), optionally carrying its own attributes. |
| **Status** | The final outcome: `ok` or `error` (optionally with an error name and message). |
| **Context** | A handle identifying where new child spans belong in the span tree. |

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   facts about the span
├─ event: example.cache.lookup              occurrence during the span
│  └─ attribute: cache.hit=false            fact about the event
└─ status: ok                               final outcome
```

## Core context API

`TelemetryContext.startSpan()` starts a span around a callback. The callback receives a `TelemetrySpan` that also serves as the explicit parent context for nested child spans. Contexts may expose optional `metrics?: TelemetryMetrics` and `propagation?: TelemetryPropagation` capabilities, inherited by child spans and extracted parents.

```typescript
return telemetryContext.startSpan({ name: "example.parent" }, async (parentSpan) => {
  return parentSpan.startSpan({ name: "example.child" }, async (childSpan) => {
    childSpan.addEvent("example.cache.lookup", { "example.cache.hit": true });
    return performWork();
  });
});
```

There is no public `end()` method—`startSpan()` settles the span automatically when the callback returns, resolves, throws, or rejects. For expected failures returned normally, set the status explicitly:

```typescript
return telemetryContext.startSpan({ name: "example.save" }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({ status: "error", error: { name: "SaveError", message: result.reason } });
  }
  return result;
});
```

## Adapter contract

Adapters implement `TelemetryContext` and bridge it to a backend. Typed inputs are trusted (adapters do not need to validate inputs or suppress backend errors). Required behaviors:

- Create a child span and invoke the callback synchronously, exactly once.
- Preserve return values and rejections, converting synchronous throws to rejected promises with the same error.
- Keep the native span open until any returned promise settles; mark normal completion `ok` and throws/rejections `error` unless `setStatus()` was explicitly called.
- Make `setStatus()` last-write-wins, merge `setAttributes()` (later defined values replace earlier ones; `undefined` is ignored), keep recording methods synchronous, and ignore calls after settlement.
- Propagate optional `metrics` and `propagation` capabilities onto child spans, extracted parents, and inert fallback spans.

Run the [adapter conformance suite](#adapter-conformance) to verify any custom adapter.

## Propagation and span links

Expose optional cross-process propagation via `context.propagation`:

```typescript
interface TelemetryPropagation {
  inject(context: TelemetryContext): TelemetryCarrier | undefined;
  extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}
type TelemetryCarrier = Record<string, string>;
```

Carriers are opaque JSON-safe string maps (for example W3C `traceparent`/`tracestate`). Transport code sends only the carrier, never a context or span:

```typescript
const caller = new InMemoryTelemetryContext();
const provider = new InMemoryTelemetryContext();
await caller.startSpan({ name: "rpc.client" }, async (span) => {
  const wire = JSON.stringify(caller.inject(span));
  await provider.extract(JSON.parse(wire)).startSpan(
    { name: "rpc.server" },
    (serverSpan) => handleRequest(serverSpan),
  );
});
```

`inject()` returns a detached carrier (or `undefined` for roots, no-op contexts, or unsupported contexts). `extract()` returns a receiver-owned parent, falling back to the adapter's root for absent or unknown carriers.

Relate spans without changing parentage via `SpanOptions.links` (at creation) or `span.addLink()` (while active):

```typescript
await telemetry.startSpan(
  { name: "activation", links: [{ context: firstGetter, attributes: { reason: "trigger" } }] },
  async (activation) => {
    laterGetter.addLink({ context: activation });
    await activate();
  },
);
```

Settled targets remain linkable and injectable; settled sources ignore `addLink()`. `NOOP_TELEMETRY_PROPAGATION` returns `undefined` from `inject()` and `NOOP_TELEMETRY_CONTEXT` from `extract()`.

## Metrics

Expose optional metrics via `context.metrics` so nested calls can record measurements without separate configuration:

```typescript
const bytes = telemetry.counter("network.bytes", { description: "Encoded WebSocket bytes", unit: "By" });
bytes.add(encodedSize, { direction: "out" });

const active = telemetry.upDownCounter("calls.active");
active.add(1);
active.add(-1);

const duration = telemetry.histogram("call.duration", { unit: "ms", boundaries: [1, 10, 100, 1000] });
duration.record(elapsedMs, { method: "read" }, currentSpan);
```

Supply finite values and non-negative counter increments (up-down counters and histograms accept signed values). `histogram.record(value, attributes?, context?)` optionally attaches a span exemplar. Keep metric attributes strictly low-cardinality (direction, method, provider—never request IDs, user IDs, prompts, or arbitrary paths).

### Typed metric schemas

Declare metrics inside `TelemetrySchemaDefinition.metrics` and bind them with `createTypedMetrics()` for compile-time validation of names, kinds, and low-cardinality attributes:

```typescript
const schema = defineTelemetrySchema({
  version: 1,
  spans: {},
  metrics: {
    "network.bytes": {
      kind: "counter",
      description: "Encoded bytes",
      unit: "By",
      attributes: {
        direction: {
          type: "string",
          required: true,
          values: ["in", "out"],
          description: "Direction",
          cardinality: "low",
        },
      },
    },
  },
} as const);

const metrics = createTypedMetrics(telemetry, [schema]);
metrics.counter("network.bytes").add(encodedSize, { direction: "out" });
```

Only `kind: "histogram"` may declare `boundaries`, and metric attributes reject `cardinality: "high"`. `InMemoryTelemetryContext.getMetrics()` returns detached `RecordedTelemetryMeasurement` logs in recording order (unbounded in memory).

## No-op and in-memory contexts

- **`NOOP_TELEMETRY_CONTEXT`:** Shared passive default when telemetry is disabled. Invokes callbacks synchronously, preserves return values and rejections (converting sync throws to rejections), exposes `NOOP_TELEMETRY_METRICS` and `NOOP_TELEMETRY_PROPAGATION`, and retains nothing.
- **`InMemoryTelemetryContext`:** Process-local reference adapter for tests and diagnostics with deterministic IDs, JSON-safe cross-process carriers, unbounded in-memory recording, `getSpans()`, `getMetrics()`, and `TelemetryStore` queries. Create a fresh instance per test or recording scope.

## Stored telemetry

`TelemetryStore` separates querying from recording (implemented by `InMemoryTelemetryContext` and persistent adapters):

- `findTraces(query?)` → `Promise<{ traces: readonly StoredTrace[]; cursor?: string }>` (newest trace start first; supports filters `name`, inclusive `startMin`/`startMax`, `errors: true`, scalar `attributes`, `limit` default `20`, and opaque `cursor`).
- `getTrace(traceId)` → `Promise<StoredTrace | undefined>`.
- `findMetrics({ name, startMin?, startMax?, attributes? })` → `Promise<readonly StoredMetric[]>` (`{ intervalMs, name, kind, unit?, attributes, count, sum, min, max }`).

Only settled spans are returned. `StoredSpan` records `{ id, traceId, parentId?, name, startedMs, endedMs, attributes, events: [{ name, timeMs, attributes }], links: [{ traceId, spanId, attributes? }], status }` using monotonic durations anchored to epoch milliseconds (`telemetryNow()`).

Format stored spans into an indented chronological tree with `@bastani/atomic-telemetry/render`:

```typescript
import { renderTrace } from "@bastani/atomic-telemetry/render";

const page = await telemetry.findTraces({ errors: true, limit: 10 });
for (const trace of page.traces) console.log(renderTrace(trace.spans));
```

## Adapter conformance

`@bastani/atomic-telemetry/testing` exports a runner-independent conformance suite (`createTelemetryAdapterConformance`) that verifies capability identity, synchronous single invocation, return/rejection preservation, status rules, attribute merging, event ordering, post-settlement inertness, nested/concurrent parentage, span links, and optional propagation and metrics fixtures:

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from "@bastani/atomic-telemetry/testing";
import { describe, it } from "vitest";

const conformance = createTelemetryAdapterConformance(async () => {
  const adapter = createMyTelemetryAdapter();
  return {
    context: adapter.context,
    getSpans: async () => adapter.normalizedSpans(),
    async [Symbol.asyncDispose]() {
      await adapter.close();
    },
  } satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(group, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, () => testCase.run());
    }
  });
}
```

`@bastani/atomic-telemetry/testing` uses Node's assertion APIs, while the root package remains runtime-neutral.

## Typed schemas

Define closed, JSON-serializable span and metric vocabularies with `defineTelemetrySchema()` and bind them with `createTypedSpanStarter()`:

```typescript
import { createTypedSpanStarter, defineTelemetrySchema } from "@bastani/atomic-telemetry";

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "example.read": {
      description: "Read one resource",
      parents: { kind: "any" },
      startAttributes: {
        "example.resource": {
          type: "string",
          required: true,
          values: ["account", "project"],
          description: "Resource kind",
        },
      },
      endAttributes: {
        "example.item_count": {
          type: "number",
          description: "Number of returned items",
        },
      },
      events: {
        "example.cache": {
          description: "Cache lookup result",
          attributes: {
            "example.cache.hit": {
              type: "boolean",
              required: true,
              description: "Whether the cache contained the resource",
            },
          },
        },
      },
      status: { default: "ok", errorWhen: "The read throws or returns an error result" },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(telemetryContext, [EXAMPLE_TELEMETRY_SCHEMA]);

await startSpan("example.read", { "example.resource": "account" }, async (span, startChildSpan) => {
  span.addEvent("example.cache", { "example.cache.hit": true });
  const accounts = await readAccounts();
  span.setAttributes({ "example.item_count": accounts.length });

  await startChildSpan("example.read", { "example.resource": "project" }, async (childSpan) => {
    const projects = await readProjects();
    childSpan.setAttributes({ "example.item_count": projects.length });
  });

  return accounts;
});
```

Always pass the second `attributes` argument to `startSpan()` (`{}` when `startAttributes` is empty). `startSpan()` can compose multiple schemas (`[SCHEMA_A, SCHEMA_B] as const`) and rejects duplicate literal span names, missing required attributes, unknown keys, and invalid closed-set values at compile time. `defineTelemetrySchema()` is a typed identity helper that performs no runtime validation.

### Start and completion attributes

| Schema field | How values are recorded | Requiredness |
| --- | --- | --- |
| `startAttributes` | Passed in `startSpan()`'s `attributes` argument when the span starts | Explicit `required: true` or `false` |
| `endAttributes` | Added later via `span.setAttributes()` while the callback runs | Always optional (calling zero times is valid) |

Both sets merge into the same backend span attribute bag (later defined values win; `undefined` is ignored). Supported attribute types are `string`, `number`, `boolean`, and their homogeneous arrays (`string[]`, `number[]`, `boolean[]`), with optional metadata fields `values`, `elementValues`, `examples`, `sensitive`, and `cardinality` (`"low"` | `"high"`). Descriptive `parents` rules accept `{ kind: "any" }`, `{ kind: "root_or_external" }`, or `{ kind: "spans", spans: [...] }`.

## Using with `@bastani/atomic-ai`

Pass a parent `TelemetryContext` to [`@bastani/atomic-ai`](/libraries/ai) via `telemetryContext` in request options:

```typescript
import { InMemoryTelemetryContext } from "@bastani/atomic-telemetry";

const telemetry = new InMemoryTelemetryContext();
await models.completeSimple(model, context, { telemetryContext: telemetry });
```

## Security and portability

<Warning>
Telemetry is diagnostic data, not durable application state. Never persist a `TelemetryContext`, `TelemetrySpan`, or backend trace object inside records, messages, or snapshots, and never record prompts, completions, tool arguments/output, file contents, credentials, or raw headers unless your schema and data policy explicitly permit them.
</Warning>

An injected `TelemetryCarrier` may cross a transport or be stored as optional diagnostic correlation data. This package uses no `AsyncLocalStorage` or runtime-specific globals, so it works in Node.js, Bun, browsers, and workers (backend adapters own their own runtime compatibility).

## API reference

### Core types and values

| Export | Purpose |
| --- | --- |
| `TelemetryContext` / `TelemetrySpan` | Callback-managed span starter and active span handle |
| `SpanOptions` / `SpanLink` / `SpanAttributes` / `AttributeValue` / `SpanStatus` | Core span creation and recording types |
| `TelemetryCarrier` / `TelemetryPropagation` | Cross-process opaque carrier and inject/extract contract |
| `TelemetryMetrics` / `TelemetryCounter` / `TelemetryUpDownCounter` / `TelemetryHistogram` | Metric instrument factories and recorders |
| `InstrumentOptions` / `HistogramOptions` / `RecordedTelemetryMeasurement` | Metric metadata, bucket hints, and recorded measurement snapshots |
| `NOOP_TELEMETRY_CONTEXT` / `NOOP_TELEMETRY_METRICS` / `NOOP_TELEMETRY_PROPAGATION` | Shared passive no-op implementations |
| `InMemoryTelemetryContext` | Deterministic in-memory reference adapter |
| `RecordedTelemetrySpan` / `RecordedTelemetryEvent` / `RecordedTelemetryLink` | Normalized captured span snapshots |
| `TelemetryStore` / `StoredSpan` / `StoredTrace` / `StoredMetric` / `TraceQuery` / `MetricQuery` | Backend-independent settled trace and metric query API |
| `telemetryNow()` | Monotonic-anchored wall-clock milliseconds used by `StoredSpan` |

### Subpaths

| Subpath | Exports |
| --- | --- |
| `@bastani/atomic-telemetry/render` | `renderTrace()` — formats `StoredSpan[]` into an indented chronological trace tree |
| `@bastani/atomic-telemetry/testing` | `createTelemetryAdapterConformance()`, `TelemetryAdapterFixture`, `TelemetryAdapterFixtureFactory`, `TelemetryAdapterConformanceCase` |

### Schema definitions and inference

**Primary helpers:**

| Export | Purpose |
| --- | --- |
| `defineTelemetrySchema()` | Typed identity helper for serializable schema definitions |
| `createTypedSpanStarter()` | Binds a parent context to one or more span schemas |
| `createTypedMetrics()` / `TypedTelemetryMetrics` | Binds metric names, kinds, metadata, and attributes to schemas |
| `TelemetrySchemaDefinition` / `TelemetrySpanDefinition` / `TelemetryMetricDefinition` | Top-level schema, span, and metric definition shapes |
| `SchemaTelemetrySpan` / `SchemaTelemetryCounter` / `SchemaTelemetryHistogram` | Schema-constrained span and metric views |
| `TypedSpanStarter` | Exact span starter type with recursively child-bound callbacks |

<Accordion title="TypeScript inference utility types">
| Export | Purpose |
| --- | --- |
| `TelemetryAttributeType` | Supported scalar and array attribute type names |
| `TelemetryAttributeMetadata` | Description, sensitivity, and cardinality metadata |
| `TelemetryAttributeDefinition` | Attribute type, allowed values, examples, and metadata |
| `TelemetryStartAttributeDefinition` | Start attribute definition with requiredness |
| `TelemetryEventAttributeDefinition` | Event attribute definition with requiredness |
| `TelemetryMetricAttributeDefinition` | Low-cardinality metric attribute definition |
| `TelemetryEventDefinition` | Event description and attribute definitions |
| `TelemetryParentDefinition` | Open, external-root, or finite schema-parent rule |
| `TelemetrySchemaSpanName` | Union of declared span names |
| `TelemetrySchemaSpanStartAttributes` | Exact inferred start attributes for one span |
| `TelemetrySchemaSpanEndAttributes` | Optional inferred end attributes for one span |
| `TelemetrySchemaSpanEventName` | Union of events declared by one span |
| `TelemetrySchemaSpanEventAttributes` | Exact inferred attributes for one event |
| `TelemetrySchemaSpanUnion` | Discriminated union of all spans in a schema |
| `InferStartAttributes` | Required and optional values inferred from start definitions |
| `InferOptionalAttributes` | Optional values inferred from end definitions |
| `InferEventAttributes` | Required and optional values inferred from event definitions |
| `InferRequiredAndOptionalAttributes` | Shared inference utility for definitions with requiredness |
| `ExactTelemetryAttributes` | Rejects keys outside an expected attribute set |
</Accordion>
