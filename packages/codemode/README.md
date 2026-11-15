<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
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

Runs model-written JavaScript in a QuickJS VM compiled to WebAssembly. Scripts call your tools; nested tool calls never enter the model's context, only the script's output and return value do. Atomic uses it for its built-in `codemode` tool, and it runs on Node, Bun and Cloudflare Workers.

[Atomic](https://github.com/bastani-inc/atomic), the verifiable coding agent runtime, is built on it, and it is published with every Atomic release at Atomic's version.

## Install

```bash
npm install @bastani/atomic-codemode
```

Inside an Atomic extension, import it without installing it: the running Atomic provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

```ts
import { CodemodeSandbox } from "@bastani/atomic-codemode";

const sandbox = new CodemodeSandbox({
	timeoutMs: 60_000,
	tools: [
		{
			name: "read",
			execute: async (args, { signal }) => {
				const { path } = args as { path: string };
				return await readFile(path, "utf8");
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

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-codemode](https://docs.bastani.ai/libraries/codemode)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
