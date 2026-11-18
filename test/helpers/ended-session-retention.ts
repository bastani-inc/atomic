/**
 * Shared fixture of the ended-session retention tests: a scripted model on which a parent session launches two
 * children in one `subagent` call, as a workflow stage splits its work, and each child reads a file and answers.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { type CollectionCount, collectEverythingTracked } from "./collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/**
 * Structural cost: real parent and child sessions with the bundled extensions loaded for each. A file took up to about
 * 100 s on a loaded Windows runner, and a slow parent may take up to four times its usual time.
 */
export const ENDED_SESSIONS_TIMEOUT_MS = 400_000;
/** Parents that launch children and end, as the stages of one workflow run do one after another. */
export const PARENTS = 3;
export const CHILDREN_PER_PARENT = 2;
/** The prompt on which a parent delegates. */
export const DELEGATE = "DELEGATE the reading";

const PROVIDER = "faux-ended-session-retention";
const PARENT_MODEL = "parent-retention";
const CHILD_MODEL = "child-retention";

export interface RetentionFixture {
	readonly cwd: string;
	readonly agentDir: string;
	readonly modelRuntime: ModelRuntime;
	readonly parentModel: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;
	/** Children that have answered so far. */
	childrenAnswered(): number;
	dispose(): void;
}

export function quietSettings(): SettingsManager {
	return SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		sessionSummary: { enabled: false },
	});
}

export async function createRetentionFixture(): Promise<RetentionFixture> {
	vi.stubEnv("NODE_ENV", "production");
	// The scripted provider would otherwise keep every session's last prompt as its simulated prompt cache.
	vi.stubEnv("PI_CACHE_RETENTION", "none");
	const cwd = makeTempDirectory("atomic-ended-session-retention-");
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(join(cwd, "fixture.txt"), "x".repeat(32 * 1024));
	writeFileSync(
		join(cwd, ".atomic", "agents", "worker-retention.md"),
		`---\nname: worker-retention\ndescription: Reads a fixture and answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nRead the fixture, then answer.\n`,
	);
	let answered = 0;
	const respond: FauxResponseFactory = (context, _options, _state, model) => {
		const messages = context.messages;
		if (model.id === CHILD_MODEL) {
			if (!messages.some((message) => message.role === "toolResult"))
				return fauxAssistantMessage([fauxToolCall("read", { path: "fixture.txt" })], { stopReason: "toolUse" });
			answered += 1;
			return fauxAssistantMessage("child done");
		}
		const last = messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("DELEGATE"))
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: Array.from({ length: CHILDREN_PER_PARENT }, (_, index) => ({
							agent: "worker-retention",
							task: `Read the fixture, part ${index}`,
						})),
					}),
				],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("parent done");
	};
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: PARENT_MODEL }, { id: CHILD_MODEL }] });
	faux.setResponses(Array.from({ length: 1_000 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	return {
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime,
		parentModel: faux.getModel(PARENT_MODEL),
		childrenAnswered: () => answered,
		dispose() {
			faux.unregister();
			clearSubagentControls();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		},
	};
}

/** Collects garbage until every tracked session or generation is gone, then requires that none is left. */
export async function assertEveryOneCollected(collection: CollectionCount): Promise<void> {
	await collectEverythingTracked(collection);
	if (process.env.RETENTION_SNAPSHOT) (await import("node:v8")).writeHeapSnapshot(process.env.RETENTION_SNAPSHOT);
	assert.deepEqual(
		collection.uncollected(),
		[],
		`ended sessions or generations still reachable: ${collection.uncollected().length} of ${collection.created}`,
	);
}
