import assert from "node:assert/strict";
import { SessionManager, type SessionStore } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { readStoredStageMessages } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { stageSessionStore } from "../../packages/workflows/src/shared/stage-session-store.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";

vi.mock("../../packages/workflows/src/shared/stage-session-store.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/workflows/src/shared/stage-session-store.js")>()),
	stageSessionStore: vi.fn(),
}));

/** A store holding one session with the user message "go"; `stageSessionStore` resolves to it, counting the resolutions. */
async function storeWithSession(): Promise<{ store: MemorySessionStore; sessionId: string; opens: () => number }> {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	await manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
	vi.mocked(stageSessionStore).mockResolvedValue(store);
	return { store, sessionId: manager.getSessionId(), opens: () => vi.mocked(stageSessionStore).mock.calls.length };
}

function contents(messages: readonly object[]): string[] {
	return messages.map((message) => (message as { readonly content: string }).content);
}

describe("reading a released stage's messages from the session store (#4309)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(stageSessionStore).mockReset();
	});

	test("a store the read opens, from the default storage or a sessionDir, is closed once per read (#4309)", async () => {
		for (const options of [{}, { sessionDir: "/sessions" }] satisfies StageOptions[]) {
			const { store, sessionId, opens } = await storeWithSession();
			// Counted only: one store stands for the store each read opens, so it stays readable.
			const close = vi.spyOn(store, "close").mockResolvedValue();
			for (let read = 0; read < 3; read++)
				assert.deepEqual(contents(await readStoredStageMessages(options, undefined, sessionId)), ["go"]);
			assert.equal(opens(), 3, JSON.stringify(options));
			assert.equal(close.mock.calls.length, 3, JSON.stringify(options));
			vi.mocked(stageSessionStore).mockReset();
		}
	});

	test("a caller's sessionStore or sessionManager is read and left open (#4309)", async () => {
		const { store, sessionId } = await storeWithSession();
		const close = vi.spyOn(store, "close");
		const manager = await SessionManager.open(store, sessionId, process.cwd());
		for (const options of [{ sessionStore: store }, { sessionManager: manager }] satisfies StageOptions[])
			assert.deepEqual(contents(await readStoredStageMessages(options, undefined, sessionId)), ["go"]);
		assert.equal(close.mock.calls.length, 0);
	});

	test("a read that fails still closes the store it opened and throws the read's failure (#4309)", async () => {
		const { store } = await storeWithSession();
		const close = vi.spyOn(store, "close");

		await assert.rejects(readStoredStageMessages({}, undefined, "missing-session"), SessionNotFoundError);
		assert.equal(close.mock.calls.length, 1);
	});

	test("a store that fails to close after a failed read leaves the read's failure thrown, with the close failure as its cleanupCause (#4309)", async () => {
		const { store } = await storeWithSession();
		const closeFailure = new Error("close failed");
		vi.spyOn(store, "close").mockRejectedValue(closeFailure);

		const error = await readStoredStageMessages({}, undefined, "missing-session").then(
			() => assert.fail("expected a rejection"),
			(reason: unknown) => reason,
		);
		assert.ok(error instanceof SessionNotFoundError);
		assert.equal((error as Error & { readonly cleanupCause?: unknown }).cleanupCause, closeFailure);
	});

	test("a failure that is not an Error is thrown as it is when the store also fails to close (#4309)", async () => {
		const store = {
			load: () => Promise.reject("refused"),
			close: () => Promise.reject(new Error("close failed")),
		} as unknown as SessionStore;
		vi.mocked(stageSessionStore).mockResolvedValue(store);

		await assert.rejects(readStoredStageMessages({}, undefined, "s-1"), (reason: unknown) => reason === "refused");
	});
});
