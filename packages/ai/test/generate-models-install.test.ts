import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { moveChangedFiles } from "../scripts/catalog-files.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** The model catalogs the generator fetches, served without the network: a few providers of each source. */
const MOCK_FETCH = `
const models = (ids) => Object.fromEntries(ids.map((id) => [id, { id, name: id, tool_call: true }]));
const tokenPlan = models([
	"deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017",
	"glm-5.2", "glm-5.3", "qwen3.6-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max",
]);
const catalog = {
	"alibaba-token-plan": { models: tokenPlan },
	"alibaba-token-plan-cn": { models: tokenPlan },
	anthropic: { models: models(["claude-sonnet-4-6", "claude-sonnet-5"]) },
	baseten: { models: models(["zai-org/GLM-5.2"]) },
};
globalThis.fetch = async (input) => {
	const url = String(input);
	if (url === "https://models.dev/api.json") return Response.json(catalog);
	if (url === "https://models.dev/models.json?type=decision") {
		const decision = (name) => ({ type: "decision", name, modalities: { input: ["text"] }, limit: { context: 64000 } });
		return Response.json({ "typesafe/jev-latest": decision("Jev"), "typesafe/jev-1.14.0": decision("Jev 1.14") });
	}
	if (url === "https://openrouter.ai/api/v1/models?output_modalities=image") {
		return Response.json({ data: [{ id: "test/image", name: "Image", architecture: { output_modalities: ["image"] } }] });
	}
	if (url.startsWith("https://openrouter.ai/api/v1/models")) return Response.json({ data: [] });
	if (url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });
	throw new Error(\`Unexpected fetch: \${url}\`);
};
`;

/**
 * Checks the generated catalog after every file-system change the generator makes, as a process importing it at that
 * moment would find it: the data directory is there, the aggregator's shards and each shard's data file exist and read
 * whole, and no existing file is written over in place, which a reader can catch empty or half-written.
 */
const WATCH_CATALOG = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const src = join(process.cwd(), "src");
const providers = join(src, "providers");
const data = join(providers, "data");
const report = process.env.CATALOG_REPORT;
const problems = new Set();
const original = { ...fs };
const inCatalog = (path) => String(path).startsWith(src);
const readsWhole = (path, json) => {
	try {
		const text = original.readFileSync(path, "utf8");
		if (text.length === 0) return false;
		if (json) JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};
const check = (after) => {
	if (!original.existsSync(data)) problems.add(\`data directory missing after \${after}\`);
	const aggregator = join(src, "models.generated.ts");
	if (!readsWhole(aggregator, false)) problems.add(\`aggregator unreadable after \${after}\`);
	else for (const [, id] of original.readFileSync(aggregator, "utf8").matchAll(/from "\\.\\/providers\\/([^"]+)\\.models\\.ts"/g)) {
		if (!readsWhole(join(providers, \`\${id}.models.ts\`), false)) problems.add(\`\${id}.models.ts unreadable after \${after}\`);
	}
	for (const entry of original.readdirSync(providers)) {
		if (!entry.endsWith(".models.ts")) continue;
		const shard = original.readFileSync(join(providers, entry), "utf8");
		for (const [, id] of shard.matchAll(/^import values from "\\.\\/data\\/([^"]+)\\.json"/gm)) {
			if (!readsWhole(join(data, \`\${id}.json\`), true)) problems.add(\`data/\${id}.json unreadable for \${entry} after \${after}\`);
		}
	}
};
const writes = ["writeFileSync", "appendFileSync", "truncateSync"];
for (const name of [...writes, "renameSync", "rmSync", "unlinkSync", "copyFileSync", "cpSync", "rmdirSync", "mkdirSync"]) {
	fs[name] = function (path, ...rest) {
		if (writes.includes(name) && inCatalog(path) && original.existsSync(path)) {
			problems.add(\`\${String(path).slice(src.length + 1)} written in place\`);
		}
		const result = original[name].call(this, path, ...rest);
		if (inCatalog(path) || (rest.length > 0 && inCatalog(rest[0]))) check(\`\${name} \${String(path).slice(src.length + 1)}\`);
		return result;
	};
}
syncBuiltinESMExports();
process.on("exit", () => original.writeFileSync(report, JSON.stringify([...problems], null, 2)));
`;

/** A copy of the package, with its current catalog, to generate a catalog into. */
function isolatedPackage(): { readonly root: string; readonly fixtureRoot: string } {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "atomic-generate-models-install-"));
	temporaryRoots.push(fixtureRoot);
	const root = join(fixtureRoot, "package");
	mkdirSync(root);
	for (const entry of ["package.json", "scripts", "src"])
		cpSync(join(packageRoot, entry), join(root, entry), { recursive: true });
	writeFileSync(join(fixtureRoot, "mock-fetch.mjs"), MOCK_FETCH);
	writeFileSync(join(fixtureRoot, "watch-catalog.mjs"), WATCH_CATALOG);
	return { root, fixtureRoot };
}

function generate(fixture: { readonly root: string; readonly fixtureRoot: string }, run: string): string[] {
	const report = join(fixture.fixtureRoot, `${run}-report.json`);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(fixture.fixtureRoot, "mock-fetch.mjs")).href,
			"--import",
			pathToFileURL(join(fixture.fixtureRoot, "watch-catalog.mjs")).href,
			"scripts/generate-models.ts",
			"--strict",
		],
		{ cwd: fixture.root, encoding: "utf8", timeout: 60_000, env: { ...process.env, CATALOG_REPORT: report } },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	return JSON.parse(readFileSync(report, "utf8")) as string[];
}

/** Identity and modification time of each generated catalog file, by its path below src. */
function catalogFiles(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const providers = join(root, "src", "providers");
	const add = (path: string, name: string) => {
		const stats = statSync(path, { bigint: true });
		files.set(name, `${stats.ino}:${stats.mtimeNs}`);
	};
	add(join(root, "src", "models.generated.ts"), "models.generated.ts");
	for (const entry of readdirSync(providers)) {
		if (entry.endsWith(".models.ts")) add(join(providers, entry), `providers/${entry}`);
	}
	for (const entry of readdirSync(join(providers, "data")))
		add(join(providers, "data", entry), `providers/data/${entry}`);
	return files;
}

describe("installing a generated model catalog", () => {
	it("never leaves the catalog missing or half-written for a process importing it, and leaves unchanged files alone", () => {
		const fixture = isolatedPackage();
		const before = readdirSync(join(fixture.root, "src", "providers")).filter((entry) =>
			entry.endsWith(".models.ts"),
		);

		// The fixture's catalog has fewer providers than the package's: shards and data files are added, changed and removed.
		assert.deepEqual(generate(fixture, "first"), []);
		const generated = readdirSync(join(fixture.root, "src", "providers")).filter((entry) =>
			entry.endsWith(".models.ts"),
		);
		assert.ok(
			before.some((entry) => !generated.includes(entry)),
			"some providers' shards were removed",
		);
		const check = spawnSync(process.execPath, ["scripts/check-model-data.ts"], {
			cwd: fixture.root,
			encoding: "utf8",
		});
		assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);

		// The same catalog again: only the manifest, which records when the catalog was generated, changes.
		const installed = catalogFiles(fixture.root);
		assert.deepEqual(generate(fixture, "second"), []);
		const again = catalogFiles(fixture.root);
		assert.deepEqual([...again.keys()].sort(), [...installed.keys()].sort());
		assert.deepEqual(
			[...again].filter(([name, state]) => installed.get(name) !== state).map(([name]) => name),
			["providers/data/.manifest.json"],
		);
	});

	it("ignores and cleans up a stray subdirectory in src/providers/data without breaking readers", () => {
		const fixture = isolatedPackage();
		const strayDir = join(fixture.root, "src", "providers", "data", ".tmp-stale-cache");
		mkdirSync(strayDir, { recursive: true });
		writeFileSync(join(strayDir, "leftover.json"), "{}\n");

		assert.deepEqual(generate(fixture, "stray-data-dir"), []);
		assert.equal(existsSync(strayDir), false, "stray subdirectory in src/providers/data should be removed");
		const check = spawnSync(process.execPath, ["scripts/check-model-data.ts"], {
			cwd: fixture.root,
			encoding: "utf8",
		});
		assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
	});

	it("recovers when stray or colliding directories exist in catalog locations and when models.generated.ts is absent", () => {
		const fixture = isolatedPackage();
		const strayShardDir = join(fixture.root, "src", "providers", "stray.models.ts");
		mkdirSync(strayShardDir, { recursive: true });
		writeFileSync(join(strayShardDir, "nested.ts"), "export {};\n");
		const collidingData = join(fixture.root, "src", "providers", "data", "anthropic.json");
		rmSync(collidingData, { force: true, recursive: true });
		mkdirSync(collidingData, { recursive: true });
		writeFileSync(join(collidingData, "nested.json"), "{}\n");
		rmSync(join(fixture.root, "src", "models.generated.ts"), { force: true });

		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(fixture.fixtureRoot, "mock-fetch.mjs")).href,
				"scripts/generate-models.ts",
				"--strict",
			],
			{ cwd: fixture.root, encoding: "utf8", timeout: 60_000 },
		);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(existsSync(strayShardDir), false, "stray .models.ts directory should be removed");
		assert.equal(statSync(collidingData).isFile(), true, "colliding directory should be replaced with data file");
		assert.equal(statSync(join(fixture.root, "src", "models.generated.ts")).isFile(), true);
		const check = spawnSync(process.execPath, ["scripts/check-model-data.ts"], {
			cwd: fixture.root,
			encoding: "utf8",
		});
		assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
	});

	it("restores previous regular catalog files on install failure even when a stray directory exists", () => {
		const fixture = isolatedPackage();
		const dataDir = join(fixture.root, "src", "providers", "data");
		const strayDir = join(dataDir, ".tmp-stale-cache");
		mkdirSync(strayDir, { recursive: true });
		writeFileSync(join(strayDir, "leftover.json"), "{}\n");
		const beforeAgg = readFileSync(join(fixture.root, "src", "models.generated.ts"));
		const beforeAnthropic = readFileSync(join(dataDir, "anthropic.json"));

		const failInstall = join(fixture.fixtureRoot, "fail-install.mjs");
		writeFileSync(
			failInstall,
			`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const origRename = fs.renameSync;
fs.renameSync = function (from, to) {
	if (String(to).endsWith("models.generated.ts")) throw new Error("INJECTED_INSTALL_FAILURE");
	return origRename.call(this, from, to);
};
syncBuiltinESMExports();
`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(fixture.fixtureRoot, "mock-fetch.mjs")).href,
				"--import",
				pathToFileURL(failInstall).href,
				"scripts/generate-models.ts",
				"--strict",
			],
			{ cwd: fixture.root, encoding: "utf8", timeout: 60_000 },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /INJECTED_INSTALL_FAILURE/);
		assert.doesNotMatch(result.stderr, /EISDIR/);
		assert.deepEqual(readFileSync(join(fixture.root, "src", "models.generated.ts")), beforeAgg);
		assert.deepEqual(readFileSync(join(dataDir, "anthropic.json")), beforeAnthropic);
	});

	it("moveChangedFiles replaces a colliding directory while leaving unchanged regular files untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-move-changed-files-"));
		temporaryRoots.push(root);
		const staged = join(root, "staged");
		const target = join(root, "target");
		mkdirSync(staged, { recursive: true });
		mkdirSync(join(target, "colliding.json"), { recursive: true });
		writeFileSync(join(target, "colliding.json", "nested"), "x");
		writeFileSync(join(staged, "colliding.json"), '{"ok":true}\n');
		writeFileSync(join(staged, "same.json"), '{"same":1}\n');
		writeFileSync(join(target, "same.json"), '{"same":1}\n');
		const sameBefore = statSync(join(target, "same.json"), { bigint: true });

		const moved = moveChangedFiles(staged, target);
		assert.deepEqual(moved, ["colliding.json", "same.json"]);
		assert.equal(statSync(join(target, "colliding.json")).isFile(), true);
		assert.equal(readFileSync(join(target, "colliding.json"), "utf8"), '{"ok":true}\n');
		const sameAfter = statSync(join(target, "same.json"), { bigint: true });
		assert.equal(sameAfter.ino, sameBefore.ino);
		assert.equal(sameAfter.mtimeNs, sameBefore.mtimeNs);
	});
});
