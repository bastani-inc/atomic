<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-telemetry</b><br>
  Vendor-neutral telemetry contracts, typed schemas and reference contexts.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/telemetry"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-telemetry"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-telemetry?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

An explicit, callback-based `TelemetryContext` and `TelemetrySpan` contract, a no-op context, an in-memory reference context, metrics, propagation and typed schemas. It has no exporter and sends nothing on its own: you connect it to OpenTelemetry, Sentry, logs or another backend through an adapter.

[Atomic](https://github.com/bastani-inc/atomic), the verifiable coding agent runtime, is built on it, and it is published with every Atomic release at Atomic's version.

## Install

```bash
npm install @bastani/atomic-telemetry
```

Inside an Atomic extension, import it without installing it: the running Atomic provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

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

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-telemetry](https://docs.bastani.ai/libraries/telemetry)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
