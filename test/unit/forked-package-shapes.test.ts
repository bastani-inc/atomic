import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const repositoryRoot = join(moduleDir(import.meta.url), "..", "..");

/** The forked packages published both bundled and one file per module, and their exports without a wildcard. */
const packages = ["ai", "agent", "schema", "telemetry"].map((directory) => {
	const manifest = JSON.parse(readFileSync(join(repositoryRoot, "packages", directory, "package.json"), "utf8")) as {
		name: string;
		exports: Record<string, string | { module?: string; import?: string }>;
	};
	const keys = Object.keys(manifest.exports).filter((key) => !key.includes("*") && key !== "./package.json");
	const specifierOf = (key: string) => (key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`);
	const packageDir = join(repositoryRoot, "packages", directory);
	/** Each module an export names, by its specifier, and the file of its compiled module, one file per module. */
	const modules = Object.entries(manifest.exports).flatMap(([key, target]) => {
		const compiled = typeof target === "object" ? target.module : undefined;
		const bundled = typeof target === "object" ? target.import : undefined;
		if (compiled === undefined || bundled === undefined) return [];
		if (!key.includes("*")) return [[specifierOf(key), join(packageDir, compiled)] as const];
		// A pattern export: each module of its directory.
		const [prefix = "", suffix = ""] = bundled.split("*");
		return readdirSync(join(packageDir, prefix))
			.filter((name) => name.endsWith(suffix) && !name.endsWith(".d.ts") && !name.startsWith("_"))
			.map((name) => {
				const stem = name.slice(0, name.length - suffix.length);
				return [specifierOf(key.replace("*", stem)), join(packageDir, compiled.replace("*", stem))] as const;
			});
	});
	return { name: manifest.name, specifiers: keys.map(specifierOf), modules };
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
		// The JSON files the modules import ship once, beside the bundled files.
		assert.deepEqual(
			forkedFiles.filter((input) => !input.includes("/dist/_modules/") && !input.endsWith(".json")),
			[],
		);
	});
}

test("a bundler's source maps for the forked packages still reach their TypeScript sources", async () => {
	const result = await build({
		stdin: {
			contents: 'export { getProviderEnvValue } from "@bastani/atomic-ai/utils/provider-env";',
			resolveDir: repositoryRoot,
			loader: "js",
		},
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		sourcemap: "external",
		outfile: join(repositoryRoot, "out.js"),
		logLevel: "silent",
	});
	const map = JSON.parse(result.outputFiles.find((file) => file.path.endsWith(".map"))?.text ?? "{}") as {
		sources: string[];
		sourcesContent: Array<string | null>;
	};
	const index = map.sources.findIndex((source) => source.endsWith("packages/ai/src/utils/provider-env.ts"));
	assert.ok(index >= 0, map.sources.join("\n"));
	assert.match(map.sourcesContent[index] ?? "", /export function getProviderEnvValue/);
});

// Bundling renames a function or class whose name another module in the same shared file also has; the bundled files
// keep each exported function's and class's own name, the one its compiled module gives it.
test(
	"the forked packages' exported functions and classes keep their names in the bundled files",
	() => {
		const modules = packages.flatMap((pkg) =>
			pkg.modules.map(([specifier, file]) => [specifier, pathToFileURL(file).href]),
		);
		const script = `const renamed = [];
for (const [specifier, compiled] of ${JSON.stringify([...modules, ["@bastani/atomic-tui", ""]])}) {
	const bundled = await import(specifier);
	const own = compiled === "" ? undefined : await import(compiled);
	for (const [key, value] of Object.entries(bundled)) {
		if (typeof value !== "function") continue;
		// The terminal UI package has no compiled copy: a bundler's renaming adds a "$" and a number.
		const expected = own === undefined ? value.name.replace(/\\$\\d+$/, "") : own[key]?.name;
		if (value.name !== expected) renamed.push(specifier + " " + key + ": " + value.name + ", not " + expected);
	}
}
console.log(JSON.stringify(renamed));`;
		const result = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], { cwd: repositoryRoot });
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString()), []);
	},
	SHAPE_PROBE_TIMEOUT_MS,
);
