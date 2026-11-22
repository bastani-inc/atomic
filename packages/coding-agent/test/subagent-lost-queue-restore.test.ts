import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import type { Terminal } from "@bastani/atomic-tui";
import { afterEach, describe, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { InteractiveMode } from "../src/index.js";
import { attachLostAgentQueueNotices } from "../src/modes/interactive/agent-view/prompt-retarget.ts";
import { setViewedNoticeSink } from "../src/modes/interactive/agent-view/viewed-notices.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import type { InteractiveEngineGenerationEnded } from "../src/modes/interactive-engine/engine-generation.ts";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.ts";
import { FakeAgentViewPort } from "./helpers/fake-agent-view-port.ts";

const openable = vi.hoisted(() => ({
	ports: new Map<string, unknown>(),
}));
vi.mock("../src/modes/interactive/agent-view/open-port.ts", () => ({
	openAgentViewPort: async (_mode: unknown, taskId: string) => openable.ports.get(taskId),
}));

/** Each case builds a real interactive host over a real session, which is slow on loaded Windows runners. */
const HOST_TIMEOUT_MS = 90_000;
const WORKER_1 = "task-worker-1" as TaskId;
const WORKER_2 = "task-worker-2" as TaskId;
const SIBLING = "task-sibling-1" as TaskId;
const CHILD_SESSION = "child-session-1";
const CHILD_FILE = "/tmp/child-session-1.jsonl";
const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

class KeyTerminal implements Terminal {
	columns = 120;
	rows = 40;
	kittyProtocolActive = true;
	input: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get resize(): undefined {
		return undefined;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Timed out waiting for host state");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

interface HostRig {
	readonly mode: InteractiveMode;
	readonly warnings: string[];
	readonly viewedNotices: string[];
	press(...keys: string[]): Promise<void>;
	type(text: string): Promise<void>;
	view(taskId: TaskId | undefined): Promise<void>;
	cleanup(): Promise<void>;
}

let host: HostRig | undefined;

afterEach(async () => {
	openable.ports.clear();
	await host?.cleanup();
	host = undefined;
});

async function createHost(): Promise<HostRig> {
	initTheme("dark");
	const cwd = mkdtempSync(join(tmpdir(), "subagent-lost-queue-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "subagent-lost-queue-agent-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: true,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				cwd: runtimeOptions.cwd,
				agentDir: runtimeOptions.agentDir,
				builtinPackagePaths: [],
				extensionFactories: [],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: faux.getModel(),
			builtins: NO_BUILTINS,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const terminal = new KeyTerminal();
	const mode = new InteractiveMode(runtime, { terminal });
	await mode.init();
	const warnings: string[] = [];
	const viewedNotices: string[] = [];
	const showWarning = mode.showWarning.bind(mode);
	mode.showWarning = (message, target) => {
		warnings.push(message);
		showWarning(message, target);
	};
	setViewedNoticeSink(mode, {
		show: (text, kind) => viewedNotices.push(`${kind}: ${text}`),
	});
	return {
		mode,
		warnings,
		viewedNotices,
		async press(...keys) {
			for (const key of keys) {
				terminal.input?.(key);
				await settle();
			}
		},
		async type(text) {
			for (const ch of text) terminal.input?.(ch);
			await settle();
		},
		async view(taskId) {
			assert.equal(await mode.agentView?.view(taskId), true);
			await settle();
		},
		async cleanup() {
			mode.stop();
			await runtime.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function fakeEngineHarness(
	mode: InteractiveMode,
	findQueuedMessages?: (
		messages: readonly unknown[],
		session?: { readonly sessionId: string; readonly sessionFile?: string },
	) => Promise<{ readonly saved: ReadonlySet<string>; readonly absent: ReadonlySet<string> }>,
) {
	const ended = new Set<(event: InteractiveEngineGenerationEnded) => void>();
	const recovered = new Set<(replaced: boolean) => void>();
	const engineMessages = new Set<(message: InteractiveEngineMessage) => void>();
	const detach = attachLostAgentQueueNotices(mode, {
		onGenerationEnded: (listener) => {
			ended.add(listener);
			return () => ended.delete(listener);
		},
		onEngineRecovered: (listener) => {
			recovered.add(listener);
			return () => recovered.delete(listener);
		},
		onEngineMessage: (listener) => {
			engineMessages.add(listener);
			return () => engineMessages.delete(listener);
		},
		...(findQueuedMessages === undefined ? {} : { findQueuedMessages }),
	} as never);
	return {
		detach,
		crash: (portToKill?: FakeAgentViewPort, generation = 1) => {
			// Mirrors RemoteAgentViewPort + installAgentView on generation-lost.
			portToKill?.setStatus({ gone: true });
			mode.agentView?.reset("generation-lost");
			for (const listener of [...ended]) {
				listener({
					generation,
					error: new Error("engine stopped"),
					kind: "exit",
					expected: false,
				} as InteractiveEngineGenerationEnded);
			}
		},
		recover: (replaced: boolean) => {
			for (const listener of [...recovered]) listener(replaced);
		},
		engineMessage: (message: InteractiveEngineMessage) => {
			for (const listener of [...engineMessages]) listener(message);
		},
	};
}

describe("restoring a lost subagent chat's unsaved queued messages into its own editor", () => {
	test(
		"restores unsent absent-receipt and listed messages immediately into the matching open writable child composer ahead of its draft, never touching main",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				queued: { steering: ["listed steer"], followUp: [] },
				delivering: { steering: ["never saved"], followUp: [] },
				unsaved: ["saved"],
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [
						{ id: "saved-id", after: 3, local: true },
						{ id: "never-id", after: 3, local: true, typed: "never saved, as typed" },
					],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const lookupGate = Promise.withResolvers<{ saved: Set<string>; absent: Set<string> }>();
			const engine = fakeEngineHarness(host.mode, () => lookupGate.promise);

			await host.type("main draft");
			await host.view(WORKER_1);
			engine.crash(oldPort);
			assert.equal(host.mode.agentView?.viewed.kind, "main");
			assert.equal(host.mode.editor.getText(), "main draft");

			engine.recover(true);
			// Replacement engine restores the child with a new taskId/agentKey but the same physical (sessionId, sessionFile).
			const reopenedPort = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopenedPort);
			await host.view(WORKER_2);
			await host.type("active child draft");

			lookupGate.resolve({ saved: new Set(["saved-id"]), absent: new Set(["never-id"]) });
			await until(() => host!.mode.editor.getText().includes("never saved, as typed"));
			await settle();

			assert.equal(
				host.mode.editor.getText(),
				"never saved, as typed\n\nlisted steer\n\nactive child draft",
				"restores unsent-from-absent first, then listed, ahead of the active child draft",
			);
			assert.deepEqual(host.viewedNotices, [
				"warning: Engine restarted; 2 queued messages to worker weren't sent and are back in the editor",
			]);
			assert.deepEqual(host.warnings, []);

			// Switching back to main leaves main's draft untouched; reopening worker does not restore a second time.
			await host.view(undefined);
			assert.equal(host.mode.editor.getText(), "main draft");
			await host.view(WORKER_2);
			host.mode.editor.setText("");
			await host.view(undefined);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "never restored twice");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"when closed at settlement, shows main pending notice and restores one-shot on reopen only into the matching physical child, never main or a sibling",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				queued: { steering: ["listed steer"], followUp: [] },
				delivering: { steering: ["never saved"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "never-id", after: 2, local: true, typed: "never saved, as typed" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["never-id"]),
			}));

			await host.type("main draft");
			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);

			await until(() => host!.warnings.length > 0);
			await settle();
			assert.deepEqual(host.warnings, [
				"Engine restarted; 2 queued messages to worker weren't sent; they're back in its editor when you open it",
			]);
			assert.equal(host.mode.editor.getText(), "main draft", "main editor is untouched");

			// A sibling with the same display name AND the reused old taskId/agentKey, but a different sessionId, gets nothing.
			const siblingPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: "other-child-session",
				sessionFile: "/tmp/other-child-session.jsonl",
			});
			openable.ports.set(WORKER_1, siblingPort);
			await host.view(WORKER_1);
			assert.equal(host.mode.editor.getText(), "", "different physical child session gets nothing");

			// A sibling with same sessionId but different sessionFile also gets nothing.
			const wrongFilePort = new FakeAgentViewPort({
				taskId: SIBLING,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: "/tmp/different-file.jsonl",
			});
			openable.ports.set(SIBLING, wrongFilePort);
			await host.view(SIBLING);
			assert.equal(host.mode.editor.getText(), "", "different sessionFile gets nothing");

			// Opening the exact matching child writable restores once.
			const matchingPort = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, matchingPort);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "never saved, as typed\n\nlisted steer");

			// Clearing, leaving, and reopening never restores twice.
			host.mode.editor.setText("");
			await host.view(undefined);
			assert.equal(host.mode.editor.getText(), "main draft");
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "one-shot: never restored twice");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"preserves a child's parked draft behind Up history browsing rather than merging the recalled history entry",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["unsent msg"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "u1", after: 1, local: true, typed: "unsent msg" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const lookupGate = Promise.withResolvers<{ saved: Set<string>; absent: Set<string> }>();
			const engine = fakeEngineHarness(host.mode, () => lookupGate.promise);

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			reopened.delivered = ["earlier prompt"];
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			await until(() => host!.mode.defaultEditor.getHistory().includes("earlier prompt"));
			await host.type("parked draft");
			await host.press("\x01", "\x1b[A");
			assert.equal(host.mode.editor.getText(), "earlier prompt");

			lookupGate.resolve({ saved: new Set(), absent: new Set(["u1"]) });
			await until(() => host!.mode.editor.getText().includes("unsent msg"));
			assert.equal(host.mode.editor.getText(), "unsent msg\n\nparked draft");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"keeps the full-text notice and never writes when the child view is read-only at settlement or when reopened read-only",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["unsent ro"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "ro-1", after: 1, local: true, typed: "unsent ro" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["ro-1"]),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			await until(() => host!.warnings.length === 1);
			assert.equal(
				host.warnings[0],
				"Engine restarted; 1 queued message to worker wasn't sent; it's back in its editor when you open it",
			);

			// Reopening read-only must NOT write into its composer, and must fall back to full-text notice so nothing is lost.
			const roPort = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				readOnlyReason: "This subagent was stopped for good; its chat is read-only.",
			});
			openable.ports.set(WORKER_2, roPort);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "read-only composer stays empty");
			assert.deepEqual(host.warnings.slice(1), [
				"Engine restarted; 1 queued message to worker wasn't sent:\nunsent ro",
			]);

			// Opening writable later does not restore again after the read-only fallback consumed it.
			const writableLater = new FakeAgentViewPort({
				taskId: SIBLING,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(SIBLING, writableLater);
			await host.view(SIBLING);
			assert.equal(host.mode.editor.getText(), "");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	for (const reason of ["stopped", "cleared", "session-ended", "sent-elsewhere"] as const) {
		test(
			`drops pending restore when the child is invalidated (${reason}) before reopening`,
			async () => {
				host = await createHost();
				const oldPort = new FakeAgentViewPort({
					taskId: WORKER_1,
					name: "worker",
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					busy: true,
					delivering: { steering: ["stale msg"], followUp: [] },
					receipts: {
						sessionId: CHILD_SESSION,
						sessionFile: CHILD_FILE,
						taken: [{ id: "inv-1", after: 1, local: true, typed: "stale msg" }],
					},
				});
				openable.ports.set(WORKER_1, oldPort);
				const engine = fakeEngineHarness(host.mode, async () => ({
					saved: new Set<string>(),
					absent: new Set(["inv-1"]),
				}));

				await host.view(WORKER_1);
				engine.crash(oldPort);
				engine.recover(true);
				await until(() => host!.warnings.length === 1);

				engine.engineMessage({
					type: "engine_agent_queue_invalidated",
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					reason,
				});

				const reopened = new FakeAgentViewPort({
					taskId: WORKER_2,
					name: "worker",
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
				});
				openable.ports.set(WORKER_2, reopened);
				await host.view(WORKER_2);
				assert.equal(host.mode.editor.getText(), "", `pending restore dropped on ${reason}`);
				engine.detach();
			},
			HOST_TIMEOUT_MS,
		);
	}

	test(
		"drops pending restore when the host session changes (engine_extension_ui_reset)",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["old host msg"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "hs-1", after: 1, local: true, typed: "old host msg" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["hs-1"]),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			await until(() => host!.warnings.length === 1);

			engine.engineMessage({ type: "engine_extension_ui_reset" });

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "host session change dropped pending restore");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"preserves pending restore across a second crash before the child is reopened",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["survives second crash"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "sc-1", after: 1, local: true, typed: "survives second crash" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["sc-1"]),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort, 1);
			engine.recover(true);
			await until(() => host!.warnings.length === 1);

			// Second unexpected engine crash happens while user is still on main.
			engine.crash(undefined, 2);
			engine.recover(true);
			await settle();

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "survives second crash");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"keeps unknown taken messages in the unconfirmed notice and never in any editor, while restoring listed messages",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				queued: { steering: ["listed only"], followUp: [] },
				delivering: { steering: ["unknown taken"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "unk-1", after: 1, local: true }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set<string>(),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			await until(() => host!.warnings.length === 2);
			assert.deepEqual(host.warnings, [
				"Engine restarted; this message to worker may not have been delivered:\nunknown taken",
				"Engine restarted; 1 queued message to worker wasn't sent; it's back in its editor when you open it",
			]);

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "listed only");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"older engine without AgentViewStatus.sessionId falls back to full-text notice only and never writes to any editor",
		async () => {
			host = await createHost();
			// Simulates a 0.10.4 engine: receipts carries sessionId, but AgentViewStatus.sessionId is absent.
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				busy: true,
				delivering: { steering: ["legacy engine msg"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "leg-1", after: 1, local: true, typed: "legacy engine msg" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["leg-1"]),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			await until(() => host!.warnings.length === 1);
			assert.deepEqual(host.warnings, [
				"Engine restarted; 1 queued message to worker wasn't sent:\nlegacy engine msg",
			]);

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "older engine never stashes pending restore");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"invalidation arriving while receipt lookup is in flight prevents editor restore and falls back to full-text notice",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["in-flight unsent"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "inf-1", after: 1, local: true, typed: "in-flight unsent" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const lookupGate = Promise.withResolvers<{ saved: Set<string>; absent: Set<string> }>();
			const engine = fakeEngineHarness(host.mode, () => lookupGate.promise);

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			// User sends to the child by another path while receipt lookup is still in flight.
			engine.engineMessage({
				type: "engine_agent_queue_invalidated",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				reason: "sent-elsewhere",
			});
			lookupGate.resolve({ saved: new Set(), absent: new Set(["inf-1"]) });
			await until(() => host!.warnings.length === 1);
			assert.deepEqual(host.warnings, [
				"Engine restarted; 1 queued message to worker wasn't sent:\nin-flight unsent",
			]);

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "", "in-flight invalidation prevents stale editor restore");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"keeps full-text notice and writes nothing when the matching child is open and read-only at settlement",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["ro at settle"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "ros-1", after: 1, local: true, typed: "ro at settle" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const lookupGate = Promise.withResolvers<{ saved: Set<string>; absent: Set<string> }>();
			const engine = fakeEngineHarness(host.mode, () => lookupGate.promise);

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);

			const roPort = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				readOnlyReason: "This subagent was stopped for good; its chat is read-only.",
			});
			openable.ports.set(WORKER_2, roPort);
			await host.view(WORKER_2);

			lookupGate.resolve({ saved: new Set(), absent: new Set(["ros-1"]) });
			await until(() => host!.warnings.length === 1);
			assert.deepEqual(host.warnings, ["Engine restarted; 1 queued message to worker wasn't sent:\nro at settle"]);
			assert.equal(host.mode.editor.getText(), "");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"host session change while receipt lookup is in flight shows nothing and writes nothing",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["prior host session"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "hsi-1", after: 1, local: true, typed: "prior host session" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const lookupGate = Promise.withResolvers<{ saved: Set<string>; absent: Set<string> }>();
			const engine = fakeEngineHarness(host.mode, () => lookupGate.promise);

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			engine.engineMessage({ type: "engine_extension_ui_reset" });
			lookupGate.resolve({ saved: new Set(), absent: new Set(["hsi-1"]) });
			await settle();
			assert.deepEqual(host.warnings, []);
			assert.deepEqual(host.viewedNotices, []);

			const reopened = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
			});
			openable.ports.set(WORKER_2, reopened);
			await host.view(WORKER_2);
			assert.equal(host.mode.editor.getText(), "");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"preserves active draft typed for the child when restoring pending messages on reopen",
		async () => {
			host = await createHost();
			const oldPort = new FakeAgentViewPort({
				taskId: WORKER_1,
				name: "worker",
				sessionId: CHILD_SESSION,
				sessionFile: CHILD_FILE,
				busy: true,
				delivering: { steering: ["restored first"], followUp: [] },
				receipts: {
					sessionId: CHILD_SESSION,
					sessionFile: CHILD_FILE,
					taken: [{ id: "dr-1", after: 1, local: true, typed: "restored first" }],
				},
			});
			openable.ports.set(WORKER_1, oldPort);
			const engine = fakeEngineHarness(host.mode, async () => ({
				saved: new Set<string>(),
				absent: new Set(["dr-1"]),
			}));

			await host.view(WORKER_1);
			engine.crash(oldPort);
			engine.recover(true);
			await until(() => host!.warnings.length === 1);

			// User first opens a port with the same agentKey (before sessionId arrives), types a draft,
			// then sessionId arrives on status update: restored message must go ahead of the active draft.
			const lateIdPort = new FakeAgentViewPort({
				taskId: WORKER_2,
				name: "worker",
			});
			openable.ports.set(WORKER_2, lateIdPort);
			await host.view(WORKER_2);
			await host.type("my active draft");
			lateIdPort.setStatus({ sessionId: CHILD_SESSION, sessionFile: CHILD_FILE });
			await settle();
			assert.equal(host.mode.editor.getText(), "restored first\n\nmy active draft");
			engine.detach();
		},
		HOST_TIMEOUT_MS,
	);
});
