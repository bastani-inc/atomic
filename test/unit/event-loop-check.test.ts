import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { CallGraph } from "../../scripts/event-loop/call-graph.ts";
import { analyzeEventLoop, buildCallGraph, type EventLoopReport } from "../../scripts/event-loop/check-event-loop.ts";
import { DETACHED_CALLBACKS, type EventLoopPolicy, SINKS } from "../../scripts/event-loop/policy.ts";
import { openProject, REPO_ROOT } from "../../scripts/event-loop/program.ts";

const FIXTURE = join(REPO_ROOT, "test", "fixtures", "event-loop");
const COMPILER_START_TIMEOUT_MS = 60_000;

const fixturePolicy: EventLoopPolicy = {
	isAnalyzedFile: (path) => path.startsWith("src/"),
	processEntries: [{ file: "src/host.ts", name: "<module>" }],
	startupModules: ["src/host.ts"],
	otherModes: [],
	interfaceRoots: [
		{ file: "src/terminal.ts", type: "Component", members: ["render"], reason: "rendered every frame" },
	],
	interactiveRoots: [
		{
			file: "src/values.ts",
			name: "handleEngineRequest",
			reason: "the fixture's stand-in for a request handler reached through a path the graph does not follow",
		},
	],
	sinks: SINKS,
	detachedCallbacks: DETACHED_CALLBACKS,
	ownedElsewhere: [
		{ owner: "another change", paths: ["src/owned.ts"] },
		{ owner: "statements change", functions: [{ file: "src/statements.ts", name: "queryStatement" }] },
	],
	startupOnly: [
		{
			file: "src/host.ts",
			name: "reviewedStartupHelper",
			reason: "the fixture's stand-in for a reviewed helper that only runs before the first frame",
		},
	],
	exitOnly: [],
	synchronousLoaderHooks: [],
	durableRecords: [
		{
			file: "src/statements.ts",
			name: "recordDurably",
			reason: "the fixture's stand-in for a record whose write must land before the next step",
		},
	],
	guardedCalls: [
		{
			from: { file: "src/loader.ts", name: "Loader.constructor" },
			to: { file: "src/loader.ts", name: "readDefaultText" },
			reason: "the fixture's interactive caller always passes the text",
		},
	],
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
			"src/host.ts handleKey fs.realpathSync.native",
			"src/host.ts pollStatus child_process.execSync",
			"src/host.ts readLazily fs.readFileSync",
			"src/host.ts sleepWithAtomics Atomics.wait",
			"src/host.ts spin loop polling a clock",
			"src/session.ts SessionBase.constructor fs.statSync",
			"src/session.ts exportText fs.writeFileSync",
			"src/session.ts installSessionAccessors/title.get fs.readFileSync",
			"src/startup.ts afterImmediate fs.readdirSync",
			"src/startup.ts afterSettled fs.lstatSync",
			"src/startup.ts scheduleStartupWork/<call>() fs.statSync",
			"src/startup.ts warmCache fs.readFileSync",
			"src/statements.ts lockHeld fs.existsSync",
			"src/statements.ts readStartToken fs.readFileSync",
			"src/stores.ts FileStore.save fs.writeFileSync",
			"src/values.ts countEntries fs.readdirSync",
			"src/values.ts createCommandHandler/handleCommand fs.readFileSync",
			"src/values.ts existsByElement fs.existsSync",
			"src/values.ts handleEngineRequest fs.statSync",
			"src/values.ts listThroughShorthand fs.readdirSync",
			"src/values.ts listThroughShorthand fs.readdirSync",
			"src/values.ts nativeProcessQueries natives.tryAdvisoryLock",
			"src/values.ts nativeProcessQueries natives.trySharedAdvisoryLock",
			"src/values.ts openDatabase new DatabaseSync",
			"src/values.ts readThroughCast fs.readFileSync",
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

	test("defers findings in areas another change owns, or reached only through them, and keeps reviewed startup helpers out of the walk", () => {
		assert.deepEqual(
			report.deferred.map((v) => `${v.function} ${v.api} ${v.ownedBy}`),
			[
				"readHelperOnlyOwnedCodeCalls fs.readFileSync another change",
				"listOwnedArea fs.readdirSync another change",
				"queryStatement DatabaseSync.close statements change",
				"queryStatement new DatabaseSync statements change",
			],
		);
		assert.equal(
			report.violations.some((v) => v.function === "reviewedStartupHelper"),
			false,
		);
	});

	test("rejects a backtracking regular expression on an interactive path, not one that only runs at startup", () => {
		assert.deepEqual(
			report.regexFindings
				.filter((finding) => finding.file === "src/host.ts")
				.map((finding) => `${finding.function} /${finding.pattern}/ ${finding.kind}`),
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
		assert.deepEqual(
			reviewed.regexFindings.filter((finding) => finding.file === "src/host.ts"),
			[],
		);
		assert.deepEqual(reviewed.policyErrors, []);
	});

	test("does not follow a reviewed guarded call, and reports the fallback without the review", () => {
		assert.equal(
			report.violations.some((v) => v.function === "readDefaultText"),
			false,
		);
		const unreviewed = analyzeEventLoop(graph, { ...fixturePolicy, guardedCalls: [] });
		assert.ok(unreviewed.violations.some((v) => v.function === "readDefaultText" && v.api === "fs.readFileSync"));
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

	test("follows methods and accessors installed on a class's prototype, and its constructor behind a cast, to the calls made through its instances", () => {
		const session = report.violations
			.filter((v) => v.file === "src/session.ts")
			.map((v) => `${v.function} ${v.api}`)
			.sort();
		assert.deepEqual(session, [
			"SessionBase.constructor fs.statSync",
			"exportText fs.writeFileSync",
			"installSessionAccessors/title.get fs.readFileSync",
		]);
	});

	test("checks module-scope and static regular expressions where a reachable function uses them", () => {
		assert.deepEqual(
			report.regexFindings
				.filter((finding) => finding.file === "src/patterns.ts")
				.map((finding) => `${finding.function} /${finding.pattern}/ ${finding.kind}`)
				.sort(),
			["matchesModulePatterns /^(\\w+\\s?)+$/ exponential", "matchesModulePatterns /^(a|a)*$/ exponential"],
		);
	});

	test("reports a regular expression the analyzer cannot read instead of skipping it", () => {
		assert.deepEqual(
			report.analysisErrors.map((error) => error.replace(/:\d+ /, " ")),
			["src/patterns.ts compilesInvalidPattern /[/: Invalid regular expression: /[/: Unterminated character class"],
		);
	});

	test("reports blocking APIs passed as values or shorthand properties, returned by a factory, behind a cast require and through element access", () => {
		assert.deepEqual(
			report.violations
				.filter((v) => v.file === "src/values.ts")
				.map((v) => `${v.function} ${v.api}`)
				.sort(),
			[
				"countEntries fs.readdirSync",
				"createCommandHandler/handleCommand fs.readFileSync",
				"existsByElement fs.existsSync",
				"handleEngineRequest fs.statSync",
				"listThroughShorthand fs.readdirSync",
				"listThroughShorthand fs.readdirSync",
				"nativeProcessQueries natives.tryAdvisoryLock",
				"nativeProcessQueries natives.trySharedAdvisoryLock",
				"openDatabase new DatabaseSync",
				"readThroughCast fs.readFileSync",
			],
		);
	});

	test("treats setImmediate callbacks, promise continuations, detached async work and an async IIFE started at startup as interactive", () => {
		assert.deepEqual(
			report.violations
				.filter((v) => v.file === "src/startup.ts")
				.map((v) => `${v.function} ${v.api}`)
				.sort(),
			[
				"afterImmediate fs.readdirSync",
				"afterSettled fs.lstatSync",
				"scheduleStartupWork/<call>() fs.statSync",
				"warmCache fs.readFileSync",
			],
		);
	});

	test("defers only the calls of the functions an owned entry names, not a lock they take on the way", () => {
		assert.ok(report.violations.some((v) => v.function === "lockHeld" && v.api === "fs.existsSync"));
		assert.equal(
			report.violations.some((v) => v.function === "queryStatement"),
			false,
		);
	});

	test("a durable record exempts its own write, not the reads it makes first", () => {
		assert.ok(report.violations.some((v) => v.function === "readStartToken" && v.api === "fs.readFileSync"));
		assert.equal(
			report.violations.some((v) => v.function === "recordDurably"),
			false,
		);
	});

	test("fails the policy on a stale entry in every reviewed list", () => {
		const stale = analyzeEventLoop(graph, {
			...fixturePolicy,
			otherModes: [
				{
					file: "src/host.ts",
					name: "flushOnExit",
					reason: "the fixture's stand-in for a function no mode reaches",
				},
			],
			ownedElsewhere: [
				...fixturePolicy.ownedElsewhere,
				{ owner: "a landed change", paths: ["src/loader.ts"] },
				{ owner: "a landed statement", functions: [{ file: "src/stores.ts", name: "MemoryStore.save" }] },
			],
			durableRecords: [
				...fixturePolicy.durableRecords,
				{
					file: "src/host.ts",
					name: "loadConfigBeforeFirstFrame",
					reason: "the fixture's stand-in for a record no interactive path writes",
				},
			],
			guardedCalls: [
				...fixturePolicy.guardedCalls,
				{
					from: { file: "src/host.ts", name: "startHost" },
					to: { file: "src/host.ts", name: "loadConfigBeforeFirstFrame" },
					reason: "the fixture's stand-in for a guarded call no interactive path makes",
				},
			],
			interactiveRoots: [
				...fixturePolicy.interactiveRoots,
				{
					file: "src/values.ts",
					name: "handleRemovedRequest",
					reason: "the fixture's stand-in for a request handler that no longer exists",
				},
			],
		});
		assert.deepEqual(stale.policyErrors.map((error) => error.replace(/:\d+ /, " ")).sort(), [
			"DURABLE_RECORDS: src/host.ts loadConfigBeforeFirstFrame is no longer reached from an interactive root",
			"GUARDED_CALLS: src/host.ts startHost is no longer reached from an interactive root",
			"INTERACTIVE_ROOTS: no function src/values.ts#handleRemovedRequest",
			"OTHER_MODES: src/host.ts flushOnExit is no longer reached from the process entries",
			"OWNED_ELSEWHERE: nothing left for a landed change in src/loader.ts; remove the entry",
			"OWNED_ELSEWHERE: nothing left for a landed statement in src/stores.ts#MemoryStore.save; remove the entry",
		]);
	});
});

describe("the interactive host's analysis program", () => {
	test(
		"contains every declaration file a sink names, so the callbacks registered through it are followed",
		() => {
			// Each sink is matched by the file that declares it. If that file drops out of the program, as lib.dom.d.ts
			// does when nothing adds the DOM library, every callback registered through the sink is silently skipped.
			const { project, close } = openProject();
			try {
				const files = project.program.getSourceFileNames().map((name) => name.replaceAll("\\", "/"));
				const declarationFiles = SINKS.map((spec) => spec.file).filter(
					(file) => file.endsWith(".d.ts") && file !== ".d.ts",
				);
				assert.deepEqual(
					declarationFiles.filter((file) => !files.some((name) => name.endsWith(file))),
					[],
				);
			} finally {
				close();
			}
		},
		COMPILER_START_TIMEOUT_MS,
	);
});
