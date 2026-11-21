// Covers when an incremental `npm run build` step reruns: input hashing, output fingerprints and the stamp decision.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILD_STEPS, MODEL_CATALOG_MAX_AGE_MS, shouldForce, stepInputs } from "./build.mjs";
import { decideStep, fingerprintOutputs, hashInputs, readStamp, writeStamp } from "./build-stamps.mjs";

function workspace(t) {
	const directory = mkdtempSync(join(tmpdir(), "atomic-build-stamps-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function write(root, relative, content) {
	mkdirSync(dirname(join(root, relative)), { recursive: true });
	writeFileSync(join(root, relative), content);
}

/** A built step: stamp recorded from the current inputs and outputs. */
function builtStep(root, inputs, outputs) {
	const inputHash = hashInputs(root, inputs);
	return {
		inputHash,
		stamp: { version: 1, inputHash, outputHash: fingerprintOutputs(root, outputs).hash, builtAt: Date.now() },
	};
}

function decide(root, inputs, outputs, stamp, force = false) {
	return decideStep({ force, stamp, inputHash: hashInputs(root, inputs), outputs: fingerprintOutputs(root, outputs) });
}

test("an unchanged step is up to date and keeps incremental state", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	write(root, "dist/a.js", "a");
	const { stamp } = builtStep(root, ["src"], ["dist"]);
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), { reason: undefined, incremental: true });
});

test("editing, adding or deleting an input file reruns the step incrementally", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	write(root, "dist/a.js", "a");
	const { stamp } = builtStep(root, ["src"], ["dist"]);

	write(root, "src/a.ts", "changed");
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), { reason: "inputs changed", incremental: true });
	write(root, "src/a.ts", "a");
	write(root, "src/nested/b.ts", "b");
	assert.equal(decide(root, ["src"], ["dist"], stamp).reason, "inputs changed");
	rmSync(join(root, "src/nested"), { recursive: true });
	rmSync(join(root, "src/a.ts"));
	assert.equal(decide(root, ["src"], ["dist"], stamp).reason, "inputs changed");
});

test("input hashes follow content, not modification times", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	const before = hashInputs(root, ["src"]);
	utimesSync(join(root, "src/a.ts"), new Date(0), new Date(0));
	assert.equal(hashInputs(root, ["src"]), before);
});

test("a missing input path is hashed, so creating it reruns the step", (t) => {
	const root = workspace(t);
	const before = hashInputs(root, ["Cargo.lock"]);
	write(root, "Cargo.lock", "");
	assert.notEqual(hashInputs(root, ["Cargo.lock"]), before);
});

test("dependency and build-output directories and excluded files are not inputs", (t) => {
	const root = workspace(t);
	write(root, "pkg/src/a.ts", "a");
	const before = hashInputs(root, [{ path: "pkg", exclude: (relative) => relative.endsWith(".generated.ts") }]);
	write(root, "pkg/node_modules/dep/index.js", "dep");
	write(root, "pkg/dist/a.js", "a");
	write(root, "pkg/target/release/lib.so", "lib");
	write(root, "pkg/src/models.generated.ts", "generated");
	assert.equal(hashInputs(root, [{ path: "pkg", exclude: (relative) => relative.endsWith(".generated.ts") }]), before);
});

test("a toolchain, environment or upstream key change reruns the step", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	const base = hashInputs(root, ["src"], { "toolchain:rustc": "1.99.1", "env:RUSTFLAGS": undefined });
	assert.notEqual(hashInputs(root, ["src"], { "toolchain:rustc": "1.99.2", "env:RUSTFLAGS": undefined }), base);
	assert.notEqual(hashInputs(root, ["src"], { "toolchain:rustc": "1.99.1", "env:RUSTFLAGS": "-C opt-level=1" }), base);
	assert.equal(hashInputs(root, ["src"], { "env:RUSTFLAGS": undefined, "toolchain:rustc": "1.99.1" }), base);
});

test("a deleted, rewritten or added output reruns the step from scratch", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	write(root, "dist/a.js", "a");
	write(root, "dist/b.js", "b");
	const { stamp } = builtStep(root, ["src"], ["dist"]);
	const changed = { reason: "outputs changed since the last build", incremental: false };

	rmSync(join(root, "dist/b.js"));
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), changed);
	write(root, "dist/b.js", "b");
	utimesSync(join(root, "dist/b.js"), new Date(0), new Date(0));
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), changed);
	write(root, "dist/extra.js", "extra");
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), changed);
});

test("a missing or empty output directory reruns the step from scratch", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	write(root, "dist/a.js", "a");
	const { stamp } = builtStep(root, ["src"], ["dist"]);
	rmSync(join(root, "dist/a.js"));
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), { reason: "missing output dist", incremental: false });
	rmSync(join(root, "dist"), { recursive: true });
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp), { reason: "missing output dist", incremental: false });
});

test("a missing, unreadable or older stamp reruns the step from scratch, and force always does", (t) => {
	const root = workspace(t);
	write(root, "src/a.ts", "a");
	write(root, "dist/a.js", "a");
	const stampPath = join(root, "cache/step.stamp.json");
	assert.equal(readStamp(stampPath), undefined);
	assert.deepEqual(decide(root, ["src"], ["dist"], undefined), { reason: "no stamp", incremental: false });

	write(root, "cache/step.stamp.json", "{not json");
	assert.equal(readStamp(stampPath), undefined);
	write(root, "cache/step.stamp.json", JSON.stringify({ version: 0, inputHash: "x", outputHash: "y" }));
	assert.equal(readStamp(stampPath), undefined);

	const { inputHash, stamp } = builtStep(root, ["src"], ["dist"]);
	writeStamp(stampPath, { inputHash, outputHash: stamp.outputHash, builtAt: stamp.builtAt });
	assert.deepEqual(readStamp(stampPath), stamp);
	assert.deepEqual(decide(root, ["src"], ["dist"], stamp, true), { reason: "forced", incremental: false });
});

test("a fetched snapshot is reused within its maximum age and refreshed once it is older", (t) => {
	const root = workspace(t);
	write(root, "scripts/generate.ts", "generator");
	write(root, "data/catalog.json", "{}");
	const { inputHash, stamp } = builtStep(root, ["scripts"], ["data"]);
	const outputs = fingerprintOutputs(root, ["data"]);
	const maxAgeMs = MODEL_CATALOG_MAX_AGE_MS;
	const at = (ageMs) => decideStep({ force: false, stamp, inputHash, outputs, maxAgeMs, now: stamp.builtAt + ageMs });

	assert.deepEqual(at(maxAgeMs), { reason: undefined, incremental: true });
	assert.deepEqual(at(maxAgeMs + 1), { reason: "older than 24 h", incremental: true, stale: true });
	assert.equal(at(-1).stale, true, "a stamp dated in the future, after the clock moved back, is stale");
	const { builtAt: _, ...withoutTime } = stamp;
	assert.equal(decideStep({ force: false, stamp: withoutTime, inputHash, outputs, maxAgeMs }).stale, true);
	assert.equal(
		decideStep({ force: false, stamp, inputHash, outputs, now: stamp.builtAt + 365 * maxAgeMs }).reason,
		undefined,
	);
});

test("--force, ATOMIC_BUILD_FORCE and CI force a full build", () => {
	assert.equal(shouldForce([], {}), false);
	assert.equal(shouldForce(["--force"], {}), true);
	assert.equal(shouldForce([], { ATOMIC_BUILD_FORCE: "1" }), true);
	assert.equal(shouldForce([], { ATOMIC_BUILD_FORCE: "0" }), false);
	assert.equal(shouldForce([], { CI: "true" }), true);
	assert.equal(shouldForce([], { CI: "false" }), false);
	assert.equal(shouldForce([], { CI: "" }), false);
});

/** @param {import("./build.mjs").BuildStep} step */
const inputPaths = (step) => stepInputs(step).map((input) => (typeof input === "string" ? input : input.path));

test("every step hashes the tsconfig and bunfig files its compilers and bundlers read", () => {
	for (const file of ["tsconfig.json", "tsconfig.base.json", "bunfig.toml"]) {
		for (const step of BUILD_STEPS) assert.ok(inputPaths(step).includes(file), `${step.name} hashes ${file}`);
	}
	const ai = BUILD_STEPS.find((step) => step.name === "ai");
	for (const file of ["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"]) {
		assert.ok(ai && inputPaths(ai).includes(`packages/ai/${file}`), `ai hashes packages/ai/${file}`);
	}
	const atomic = BUILD_STEPS.find((step) => step.name === "atomic");
	assert.ok(atomic && inputPaths(atomic).includes("packages/coding-agent/tsconfig.build.json"));
});

test("each package builds after the forked packages and native step whose outputs it consumes", () => {
	const names = BUILD_STEPS.map((step) => step.name);
	assert.deepEqual(names, ["schema", "telemetry", "ai-models", "ai", "tui", "agent", "codemode", "natives", "atomic"]);
	for (const step of BUILD_STEPS) {
		for (const upstream of step.after ?? []) {
			assert.ok(names.indexOf(upstream) < names.indexOf(step.name), `${step.name} builds after ${upstream}`);
		}
	}
	assert.deepEqual(BUILD_STEPS.find((step) => step.name === "ai")?.after, ["schema", "telemetry"]);
	assert.deepEqual(BUILD_STEPS.find((step) => step.name === "agent")?.after, ["ai", "schema"]);
	const atomic = BUILD_STEPS.find((step) => step.name === "atomic");
	assert.deepEqual(atomic?.after, ["ai", "tui", "agent", "codemode", "natives"]);
});

test("the packages Atomic depends on are refreshed through a staging directory, never compiled into their dist in place", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const readManifest = (/** @type {string} */ packageDir) =>
		JSON.parse(readFileSync(join(root, packageDir, "package.json"), "utf8"));
	const manifests = new Map(BUILD_STEPS.map((step) => [step.packageDir, readManifest(step.packageDir)]));
	/** Atomic's dependencies, with theirs among the packages the build compiles. */
	const dependencies = new Set(Object.keys(readManifest("packages/coding-agent").dependencies ?? {}));
	for (const name of dependencies) {
		const manifest = [...manifests.values()].find((candidate) => candidate.name === name);
		for (const dependency of Object.keys(manifest?.dependencies ?? {})) dependencies.add(dependency);
	}
	const staged = BUILD_STEPS.filter(
		(step) =>
			step.outputs.includes(`${step.packageDir}/dist`) && dependencies.has(manifests.get(step.packageDir).name),
	);
	assert.deepEqual(
		staged.map((step) => step.name),
		["schema", "telemetry", "ai", "tui", "agent", "codemode"],
	);
	for (const step of staged) {
		assert.equal(step.staged, true, `${step.name} moves only changed files into its dist`);
		assert.deepEqual(
			step.scripts.filter((script) => script.tsc),
			[],
			`${step.name} runs no compiler into its dist`,
		);
		assert.ok(inputPaths(step).includes("scripts/refresh-package-dist.mjs"), `${step.name} hashes the refresh`);
	}
});
