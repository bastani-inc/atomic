import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	defaultSessionDatabasePathSteps,
	resetStorageHomeCacheForTests,
	runStorageStepsSync,
	type StorageSteps,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-concurrent-starts-");
	resetStorageHomeCacheForTests();
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

const START_PROCESSES = 8;
const START_ROUNDS = 100;
const START_PROCESS_TIMEOUT_MS = 60_000;

test(
	"processes starting together on fresh agent directories all start on one storage home decision (#5429)",
	async () => {
		for (let round = 0; round < START_ROUNDS; round++)
			mkdirSync(join(root, "agents", String(round), "agent"), { recursive: true });
		const children = Array.from({ length: START_PROCESSES }, (_, index) => {
			const child = spawnProcess(
				[
					bunExecutable(),
					resolve("test/fixtures/agent-dir-storage-start-child.ts"),
					root,
					`start-${index}`,
					String(START_PROCESSES),
					String(START_ROUNDS),
				],
				{
					env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
					stderr: "pipe",
					timeout: START_PROCESS_TIMEOUT_MS,
				},
			);
			return { child, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text() };
		});
		try {
			const failures: string[] = [];
			for (const { child, stdout, stderr } of children) {
				assert.equal(await child.exited, 0, await stderr);
				for (const line of (await stdout).trim().split("\n")) {
					const outcome = JSON.parse(line) as { round: number; path?: string; error?: string };
					const expected = join(root, "agents", String(outcome.round), "agent", "workflows", "journal.sqlite");
					if (outcome.path !== expected) failures.push(line);
				}
			}
			assert.deepEqual(failures, []);
		} finally {
			for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map(({ child }) => child.exited));
		}
	},
	START_PROCESS_TIMEOUT_MS,
);

interface StorageRequestView {
	readonly op: string;
	readonly args: readonly unknown[];
}

/** What the injected file system answers instead of the real one: a value, or an error the operation throws. */
type Injected = { readonly value: unknown } | { readonly error: Error } | undefined;

/** Runs storage steps on the real file system, except for the operations `inject` answers itself. */
function runWithInjectedIo<T>(steps: StorageSteps<T>, inject: (request: StorageRequestView) => Injected): T {
	function* intercepted(): StorageSteps<T> {
		let next = steps.next();
		while (!next.done) {
			const request = next.value as StorageRequestView;
			const injected = inject(request);
			if (injected !== undefined) {
				next = "error" in injected ? steps.throw(injected.error) : steps.next(injected.value);
				continue;
			}
			try {
				next = steps.next(yield next.value);
			} catch (error) {
				next = steps.throw(error);
			}
		}
		return next.value;
	}
	return runStorageStepsSync(intercepted(), () => ({}));
}

function errno(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

function competingDecision(): string {
	return `${JSON.stringify({ home: ".", id: "competing-start", relativePaths: true, targets: [] })}\n`;
}

test("a start that finds no storage home decision adopts the one another start publishes right after (#5429)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	const decision = join(agent, ".atomic-storage-home");
	let published = false;
	const path = runWithInjectedIo(defaultSessionDatabasePathSteps(agent, {}), (request) => {
		if (published || request.args[0] !== decision) return undefined;
		// This start looks at the decision before it exists; another start publishes it immediately afterwards.
		published = true;
		const absent = request.op === "exists" ? { value: false } : { error: errno("ENOENT", decision) };
		writeFileSync(decision, competingDecision());
		return absent;
	});
	assert.equal(published, true);
	assert.equal(path, join(agent, "workflows", "journal.sqlite"));
	assert.equal(readFileSync(decision, "utf8"), competingDecision());
});

test("a storage home decision that is briefly busy or still empty is waited for, not reported unreadable (#5429)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	const decision = join(agent, ".atomic-storage-home");
	writeFileSync(decision, competingDecision());
	const transient: Injected[] = [{ error: errno("EBUSY", decision) }, { value: "" }];
	const path = runWithInjectedIo(defaultSessionDatabasePathSteps(agent, {}), (request) =>
		request.op === "readFile" && request.args[0] === decision ? transient.shift() : undefined,
	);
	assert.equal(transient.length, 0);
	assert.equal(path, join(agent, "workflows", "journal.sqlite"));
});

test("a staged storage home decision that cannot be removed yet does not fail the start that published it (#5429)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	const decision = join(agent, ".atomic-storage-home");
	const blockedRemovals: string[] = [];
	const path = runWithInjectedIo(defaultSessionDatabasePathSteps(agent, {}), (request) => {
		const target = request.args[0];
		if (request.op !== "remove" || typeof target !== "string" || !target.startsWith(`${decision}.`)) return undefined;
		blockedRemovals.push(target);
		return { error: errno("EBUSY", target) };
	});
	assert.equal(blockedRemovals.length, 1);
	assert.equal(path, join(agent, "workflows", "journal.sqlite"));
	assert.ok(readFileSync(decision, "utf8").length > 0);
});

test("a storage home decision that stays unreadable still fails the start after a bounded wait (#5429)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	const decision = join(agent, ".atomic-storage-home");
	writeFileSync(decision, competingDecision());
	let waitedMs = 0;
	assert.throws(
		() =>
			runWithInjectedIo(defaultSessionDatabasePathSteps(agent, {}), (request) => {
				if (request.op === "sleep") {
					waitedMs += request.args[0] as number;
					return { value: undefined };
				}
				return request.op === "readFile" && request.args[0] === decision
					? { error: errno("EBUSY", decision) }
					: undefined;
			}),
		/Cannot read storage home decision/,
	);
	assert.ok(waitedMs > 0 && waitedMs <= 1_000, `waited ${waitedMs} ms`);
});
