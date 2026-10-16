import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";

interface CuratorCallbacks {
	onSubmit(payload: { selectedQueryIndices: number[]; rawResults: boolean }): void;
	onCancel(reason: "user" | "timeout" | "stale"): void;
}

const curator = vi.hoisted(() => ({
	callbacks: null as CuratorCallbacks | null,
	opened: () => {},
}));

vi.mock("../../packages/web-access/curator-server.js", () => ({
	startCuratorServer: async (_options: object, callbacks: CuratorCallbacks) => {
		curator.callbacks = callbacks;
		return {
			url: "http://example.test",
			close() {
				callbacks.onCancel("stale");
			},
			searchesDone() {},
		};
	},
}));
vi.mock("../../packages/web-access/web-search-browser.js", () => ({
	openCuratorWindow: async () => {
		curator.opened();
	},
}));
vi.mock("../../packages/web-access/web-search-config.js", () => ({
	loadCuratorBootstrap: async () => ({ availableProviders: {}, defaultProvider: "exa", timeoutSeconds: 1 }),
	normalizeQueryList: (queries: string[]) => queries,
}));
vi.mock("../../packages/web-access/web-search-summary.js", () => ({
	loadSummaryModelChoices: async () => ({ summaryModels: [], defaultSummaryModel: null }),
	resolveSummaryForSubmit: () => ({ approvedSummary: "", summaryMeta: undefined }),
}));

interface CommandModule {
	registerWebSearchCommand(
		pi: ExtensionAPI,
		deps: {
			state: { activeCurator: { close(): void } | null };
			closeCurator(): void;
			buildSearchReturn(
				options: object,
			): Promise<{ content: Array<{ type: string; text: string }>; details: object }>;
		},
	): void;
}

const { registerWebSearchCommand } = await vi.importActual<CommandModule>(
	"../../packages/web-access/web-search-command.js",
);

for (const action of ["submit", "timeout"] as const) {
	test(`websearch ${action} awaits result persistence and routes its rejection to the command handler`, async () => {
		let opened: () => void = () => {};
		const opening = new Promise<void>((resolve) => {
			opened = resolve;
		});
		curator.opened = opened;
		let rejectCommit: (error: Error) => void = () => {};
		const commit = new Promise<never>((_resolve, reject) => {
			rejectCommit = reject;
		});
		let building: () => void = () => {};
		const buildStarted = new Promise<void>((resolve) => {
			building = resolve;
		});
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		const sent: object[] = [];
		const notices: string[] = [];
		const api: Pick<ExtensionAPI, "registerCommand" | "sendMessage"> = {
			registerCommand(_name, registered) {
				command = registered;
			},
			async sendMessage(message) {
				sent.push(message);
			},
		};
		const state = { activeCurator: null as { close(): void } | null };
		registerWebSearchCommand(api as ExtensionAPI, {
			state,
			closeCurator() {
				const handle = state.activeCurator;
				state.activeCurator = null;
				handle?.close();
			},
			buildSearchReturn: () => {
				building();
				return commit;
			},
		});
		assert.ok(command);
		const completion = command.handler("", {
			sessionSignal: new AbortController().signal,
			ui: {
				notify(message: string) {
					notices.push(message);
				},
			},
		} as ExtensionCommandContext);
		await opening;
		assert.ok(curator.callbacks);
		if (action === "submit") curator.callbacks.onSubmit({ selectedQueryIndices: [], rawResults: true });
		else curator.callbacks.onCancel("timeout");
		await buildStarted;
		assert.deepEqual(sent, []);
		const failure = new StorageUnavailableError({ adapter: "test", location: "command" }, new Error("write failed"));
		rejectCommit(failure);
		await completion;
		assert.deepEqual(sent, []);
		assert.equal(notices.at(-1), `Failed to open curator: ${failure.message}`);
	});
}

for (const ending of ["reload", "shutdown"] as const) {
	for (const saving of [false, true]) {
		test(`websearch ${ending} closes an open curator and drains an admitted save (${saving})`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "curator-lifetime-"));
			const manager = await SessionManager.create(directory, directory);
			const opening = Promise.withResolvers<void>();
			curator.opened = opening.resolve;
			const saveStarted = Promise.withResolvers<void>();
			const saveRelease = Promise.withResolvers<void>();
			const append = manager.appendCustomEntry.bind(manager);
			const writes = vi.spyOn(manager, "appendCustomEntry").mockImplementation(async (type, data) => {
				saveStarted.resolve();
				await saveRelease.promise;
				return append(type, data);
			});
			const state = { activeCurator: null as { close(): void } | null };
			let closed = 0;
			let shutdown = false;
			const closeCurator = () => {
				const handle = state.activeCurator;
				state.activeCurator = null;
				if (handle) closed++;
				handle?.close();
			};
			const extensions = await createTestExtensionsResult([
				(pi) => {
					registerWebSearchCommand(pi, {
						state,
						closeCurator,
						async buildSearchReturn() {
							await pi.appendEntry("curator-save", { saved: true });
							return { content: [{ type: "text", text: "saved" }], details: {} };
						},
					});
					pi.on("session_shutdown", () => {
						shutdown = true;
						closeCurator();
					});
				},
			]);
			const loader = createTestResourceLoader({ extensionsResult: extensions });
			loader.prepareReload = async () => ({
				loader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([]) }),
				activate() {},
				commit() {},
			});
			const harness = await createHarness({ sessionManager: manager, resourceLoader: loader });
			let endingWork: Promise<void> | undefined;
			try {
				await harness.session.bindExtensions({});
				const runner = harness.session.extensionRunner;
				const command = runner.getCommand("websearch");
				assert.ok(command);
				const context = runner.createCommandContext();
				const completion = command.handler("", context);
				await opening.promise;
				if (saving) {
					curator.callbacks!.onSubmit({ selectedQueryIndices: [], rawResults: true });
					await saveStarted.promise;
				}
				let ended = false;
				endingWork = (ending === "reload" ? harness.session.reload() : harness.session.dispose()).then(() => {
					ended = true;
				});
				await vi.waitFor(() => assert.equal(closed, 1), { timeout: 500 });
				assert.equal(context.sessionSignal.aborted, true);
				assert.equal(state.activeCurator, null);
				if (saving) {
					assert.equal(ended, false, "ending waits for the pending save");
					assert.equal(shutdown, false, "save drains before session_shutdown");
				}
				saveRelease.resolve();
				await vi.waitFor(() => assert.equal(ended, true), { timeout: 1000 });
				await completion;
				assert.equal(shutdown, true);
				assert.equal(writes.mock.calls.length, saving ? 1 : 0);
				const reopened = await SessionManager.open(manager.getSessionFile()!);
				assert.equal(
					reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "curator-save")
						.length,
					saving ? 1 : 0,
				);
			} finally {
				saveRelease.resolve();
				closeCurator();
				await endingWork;
				await harness.cleanup();
				writes.mockRestore();
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
}
