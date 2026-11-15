<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-schema</b><br>
  JSON Schema builders and validation without eval.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/schema"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-schema"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-schema?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

Builders that return plain JSON Schema typed with the values it accepts, and a validator that compiles a schema once into plain closures: drafts 2020-12 and 7, no `eval`, so it works under a strict Content Security Policy. Atomic validates tool arguments with it.

[Atomic](https://github.com/bastani-inc/atomic), the verifiable coding agent runtime, is built on it, and it is published with every Atomic release at Atomic's version.

## Install

```bash
npm install @bastani/atomic-schema
```

Inside an Atomic extension, import it without installing it: the running Atomic provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

```typescript
import { compile, int, obj, oneOf, opt, type Static, str } from "@bastani/atomic-schema";

const Read = obj({
	path: str({ description: "Path to the file", minLength: 1 }),
	offset: opt(int({ minimum: 1 })),
	mode: oneOf(["text", "binary"]),
});
type Read = Static<typeof Read>; // { path: string; mode: "text" | "binary"; offset?: number }

const read = compile(Read);
if (read.check(value)) value.path; // value: Read

read.errors({ offset: 0, extra: true });
// [
//   { path: "/path", keyword: "required", message: "missing" },
//   { path: "/mode", keyword: "required", message: "missing" },
//   { path: "/offset", keyword: "minimum", message: "expected >= 1" },
//   { path: "/extra", keyword: "additionalProperties", message: "unknown field" },
// ]
```

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-schema](https://docs.bastani.ai/libraries/schema)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
