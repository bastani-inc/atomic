import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { coercePossibleStages } from "../../packages/workflows/src/shared/possible-stages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const SCANNED = ["orchestrator-*", "pull-request", "reviewer-error"] as const;

const plain = workflow({
	name: "possible-stages-plain",
	description: "",
	inputs: {},
	outputs: { value: Type.String() },
	run: async () => ({ value: "ok" }),
});

// ---------------------------------------------------------------------------
// D10 — the scan persists with the run and survives resume/replay
// ---------------------------------------------------------------------------

describe("possible-stages persistence (D10)", () => {
	test("a launch-time scan persists onto the root snapshot and the durable handle", async () => {
		const backend = await createMemoryTestBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-1",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		assert.deepEqual(store.runs().find((candidate) => candidate.id === "ps-run-1")?.possibleStages, [...SCANNED]);
		assert.deepEqual(backend.getWorkflow("ps-run-1")?.possibleStages, [...SCANNED]);
	});

	test("resume hydrates the persisted scan instead of recomputing it", async () => {
		const backend = await createMemoryTestBackend();
		const first = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-2",
				store: first,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		// A later resume in a fresh session: no scan is supplied, the durable
		// value wins so mid-run definition edits cannot change advertised targets.
		const second = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-2",
				store: second,
				durableBackend: backend,
				durableRootBackend: backend,
			},
		);
		assert.deepEqual(second.runs().find((candidate) => candidate.id === "ps-run-2")?.possibleStages, [...SCANNED]);
	});

	test("a missing or corrupt scan hydrates as an empty set", async () => {
		const backend = await createMemoryTestBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-3",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "ps-run-3");
		assert.deepEqual(snapshot?.possibleStages, []);

		const storeWithoutHandle = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-4",
				store: storeWithoutHandle,
			},
		);
		assert.deepEqual(storeWithoutHandle.runs().find((candidate) => candidate.id === "ps-run-4")?.possibleStages, []);
	});

	test("possibleStages survives journal reopen", async () => {
		const backend = await JournalTestBackend.create();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-journal-1",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		const fresh = await backend.reopen();
		assert.deepEqual(fresh.getWorkflow("ps-journal-1")?.possibleStages, [...SCANNED]);
	});

	test("continuations inherit the source run's persisted scan", async () => {
		const backend = await createMemoryTestBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-src",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		const sourceSnapshot = store.runs().find((candidate) => candidate.id === "ps-run-src");
		assert.ok(sourceSnapshot !== undefined);
		await run(
			plain,
			{},
			{
				runId: "ps-run-cont",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				continuation: { source: sourceSnapshot },
			},
		);
		const continuation = store.runs().find((candidate) => candidate.id === "ps-run-cont");
		assert.deepEqual(continuation?.possibleStages, [...SCANNED]);
		assert.deepEqual(backend.getWorkflow("ps-run-cont")?.possibleStages, [...SCANNED]);
	});

	test("child runs do not carry the root scan", async () => {
		const backend = await createMemoryTestBackend();
		const store = createStore();
		const child = workflow({
			name: "possible-stages-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			run: async () => ({ value: "ok" }),
		});
		await run(
			child,
			{},
			{
				runId: "ps-child-1",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				parentRun: { runId: "ps-root-1", stageId: "boundary", rootRunId: "ps-root-1" },
				possibleStages: [...SCANNED],
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "ps-child-1");
		assert.equal(snapshot?.parentRunId, "ps-root-1");
		assert.equal(snapshot?.possibleStages, undefined);
	});

	test("corrupt persisted values are dropped, not fatal", async () => {
		assert.equal(coercePossibleStages("not-an-array"), undefined);
		assert.equal(coercePossibleStages({ stages: [] }), undefined);
		assert.equal(coercePossibleStages(["ok", 42]), undefined);
		assert.deepEqual(coercePossibleStages(["a-*", "b"]), ["a-*", "b"]);
	});
});

// ---------------------------------------------------------------------------
// D10 — discovery/reload lint: zero-stage definitions warn
// ---------------------------------------------------------------------------

describe("possible-stages discovery lint (D10)", () => {
	const TEST_DIR = makeTempDirectory("possible-stages-lint");
	afterAll(() => {
		removeTempDirectory(TEST_DIR);
	});

	function writeWorkflow(relativeName: string, body: string): void {
		const workflowsDir = join(TEST_DIR, ".atomic", "workflows");
		makeDirectorySync(workflowsDir, { recursive: true });
		writeTextSync(
			join(workflowsDir, relativeName),
			[
				`import { workflow } from "@bastani/atomic/workflows";`,
				`export default workflow({`,
				`  name: ${JSON.stringify(relativeName.replace(/\.ts$/, ""))},`,
				`  description: "",`,
				`  inputs: {},`,
				`  outputs: {},`,
				`  run: async (ctx) => {`,
				body,
				`  },`,
				`});`,
			].join("\n"),
			"utf-8",
		);
	}

	test("a definition yielding zero stages logs a ZERO_STAGES warning", async () => {
		writeWorkflow("lint-empty.ts", "\t\t\treturn {};");
		writeWorkflow("lint-busy.ts", '\t\t\tawait ctx.stage("real-stage");\n\t\t\treturn {};');
		writeWorkflow("lint-tool.ts", '\t\t\tawait ctx.tool("durable-check", {}, async () => "ok");\n\t\t\treturn {};');
		const result = await discoverWorkflows({
			cwd: TEST_DIR,
			homeDir: join(TEST_DIR, "home"),
			includeBundled: false,
		});
		const zeroStages = result.errors.filter((diagnostic) => diagnostic.code === "ZERO_STAGES");
		assert.equal(zeroStages.length, 1, JSON.stringify(result.errors, null, 1));
		assert.equal(zeroStages[0]?.level, "warn");
		assert.match(zeroStages[0]?.message ?? "", /lint-empty/);
		assert.equal(result.registry.has("lint-empty"), true, "the lint never blocks registration");
		assert.equal(result.registry.has("lint-busy"), true);
		assert.equal(result.registry.has("lint-tool"), true, "ctx.tool creates a tracked workflow node");
	});
});

// ---------------------------------------------------------------------------
// D10 — admission-time wiring: resolvePossibleStageEntry -> dispatch -> snapshot
// ---------------------------------------------------------------------------

describe("possible-stages admission wiring (D10)", () => {
	const WIRE_DIR = makeTempDirectory("possible-stages-wiring");
	afterAll(() => {
		removeTempDirectory(WIRE_DIR);
	});

	async function wireWorkflow(): Promise<void> {
		const workflowsDir = join(WIRE_DIR, ".atomic", "workflows");
		makeDirectorySync(workflowsDir, { recursive: true });
		writeTextSync(
			join(workflowsDir, "wired.ts"),
			[
				`import { workflow } from "@bastani/atomic/workflows";`,
				`export default workflow({`,
				`  name: "wired",`,
				`  description: "",`,
				`  inputs: {},`,
				`  outputs: {},`,
				`  run: async (ctx) => {`,
				`    await ctx.stage("alpha");`,
				`    await ctx.task(\`beta-\${n}\`, { prompt: "p" });`,
				`    return {};`,
				`  },`,
				`});`,
			].join("\n"),
			"utf-8",
		);
	}

	test("dispatch persists the admission-time scan onto the root snapshot", async () => {
		await wireWorkflow();
		setDurableBackend(await createMemoryTestBackend());
		const discovery = await discoverWorkflows({
			cwd: WIRE_DIR,
			homeDir: join(WIRE_DIR, "home"),
			includeBundled: false,
		});
		const source = discovery.sources.find((entry) => entry.id === "wired");
		assert.ok(source?.filePath !== undefined, "fixture workflow must carry its source path");
		const store = createStore();
		await dispatch(
			{ action: "run", workflow: "wired" },
			{
				registry: discovery.registry,
				store,
				resolvePossibleStageEntry: (normalizedName) => (normalizedName === "wired" ? source.filePath : undefined),
			},
		);
		let snapshot: RunSnapshot | undefined;
		for (let attempt = 0; attempt < 100 && snapshot === undefined; attempt += 1) {
			await sleep(20);
			snapshot = store.runs().find((candidate) => candidate.id !== undefined && candidate.name === "wired");
		}
		assert.ok(snapshot !== undefined, "wired run should be admitted");
		assert.deepEqual(snapshot.possibleStages, ["alpha", "beta-*"]);
	});

	test("every extension runtime construction site threads the scan resolver", async () => {
		// Regression (review round 4): runtimeForContext built a per-context
		// runtime without resolvePossibleStageEntry, so workflow-tool launches
		// persisted an empty set. All construction sites must thread it.
		const sourcePath = join(
			moduleDir(import.meta.url),
			"..",
			"..",
			"packages",
			"workflows",
			"src",
			"extension",
			"extension-runtime-state.ts",
		);
		const source = readFileSync(sourcePath, "utf-8");
		const sites = source.split("createExtensionRuntime({").slice(1);
		assert.ok(sites.length >= 3, `expected at least 3 construction sites, found ${sites.length}`);
		for (const [index, site] of sites.entries()) {
			assert.ok(
				site.includes("resolvePossibleStageEntry"),
				`createExtensionRuntime site #${index + 1} does not thread resolvePossibleStageEntry`,
			);
		}
	});

	test("dispatch surfaces scan warnings as one aggregate launch line", async () => {
		const workflowsDir = join(WIRE_DIR, ".atomic", "workflows");
		makeDirectorySync(workflowsDir, { recursive: true });
		writeTextSync(
			join(workflowsDir, "partial-scan.ts"),
			[
				`import { workflow } from "@bastani/atomic/workflows";`,
				`export default workflow({`,
				`  name: "partial-scan",`,
				`  description: "",`,
				`  inputs: {},`,
				`  outputs: {},`,
				`  run: async (ctx) => {`,
				`    await ctx.stage("good-stage");`,
				`    await ctx.parallel(warmIndices.map((index) => steps[index]));`,
				`    return {};`,
				`  },`,
				`});`,
			].join("\n"),
			"utf-8",
		);
		setDurableBackend(await createMemoryTestBackend());
		const discovery = await discoverWorkflows({
			cwd: WIRE_DIR,
			homeDir: join(WIRE_DIR, "home"),
			includeBundled: false,
		});
		const source = discovery.sources.find((entry) => entry.id === "partial-scan");
		assert.ok(source?.filePath !== undefined);
		const store = createStore();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await dispatch(
				{ action: "run", workflow: "partial-scan" },
				{
					registry: discovery.registry,
					store,
					resolvePossibleStageEntry: (normalizedName) =>
						normalizedName === "partial-scan" ? source.filePath : undefined,
				},
			);
			let snapshot: import("../../packages/workflows/src/shared/store-types.js").RunSnapshot | undefined;
			for (let attempt = 0; attempt < 100 && snapshot === undefined; attempt += 1) {
				await sleep(20);
				snapshot = store.runs().find((candidate) => candidate.name === "partial-scan");
			}
			assert.ok(snapshot !== undefined);
			const aggregate = warnSpy.mock.calls
				.map((call) => call.join(" "))
				.filter((text) => text.includes("possible-stages scan produced"));
			assert.equal(aggregate.length, 1, JSON.stringify(warnSpy.mock.calls));
			assert.match(aggregate[0] ?? "", /1 warning\(s\):/);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("a missing entry path never blocks launch and hydrates an empty set", async () => {
		setDurableBackend(await createMemoryTestBackend());
		const discovery = await discoverWorkflows({
			cwd: WIRE_DIR,
			homeDir: join(WIRE_DIR, "home"),
			includeBundled: false,
		});
		const store = createStore();
		await dispatch(
			{ action: "run", workflow: "wired" },
			{
				registry: discovery.registry,
				store,
				resolvePossibleStageEntry: () => join(WIRE_DIR, "does-not-exist.ts"),
			},
		);
		let snapshot: RunSnapshot | undefined;
		for (let attempt = 0; attempt < 100 && snapshot === undefined; attempt += 1) {
			await sleep(20);
			snapshot = store.runs().find((candidate) => candidate.name === "wired");
		}
		assert.ok(snapshot !== undefined, "the run must still be admitted");
		assert.deepEqual(snapshot.possibleStages, []);
	});
});
