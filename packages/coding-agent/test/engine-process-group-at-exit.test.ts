import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const QUIT_INTENT_URL = pathToFileURL(
	fileURLToPath(new URL("../src/modes/interactive-engine/engine-quit-intent.ts", import.meta.url)),
).href;
/** A child Node process loads the module from source: structural, not a slow test. */
const CHILD_PROCESS_TEST_TIMEOUT_MS = 60_000;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;

const directories: string[] = [];
const leftovers: number[] = [];

afterEach(() => {
	for (const pid of leftovers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	return predicate();
}

function node(script: string, options: { detached: boolean }): ChildProcess {
	return spawn(
		process.execPath,
		[
			"--import",
			`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
			"--input-type=module",
			"--eval",
			script,
		],
		{ detached: options.detached, stdio: "ignore" },
	);
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** A program that starts a process in its own group, records it, writes a marker from an exit handler, then exits. */
function engineScript(memberFile: string, markerFile: string): string {
	return `
		import { spawn } from "node:child_process";
		import { writeFileSync } from "node:fs";
		import { endProcessGroupAtExit } from ${JSON.stringify(QUIT_INTENT_URL)};
		const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		member.unref();
		writeFileSync(${JSON.stringify(memberFile)}, String(member.pid));
		process.on("exit", () => writeFileSync(${JSON.stringify(markerFile)}, "records written"));
		endProcessGroupAtExit();
		process.exit(0);
	`;
}

// Windows has no process groups: the function does nothing there.
describe.skipIf(process.platform === "win32")("an engine ending its process group as it exits (#6104)", () => {
	test(
		"an engine that leads its own group ends it, the process it started included, after its exit handlers",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "atomic-engine-group-"));
			directories.push(directory);
			const memberFile = join(directory, "member");
			const markerFile = join(directory, "marker");
			// Started as the host starts its engine: in a group of its own.
			const engine = node(engineScript(memberFile, markerFile), { detached: true });

			const exit = await exited(engine);
			const member = Number(readFileSync(memberFile, "utf8"));
			leftovers.push(member);

			assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
			assert.equal(existsSync(markerFile), true, "an exit handler registered before it ran first");
			assert.equal(await waitUntil(() => !running(member), GONE_MS), true, "the process it started outlived it");
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"an engine started inside another process's group leaves that group alone",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "atomic-engine-group-"));
			directories.push(directory);
			const memberFile = join(directory, "member");
			const markerFile = join(directory, "marker");
			const statusFile = join(directory, "status");
			// The group's leader starts the engine inside its group, reports how it ended, and goes on running.
			const leader = node(
				`
				import { spawn } from "node:child_process";
				import { writeFileSync } from "node:fs";
				const args = ["--import", ${JSON.stringify(`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`)}, "--input-type=module", "--eval", ${JSON.stringify(engineScript(memberFile, markerFile))}];
				const engine = spawn(process.execPath, args, { stdio: "ignore" });
				engine.once("exit", (code, signal) => writeFileSync(${JSON.stringify(statusFile)}, JSON.stringify({ code, signal })));
				setInterval(() => {}, 1000);
				`,
				{ detached: true },
			);
			const leaderPid = leader.pid;
			assert.ok(leaderPid !== undefined);
			leftovers.push(leaderPid);

			assert.equal(await waitUntil(() => existsSync(statusFile), CHILD_PROCESS_TEST_TIMEOUT_MS / 2), true);
			const member = Number(readFileSync(memberFile, "utf8"));
			leftovers.push(member);

			assert.deepEqual(JSON.parse(readFileSync(statusFile, "utf8")), { code: 0, signal: null });
			assert.equal(running(leaderPid), true, "the engine ended the group it was started in");
			assert.equal(running(member), true, "the engine ended a process of a group it does not lead");
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
