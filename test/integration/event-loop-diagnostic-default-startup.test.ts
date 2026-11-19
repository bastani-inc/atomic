import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage, readRecords } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const CLI = join(PACKAGE, "dist/cli.js");
const PRELOAD = join(ROOT, "test/fixtures/event-loop-sampler-forbidden.cjs");
/** Real host and engine startup, all builtin loaders, then the startup benchmark's normal disposal path. */
const REAL_STARTUP_BENCHMARK_TIMEOUT_MS = 60_000;
const BROKER_CLEANUP_TIMEOUT_MS = 10_000;
const REAL_STARTUP_TEST_TIMEOUT_MS = REAL_STARTUP_BENCHMARK_TIMEOUT_MS + BROKER_CLEANUP_TIMEOUT_MS;

async function startupWithUnavailableSampler(threshold: string | undefined, stacks?: string): Promise<void> {
	const root = makeTempDirectory("event-loop-diagnostic-default-");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "package");
	const project = join(root, "project");
	const imports = join(root, "inspector-imports.txt");
	const trace = join(root, "startup.jsonl");
	const preload = join(root, "sampler preload 空間 e\u0301.cjs");
	let program: PtyProgram | undefined;
	try {
		mkdirSync(project, { recursive: true });
		copyFileSync(PRELOAD, preload);
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, packageDir);
		vi.stubEnv("ATOMIC_EVENT_LOOP_BLOCK_MS", threshold);
		vi.stubEnv("ATOMIC_EVENT_LOOP_BLOCK_LOG", undefined);
		vi.stubEnv("ATOMIC_EVENT_LOOP_BLOCK_STACKS", stacks);
		program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, "--offline", "--no-session", "--approve"],
			cwd: project,
			env: {
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: packageDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_STARTUP_BENCHMARK: "1",
				ATOMIC_STARTUP_TRACE: trace,
				ATOMIC_TEST_INSPECTOR_IMPORTS: imports,
				...(threshold === undefined ? {} : { ATOMIC_EVENT_LOOP_BLOCK_MS: threshold }),
				...(stacks === undefined ? {} : { ATOMIC_EVENT_LOOP_BLOCK_STACKS: stacks }),
				NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll("\\", "/"))}`,
				TERM: "xterm-256color",
				CI: "0",
			},
			timeoutMs: REAL_STARTUP_BENCHMARK_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
		const exited = await program.exited;
		assert.equal(exited.timedOut, false, program.screen());
		assert.equal(exited.exitCode, 0, program.screen());
		const labels = readTextSync(trace, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { readonly label: string }).label);
		assert.ok(labels.includes("tui-start"), "the real interactive host started");
		assert.ok(labels.includes("engine-resources-ready"), "the real engine finished loading its resources");
		assert.equal(
			fileExistsSync(imports),
			threshold !== undefined && stacks?.trim() !== "0",
			"only a diagnostic with stack capture enabled imports its optional inspector sampler",
		);
		const log = join(agentDir, "event-loop-blocks.jsonl");
		assert.equal(fileExistsSync(log), threshold !== undefined);
		if (threshold !== undefined && stacks?.trim() === "0") {
			const records = readRecords(log);
			for (const role of ["host", "engine"] as const) {
				const start = records.find((record) => record.type === "start" && record.role === role);
				assert.ok(start?.type === "start");
				assert.equal(start.stacks, "disabled");
				assert.ok(records.some((record) => record.type === "delay" && record.role === role));
			}
		}
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

test(
	"default CLI startup neither loads nor waits for the optional stack sampler (#5544)",
	() => startupWithUnavailableSampler(undefined),
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"an unavailable opt-in stack sampler does not block CLI startup (#5544)",
	() => startupWithUnavailableSampler("150"),
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"delay-only diagnostics record startup without importing or awaiting stack capture (#5544)",
	() => startupWithUnavailableSampler("150", " 0 "),
	REAL_STARTUP_TEST_TIMEOUT_MS,
);
