import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const repositoryRoot = join(moduleDir(import.meta.url), "..", "..");

/** The forked packages published both bundled and one file per module, and their exports without a wildcard. */
const packages = ["ai", "agent", "schema", "telemetry"].map((directory) => {
	const manifest = JSON.parse(readFileSync(join(repositoryRoot, "packages", directory, "package.json"), "utf8")) as {
		name: string;
		exports: Record<string, unknown>;
	};
	const specifiers = Object.keys(manifest.exports)
		.filter((key) => !key.includes("*") && key !== "./package.json")
		.map((key) => (key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`));
	return { name: manifest.name, specifiers };
});
const specifiers = packages.flatMap(({ specifiers }) => specifiers);
const SHAPE_PROBE_TIMEOUT_MS = 60_000;

// Node and Bun load the bundled files, so a process never holds two copies of a module; bundlers get one file per
// module, so they can leave out the modules an app does not use.
test(
	"Node and Bun resolve the forked packages to their bundled files",
	() => {
		const script = `for (const specifier of ${JSON.stringify(specifiers)}) console.log(import.meta.resolve(specifier));`;
		for (const runtime of [
			[process.execPath, "--input-type=module", "-e", script],
			[bunExecutable(), "-e", script],
		]) {
			const result = spawnSyncCollect(runtime, { cwd: repositoryRoot });
			assert.equal(result.exitCode, 0, result.stderr.toString());
			const resolved = result.stdout.toString().trim().split("\n");
			assert.equal(resolved.length, specifiers.length);
			assert.deepEqual(
				resolved.filter((url) => url.includes("/dist/_modules/") || !url.includes("/dist/")),
				[],
				runtime[0],
			);
		}
	},
	SHAPE_PROBE_TIMEOUT_MS,
);

for (const platform of ["browser", "node"] as const) {
	test(`bundlers targeting ${platform} resolve the forked packages to one file per module`, async () => {
		const result = await build({
			stdin: {
				contents: specifiers
					.map((specifier, index) => `import * as m${index} from ${JSON.stringify(specifier)};`)
					.join("\n"),
				resolveDir: repositoryRoot,
				loader: "js",
			},
			bundle: true,
			platform,
			format: "esm",
			write: false,
			metafile: true,
			logLevel: "silent",
			plugins: [
				{
					name: "only-forked-packages",
					setup(build) {
						build.onResolve({ filter: /^[^./]/ }, ({ path, kind }) =>
							kind === "entry-point" || packages.some(({ name }) => path === name || path.startsWith(`${name}/`))
								? undefined
								: { path, external: true },
						);
					},
				},
			],
		});
		const forkedFiles = Object.keys(result.metafile.inputs).filter((input) =>
			/packages\/(ai|agent|schema|telemetry)\/dist\//.test(input),
		);
		assert.ok(forkedFiles.length > 0);
		assert.deepEqual(
			forkedFiles.filter((input) => !input.includes("/dist/_modules/")),
			[],
		);
	});
}
