import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	INTERACTIVE_ENGINE_ENV_VARS,
	scrubInteractiveEngineEnv,
} from "../../packages/coding-agent/src/utils/interactive-engine-env.ts";
import { buildSubagentSpawnEnv } from "../../packages/subagents/src/runs/shared/spawn-env.ts";
import { moduleDir, sleep } from "../helpers/runtime.js";
import { DefaultMainDriver } from "./fixtures/default-main-driver.ts";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

const ENGINE_ENV: Record<string, string> = {
	ATOMIC_INTERACTIVE_ENGINE_CHILD: "1",
	ATOMIC_INTERACTIVE_ENGINE_HOST_PID: "4242",
	ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE: "/tmp/atomic-engine-guardian-4242",
	ATOMIC_INTERACTIVE_ENGINE_API_KEY: "sk-should-never-reach-a-child",
};

test("the engine env list covers exactly the four control variables", () => {
	assert.deepEqual(
		[...INTERACTIVE_ENGINE_ENV_VARS],
		[
			"ATOMIC_INTERACTIVE_ENGINE_CHILD",
			"ATOMIC_INTERACTIVE_ENGINE_HOST_PID",
			"ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE",
			"ATOMIC_INTERACTIVE_ENGINE_API_KEY",
		],
	);
});

test("scrubInteractiveEngineEnv removes every engine key, preserves the rest, and does not mutate its input", () => {
	const input: NodeJS.ProcessEnv = { ...ENGINE_ENV, PATH: "/usr/bin", ATOMIC_SESSION_ID: "abc", EMPTY: "" };
	const scrubbed = scrubInteractiveEngineEnv(input);
	for (const name of INTERACTIVE_ENGINE_ENV_VARS) {
		assert.equal(scrubbed[name], undefined, `${name} survived the scrub`);
		assert.ok(!(name in scrubbed), `${name} remained as an own key`);
	}
	assert.equal(scrubbed.PATH, "/usr/bin");
	assert.equal(scrubbed.ATOMIC_SESSION_ID, "abc");
	assert.equal(scrubbed.EMPTY, "", "an unrelated empty value must be preserved verbatim");
	assert.equal(input.ATOMIC_INTERACTIVE_ENGINE_CHILD, "1", "the caller's object was mutated");
});

test("subagent spawn env merges layers in order and scrubs after the last merge", () => {
	const env = buildSubagentSpawnEnv(
		{ ...ENGINE_ENV, PATH: "/usr/bin", LAYER: "base" },
		// A caller-supplied environment must not be able to reintroduce a key.
		{ LAYER: "caller", ATOMIC_INTERACTIVE_ENGINE_API_KEY: "sk-reintroduced" },
		{ ATOMIC_SUBAGENT_DEPTH: "1", ATOMIC_INTERACTIVE_ENGINE_CHILD: "1" },
	);
	for (const name of INTERACTIVE_ENGINE_ENV_VARS) assert.equal(env[name], undefined, `${name} survived the scrub`);
	assert.equal(env.LAYER, "caller", "later layers must win");
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.ATOMIC_SUBAGENT_DEPTH, "1");
});

test("subagent spawn env tolerates omitted layers", () => {
	const env = buildSubagentSpawnEnv({ ...ENGINE_ENV, KEEP: "yes" }, undefined);
	assert.equal(env.KEEP, "yes");
	assert.equal(env.ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE, undefined);
});

/**
 * The leak that broke issue #2062: the engine child inherited its own control
 * variables and passed them to every process it spawned, so bash tool commands,
 * subagents, MCP servers, and hooks all started in engine mode with the host's
 * guard PID and the `--api-key` credential in their environment.
 *
 * Deleting them from `process.env` cannot fix that under Bun 1.3.14: a child
 * spawned without an explicit `env` inherits the runtime's launch-time
 * environment. The engine is therefore launched with an environment that never
 * contained the values, and this probe uses exactly the omitted-env spawn shape
 * that would expose a stale launch map.
 */
serialTest(
	"a real engine child and its omitted-env subprocesses never see the control values",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-engine-env-"));
		const probeFile = join(temp, "engine-env.json");
		const apiKey = "sk-fixture-engine-api-key";
		const driver = new DefaultMainDriver(
			[
				"--no-session",
				"--no-extensions",
				"--extension",
				join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
				"--extension",
				join(moduleDir(import.meta.url), "fixtures", "engine-death-extension.ts"),
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
				"--approve",
				"--provider",
				"isolation-fixture",
				"--model",
				"blocking-model",
				"--api-key",
				apiKey,
			],
			{
				ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
				ATOMIC_ENGINE_ENV_PROBE_FILE: probeFile,
				ATOMIC_NONBLOCKING_TOOL: "1",
			},
		);
		try {
			const ready = await driver.waitFor(
				(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
			);
			const deadline = performance.now() + 10_000;
			// The fixture publishes with temp-file + rename, so the final path appears
			// only once the complete JSON is on disk.
			while (!existsSync(probeFile) && performance.now() < deadline) await sleep(20);
			assert.ok(existsSync(probeFile), "engine child never wrote the environment probe");
			const probe = JSON.parse(readFileSync(probeFile, "utf8")) as {
				pid: number;
				own: Record<string, string | undefined>;
				child: string;
				argv: string[];
			};
			assert.equal(probe.pid, ready.enginePid, "probe did not run inside the engine child");
			for (const name of INTERACTIVE_ENGINE_ENV_VARS) {
				assert.equal(probe.own[name], undefined, `${name} remained in the engine child's process.env`);
			}
			const child = JSON.parse(probe.child) as { env: Array<string | null>; bootstrapArg: boolean };
			assert.deepEqual(
				child.env,
				[null, null, null, null],
				"an omitted-env subprocess of the engine child inherited engine control values",
			);
			assert.equal(child.bootstrapArg, false, "a nested process must not be able to enter engine mode");
			// The credential must live only in the protected bootstrap file.
			assert.ok(
				!probe.argv.some((argument) => argument.includes(apiKey)),
				"the API key reached the engine child's argv",
			);
			assert.ok(
				!JSON.stringify(probe.own).includes(apiKey) && !probe.child.includes(apiKey),
				"the API key reached an environment",
			);
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	30_000,
);
