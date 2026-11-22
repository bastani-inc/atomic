---
title: "@bastani/atomic-telemetry"
sidebarTitle: "Telemetry"
description: "Vendor-neutral telemetry contracts, a no-op and an in-memory context, metrics and typed schemas."
---

Vendor-neutral telemetry contracts and typed schema utilities for Atomic's libraries. This package contains no exporter and sends nothing on its own; you supply the adapter.

This package provides:

- An explicit, callback-based `TelemetryContext` and `TelemetrySpan` contract.
- A shared `NOOP_TELEMETRY_CONTEXT`.
- Opaque cross-process propagation and span links.
- Counters, up-down counters, histograms, and typed metric schemas.
- A reference `InMemoryTelemetryContext` implementation.
- Serializable schema definitions with inferred TypeScript types.
- No exporter, global current-span state, or dependency on a telemetry backend.

Applications can use the in-memory reference or supply an adapter for OpenTelemetry, Sentry, logs, or another backend. Atomic's packages pass telemetry contexts explicitly and define their domain schemas separately.

## Installation

```bash
npm install @bastani/atomic-telemetry
```

## Telemetry concepts

Telemetry describes what a program did while running using spans, attributes, events, statuses, and explicit context:

| Concept | Plain-language meaning |
|---|---|
| **Span** | A timed record of one operation, such as loading an account or making an AI request. It begins before the work and ends when the work finishes. |
| **Parent and child spans** | Operations can contain smaller operations. A request span might contain a cache lookup and a database query. Together they form a tree showing where time was spent. |
| **Attribute** | A named fact attached to a span, such as `provider: "openai"`, `cache.hit: true`, or `item_count: 12`. Attributes describe the operation and its result. |
| **Event** | A named occurrence at a point during a span, such as `retry.scheduled` or `cache.lookup`. Events have no duration and may carry their own attributes. |
| **Status** | The operation's outcome: `ok` or `error`. An error status may include an error name and message. |
| **Context** | A handle identifying where new work belongs in the span tree. Starting a span from a context makes it a child of that context. |

For example, loading an account produces this structure:

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   facts about the span
├─ event: example.cache.lookup              occurrence during the span
│  └─ attribute: cache.hit=false            fact about the event
└─ status: ok                               final outcome
```

A span is diagnostic data, not business state. An adapter translates these generic concepts into the corresponding concepts used by OpenTelemetry, Sentry, logs, or another backend.

## Core context API

A `TelemetryContext` starts a span around a callback. The callback receives a `TelemetrySpan`, which is also the explicit parent context for child spans. Contexts may expose their adapter's `metrics?: TelemetryMetrics` and `propagation?: TelemetryPropagation` capabilities, and child spans and extracted parents carry the same capabilities. A tracing adapter that implements only `startSpan()` is still valid.

```typescript
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from '@bastani/atomic-telemetry';

async function loadAccount(
  accountId: string,
  telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
) {
  return telemetryContext.startSpan(
    {
      name: 'example.account.load',
      attributes: { 'example.account.id': accountId },
    },
    async (span) => {
      const account = await readAccount(accountId);
      span.setAttributes({ 'example.account.found': account !== undefined });
      return account;
    },
  );
}
```

Pass the callback span to lower-level work to create explicit nesting:

```typescript
return telemetryContext.startSpan({ name: 'example.parent' }, async (parentSpan) => {
  return parentSpan.startSpan({ name: 'example.child' }, async (childSpan) => {
    childSpan.addEvent('example.cache.lookup', { 'example.cache.hit': true });
    return performWork();
  });
});
```

There is no public `end()` method. `startSpan()` owns settlement and keeps the span open until the callback's value or promise settles. For an expected failure represented by a normal return value, set the status explicitly:

```typescript
return telemetryContext.startSpan({ name: 'example.save' }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({
      status: 'error',
      error: { name: 'SaveError', message: result.reason },
    });
  }
  return result;
});
```

## Adapter contract

An adapter implements `TelemetryContext` and bridges the generic API to its backend. Typed inputs are trusted, and malformed inputs have unspecified behavior. Adapters are not required to validate inputs or suppress backend failures.

The callback and recording contract requires an adapter to:

- Create a child span and invoke the callback synchronously, exactly once.
- Expose optional metric and propagation capabilities on its contexts, child spans, and extracted parents, including inert fallback spans.
- Preserve the callback's return value and rejection value, returning a rejected promise with the same error after a synchronous throw.
- Keep the native span open until a returned promise settles.
- Treat normal completion as `ok` and throws or rejections as errors unless an explicit status was set.
- Make repeated `setStatus()` calls last-write-wins.
- Merge `setAttributes()` calls so later defined values replace earlier ones while `undefined` is ignored.
- Make recording methods synchronous.
- Ignore calls made after settlement.

Adapters may activate backend ambient context for automatic instrumentation, while callers pass the parent through `TelemetryContext` arguments. Adapters own exporter buffering, flushing, sampling, backend IDs, and backend-specific context objects. Run the [adapter conformance suite](#adapter-conformance) to verify adapter behavior.

## Propagation and span links

An adapter may also implement `TelemetryPropagation`. Expose it through `context.propagation` so code can inject or extract using the context it already has. The root, spans, and extracted parents share the adapter's capability object:

```typescript
interface TelemetryPropagation {
  inject(context: TelemetryContext): TelemetryCarrier | undefined;
  extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}
type TelemetryCarrier = Record<string, string>;
```

A carrier is an opaque JSON-safe string map. Adapters own its format; W3C `traceparent` and `tracestate` fit without requiring them. Transport code sends only the carrier, never a context or span:

```typescript
const caller = new InMemoryTelemetryContext();
const provider = new InMemoryTelemetryContext();
await caller.startSpan({ name: 'rpc.client' }, async (span) => {
  const wire = JSON.stringify(caller.inject(span));
  await provider.extract(JSON.parse(wire)).startSpan(
    { name: 'rpc.server' },
    (serverSpan) => handleRequest(serverSpan),
  );
});
```

Injection returns a detached carrier or `undefined` for roots, no-op contexts, and unsupported contexts. Extraction returns a receiver-owned parent. Absent or unknown carriers fall back to the adapter's root. Extraction checks only that required carrier keys contain strings; identifiers are opaque and need no format validation. Both methods are synchronous. Trace metadata is diagnostics, never authorization. Transport boundaries own carrier size limits.

A link relates work without changing its parent. Use `SpanOptions.links` when the target is known at creation, or `span.addLink()` after the span has started:

```typescript
await telemetry.startSpan(
  { name: 'activation', links: [{ context: firstGetter, attributes: { reason: 'trigger' } }] },
  async (activation) => {
    laterGetter.addLink({ context: activation });
    await activate();
  },
);
```

Link targets are `TelemetryContext` handles, including spans and extracted remote parents. For a remote link, first call `adapter.extract(carrier)`. A settled target remains linkable and injectable; a settled source ignores `addLink()`. Links append in order, copy attributes, and ignore root, no-op, or unsupported contexts. The typed span starter's callback also supports `addLink()`; initial links use the low-level `startSpan()` API.

`NOOP_TELEMETRY_PROPAGATION` ignores its arguments: injection returns `undefined`, extraction returns `NOOP_TELEMETRY_CONTEXT`.

## Metrics

An adapter may implement `TelemetryMetrics` alongside `TelemetryContext` and `TelemetryPropagation`. Applications configure one adapter, not separate backends for each capability. Expose the shared capability through `context.metrics`; child spans retain it, so nested model calls can record metrics without a separate configuration option. The in-memory adapter also implements the factory methods directly:

```typescript
const bytes = telemetry.counter('network.bytes', {
  description: 'Encoded WebSocket bytes', unit: 'By',
});
bytes.add(encodedSize, { direction: 'out' });

const active = telemetry.upDownCounter('calls.active');
active.add(1);
active.add(-1);

const duration = telemetry.histogram('call.duration', {
  unit: 'ms', boundaries: [1, 10, 100, 1000],
});
duration.record(elapsedMs, { method: 'read' }, currentSpan);
```

Factories take an instrument name and optional `InstrumentOptions` (`description`, `unit`). Histograms also accept `HistogramOptions.boundaries` for finite, strictly increasing bucket hints. Backends own aggregation and may translate these hints.

Callers must supply finite measurements and non-negative counter increments, while up-down counters and histograms accept signed values. Histogram `record(value, attributes?, context?)` optionally correlates a measurement with a span as an exemplar. Counter `add(value, attributes?)` takes no context argument.

Factories and recording methods are synchronous and trust typed inputs. Adapters do not need to validate measurement values, metadata, attributes, or boundaries, and malformed inputs have unspecified behavior. `NOOP_TELEMETRY_METRICS` returns shared frozen instruments that discard measurements. Record only values already available to application code; do not serialize or measure extra data solely for telemetry.

Use only low-cardinality attributes with bounded values such as direction or method, rather than request IDs, user IDs, prompts, or arbitrary paths. The low-level attribute bag remains open, so instrumentation code enforces this policy.

### Typed metric schemas

`TelemetrySchemaDefinition.metrics` optionally declares instrument names, kinds, metadata, and required/optional attributes. `createTypedMetrics()` combines one or more schemas and rejects duplicate metric names, incorrect instrument kinds, unknown attributes, and missing required attributes at compile time:

```typescript
const schema = defineTelemetrySchema({
  version: 1,
  spans: {},
  metrics: {
    'network.bytes': {
      kind: 'counter', description: 'Encoded bytes', unit: 'By',
      attributes: {
        direction: {
          type: 'string', required: true, values: ['in', 'out'],
          description: 'Direction', cardinality: 'low',
        },
      },
    },
  },
} as const);

const metrics = createTypedMetrics(telemetry, [schema]);
metrics.counter('network.bytes').add(encodedSize, { direction: 'out' });
```

Metric definitions use `kind: 'counter' | 'upDownCounter' | 'histogram'`; only histograms may declare `boundaries`. Metric attributes use the same scalar/array definitions as spans, but reject `cardinality: 'high'`. Omitting the cardinality annotation does not waive the low-cardinality policy. Unlike the typed span starter, the metric helper reads and retains schema instrument metadata at runtime. It performs no runtime attribute validation.

`InMemoryTelemetryContext.getMetrics()` returns ordered, detached `RecordedTelemetryMeasurement` snapshots: `kind`, `name`, optional `description`/`unit`/`boundaries`, `value`, copied `attributes`, and a carrier-shaped exemplar `context` or `null`. This is a measurement log, not aggregated counters or buckets; storage is unbounded. Measurement times are retained privately for store queries, not exposed in these snapshots.

## No-op context

Use `NOOP_TELEMETRY_CONTEXT` when telemetry is optional:

```typescript
import { NOOP_TELEMETRY_CONTEXT } from '@bastani/atomic-telemetry';

const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
  { name: 'example.operation' },
  () => runOperation(),
);
```

The no-op context:

- Invokes callbacks synchronously.
- Preserves returned values and asynchronous rejections, and converts a synchronous throw to a promise rejected with the same value.
- Uses one shared frozen inert span, including for nested spans.
- Exposes `NOOP_TELEMETRY_METRICS` and `NOOP_TELEMETRY_PROPAGATION` on its root and spans.
- Does not inspect or retain names, attributes, events, or statuses.

## In-memory reference adapter

`InMemoryTelemetryContext` is a backend-neutral reference adapter for tests, local diagnostics, and process-local capture without an exporter:

```typescript
import { InMemoryTelemetryContext } from '@bastani/atomic-telemetry';

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan(
  { name: 'example.operation', attributes: { input: 'demo' } },
  async (span) => {
    span.addEvent('example.started');
    span.setAttributes({ output_count: 3 });
  },
);

console.log(telemetry.getSpans());
```

`getSpans()` returns detached snapshots in span-start order. Each `RecordedTelemetrySpan` contains a deterministic numeric ID, local parent ID, carrier-shaped `context` and `parentContext` snapshots, ordered `links`, merged attributes, ordered events, final status, settlement state, and deterministic end sequence without timestamps. A remote parent has `parentId: null` and a non-null `parentContext`; a root has both `null`. A `RecordedTelemetryLink` contains a target carrier and copied attributes.

`InMemoryTelemetryContext` implements `TelemetryPropagation` with JSON-safe carriers that work across independent processes without a shared registry. Treat its carrier keys as opaque and specific to `InMemoryTelemetryContext`, not as a shared wire format for other adapters.

Storage in `InMemoryTelemetryContext` is unbounded and process-local. Create a fresh instance per test or recording scope, and avoid recording sensitive attributes unless your data policy permits them.

## Stored telemetry

`TelemetryStore` separates querying from recording. `InMemoryTelemetryContext` implements it, and persistent adapters can implement it too:

- `findTraces(query?)` returns locally stored traces, newest trace start first. Filters include the earliest stored span's `name`, inclusive `startMin` and `startMax`, `errors: true`, and scalar `attributes` (all requested attributes must match one span anywhere in the trace). Pages default to 20 traces; pass the returned opaque `cursor` with the same filters to continue. Equal start times order by trace ID.
- `getTrace(traceId)` returns a trace or `undefined`.
- `findMetrics({ name, startMin?, startMax?, attributes? })` returns metric rows with count, sum, minimum, and maximum. Time bounds are inclusive interval-start times. `InMemoryTelemetryContext` maps each raw measurement to a count-one row in its 10-second interval, while persistent stores can aggregate measurements per series and interval.

Only settled spans are returned. A trace ID propagates from the root span with the parent identity. Stores return the spans available locally, so remote or expired parents may be absent and a child can appear before its parent settles. Pagination is not a frozen snapshot across requests because late settlements and retention can change a trace's earliest stored span.

`StoredSpan` includes epoch-millisecond `startedMs` and `endedMs`, event offsets in `timeMs`, and links carrying both target `traceId` and `spanId`. Durations use a monotonic clock because wall clocks across processes may disagree. Merge spans from multiple stores by trace ID; parent relationships, not timestamp containment, define the tree.

Trace formatting lives in `@bastani/atomic-telemetry/render`:

```typescript
import { renderTrace } from '@bastani/atomic-telemetry/render';

const page = await telemetry.findTraces({ errors: true, limit: 10 });
for (const trace of page.traces) console.log(renderTrace(trace.spans));
```

`renderTrace()` accepts stored spans, deduplicates IDs, treats absent parents as roots, and formats attributes, durations, statuses, event offsets, and cross-trace links. It never follows links or queries a store.

## Adapter conformance

`@bastani/atomic-telemetry/testing` exports a runner-independent conformance suite modeled as grouped cases. A fixture supplies a fresh context and converts its backend's finished spans into normalized `RecordedTelemetrySpan` snapshots:

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from '@bastani/atomic-telemetry/testing';
import { describe, it } from 'vitest';

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

The suite verifies capability identity on roots, child spans, extracted parents, and inert spans. It also checks synchronous single invocation, return and rejection identity, automatic and explicit statuses, attribute merging, event ordering, inert post-settlement calls, nested and concurrent parentage, and span links.

Fixtures may supply `propagation` to verify JSON round trips, multi-adapter hops, and root fallback for absent or unknown carriers. Fixtures may also supply `metrics` and `getMetrics()` to verify ordered measurements, histogram exemplars, and input copying. The suite does not test malformed inputs or require suppressing backend failures. `getSpans()` may flush an asynchronous exporter before returning. `@bastani/atomic-telemetry/testing` uses Node's assertion APIs, while the root package remains runtime-neutral.

## Typed schemas

The low-level span API intentionally accepts open names and attribute bags so adapters remain generic. Domain packages can define closed, serializable schemas and infer exact TypeScript types from them.

```typescript
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
} from '@bastani/atomic-telemetry';

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'example.read': {
      description: 'Read one resource',
      parents: { kind: 'any' },
      startAttributes: {
        'example.resource': {
          type: 'string',
          required: true,
          values: ['account', 'project'],
          description: 'Resource kind',
        },
      },
      endAttributes: {
        'example.item_count': {
          type: 'number',
          description: 'Number of returned items',
        },
      },
      events: {
        'example.cache': {
          description: 'Cache lookup result',
          attributes: {
            'example.cache.hit': {
              type: 'boolean',
              required: true,
              description: 'Whether the cache contained the resource',
            },
          },
        },
      },
      status: {
        default: 'ok',
        errorWhen: 'The read throws or returns an error result',
      },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(
  telemetryContext,
  [EXAMPLE_TELEMETRY_SCHEMA],
);
```

The starter exposes one overload per span and checks names and attributes at compile time. Union-valued names must be narrowed before a call, preserving the relationship between each runtime name and its attribute schema. Its callback receives a child starter over the same schemas, already bound to the callback span:

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' },
  async (span, startChildSpan) => {
    span.addEvent('example.cache', { 'example.cache.hit': true });
    const accounts = await readAccounts();
    span.setAttributes({ 'example.item_count': accounts.length });

    await startChildSpan(
      'example.read',
      { 'example.resource': 'project' },
      async (childSpan) => {
        const projects = await readProjects();
        childSpan.setAttributes({ 'example.item_count': projects.length });
      },
    );

    return accounts;
  },
);
```

### Start and completion attributes

`startAttributes` and `endAttributes` describe when an attribute is normally known, not separate runtime storage:

| Schema field | How values are recorded | Requiredness |
|---|---|---|
| `startAttributes` | Passed in the typed starter's `attributes` argument when the span is created | Each definition explicitly sets `required: true` or `false` |
| `endAttributes` | Added later through the schema-scoped span's `setAttributes()` method | Always optional |

Both sets become ordinary attributes on the same backend span. There is no separate end-attribute payload or end callback. In the preceding example, `example.resource` is known when `example.read` starts, while `example.item_count` is known only after `readAccounts()` returns:

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' }, // required start attribute
  async (span) => {
    const accounts = await readAccounts();
    span.setAttributes({
      'example.item_count': accounts.length, // optional completion attribute
    });
    return accounts;
  },
); // resolving the callback settles the span
```

"End" means completion enrichment. You can set an end attribute at any point while the callback runs, or omit it when unavailable. Calling `setAttributes()` zero times is valid, which accommodates early failures, cancellation, and provider-specific fields that are not present on every path.

Repeated `setAttributes()` calls merge into the same attribute bag. A later defined value replaces an earlier value for the same key, while `undefined` is ignored. The schema-scoped method accepts only the current span's declared end attributes.

Attributes do not end the span. Returning, resolving, throwing, or rejecting from the callback controls settlement; `startSpan()` performs the actual end operation. Adapter calls made after settlement are inert.

A starter can compose multiple independently versioned schemas, each defined with `defineTelemetrySchema()`:

```typescript
const startAppSpan = createTypedSpanStarter(telemetryContext, [
  EXAMPLE_TELEMETRY_SCHEMA,
  CACHE_TELEMETRY_SCHEMA,
] as const);
```

Inline schema arrays retain their tuple types automatically. Separately declared arrays should use `as const`. Literal duplicate span names across the array are rejected at compile time; schemas are not merged, inspected, or retained at runtime.

Schema-derived types reject missing required attributes, unknown keys, invalid closed-set values, undeclared events, and attributes on empty schemas. End attributes are always optional enrichment; the type system does not require `setAttributes()` to be called.

`defineTelemetrySchema()` is a typed identity function. It returns ordinary JSON-serializable data and performs no runtime validation or parent-rule enforcement.

## Schema metadata

Supported attribute types are:

- `string`, `number`, and `boolean`
- `string[]`, `number[]`, and `boolean[]`

Attribute definitions support:

- `values`: a closed set for scalar values
- `elementValues`: a closed set for array elements
- `examples`: documentation examples
- `sensitive`: marks data requiring special handling
- `cardinality`: records expected `low` or `high` cardinality

Start and event attributes declare `required`. End attributes do not; see [Start and completion attributes](#start-and-completion-attributes).

Parent metadata is descriptive schema data:

- `{ kind: 'any' }`: root or any caller span
- `{ kind: 'root_or_external' }`: root or a caller-owned span outside the schema
- `{ kind: 'spans', spans: [...] }`: only the listed schema spans

Adapters do not need to understand schema objects. Instrumentation helpers and tests use them to keep emitted names and attributes consistent.

## Using with `@bastani/atomic-ai`

Pass a parent `TelemetryContext` to `@bastani/atomic-ai` through `telemetryContext` in request options:

```typescript
import { InMemoryTelemetryContext } from '@bastani/atomic-telemetry';

const telemetry = new InMemoryTelemetryContext();
await models.completeSimple(model, context, { telemetryContext: telemetry });
```

## Security and portability

Telemetry is diagnostic data, not durable application state. Do not persist a `TelemetryContext`, `TelemetrySpan`, or backend-native trace object in records, messages, snapshots, or deferred handles. An injected `TelemetryCarrier` may cross a transport or be stored as optional diagnostic correlation data. Changing adapters may lose correlation because carriers are not application state.

Attribute values are limited to scalar values and homogeneous scalar arrays. Avoid recording prompts, completions, tool arguments or output, file contents, provider payloads, headers, credentials, and free-form error details unless your schema and data policy explicitly allow them.

This package does not use `AsyncLocalStorage` or any runtime-specific ambient context API. It works in Node.js, Bun, browsers, and workers; backend adapters remain responsible for their own runtime compatibility.

## API reference

### Core types and values

| Export | Purpose |
|---|---|
| `TelemetryContext` | Starts callback-managed child spans and optionally exposes adapter metrics/propagation |
| `TelemetrySpan` | Records attributes, events, and status; also acts as a child context |
| `SpanOptions` | Span name, optional start attributes and links |
| `SpanLink` | Context target and optional link attributes |
| `TelemetryCarrier` | Opaque JSON-safe string map |
| `TelemetryPropagation` | Optional adapter injection and extraction capability |
| `NOOP_TELEMETRY_PROPAGATION` | Shared passive propagation for disabled telemetry |
| `TelemetryMetrics` | Optional adapter instrument factories |
| `TelemetryCounter` / `TelemetryUpDownCounter` | Instruments with `add()` |
| `TelemetryHistogram` | Instrument with `record()` and optional exemplar context |
| `InstrumentOptions` / `HistogramOptions` | Description, unit, and histogram boundary hints |
| `NOOP_TELEMETRY_METRICS` | Shared passive metric instruments |
| `RecordedTelemetryMeasurement` | Captured measurement and optional exemplar |
| `SpanAttributes` / `AttributeValue` | Open adapter-level attribute bag and supported values |
| `SpanStatus` | Explicit `ok` or `error` status |
| `NOOP_TELEMETRY_CONTEXT` | Shared passive context for disabled telemetry |
| `InMemoryTelemetryContext` | Reference adapter with deterministic process-local recording |
| `RecordedTelemetrySpan` | Normalized captured span snapshot |
| `RecordedTelemetryEvent` | Normalized captured event snapshot |
| `RecordedTelemetryLink` | Captured target carrier and link attributes |
| `TelemetryStore` | Settled trace discovery, trace retrieval, and metric queries |
| `StoredSpan` / `StoredTrace` | Backend-independent timed span and trace snapshots |
| `TraceQuery` / `MetricQuery` | Trace filters, pagination, and metric filters |
| `StoredMetric` | Metric interval row with count, sum, minimum, and maximum |
| `telemetryNow()` | Monotonic-anchored wall-clock milliseconds used by `StoredSpan` |

### Render subpath (`@bastani/atomic-telemetry/render`)

| Export | Purpose |
|---|---|
| `renderTrace()` | Formats `StoredSpan[]` into an indented chronological trace tree |

### Schema definitions and inference

| Export | Purpose |
|---|---|
| `defineTelemetrySchema()` | Typed identity helper for serializable schema data |
| `createTypedSpanStarter()` | Binds a parent context to one or more schema vocabularies |
| `createTypedMetrics()` / `TypedTelemetryMetrics` | Binds metric names, kinds, metadata, and attributes to schemas |
| `TelemetryMetricDefinition` / `TelemetryMetricAttributeDefinition` | Serializable instrument metadata and low-cardinality attribute definitions |
| `SchemaTelemetryCounter` / `SchemaTelemetryHistogram` | Schema-constrained recording methods |
| `TypedSpanStarter` | Exact starter type with recursively child-bound callbacks |
| `TelemetrySchemaDefinition` | Top-level schema shape |
| `TelemetrySpanDefinition` | Span metadata, parents, attributes, events, and status rule |
| `TelemetryAttributeType` | Supported scalar and array type names |
| `TelemetryAttributeMetadata` | Description, sensitivity, and cardinality metadata |
| `TelemetryAttributeDefinition` | Attribute type, allowed values, examples, and metadata |
| `TelemetryStartAttributeDefinition` | Start attribute definition with requiredness |
| `TelemetryEventAttributeDefinition` | Event attribute definition with requiredness |
| `TelemetryEventDefinition` | Event description and attribute definitions |
| `TelemetryParentDefinition` | Open, external-root, or finite schema-parent rule |
| `TelemetrySchemaSpanName` | Union of declared span names |
| `TelemetrySchemaSpanStartAttributes` | Exact inferred start attributes for one span |
| `TelemetrySchemaSpanEndAttributes` | Optional inferred end attributes for one span |
| `TelemetrySchemaSpanEventName` | Union of events declared by one span |
| `TelemetrySchemaSpanEventAttributes` | Exact inferred attributes for one event |
| `SchemaTelemetrySpan` | Span view restricted to one schema span |
| `TelemetrySchemaSpanUnion` | Discriminated union of all spans in a schema |
| `InferStartAttributes` | Required and optional values inferred from start definitions |
| `InferOptionalAttributes` | Optional values inferred from end definitions |
| `InferEventAttributes` | Required and optional values inferred from event definitions |
| `InferRequiredAndOptionalAttributes` | Shared inference utility for definitions with requiredness |
| `ExactTelemetryAttributes` | Rejects keys outside an expected attribute set |

### Testing subpath

| Export | Purpose |
|---|---|
| `createTelemetryAdapterConformance()` | Creates runner-independent adapter conformance cases |
| `TelemetryAdapterFixture` | Fresh context and normalized snapshot reader for one case |
| `TelemetryAdapterFixtureFactory` | Creates isolated fixtures |
| `TelemetryAdapterConformanceCase` | Grouped case that test runners execute |
