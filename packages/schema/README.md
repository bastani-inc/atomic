<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
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

`@bastani/atomic-schema` provides typed JSON Schema builders and a validator that compiles Draft 2020-12 and Draft 7 schemas into plain JavaScript closures without `eval`, so it works under strict Content Security Policies. Atomic uses it to validate tool arguments.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-schema
```

Inside an Atomic extension, you can import it without installing it because the running Atomic process provides it. See [Libraries](https://docs.bastani.ai/libraries).

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
const value: unknown = { path: "README.md", mode: "text" };
if (read.check(value)) {
	console.log(value.path); // value is narrowed to Read
}

console.log(read.errors({ offset: 0, extra: true }));
// [
//   { path: "/path", keyword: "required", message: "missing" },
//   { path: "/mode", keyword: "required", message: "missing" },
//   { path: "/offset", keyword: "minimum", message: "expected >= 1" },
//   { path: "/extra", keyword: "additionalProperties", message: "unknown field" },
// ]
```

Pass `{ coerce: true }` to `compile()` to get a coercing validator with `parse()` for lenient string-to-number or string-to-boolean inputs. Import optional JSON Schema string format validators (`email`, `uri`, `date-time`, `uuid`, and more) from `@bastani/atomic-schema/formats`.

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-schema](https://docs.bastani.ai/libraries/schema)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
