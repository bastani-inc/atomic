import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { CallGraph } from "../../scripts/event-loop/call-graph.ts";
import { analyzeEventLoop, buildCallGraph, type EventLoopReport } from "../../scripts/event-loop/check-event-loop.ts";
import { DETACHED_CALLBACKS, type EventLoopPolicy, SINKS } from "../../scripts/event-loop/policy.ts";
import { REPO_ROOT } from "../../scripts/event-loop/program.ts";

const FIXTURE = join(REPO_ROOT, "test", "fixtures", "event-loop");
/** Starting the TypeScript 7 compiler process and loading the fixture program. */
const COMPILER_START_TIMEOUT_MS = 60_000;

const fixturePolicy: EventLoopPolicy = {
	isAnalyzedFile: (path) => path.startsWith("src/"),
	processEntries: [{ file: "src/host.ts", name: "<module>" }],
	startupModules: ["src/host.ts"],
	otherModes: [],
	interfaceRoots: [
		{ file: "src/terminal.ts", type: "Component", members: ["render"], reason: "rendered every frame" },
	],
	sinks: SINKS,
	detachedCallbacks: DETACHED_CALLBACKS,
	ownedElsewhere: [{ owner: "another change", paths: ["src/owned.ts"] }],
	startupOnly: [
		{
			file: "src/host.ts",
			name: "reviewedStartupHelper",
			reason: "the fixture's stand-in for a reviewed helper that only runs before the first frame",
		},
	],
	exitOnly: [],
	reviewedRegexes: [],
};

let graph: CallGraph;
let close: () => void;
let report: EventLoopReport;

const found = (r: EventLoopReport) => r.violations.map((v) => `${v.file} ${v.function} ${v.api}`).sort();

describe("event-loop check", () => {
	beforeAll(() => {
		({ graph, close } = buildCallGraph(fixturePolicy, join(FIXTURE, "tsconfig.json"), FIXTURE));
		report = analyzeEventLoop(graph, fixturePolicy);
	}, COMPILER_START_TIMEOUT_MS);

	afterAll(() => close?.());

	test("reports each blocking call reachable from an input handler, a timer or a rendered component", () => {
		assert.deepEqual(found(report), [
			"src/components.ts GitBranchLine.render fs.existsSync",
			"src/components.ts sizeBanner.render fs.statSync",
			"src/host.ts handleKey crypto.pbkdf2Sync",
			"src/host.ts handleKey fs.appendFileSync",
			"src/host.ts pollStatus child_process.execSync",
			"src/host.ts readLazily fs.readFileSync",
			"src/host.ts sleepWithAtomics Atomics.wait",
			"src/host.ts spin loop polling a clock",
			"src/stores.ts FileStore.save fs.writeFileSync",
		]);
		assert.deepEqual(report.policyErrors, []);
	});

	test("does not report startup code, exit handlers, or classes that are never rendered", () => {
		const functions = new Set(report.violations.map((v) => v.function));
		for (const quiet of [
			"loadConfigBeforeFirstFrame",
			"startHost",
			"flushOnExit",
			"UnusedLine.render",
			"MemoryStore.save",
		]) {
			assert.equal(functions.has(quiet), false, quiet);
		}
		assert.equal(
			report.violations.some((v) => v.api === "fs.writeFileSync" && v.file === "src/host.ts"),
			false,
		);
	});

	test("explains each finding with the path from its entry point", () => {
		const timer = report.violations.find((v) => v.function === "pollStatus");
		assert.ok(timer);
		assert.match(timer.path[0], /pollStatus \[registered with setInterval by startHost at src\/host\.ts:\d+\]/);
		const key = report.violations.find((v) => v.api === "fs.appendFileSync");
		assert.ok(key);
		assert.match(key.path[0], /process\.stdin\.on\("data"\).*registered with/);
	});

	test("defers findings in areas another change owns, and keeps reviewed startup helpers out of the walk", () => {
		assert.deepEqual(
			report.deferred.map((v) => `${v.function} ${v.api} ${v.ownedBy}`),
			["listOwnedArea fs.readdirSync another change"],
		);
		assert.equal(
			report.violations.some((v) => v.function === "reviewedStartupHelper"),
			false,
		);
	});

	test("rejects a backtracking regular expression on an interactive path, not one that only runs at startup", () => {
		assert.deepEqual(
			report.regexFindings.map((finding) => `${finding.function} /${finding.pattern}/ ${finding.kind}`),
			["handleKey /^(\\w+\\s?)*$/ exponential"],
		);
		const reviewed = analyzeEventLoop(graph, {
			...fixturePolicy,
			reviewedRegexes: [
				{
					file: "src/host.ts",
					pattern: "^(\\w+\\s?)*$",
					reason: "the fixture's stand-in for a regex that only sees short input",
				},
			],
		});
		assert.deepEqual(reviewed.regexFindings, []);
		assert.deepEqual(reviewed.policyErrors, []);
	});

	test("fails the policy when a reviewed entry no longer names a reachable function", () => {
		const stale = analyzeEventLoop(graph, {
			...fixturePolicy,
			startupOnly: [
				...fixturePolicy.startupOnly,
				{
					file: "src/host.ts",
					name: "loadConfigBeforeFirstFrame",
					reason: "never reached from an interactive root",
				},
				{ file: "src/host.ts", name: "removedFunction", reason: "the function this entry named was deleted" },
			],
		});
		assert.deepEqual(
			stale.policyErrors.map((error) => error.replace(/:\d+ /, " ")),
			[
				"STARTUP_ONLY: no function src/host.ts#removedFunction",
				"STARTUP_ONLY: src/host.ts loadConfigBeforeFirstFrame is no longer reached from an interactive root",
			],
		);
	});
});
