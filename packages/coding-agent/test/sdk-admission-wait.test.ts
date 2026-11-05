import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions, ResourceAdmission, ResourceAdmissionRequest } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An admission that grants every permit on the next turn, or refuses every one with `refusal`. */
class RecordingAdmission implements ResourceAdmission {
	readonly requests: {
		readonly kind: string;
		readonly signal: AbortSignal | undefined;
		readonly request: ResourceAdmissionRequest | undefined;
	}[] = [];
	readonly waitsWhileAcquiring: (readonly boolean[])[] = [];
	private readonly waits: boolean[];
	private readonly refusal: Error | undefined;
	constructor(waits: boolean[], refusal?: Error) {
		this.waits = waits;
		this.refusal = refusal;
	}
	async acquire(kind: "session" | "process", signal?: AbortSignal, request?: ResourceAdmissionRequest) {
		this.requests.push({ kind, signal, request });
		this.waitsWhileAcquiring.push([...this.waits]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (this.refusal) throw this.refusal;
		return async () => undefined;
	}
}

async function start(options: Partial<CreateAgentSessionOptions>) {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-admission-wait-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
		...options,
	});
	cleanups.push(() => session.dispose());
	return session;
}

test("createAgentSession reports the wait for its session permit, around exactly that wait (#4319)", async () => {
	const waits: boolean[] = [];
	const admission = new RecordingAdmission(waits);
	const signal = new AbortController().signal;
	await start({
		resourceAdmission: admission,
		resourceAdmissionSignal: signal,
		onResourceAdmissionWait: (waiting) => waits.push(waiting),
	});
	assert.deepEqual(waits, [true, false]);
	assert.deepEqual(admission.waitsWhileAcquiring, [[true]], "the wait was reported before the permit was asked for");
	assert.deepEqual(admission.requests, [{ kind: "session", signal, request: undefined }]);
});

test("a delegated session asks its admission for a delegated permit (#4319)", async () => {
	const admission = new RecordingAdmission([]);
	await start({ resourceAdmission: admission, resourceAdmissionDelegated: true });
	assert.deepEqual(
		admission.requests.map(({ kind, request }) => ({ kind, request })),
		[{ kind: "session", request: { delegated: true } }],
	);
});

test("a refused permit ends the reported wait and fails the session with the admission's error (#4319)", async () => {
	const waits: boolean[] = [];
	const refusal = new Error("no capacity");
	await assert.rejects(
		start({
			resourceAdmission: new RecordingAdmission(waits, refusal),
			onResourceAdmissionWait: (waiting) => waits.push(waiting),
		}),
		(error: unknown) => {
			for (let current = error; current instanceof Error; current = current.cause)
				if (current === refusal) return true;
			return false;
		},
	);
	assert.deepEqual(waits, [true, false]);
});

test("a session that takes no permit reports no wait (#4319)", async () => {
	const waits: boolean[] = [];
	await start({ resourceAdmission: null, onResourceAdmissionWait: (waiting) => waits.push(waiting) });
	assert.deepEqual(waits, []);
});
