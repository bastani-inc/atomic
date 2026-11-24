<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-telemetry</b><br>
  Vendor-neutral telemetry contracts, typed schemas, and reference contexts.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/telemetry"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-telemetry"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-telemetry?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

`@bastani/atomic-telemetry` defines an explicit, callback-based `TelemetryContext` and `TelemetrySpan` contract alongside a no-op context, an in-memory reference context, metrics, context propagation, and typed schemas. It ships no built-in exporter and sends nothing on its own; connect it to OpenTelemetry, Sentry, logs, or another backend through an adapter.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-telemetry
```

Inside an Atomic extension, you can import it without installing it because the running Atomic process provides it. See [Libraries](https://docs.bastani.ai/libraries).

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

## Subpath exports

- `@bastani/atomic-telemetry`: Core interfaces, `NOOP_TELEMETRY_CONTEXT`, `InMemoryTelemetryContext`, and typed span schemas.
- `@bastani/atomic-telemetry/render`: `renderTrace()` to format stored traces as readable terminal text.
- `@bastani/atomic-telemetry/testing`: `createTelemetryAdapterConformance()` to test custom telemetry adapters against the contract.

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-telemetry](https://docs.bastani.ai/libraries/telemetry)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
