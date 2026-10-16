import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";

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
