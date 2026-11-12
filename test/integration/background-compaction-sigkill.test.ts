import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { BACKGROUND_COMPACTION_RESULT_TYPE } from "../../packages/coding-agent/src/core/compaction/background-compaction.js";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createHarnessWithExtensions } from "../../packages/coding-agent/test/test-harness.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { fileExists, makeTempDirectory, moduleDir, readText, sleep, spawnProcess } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/background-compaction-sigkill.ts");
/**
 * A TypeScript child process compiles the session runtime through jiti before it reaches the marker. That is CPU the
 * integration shard shares with the other files running in parallel: on a loaded linux-x64 runner the child needed more
 * than 60 s (#4641, #4655), so this is headroom for a loaded host, not a measured start-up.
 */
const CHILD_STARTUP_AND_MARKER_TIMEOUT_MS = 180_000;
const SIGKILL_RESTART_TIMEOUT_MS = 2 * CHILD_STARTUP_AND_MARKER_TIMEOUT_MS;

async function runUntilKilled(mode: "planning" | "ready", directory: string): Promise<string> {
	const child = spawnProcess([process.execPath, "--import", "jiti/register", FIXTURE, mode, directory], {
		cwd: ROOT,
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: join(directory, "agent") },
	});
	const stderr = new Response(child.stderr).text();
	try {
		const marker = join(directory, mode);
		const deadline = Date.now() + CHILD_STARTUP_AND_MARKER_TIMEOUT_MS;
		while (!(await fileExists(marker))) {
			assert.equal(child.exitCode, null, `child exited before ${mode}: ${await stderr}`);
			assert.ok(Date.now() < deadline, `child never reached ${mode}`);
			await sleep(20);
		}
		child.kill("SIGKILL");
		await child.exited;
		assert.equal(child.signalCode, "SIGKILL");
		return await readText(marker);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
		await stderr;
	}
}

async function resume(sessionFile: string, directory: string, resumedUsage: number) {
	const sessionManager = await SessionManager.open(sessionFile, join(directory, "sessions"));
	let plannerCalls = 0;
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: { compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 } },
		sessionManager,
		responses: [{ text: "resumed", usage: { input: resumedUsage, output: 10 } }],
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => {
					plannerCalls += 1;
					return { compactedText: "[User]: retained after restart" };
				});
			},
		],
	});
	await harness.session.bindExtensions({});
	harness.agent.convertToLlm = convertToLlm;
	harness.session.refreshContext();
	return { harness, sessionManager, plannerCalls: () => plannerCalls };
}

function countByType(manager: SessionManager) {
	const entries = manager.getEntries();
	return {
		boundaries: entries.filter((entry) => entry.type === "compaction").length,
		results: entries.filter(
			(entry) => entry.type === "custom" && entry.customType === BACKGROUND_COMPACTION_RESULT_TYPE,
		).length,
	};
}

test(
	"SIGKILL mid-compaction leaves no partial boundary and the next start compacts cleanly (#4330)",
	async () => {
		const directory = makeTempDirectory("background-compaction-sigkill-");
		try {
			const sessionFile = await runUntilKilled("planning", directory);
			const { harness, sessionManager, plannerCalls } = await resume(sessionFile, directory, 770);
			try {
				assert.deepEqual(countByType(sessionManager), { boundaries: 0, results: 0 });
				assert.equal(harness.session.compaction.state, "idle");
				await harness.session.prompt("resume");
				assert.equal(plannerCalls(), 1, "the next start schedules a new background task");
				await harness.session.awaitBackgroundCompaction();
				await harness.session.prompt("continue");
				assert.deepEqual(countByType(sessionManager), { boundaries: 1, results: 1 });
			} finally {
				harness.cleanup();
			}
		} finally {
			await removeTempRootReleasingBroker(directory);
		}
	},
	SIGKILL_RESTART_TIMEOUT_MS,
);

test(
	"a result stored before SIGKILL is committed exactly once after restart, without planning again (#4330)",
	async () => {
		const directory = makeTempDirectory("background-compaction-sigkill-ready-");
		try {
			const sessionFile = await runUntilKilled("ready", directory);
			const { harness, sessionManager, plannerCalls } = await resume(sessionFile, directory, 300);
			try {
				assert.deepEqual(countByType(sessionManager), { boundaries: 0, results: 1 });
				assert.equal(harness.session.compaction.state, "ready");
				await harness.session.prompt("resume");
				await harness.session.prompt("again");
				assert.equal(plannerCalls(), 0);
				assert.deepEqual(countByType(sessionManager), { boundaries: 1, results: 1 });
				const [boundary] = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
				assert.equal(boundary.type === "compaction" && boundary.summary, "[User]: retained");
			} finally {
				harness.cleanup();
			}
		} finally {
			await removeTempRootReleasingBroker(directory);
		}
	},
	SIGKILL_RESTART_TIMEOUT_MS,
);
