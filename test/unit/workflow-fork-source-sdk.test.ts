import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	AuthStorage,
	JsonlSessionStore,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Run stages through SDK sessions; return the user turns sent in each actual model request. */
async function requestsFor(
	body: (ctx: WorkflowRunContext, source: () => SessionManager, cwd: string) => Promise<void>,
): Promise<string[][]> {
	const cwd = makeTempDirectory("workflow-sdk-fork-");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(cwd, "run.sqlite")));
	const faux = registerFauxProvider({ models: [{ id: "local" }] });
	try {
		const requests: string[][] = [];
		faux.setResponses(
			Array.from({ length: 8 }, () => (context) => {
				requests.push(
					context.messages.flatMap((m) =>
						m.role !== "user"
							? []
							: typeof m.content === "string"
								? [m.content]
								: m.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
					),
				);
				return fauxAssistantMessage("answer");
			}),
		);
		const model = faux.getModel();
		const credentials = AuthStorage.inMemory();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "test-key",
			api: faux.api,
			models: faux.models,
		});
		const adapter = createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			tools: [],
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		let source: SessionManager | undefined;
		const create = adapter.create.bind(adapter);
		adapter.create = (...args) => {
			source ??= args[0].sessionManager;
			return create(...args);
		};
		const definition = workflow({
			name: "fork-source",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await body(
					ctx,
					() => {
						assert.ok(source);
						return source;
					},
					cwd,
				);
				return {};
			},
		});
		const result = await run(
			definition,
			{},
			{
				cwd,
				defaultSessionDir: join(cwd, "sessions"),
				store: createStore(),
				durableBackend: backend,
				adapters: { agentSession: adapter },
			},
		);
		assert.equal(result.status, "completed", result.error);
		return requests;
	} finally {
		faux.unregister();
		await backend.close();
		removeTempDirectory(cwd);
	}
}

test.each([false, true])(
	"forking the original session after its manager switches to a new session (replacement populated: %s, #5481)",
	async (populated) => {
		const requests = await requestsFor(async (ctx, manager) => {
			const source = await ctx.task("source", { prompt: "original" });
			const handle = manager();
			assert.equal(handle.getSessionId(), source.sessionId);
			await handle.newSession();
			if (populated) await handle.appendMessage({ role: "user", timestamp: 1, content: "unrelated" });
			await ctx.task("child", { prompt: "child", context: "fork", forkFromSessionId: source.sessionId });
		});
		assert.deepEqual(requests.at(-1), ["original", "child"]);
	},
);

test.each([false, true])(
	"fork uses a second writer's committed conversation in the selected store (separate directory: %s, #5481)",
	async (separate) => {
		const requests = await requestsFor(async (ctx, manager, cwd) => {
			const resident = ctx.stage("source");
			await resident.prompt("original");
			const id = resident.sessionId;
			const original = manager().getSessionStore();
			const dir = join(cwd, "other-sessions");
			const selected = separate ? await JsonlSessionStore.open(dir, { exactDirectory: true }) : original;
			try {
				if (separate) {
					const data = await original.load(id);
					await selected.create(data.header, data.entries);
				}
				const writer = await SessionManager.open(selected, id);
				await writer.appendMessage({ role: "user", timestamp: 1, content: "committed before fork" });
				await ctx.task("child", {
					prompt: "child",
					context: "fork",
					forkFromSessionId: id,
					...(separate ? { sessionDir: dir } : {}),
				});
			} finally {
				if (separate) await selected.close();
			}
		});
		assert.deepEqual(requests.at(-1), ["original", "committed before fork", "child"]);
	},
);

test("one parallel can fork the same session ID in two different stores (#5481)", async () => {
	const requests = await requestsFor(async (ctx, manager, cwd) => {
		const resident = ctx.stage("source");
		await resident.prompt("original");
		const id = resident.sessionId;
		const original = manager().getSessionStore();
		const dir = join(cwd, "other-sessions");
		const copy = await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const source = await original.load(id);
			await copy.create(source.header, source.entries);
			await (await SessionManager.open(copy, id)).appendMessage({
				role: "user",
				timestamp: 1,
				content: "copy only",
			});
			await ctx.parallel(
				[
					{ name: "left", prompt: "left" },
					{ name: "right", prompt: "right", sessionDir: dir },
				],
				{ concurrency: 1, context: "fork", forkFromSessionId: id },
			);
		} finally {
			await copy.close();
		}
	});
	assert.deepEqual(requests, [["original"], ["original", "left"], ["original", "copy only", "right"]]);
});

test("a fork record does not delay reading the prompt of a worker that already has a slot (#5481)", async () => {
	const requests = await requestsFor(async (ctx) => {
		const source = await ctx.task("source", { prompt: "original" });
		const first = { name: "first", prompt: "first at admission" };
		const second = { name: "second", prompt: "not yet admitted" };
		const group = ctx.parallel([first, second], {
			context: "fork",
			forkFromSessionId: source.sessionId,
			concurrency: 1,
			task: "fallback",
		});
		first.prompt = "too late for first";
		second.prompt = "second at admission";
		await group;
	});
	assert.deepEqual(
		requests.map((turns) => turns.at(-1)),
		["original", "first at admission", "second at admission"],
	);
});

test("a queued forked worker reads its authored prompt on admission (#5481)", async () => {
	const requests = await requestsFor(async (ctx) => {
		const source = await ctx.task("source", { prompt: "original" });
		class Next {
			name = "second";
			get prompt() {
				return "authored prompt";
			}
		}
		await ctx.parallel([{ name: "first", prompt: "first prompt" }, new Next()], {
			context: "fork",
			forkFromSessionId: source.sessionId,
			concurrency: 1,
			task: "shared fallback",
		});
	});
	assert.deepEqual(
		requests.map((turns) => turns.at(-1)),
		["original", "first prompt", "authored prompt"],
	);
});
