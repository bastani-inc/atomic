import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	AuthStorage,
	ModelRuntime,
	type SessionManager,
	type SessionStore,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { asAgentSession } from "../../packages/workflows/src/runs/foreground/stage-runner-session.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

test("queued children using independently opened SDK stores copy at their own admission", async () => {
	const cwd = makeTempDirectory("workflow-sdk-fork-");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(cwd, "run.sqlite")));
	const stores = new Set<SessionStore>();
	const faux = registerFauxProvider({ models: [{ id: "local" }] });
	try {
		const requests: string[][] = [];
		faux.setResponses(
			Array.from({ length: 3 }, () => (context) => {
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
		const location = { cwd, agentDir: join(cwd, "agent") };
		const adapter = createAgentSessionAdapter({
			...location,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			tools: [],
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		let source: SessionManager | undefined;
		const create = adapter.create.bind(adapter);
		adapter.create = async (options, meta) => {
			const created = await create(options, meta);
			const session = asAgentSession("session" in created ? created.session : created);
			assert.ok(session);
			const store = session.sessionManager.getSessionStore();
			assert.equal(stores.has(store), false);
			stores.add(store);
			if (meta?.stageName === "source") {
				assert.equal(options.sessionManager, undefined);
				source = session.sessionManager;
			}
			if (meta?.stageName === "left") {
				assert.ok(source);
				await source.appendMessage({ role: "user", timestamp: 2, content: "later source turn" });
			}
			return created;
		};
		const definition = workflow({
			name: "queued-forks",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const resident = ctx.stage("source", location);
				await resident.prompt("original");
				await ctx.parallel(
					[
						{ name: "left", prompt: "left" },
						{ name: "right", prompt: "right" },
					],
					{ ...location, context: "fork", forkFromSessionId: resident.sessionId, concurrency: 1 },
				);
				return {};
			},
		});
		const result = await run(
			definition,
			{},
			{ cwd, durableBackend: backend, store: createStore(), adapters: { agentSession: adapter } },
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [["original"], ["original", "left"], ["original", "later source turn", "right"]]);
	} finally {
		faux.unregister();
		await backend.close();
		for (const store of stores) await store.close();
		removeTempDirectory(cwd);
	}
});
