# Notice

`@bastani/pi-ai` is a Bastani-branded fork of the `packages/ai` package from
[earendil-works/pi](https://github.com/earendil-works/pi). It lives in this
monorepo at `packages/ai` and publishes at the same version as `@bastani/atomic`.

- Upstream package: [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
- Original fork point: `v0.84.2` (`914cf1472e715297caa30db4b9535d534a9eb718`)
- Pi AI fixes and generated image catalog synced through audited upstream `main`: `earendil-works/pi@d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31`
- Catalog JSON under `src/providers/data/` is generated at build time from models.dev, matching upstream. It is not committed.

Original work is Copyright (c) 2025 Mario Zechner and is licensed under the MIT License.
Bastani modifications are Copyright (c) 2026 Bastani, Inc. and are also licensed under the MIT License.

Import from `@bastani/pi-ai` instead of `@earendil-works/pi-ai`. Telemetry types still come from the
upstream `@earendil-works/pi-telemetry` package.
