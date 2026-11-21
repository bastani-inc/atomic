import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "vitest";

// `@bastani/atomic-codemode/portable` and `/declarations` run outside Node (browsers, Workers): whatever the published
// package's files share with its Node-only code, a bundler targeting a browser must still bundle these entries.
for (const entry of ["@bastani/atomic-codemode/portable", "@bastani/atomic-codemode/declarations"]) {
	test(`${entry} bundles for a browser`, async () => {
		const result = await build({
			stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: process.cwd(), loader: "js" },
			bundle: true,
			platform: "browser",
			format: "esm",
			write: false,
			logLevel: "silent",
		});
		assert.deepEqual(result.errors, []);
		assert.ok((result.outputFiles[0]?.text.length ?? 0) > 0);
	});
}
