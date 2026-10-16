import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent, RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const UNRESPONSIVE_REPLACEMENT_GUARD_MS = 1_000;

class InspectableAgentSessionRuntime extends AgentSessionRuntime {
	settleForTest(): Promise<void> {
		return this.settleActiveResponseBeforeTeardown();
	}
}

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
	};
}

function createState(): RpcSessionState {
	return {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "engine-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
}

function createUnresponsiveEngineClient() {
	let eventListener: ((event: RpcEvent) => void) | undefined;
	let abortCalls = 0;
	let releaseAbort = () => {};
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			eventListener = listener;
			return () => {
				if (eventListener === listener) eventListener = undefined;
			};
		},
		onGenerationEnded: () => () => {},
		switchSession: async (_sessionPath: string) => ({ cancelled: false }),
		getState: async () => createState(),
		requestInternal: async <T>(command: { type: string }): Promise<T> => {
			if (command.type === "get_available_models") {
				return { models: [], scopedModels: [] } as T;
			}
			return undefined as T;
		},
		getCommands: async () => [],
		abort: async () => {
			abortCalls += 1;
			await new Promise<void>((resolve) => {
				releaseAbort = resolve;
			});
		},
		stop: async () => {},
	};
	return {
		client,
		emit(event: RpcEvent): void {
			eventListener?.(event);
		},
		get abortCalls(): number {
			return abortCalls;
		},
		releaseAbort(): void {
			releaseAbort();
		},
	};
}

async function completesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("AgentSessionRuntime teardown settling", () => {
	test("does not abort an idle session before replacement", async () => {
		const harness = await createHarness();
		try {
			const runtime = new InspectableAgentSessionRuntime(
				harness.session,
				servicesFor(harness) as never,
				async () => {
					throw new Error("unused runtime factory");
				},
			);
			const abort = vi.spyOn(harness.session, "abort").mockResolvedValue();
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(false);

			await runtime.settleForTest();

			expect(abort).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	test("aborts a streaming session before replacement", async () => {
		const harness = await createHarness();
		try {
			const runtime = new InspectableAgentSessionRuntime(
				harness.session,
				servicesFor(harness) as never,
				async () => {
					throw new Error("unused runtime factory");
				},
			);
			const abort = vi.spyOn(harness.session, "abort").mockResolvedValue();
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

			await runtime.settleForTest();

			expect(abort).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	});
});

describe("isolated interactive engine session replacement", () => {
	test("replaces a session even when the engine cannot answer abort", async () => {
		const first = await createHarness();
		const second = await createHarness();
		const targetManager = await SessionManager.create(first.session.sessionManager.getSessionStore(), second.tempDir);

		const targetSessionId = targetManager.getSessionId();

		const probe = createUnresponsiveEngineClient();
		const localRuntime = new AgentSessionRuntime(first.session, servicesFor(first) as never, async () => {
			throw new Error("unused local runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => ({ session: second.session, services: servicesFor(second), diagnostics: [] }) as never,
			probe.client as never,
		);
		probe.emit({ type: "agent_start" });
		expect(runtime.session.isStreaming).toBe(true);

		const replacement = runtime.switchSession(targetSessionId);
		try {
			expect(await completesWithin(replacement, UNRESPONSIVE_REPLACEMENT_GUARD_MS)).toBe(true);
			expect(probe.abortCalls).toBe(0);
			expect(runtime.session).toBe(second.session);
		} finally {
			probe.releaseAbort();
			await replacement.catch(() => {});
			first.cleanup();
			second.cleanup();
		}
	});
});

// #2873: trust resolution belongs to the child; the host mirrors the decision without re-prompting.
test("isolated host applies authoritative trust once per change", async () => {
	const harness = await createHarness();
	try {
		harness.settingsManager.setProjectTrusted(false);
		const probe = createUnresponsiveEngineClient();
		let trusted = false;
		probe.client.getState = async () => ({ ...createState(), projectTrusted: trusted });
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		const reloadSettings = vi.spyOn(harness.settingsManager, "reload");
		const reloadResources = vi.spyOn(harness.session.resourceLoader, "reload").mockResolvedValue();
		await runtime.initializeFromEngine();
		expect(harness.settingsManager.isProjectTrusted()).toBe(false);
		expect(reloadSettings).not.toHaveBeenCalled();
		trusted = true;
		await runtime.initializeFromEngine();
		expect(harness.settingsManager.isProjectTrusted()).toBe(true);
		expect(reloadSettings).toHaveBeenCalledTimes(1);
		expect(reloadResources).toHaveBeenCalledTimes(1);
		await runtime.initializeFromEngine();
		expect(reloadSettings).toHaveBeenCalledTimes(1);
		trusted = false;
		await runtime.initializeFromEngine();
		expect(harness.settingsManager.isProjectTrusted()).toBe(false);
		expect(reloadSettings).toHaveBeenCalledTimes(2);
	} finally {
		harness.cleanup();
	}
});

test("isolated host mirrors the child's startup trust decision before startup trust settles", async () => {
	const harness = await createHarness();
	try {
		harness.settingsManager.setProjectTrusted(false);
		const probe = createUnresponsiveEngineClient();
		let trusted = false;
		let decide!: () => void;
		const decision = new Promise<void>((resolve) => {
			decide = resolve;
		});
		probe.client.getState = async () => ({ ...createState(), projectTrusted: trusted });
		Object.assign(probe.client, { waitForInteractiveEngineProjectTrust: () => decision });
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		vi.spyOn(harness.session.resourceLoader, "reload").mockResolvedValue();

		const settled = runtime.waitUntilProjectTrustSettled();
		expect(await completesWithin(settled, 25)).toBe(false);
		expect(harness.settingsManager.isProjectTrusted()).toBe(false);

		trusted = true;
		decide();
		await settled;
		expect(harness.settingsManager.isProjectTrusted()).toBe(true);
	} finally {
		harness.cleanup();
	}
});

test("history reopen failure after agent_end reaches the engine diagnostic without killing the host (#3678)", async () => {
	const harness = await createHarness();
	try {
		const probe = createUnresponsiveEngineClient();
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		vi.spyOn(runtime.session, "sessionFile", "get").mockReturnValue("/session/history.jsonl");
		const reopen = vi.spyOn(SessionManager, "open").mockRejectedValueOnce(new Error("history read failed"));
		const diagnostics: string[] = [];
		const unsubscribe = runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
		try {
			probe.emit({ type: "agent_start" });
			probe.emit({ type: "agent_end", messages: [] });
			await vi.waitFor(() =>
				expect(diagnostics).toEqual(["Interactive engine refresh session view failed: history read failed"]),
			);
			expect(reopen).toHaveBeenCalledTimes(1);
			expect(runtime.session.isStreaming).toBe(false);
			probe.emit({ type: "agent_start" });
			expect(runtime.session.isStreaming).toBe(true);
		} finally {
			unsubscribe();
		}
	} finally {
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

test("isolated label writes return an awaited receipt and propagate errors to the caller (#3678)", async () => {
	const harness = await createHarness();
	const response = Promise.withResolvers<{ entryId: string }>();
	const reopened = Promise.withResolvers<SessionManager>();
	try {
		const probe = createUnresponsiveEngineClient();
		probe.client.requestInternal = async <T>(command: { type: string }): Promise<T> => {
			expect(command.type).toBe("set_label");
			return (await response.promise) as T;
		};
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		const session = runtime.session;
		vi.spyOn(session, "sessionFile", "get").mockReturnValue("/session/history.jsonl");
		const reopen = vi.spyOn(SessionManager, "open").mockReturnValue(reopened.promise);
		let settled = false;
		const receipt = session.sessionManager.appendLabelChange("target", "saved-label");
		expect(receipt).toBeInstanceOf(Promise);
		const completion = receipt.then((id) => {
			settled = true;
			return id;
		});
		response.resolve({ entryId: "label-receipt" });
		await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		const refreshed = SessionManager.inMemory();
		const target = await refreshed.appendMessage({ role: "user", content: "label target", timestamp: 1 });
		await refreshed.appendLabelChange(target, "saved-label");
		reopened.resolve(refreshed);
		expect(await completion).toBe("label-receipt");
		expect(session.sessionManager.getLabel(target)).toBe("saved-label");
		const failure = new Error("label commit failed");
		probe.client.requestInternal = async () => {
			throw failure;
		};
		await expect(session.sessionManager.appendLabelChange(target, "lost-label")).rejects.toBe(failure);
		expect(session.sessionManager.getLabel(target)).toBe("saved-label");
	} finally {
		response.resolve({ entryId: "label-receipt" });
		reopened.resolve(SessionManager.inMemory());
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

test("overlapping isolated session names retain the last requested name (#3678)", async () => {
	const harness = await createHarness();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const written: string[] = [];
	try {
		const probe = createUnresponsiveEngineClient();
		Object.assign(probe.client, {
			async setSessionName(name: string) {
				if (name === "first") {
					entered.resolve();
					await release.promise;
				}
				written.push(name);
			},
		});
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		const first = runtime.session.setSessionName("first");
		await entered.promise;
		const last = runtime.session.setSessionName("last");
		await new Promise<void>((resolve) => setImmediate(resolve));
		release.resolve();
		await Promise.all([first, last]);
		expect(runtime.session.sessionName).toBe("last");
		expect(written).toEqual(["first", "last"]);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});

test.each(["", "shared-mirror-id"])("isolated initialization scopes duplicate ID %j", async (id) => {
	const directory = mkdtempSync(join(tmpdir(), "isolated-session-identity-"));
	const localStore = await JsonlSessionStore.open(join(directory, "local"), { exactDirectory: true });
	const selectedStore = await JsonlSessionStore.open(join(directory, "selected"), { exactDirectory: true });
	const header = { id, version: 4 as const, createdAt: new Date().toISOString(), cwd: directory };
	await localStore.create(header, []);
	await selectedStore.create(header, []);
	const localManager = await SessionManager.open(localStore, id);
	const selectedManager = await SessionManager.open(selectedStore, id);
	await localManager.appendSessionInfo("local conversation");
	await selectedManager.appendSessionInfo("selected conversation");
	const harness = await createHarness({ sessionManager: localManager });
	const replacements: Harness[] = [];
	try {
		const probe = createUnresponsiveEngineClient();
		probe.client.getState = async () => ({
			...createState(),
			sessionId: id,
			sessionLocation: selectedManager.getSessionFile(),
			sessionName: selectedManager.getSessionName(),
		});
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused local runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async ({ sessionManager }) => {
				const replacement = await createHarness({ sessionManager });
				replacements.push(replacement);
				return { session: replacement.session, services: servicesFor(replacement), diagnostics: [] } as never;
			},
			probe.client as never,
		);
		await runtime.initializeFromEngine();
		assert.equal(runtime.session.sessionId, id);
		assert.equal(runtime.session.sessionManager.getSessionDir(), selectedManager.getSessionDir());
		assert.deepEqual(runtime.session.sessionManager.getEntries(), selectedManager.getEntries());
		assert.equal((await localStore.load(id)).entries.length, localManager.getEntries().length);
	} finally {
		await harness.cleanup();
		for (const replacement of replacements) await replacement.cleanup();
		await localStore.close();
		await selectedStore.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("isolated label refresh resolves an empty ID in its store after its display location changes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "isolated-label-identity-"));
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
	await store.create({ id: "", version: 4, createdAt: new Date().toISOString(), cwd: directory }, []);
	const writer = await SessionManager.open(store, "");
	const target = await writer.appendMessage({ role: "user", content: "label target", timestamp: 1 });
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, "") });
	let committedReceipt: string | undefined;
	try {
		const probe = createUnresponsiveEngineClient();
		probe.client.getState = async () => ({
			...createState(),
			sessionId: "",
			sessionLocation: writer.getSessionFile(),
		});
		probe.client.requestInternal = async <T>(command: { type: string }): Promise<T> => {
			if (command.type === "set_label") {
				committedReceipt = await writer.appendLabelChange(target, "saved label");
				return { entryId: committedReceipt } as T;
			}
			return { models: [], scopedModels: [] } as T;
		};
		const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
			throw new Error("unused local runtime factory");
		});
		const runtime = new IsolatedInteractiveRuntime(
			localRuntime,
			async () => {
				throw new Error("unexpected replacement");
			},
			probe.client as never,
		);
		await runtime.initializeFromEngine();
		const session = runtime.session;
		renameSync(writer.getSessionFile()!, join(directory, "moved-session.jsonl"));
		assert.equal(await session.sessionManager.appendLabelChange(target, "saved label"), committedReceipt);
		assert.equal(session.sessionId, "");
		assert.equal(session.sessionManager.getLabel(target), "saved label");
		assert.deepEqual(session.sessionManager.getEntries(), writer.getEntries());
	} finally {
		await harness.cleanup();
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
