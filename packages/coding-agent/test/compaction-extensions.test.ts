/**
 * Tests for deletion-shaped compaction extension events.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ContextDeletionRequest } from "../src/core/compaction/index.ts";
import {
	createExtensionRuntime,
	type Extension,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionCompactEvent,
	type SessionEvent,
} from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createCodingTools } from "../src/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

// The deletion-shaped tests below supply a `deletionRequest` or `cancel` and never reach the
// planner, so they require no API credentials and must run in credential-less CI (they exercise the
// security-relevant validation: cancel, empty-request rejection, protected-metadata enforcement).
// Only the final planner-fallback test needs a real model call and is gated with `it.skipIf`.
describe("Compaction extensions", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedEvents: SessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-extensions-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		capturedEvents = [];
	});

	afterEach(async () => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createExtension(
		onBeforeCompact?: (event: SessionBeforeCompactEvent) => SessionBeforeCompactResult | undefined,
		onCompact?: (event: SessionCompactEvent) => void,
	): Extension {
		const handlers = new Map<string, ((event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>)[]>();

		handlers.set("session_before_compact", [
			async (event: SessionEvent) => {
				if (event.type !== "session_before_compact") return undefined;
				capturedEvents.push(event);
				return onBeforeCompact?.(event);
			},
		]);

		handlers.set("session_compact", [
			async (event: SessionEvent) => {
				if (event.type !== "session_compact") return undefined;
				capturedEvents.push(event);
				onCompact?.(event);
				return undefined;
			},
		]);

		return {
			path: "test-extension",
			resolvedPath: "/test/test-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:test-extension>", { source: "test" }),
			handlers,
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	function createSession(extensions: Extension[]) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});

		const sessionManager = SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runtime = createExtensionRuntime();
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => ({ extensions, errors: [], runtime }),
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
		});

		return session;
	}

	function populateCompactableSession(): void {
		const now = Date.now();
		session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "initial task" }], timestamp: now });
		for (let index = 0; index < 8; index++) {
			session.sessionManager.appendMessage(assistantMessage(`assistant context ${index}`, now + index + 1));
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
	}

	function firstDeletableEntry(event: SessionBeforeCompactEvent): string {
		const entry = event.preparation.transcript.entries.find((candidate) => !candidate.protected);
		expect(entry).toBeDefined();
		return entry!.entryId;
	}

	it("emits deletion-shaped before and after compaction events", async () => {
		const extension = createExtension((event) => ({ deletionRequest: { deletions: [{ kind: "entry", entryId: firstDeletableEntry(event) }] } }));
		createSession([extension]);
		populateCompactableSession();

		const result = await session.compact();

		const beforeEvents = capturedEvents.filter((event): event is SessionBeforeCompactEvent => event.type === "session_before_compact");
		const compactEvents = capturedEvents.filter((event): event is SessionCompactEvent => event.type === "session_compact");
		expect(beforeEvents).toHaveLength(1);
		expect(compactEvents).toHaveLength(1);
		expect(beforeEvents[0].reason).toBe("manual");
		expect(beforeEvents[0].mode).toBe("standard");
		expect(beforeEvents[0].preparation.transcript.entries.length).toBeGreaterThan(0);
		expect(compactEvents[0].contextCompactionEntry.type).toBe("context_compaction");
		expect(compactEvents[0].result).toEqual(result);
		expect(compactEvents[0].fromExtension).toBe(true);
	});

	it("allows extensions to cancel compaction", async () => {
		const extension = createExtension(() => ({ cancel: true }));
		createSession([extension]);
		populateCompactableSession();

		await expect(session.compact()).rejects.toThrow("Compaction cancelled");
		expect(capturedEvents.some((event) => event.type === "session_compact")).toBe(false);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_compaction")).toBe(false);
	});

	it("rejects empty extension deletion requests without persisting compaction", async () => {
		const extension = createExtension(() => ({ deletionRequest: { deletions: [] } }));
		createSession([extension]);
		populateCompactableSession();

		await expect(session.compact()).rejects.toThrow(/No safe context deletions proposed by extension/);
		expect(capturedEvents.some((event) => event.type === "session_compact")).toBe(false);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_compaction")).toBe(false);
	});

	it("validates extension deletion requests against internal protected metadata", async () => {
		let protectedEntryId = "";
		const extension = createExtension((event) => {
			const protectedEntry = event.preparation.transcript.entries.find((entry) => entry.protected);
			expect(protectedEntry).toBeDefined();
			protectedEntryId = protectedEntry!.entryId;
			// Attempt to mutate the extension-facing snapshot. Validation must still use the
			// internal transcript where this entry remains protected.
			try {
				protectedEntry!.protected = false;
			} catch {
				// Frozen snapshots throw in strict mode; either outcome is acceptable as long as
				// the internal validation still rejects the deletion.
			}
			return { deletionRequest: { deletions: [{ kind: "entry", entryId: protectedEntryId }] } };
		});
		createSession([extension]);
		populateCompactableSession();

		await expect(session.compact()).rejects.toThrow(/protected/);
		expect(protectedEntryId).not.toBe("");
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_compaction")).toBe(false);
	});

	// Requires a live model: the hook observes without a deletionRequest, so compaction falls back
	// to the planner, which needs credentials.
	it.skipIf(!API_KEY)("continues with planner compaction when hooks observe without deletion requests", async () => {
		const extension = createExtension(() => undefined);
		createSession([extension]);
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();
		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.deletedTargets.length).toBeGreaterThan(0);
		const compactEvent = capturedEvents.find((event): event is SessionCompactEvent => event.type === "session_compact");
		expect(compactEvent).toBeDefined();
		expect(compactEvent!.fromExtension).toBe(false);
	});
});

// Type-only regression for the deletion-shaped hook contract. This is outside the
// API-key-gated suite so stale summary-shaped fields fail typecheck even when runtime
// extension tests are skipped.
describe("Compaction extension types", () => {
	it("accepts deletion requests and context compaction result events", () => {
		const beforeHandler = (event: SessionBeforeCompactEvent): SessionBeforeCompactResult | undefined => {
			const deletable = event.preparation.transcript.entries.find((entry) => !entry.protected);
			if (!deletable) return undefined;
			const request: ContextDeletionRequest = { deletions: [{ kind: "entry", entryId: deletable.entryId }] };
			return { deletionRequest: request };
		};
		const compactHandler = (event: SessionCompactEvent): AgentMessage | undefined => {
			expect(event.contextCompactionEntry.type).toBe("context_compaction");
			expect(event.result.deletedTargets).toBe(event.contextCompactionEntry.deletedTargets);
			return undefined;
		};

		expect(typeof beforeHandler).toBe("function");
		expect(typeof compactHandler).toBe("function");
	});
});

describe("Compaction extension offline deletion requests", () => {
	/**
	 * Shared helper: creates a session with no configured auth, using the given extension handlers.
	 * Returns the session and a cleanup function.
	 */
	function createUnauthenticatedSession(
		beforeCompactHandler: (event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>,
		onCompact?: (event: SessionEvent) => Promise<undefined>,
	): { session: AgentSession; cleanup: () => void } {
		const tempDir = join(tmpdir(), `pi-compaction-unauth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const extension: Extension = {
			path: "unauth-extension",
			resolvedPath: "/test/unauth-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:unauth-extension>", { source: "test" }),
			handlers: new Map<string, ((event: SessionEvent) => Promise<SessionBeforeCompactResult | undefined>)[]>([
				["session_before_compact", [beforeCompactHandler]],
				...(onCompact ? [["session_compact", [onCompact]] as [string, ((event: SessionEvent) => Promise<undefined>)[]]] : []),
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: createCodingTools(process.cwd()),
			},
		});
		const runtime = createExtensionRuntime();
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
		};
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json"))),
			resourceLoader,
		});

		const now = Date.now();
		session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "offline task" }], timestamp: now });
		for (let index = 0; index < 8; index++) {
			session.sessionManager.appendMessage(assistantMessage(`context ${index}`, now + index + 1));
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;

		return {
			session,
			cleanup() {
				session.dispose();
				rmSync(tempDir, { recursive: true, force: true });
			},
		};
	}

	/**
	 * Prove: extension-provided deletion request compacts successfully with no configured auth.
	 * Auth resolver is never called, so no API credentials are required.
	 */
	it("runs extension-provided deletion requests without configured auth", async () => {
		const compactEvents: SessionEvent[] = [];
		const beforeCompactEvents: SessionEvent[] = [];

		const { session, cleanup } = createUnauthenticatedSession(
			async (event) => {
				if (event.type !== "session_before_compact") return undefined;
				beforeCompactEvents.push(event);
				// Pick the first non-protected entry — no API call required to determine this.
				// Use a conditional guard rather than expect() so the handler never throws
				// (emit() silently swallows handler exceptions, masking the deletion request).
				const deletable = event.preparation.transcript.entries.find((entry) => !entry.protected);
				if (!deletable) return undefined; // will be caught by the outer expect
				return { deletionRequest: { deletions: [{ kind: "entry", entryId: deletable.entryId }] } };
			},
			async (event) => {
				if (event.type === "session_compact") compactEvents.push(event);
				return undefined;
			},
		);

		try {
			// compact() should succeed even though no API key is configured,
			// because the extension's deletionRequest bypasses planner auth.
			const result = await session.compact();

			expect(result.deletedTargets.length).toBe(1);
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_compaction")).toBe(true);
			expect(beforeCompactEvents).toHaveLength(1);
			expect(compactEvents).toHaveLength(1);
			expect((compactEvents[0] as SessionCompactEvent).fromExtension).toBe(true);
		} finally {
			cleanup();
		}
	});

	/**
	 * Prove: if the extension hook observes (returns undefined) and falls back to the planner,
	 * auth is required and the compaction fails when credentials are absent.
	 */
	it("requires auth when extension provides no deletion request and planner fallback is needed", async () => {
		const beforeCompactEvents: SessionEvent[] = [];

		const { session, cleanup } = createUnauthenticatedSession(async (event) => {
			// Observer: records the hook but provides no deletion request, triggering planner fallback.
			if (event.type === "session_before_compact") beforeCompactEvents.push(event);
			return undefined;
		});

		try {
			// compact() should throw a missing-auth error because the planner would need credentials.
			await expect(session.compact()).rejects.toThrow(/No API key found/);
			// The before-compact hook ran (hook fires before auth resolution).
			expect(beforeCompactEvents).toHaveLength(1);
			// No compaction entry should have been created.
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_compaction")).toBe(false);
		} finally {
			cleanup();
		}
	});
});
