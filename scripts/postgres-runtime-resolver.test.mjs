import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Exercise the public resolver in the same compiled launcher -> disk ESM boundary
// as builtin workflows. Alias only the host export to its real implementation;
// no package resolver/importer or filesystem behavior is mocked.
test("compiled Bun resolves relocated archive, nested native leaf and legacy disk payloads", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-compiled-"));
	try {
		const disk = join(root, "installation with spaces", "builtin", "workflows", "resolver.mjs");
		mkdirSync(dirname(disk), { recursive: true });
		await build({
			stdin: {
				contents: `export { loadEmbeddedPostgresBinaries } from ${JSON.stringify(join(repository, "packages/workflows/src/durable/dbos-embedded-postgres.ts"))};`,
				resolveDir: repository,
			},
			bundle: true,
			format: "esm",
			platform: "node",
			outfile: disk,
			alias: { "@bastani/atomic": join(repository, "packages/coding-agent/src/utils/child-process.ts") },
			external: ["@bastani/atomic-natives"],
		});
		const launcher = join(root, "launcher.js");
		writeFileSync(
			launcher,
			`const { pathToFileURL } = require("node:url"); (async () => { const m = await import(pathToFileURL(process.argv[2]).href); console.log(JSON.stringify(await m.loadEmbeddedPostgresBinaries({host: JSON.parse(process.argv[3])}))); })().catch(e => { console.error(e); process.exitCode = 1; });`,
		);
		const executable = join(root, process.platform === "win32" ? "probe.exe" : "probe");
		execFileSync("bun", ["build", launcher, "--compile", "--bytecode", "--format=cjs", "--outfile", executable], {
			stdio: "pipe",
		});
		const installation = join(root, "installation with spaces");
		const native = join(installation, "node_modules", "@bastani", "atomic-natives");
		const host = { platform: "linux", arch: "x64", libc: "glibc" };
		const invoke = () =>
			JSON.parse(
				execFileSync(executable, [disk, JSON.stringify(host)], {
					cwd: root,
					encoding: "utf8",
					env: { ...process.env, ATOMIC_POSTGRES_RUNTIME_DIR: "" },
				}),
			);
		const payload = (directory) => {
			mkdirSync(join(directory, "bin"), { recursive: true });
			for (const name of ["postgres", "initdb", "pg_ctl"]) writeFileSync(join(directory, "bin", name), name);
		};
		payload(join(native, "postgres-runtime"));
		writeFileSync(join(native, "package.json"), '{"name":"@bastani/atomic-natives"}');
		assert.equal(invoke().postgres, join(native, "postgres-runtime", "bin", "postgres"));
		const leaf = join(native, "node_modules", "@bastani", "atomic-natives-linux-x64-gnu");
		payload(join(leaf, "postgres-runtime"));
		writeFileSync(join(leaf, "package.json"), '{"name":"@bastani/atomic-natives-linux-x64-gnu"}');
		assert.equal(invoke().postgres, join(leaf, "postgres-runtime", "bin", "postgres"));
		rmSync(native, { recursive: true });
		const legacy = join(installation, "node_modules", "@embedded-postgres", "linux-x64");
		payload(join(legacy, "native"));
		mkdirSync(join(legacy, "dist"));
		writeFileSync(
			join(legacy, "package.json"),
			'{"name":"@embedded-postgres/linux-x64","type":"module","exports":"./dist/index.js"}',
		);
		writeFileSync(
			join(legacy, "dist", "index.js"),
			'throw new Error("compiled resolver must use the disk payload, not the bare JS wrapper");',
		);
		assert.equal(invoke().postgres, join(legacy, "native", "bin", "postgres"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Node and compiled Bun load the real SDK from a relocated Bun-emitted builtin", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-dbos-compiled-"));
	try {
		// No node_modules under this relocated root: the lazy SDK and its required
		// JavaScript graph must be self-contained in the disk builtin.
		const disk = join(root, "builtin.mjs");
		const entry = join(root, "entry.ts");
		writeFileSync(
			entry,
			`export { importDbosSdk } from ${JSON.stringify(join(repository, "packages/workflows/src/durable/dbos-backend.ts"))};`,
		);
		execFileSync(
			"bun",
			[
				"build",
				entry,
				"--target=node",
				"--format=esm",
				"--external=@opentelemetry/*",
				"--external=winston",
				"--external=winston-transport",
				"--outfile",
				disk,
			],
			{ stdio: "pipe" },
		);
		const launcher = join(root, "launcher.js");
		writeFileSync(
			launcher,
			'const { pathToFileURL } = require("node:url"); (async () => { const m = await import(pathToFileURL(process.argv[2]).href); const sdk = await m.importDbosSdk(); if (typeof sdk.launch !== "function" || typeof sdk.registerWorkflow !== "function") throw Error("SDK missing"); console.log("DBOS SDK loaded"); })().catch(e => { console.error(e); process.exitCode = 1; });',
		);
		assert.match(execFileSync(process.execPath, [launcher, disk], { encoding: "utf8" }), /DBOS SDK loaded/u);
		const executable = join(root, process.platform === "win32" ? "probe.exe" : "probe");
		execFileSync("bun", ["build", launcher, "--compile", "--bytecode", "--format=cjs", "--outfile", executable], {
			stdio: "pipe",
		});
		assert.match(execFileSync(executable, [disk], { encoding: "utf8" }), /DBOS SDK loaded/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
