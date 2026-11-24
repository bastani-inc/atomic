<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-codemode</b><br>
  Sandboxed JavaScript whose only capability is calling the tools you inject.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/codemode"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-codemode"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-codemode?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

`@bastani/atomic-codemode` runs model-written JavaScript inside a QuickJS WebAssembly sandbox. Scripts call only the tools you inject, so intermediate tool calls stay out of the model's context while the script's output and return value come back cleanly. Atomic uses it for its built-in `codemode` tool, and the package supports Node.js, Bun, and Cloudflare Workers.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-codemode
```

Inside an Atomic extension, you can import it without installing it because the running Atomic process provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

Sandboxed scripts have access to `tools` (your injected tool functions), `text()` and `image()` (for structured output), `store()` and `load()` (for passing values between steps), `exit()`, and `ALL_TOOLS`:

```typescript
import { readFile } from "node:fs/promises";
import { CodemodeSandbox } from "@bastani/atomic-codemode";

const sandbox = new CodemodeSandbox({
	timeoutMs: 60_000,
	tools: [
		{
			name: "read",
			execute: async (args, { signal }) => {
				const { path } = args as { path: string };
				return await readFile(path, { encoding: "utf8", signal });
			},
		},
	],
});

const result = await sandbox.execute(`
	const source = await tools.read({ path: "package.json" });
	text("bytes " + source.length);
	return JSON.parse(source).name;
`);

console.log(result.output); // [{ type: "text", text: "bytes 1234" }]
if (result.ok) console.log(result.value); // "@bastani/atomic-codemode"
else console.error(result.error.kind, result.error.message);

await sandbox.close();
```

## Subpath exports

- `@bastani/atomic-codemode`: `CodemodeSandbox` for Node.js and Bun (runs QuickJS in a worker thread).
- `@bastani/atomic-codemode/portable`: `RemoteCodemodeSandbox`, `InlineCodemodeSandbox`, and runtime-neutral helpers without Node.js worker threads.
- `@bastani/atomic-codemode/cloudflare`: Durable Object sandbox bindings for Cloudflare Workers.
- `@bastani/atomic-codemode/declarations`: TypeScript declaration generation for injected tool catalogs.
- `@bastani/atomic-codemode/source`: Source-analysis helpers for inspecting model-written scripts.
- `@bastani/atomic-codemode/node-options` and `@bastani/atomic-codemode/worker`: Worker-thread launch options and worker entrypoint.

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-codemode](https://docs.bastani.ai/libraries/codemode)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
