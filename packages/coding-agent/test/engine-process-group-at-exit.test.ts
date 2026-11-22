import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const RESOLVE_TS_SOURCES_URL = `data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`;
const QUIT_INTENT_URL = pathToFileURL(
	fileURLToPath(new URL("../src/modes/interactive-engine/engine-quit-intent.ts", import.meta.url)),
).href;
/** A child Node process loads the module from source: structural, not a slow test. */
const CHILD_PROCESS_TEST_TIMEOUT_MS = 60_000;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;

const directories: string[] = [];
/** Processes this test started directly, ended through their handles. */
const children: ChildProcess[] = [];
/** Processes started by those, recorded while they certainly ran and only signalled while they still do. */
const recorded: RecordedProcess[] = [];

afterEach(async () => {
	for (const entry of recorded.splice(0)) await signalRecordedProcess(entry);
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	return predicate();
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/**
 * An engine that starts a process in its own group and records it, then waits on its input: once released, it writes a
 * marker from an exit handler and exits as an engine signalled by its host does.
 */
const ENGINE_SCRIPT = `
	import { spawn } from "node:child_process";
	import { renameSync, writeFileSync } from "node:fs";
	const [quitIntentUrl, memberFile, markerFile] = process.argv.slice(1);
	const { endProcessGroupAtExit } = await import(quitIntentUrl);
	const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	member.unref();
	writeFileSync(memberFile + ".tmp", String(member.pid));
	renameSync(memberFile + ".tmp", memberFile);
	process.stdin.once("data", () => {
		process.on("exit", () => writeFileSync(markerFile, "records written"));
		endProcessGroupAtExit();
		process.exit(0);
	});
`;

const LEADER_SCRIPT = `
	import { spawn } from "node:child_process";
	import { renameSync, writeFileSync } from "node:fs";
	const [resolveHookUrl, engineScript, quitIntentUrl, memberFile, markerFile, statusFile] = process.argv.slice(1);
	const args = ["--import", resolveHookUrl, "--input-type=module", "--eval", engineScript, "--", quitIntentUrl, memberFile, markerFile];
	const engine = spawn(process.execPath, args, { stdio: ["inherit", "ignore", "ignore"] });
	engine.once("exit", (code, signal) => {
		writeFileSync(statusFile + ".tmp", JSON.stringify({ code, signal }));
		renameSync(statusFile + ".tmp", statusFile);
	});
	setInterval(() => {}, 1000);
`;

/** The member the engine started, recorded while it certainly runs: the engine holds until it is released. */
async function recordMember(memberFile: string): Promise<RecordedProcess> {
	assert.equal(await waitUntil(() => existsSync(memberFile), CHILD_PROCESS_TEST_TIMEOUT_MS / 2), true);
	const member = await recordProcess(Number(readFileSync(memberFile, "utf8")));
	recorded.push(member);
	return member;
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
			const engine = spawn(
				process.execPath,
				[
					"--import",
					RESOLVE_TS_SOURCES_URL,
					"--input-type=module",
					"--eval",
					ENGINE_SCRIPT,
					"--",
					QUIT_INTENT_URL,
					memberFile,
					markerFile,
				],
				{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
			);
			children.push(engine);
			const exit = exited(engine);
			const member = await recordMember(memberFile);

			engine.stdin?.end("release\n");

			assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
			assert.equal(existsSync(markerFile), true, "an exit handler registered before it ran first");
			assert.equal(await waitUntilGone(member, GONE_MS), true, "the process it started outlived it");
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
			// The group's leader starts the engine inside its group, passes on its input, reports how the engine ended,
			// and goes on running.
			const leader = spawn(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					LEADER_SCRIPT,
					"--",
					RESOLVE_TS_SOURCES_URL,
					ENGINE_SCRIPT,
					QUIT_INTENT_URL,
					memberFile,
					markerFile,
					statusFile,
				],
				{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
			);
			children.push(leader);
			const member = await recordMember(memberFile);

			leader.stdin?.end("release\n");

			assert.equal(await waitUntil(() => existsSync(statusFile), CHILD_PROCESS_TEST_TIMEOUT_MS / 2), true);
			assert.deepEqual(JSON.parse(readFileSync(statusFile, "utf8")), { code: 0, signal: null });
			assert.equal(existsSync(markerFile), true);
			assert.equal(
				leader.exitCode === null && leader.signalCode === null,
				true,
				"the engine ended its leader's group",
			);
			assert.equal(await stillRuns(member), true, "the engine ended a process of a group it does not lead");
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
