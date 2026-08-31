import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { InteractiveEngineMonitor } from "../src/modes/interactive-engine/engine-monitor.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import { InteractiveEngineResourceReadinessError } from "../src/modes/interactive-engine/resource-readiness-error.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { RpcResourceReadiness } from "../src/modes/rpc/rpc-resource-readiness.ts";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.ts";
import { isRpcTransportFailure, rpcTransportError } from "../src/modes/rpc/rpc-transport-error.ts";
import { createHarness } from "./suite/harness.ts";

function frame(message: Parameters<typeof serializeInteractiveEngineMessage>[0]): string {
	return serializeInteractiveEngineMessage(message).trimEnd();
}
interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
function observedRejectionDeferred<T>(): Deferred<T> {
	const result = deferred<T>();
	result.promise.catch(() => {});
	return result;
}

async function createGenerationRuntime() {
	const harness = await createHarness();
	let generation = 1;
	const resources = new Map<number, Deferred<void>>([[1, observedRejectionDeferred<void>()]]);
	const initializations = new Map<number, Deferred<void>>([[1, deferred<void>()]]);
	const extensionPaths = new Map<number, string>([[1, "/builtin/engine-1/index.ts"]]);
	let engineMessageListener: ((message: { type: string; message?: string }) => void) | undefined;
	let generationEndedListener:
		| ((event: { generation: number; error: Error; kind: "explicit-stop"; expected: boolean }) => void)
		| undefined;
	const restartGate = deferred<void>();
	const prompt = vi.fn(async () => {});
	const abort = vi.fn(async () => {});
	const client = {
		onEvent: () => () => {},
		onGenerationEnded: (listener: typeof generationEndedListener) => {
			generationEndedListener = listener;
			return () => {};
		},
		onInteractiveEngineMessage: (listener: typeof engineMessageListener) => {
			engineMessageListener = listener;
			return () => {};
		},
		getGeneration: () => generation,
		waitForInteractiveEngineResources: () => resources.get(generation)!.promise,
		getState: async () => {
			const requestedGeneration = generation;
			await initializations.get(requestedGeneration)!.promise;
			return {
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: `engine-${requestedGeneration}`,
				sessionName: `engine-${requestedGeneration}`,
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
				queuedMessagesPaused: false,
				resourceExtensions: [{ path: extensionPaths.get(requestedGeneration)!, hidden: false }],
			};
		},
		requestInternal: async () => ({ models: [], scopedModels: [] }),
		getCommands: async () => [],
		prompt,
		abort,
		restart: vi.fn(() => restartGate.promise),
		waitForInteractiveEngineBound: vi.fn(async () => {}),
		stop: vi.fn(async () => {
			resources.get(generation)?.reject(rpcTransportError("Agent process stopped"));
		}),
	};
	const local = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		local,
		async () => {
			throw new Error("unused runtime factory");
		},
		client as never,
	);
	return {
		runtime,
		prompt,
		abort,
		harness,
		resources,
		initializations,
		setGeneration(next: number) {
			generation = next;
			resources.set(next, observedRejectionDeferred<void>());
			extensionPaths.set(next, `/builtin/engine-${next}/index.ts`);
			initializations.set(next, deferred<void>());
		},
		setResourceExtension(extensionPath: string) {
			extensionPaths.set(generation, extensionPath);
		},
		retireGeneration(retiredGeneration: number, expected = true) {
			generationEndedListener?.({
				generation: retiredGeneration,
				error: rpcTransportError("Agent process stopped"),
				kind: "explicit-stop",
				expected,
			});
		},
		restartGate,
		emitResourceFailure(message: string) {
			engineMessageListener?.({ type: "engine_resources_failed", message });
			resources.get(generation)!.reject(new Error(`Interactive engine resource loading failed: ${message}`));
		},
	};
}

describe("interactive engine resource readiness", () => {
	it("keeps binding separate from optional resource readiness", async () => {
		const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
		let resourcesReady = false;
		void monitor.waitUntilResourcesReady().then(() => {
			resourcesReady = true;
		});

		expect(
			monitor.handleLine(
				frame({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: 123 }),
			),
		).toBe(true);
		expect(monitor.handleLine(frame({ type: "engine_bound" }))).toBe(true);
		await monitor.waitUntilBound();
		await Promise.resolve();
		expect(resourcesReady).toBe(false);

		expect(monitor.handleLine(frame({ type: "engine_resources_ready" }))).toBe(true);
		await expect(monitor.waitUntilResourcesReady()).resolves.toBeUndefined();
	});

	it("rejects the generation resource gate when transactional loading fails", async () => {
		const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
		const readiness = monitor.waitUntilResourcesReady();

		expect(monitor.handleLine(frame({ type: "engine_resources_failed", message: "workflow load failed" }))).toBe(
			true,
		);
		await expect(readiness).rejects.toThrow("workflow load failed");
	});

	it("replaces a rejected host resource gate when the same engine retries successfully", async () => {
		const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
		const failedAttempt = monitor.waitUntilResourcesReady();
		monitor.handleLine(frame({ type: "engine_resources_failed", message: "bad extension" }));
		await expect(failedAttempt).rejects.toThrow("bad extension");
		await expect(monitor.waitUntilResourcesReady()).rejects.toThrow("bad extension");

		monitor.handleLine(frame({ type: "engine_resources_ready" }));
		await expect(monitor.waitUntilResourcesReady()).resolves.toBeUndefined();
	});

	it("gates child-side prompts and dispatches them through the current session", async () => {
		const harness = await createHarness();
		const replacement = await createHarness();
		let releaseResources!: () => void;
		const waitForResources = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseResources = resolve;
				}),
		);
		const stalePrompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		const replacementPrompt = vi.spyOn(replacement.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		let currentSession = harness.session;
		const output = vi.fn();
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => currentSession,
			rebindSession: async () => {},
			output,
			waitForResources,
		});

		try {
			await expect(handle({ id: "first", type: "prompt", message: "hello" })).resolves.toBeUndefined();
			await Promise.resolve();
			expect(waitForResources).toHaveBeenCalledTimes(1);
			expect(stalePrompt).not.toHaveBeenCalled();
			expect(replacementPrompt).not.toHaveBeenCalled();

			currentSession = replacement.session;
			releaseResources();
			await vi.waitFor(() => expect(replacementPrompt).toHaveBeenCalledWith("hello", expect.any(Object)));
			expect(stalePrompt).not.toHaveBeenCalled();
			expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "first", success: true }));
		} finally {
			harness.cleanup();
			replacement.cleanup();
		}
	});

	it("holds resource-dependent control commands and reacquires the current session", async () => {
		const harness = await createHarness();
		const replacement = await createHarness();
		let releaseResources!: () => void;
		const waitForResources = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseResources = resolve;
				}),
		);
		const staleReload = vi.spyOn(harness.session, "reload").mockResolvedValue();
		const replacementReload = vi.spyOn(replacement.session, "reload").mockResolvedValue();
		let currentSession = harness.session;
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => currentSession,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForResources,
		});

		try {
			const reload = handle({ id: "reload", type: "reload" });
			await Promise.resolve();
			expect(staleReload).not.toHaveBeenCalled();
			expect(replacementReload).not.toHaveBeenCalled();

			currentSession = replacement.session;
			releaseResources();
			await expect(reload).resolves.toMatchObject({ success: true });
			expect(staleReload).not.toHaveBeenCalled();
			expect(replacementReload).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
			replacement.cleanup();
		}
	});

	it("retries failed deferred resources through reload before accepting a later prompt", async () => {
		const harness = await createHarness();
		const readiness = new RpcResourceReadiness();
		let extensionFixed = false;
		const loadResources = vi.fn(async () => {
			if (!extensionFixed) throw new Error("bad extension");
		});
		await expect(readiness.run(loadResources)).rejects.toThrow("bad extension");
		await expect(readiness.wait()).rejects.toThrow("bad extension");
		const normalReload = vi.spyOn(harness.session, "reload").mockResolvedValue();
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		const output = vi.fn();
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output,
			waitForResources: () => readiness.wait(),
			reloadResources: () => readiness.run(loadResources),
			shouldRetryResources: () => readiness.needsRetry(),
		});

		try {
			extensionFixed = true;
			await expect(handle({ id: "reload", type: "reload" })).resolves.toMatchObject({ success: true });
			await expect(handle({ id: "prompt", type: "prompt", message: "after repair" })).resolves.toBeUndefined();
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
			expect(loadResources).toHaveBeenCalledTimes(2);
			expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "prompt", success: true }));
			await expect(handle({ id: "normal-reload", type: "reload" })).resolves.toMatchObject({ success: true });
			expect(normalReload).toHaveBeenCalledTimes(1);
			expect(loadResources).toHaveBeenCalledTimes(2);
		} finally {
			harness.cleanup();
		}
	});

	it("allows only explicitly partial startup metadata through the resource gate", async () => {
		const harness = await createHarness();
		const waitForResources = vi.fn(async () => {});
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const extensions = harness.session.resourceLoader.getExtensions();
		const extensionSource = {
			path: "/builtin/workflows/index.ts",
			source: "builtin:workflows",
			scope: "user" as const,
			origin: "package" as const,
		};
		const getExtensions = vi.spyOn(harness.session.resourceLoader, "getExtensions").mockReturnValue({
			...extensions,
			extensions: [
				{
					path: extensionSource.path,
					resolvedPath: extensionSource.path,
					sourceInfo: extensionSource,
					hidden: false,
				},
			] as never,
		});
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForResources,
		});

		try {
			const stateResponse = await handle({ id: "state", type: "get_state" });
			expect(stateResponse).toMatchObject({
				success: true,
				data: {
					resourceExtensions: [{ path: extensionSource.path, sourceInfo: extensionSource, hidden: false }],
				},
			});
			await handle({ id: "state", type: "get_state" });
			await handle({ id: "catalog", type: "get_available_models", allowPartialResources: true });
			expect(waitForResources).not.toHaveBeenCalled();

			await handle({ id: "user-catalog", type: "get_available_models" });
			expect(waitForResources).toHaveBeenCalledTimes(1);
		} finally {
			getExtensions.mockRestore();
			harness.cleanup();
		}
	});

	it("fails deferred readiness when any extension did not load", async () => {
		const harness = await createHarness();
		const output = vi.fn();
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const reload = vi.spyOn(harness.session, "reload").mockRejectedValue(new Error("workflow load failed"));
		const extensionRuntime = harness.session.resourceLoader.getExtensions().runtime;
		vi.spyOn(harness.session.resourceLoader, "getExtensions").mockReturnValue({
			extensions: [],
			errors: [{ path: "builtin/workflows", error: "workflow load failed" }],
			runtime: extensionRuntime,
		} as never);
		const binding = new RpcSessionBinding({
			runtimeHost: runtime,
			output,
			pendingExtensionRequests: new Map(),
			requestShutdown: () => {},
		});

		try {
			await expect(binding.loadDeferredResources()).rejects.toThrow("workflow load failed");
			expect(reload).toHaveBeenCalledWith({ reason: "startup", failOnExtensionErrors: true });
			expect(output).toHaveBeenCalledWith(
				expect.objectContaining({ type: "extension_error", extensionPath: "builtin/workflows" }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("surfaces a current resource failure once and never sends the prompt", async () => {
		const probe = await createGenerationRuntime();
		const diagnostics = vi.fn();
		probe.runtime.onDiagnostic(diagnostics);
		try {
			probe.emitResourceFailure("workflow load failed");
			await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1));

			await expect(probe.runtime.session.prompt("hello")).rejects.toBeInstanceOf(
				InteractiveEngineResourceReadinessError,
			);
			expect(probe.prompt).not.toHaveBeenCalled();
			expect(diagnostics).toHaveBeenCalledTimes(1);
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("Escape cancels a submit blocked on resource readiness", async () => {
		const probe = await createGenerationRuntime();
		try {
			const submitted = probe.runtime.session.prompt("cancel me");
			await Promise.resolve();
			await probe.runtime.session.abort();
			probe.resources.get(1)!.resolve();
			probe.initializations.get(1)!.resolve();
			await expect(submitted).resolves.toBeUndefined();
			expect(probe.abort).toHaveBeenCalledTimes(1);
			expect(probe.prompt).not.toHaveBeenCalled();
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("does not let an old successful generation release its replacement", async () => {
		const probe = await createGenerationRuntime();
		try {
			probe.resources.get(1)!.resolve();
			const submitted = probe.runtime.session.prompt("hello");
			await Promise.resolve();
			probe.retireGeneration(1);
			probe.initializations.get(1)!.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(probe.prompt).not.toHaveBeenCalled();
			probe.setGeneration(2);
			expect(probe.prompt).not.toHaveBeenCalled();

			probe.resources.get(2)!.resolve();
			probe.initializations.get(2)!.resolve();
			await submitted;
			expect(probe.prompt).toHaveBeenCalledTimes(1);
			expect(probe.prompt).toHaveBeenCalledWith("hello", undefined, undefined);
			expect(probe.runtime.session.sessionName).toBe("engine-2");
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("does not let an old failed generation reject its replacement", async () => {
		const probe = await createGenerationRuntime();
		try {
			const submitted = probe.runtime.session.prompt("hello");
			await Promise.resolve();
			const oldResources = probe.resources.get(1)!;
			probe.retireGeneration(1);
			oldResources.reject(new Error("old workflow load failed"));
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(probe.prompt).not.toHaveBeenCalled();
			probe.setGeneration(2);

			probe.resources.get(2)!.resolve();
			probe.initializations.get(2)!.resolve();
			await submitted;
			expect(probe.prompt).toHaveBeenCalledTimes(1);
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("rejects a waiting prompt when automatic replacement fails", async () => {
		const probe = await createGenerationRuntime();
		try {
			const submitted = probe.runtime.session.prompt("hello");
			await Promise.resolve();
			probe.retireGeneration(1, false);
			probe.resources.get(1)!.reject(rpcTransportError("Agent process stopped"));
			probe.restartGate.reject(new Error("replacement spawn failed"));
			await expect(submitted).rejects.toSatisfy(isRpcTransportFailure);
			expect(probe.prompt).not.toHaveBeenCalled();
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("clears retired extension inventory and publishes only the replacement generation", async () => {
		const probe = await createGenerationRuntime();
		const observedInventories: string[][] = [];
		const disposeInventoryListener = probe.runtime.onResourceExtensionsChanged((extensions) => {
			observedInventories.push(extensions.map((extension) => extension.path));
		});
		try {
			probe.initializations.get(1)!.resolve();
			await probe.runtime.initializeFromEngine();
			expect(probe.runtime.getResourceExtensions()).toEqual([{ path: "/builtin/engine-1/index.ts", hidden: false }]);

			probe.retireGeneration(1);
			expect(probe.runtime.getResourceExtensions()).toEqual([]);
			probe.setGeneration(2);
			probe.initializations.get(2)!.resolve();
			await probe.runtime.initializeFromEngine();
			expect(probe.runtime.getResourceExtensions()).toEqual([{ path: "/builtin/engine-2/index.ts", hidden: false }]);

			probe.setResourceExtension("/builtin/reloaded/index.ts");
			await probe.runtime.synchronize();
			expect(probe.runtime.getResourceExtensions()).toEqual([{ path: "/builtin/reloaded/index.ts", hidden: false }]);
			expect(observedInventories).toEqual([
				["/builtin/engine-1/index.ts"],
				[],
				["/builtin/engine-2/index.ts"],
				["/builtin/reloaded/index.ts"],
			]);
		} finally {
			disposeInventoryListener();
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});
	it("serializes initialization so an old generation cannot overwrite newer host state", async () => {
		const probe = await createGenerationRuntime();
		try {
			const oldInitialization = probe.runtime.initializeFromEngine();
			await Promise.resolve();
			probe.retireGeneration(1);
			probe.setGeneration(2);
			const replacementInitialization = probe.runtime.initializeFromEngine();
			probe.initializations.get(1)!.resolve();
			await oldInitialization;
			probe.initializations.get(2)!.resolve();
			await replacementInitialization;
			expect(probe.runtime.session.sessionName).toBe("engine-2");
		} finally {
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("reports a replacement resource failure once while recovery is active", async () => {
		const probe = await createGenerationRuntime();
		const diagnostics = vi.fn();
		probe.runtime.onDiagnostic(diagnostics);
		try {
			probe.retireGeneration(1, false);
			probe.setGeneration(2);
			probe.emitResourceFailure("replacement workflow load failed");
			await vi.waitFor(() =>
				expect(diagnostics).toHaveBeenCalledWith(
					expect.objectContaining({
						message: "Interactive engine resource loading failed: replacement workflow load failed",
					}),
				),
			);
			const matchingFailures = diagnostics.mock.calls.filter(
				([diagnostic]) =>
					diagnostic.message === "Interactive engine resource loading failed: replacement workflow load failed",
			);
			expect(matchingFailures).toHaveLength(1);
		} finally {
			probe.restartGate.resolve();
			await probe.runtime.dispose();
			probe.harness.cleanup();
		}
	});

	it("rejects prompts after disposal without calling the client", async () => {
		const probe = await createGenerationRuntime();
		await probe.runtime.dispose();
		await expect(probe.runtime.session.prompt("hello")).rejects.toThrow("Interactive engine runtime is disposed");
		expect(probe.prompt).not.toHaveBeenCalled();
		probe.harness.cleanup();
	});

	it("rejects a prompt waiting on resources when disposal begins", async () => {
		const probe = await createGenerationRuntime();
		const submitted = probe.runtime.session.prompt("hello");
		await Promise.resolve();
		await probe.runtime.dispose();
		await expect(submitted).rejects.toThrow("Interactive engine runtime is disposed");
		expect(probe.prompt).not.toHaveBeenCalled();
		probe.harness.cleanup();
	});

	it("rejects malformed resource lifecycle messages", () => {
		expect(parseInteractiveEngineMessage('{"type":"engine_resources_failed"}')).toBeUndefined();
		expect(parseInteractiveEngineMessage('{"type":"engine_resources_ready","message":"unexpected"}')).toEqual({
			type: "engine_resources_ready",
		});
	});
});
