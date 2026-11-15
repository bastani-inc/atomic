import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import {
	type CompactionRungResult,
	type CompactionRunRequest,
	runVerbatimCompaction,
} from "../src/core/compaction/compaction-runner.js";
import type { VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import {
	conversationRegion,
	fallbackModel,
	plannerModel,
	preparationFor,
	REFUSED_MIDSTREAM,
} from "./compaction-midstream-fixtures.js";
import {
	createFauxStreamFn,
	createHarness,
	createHarnessWithExtensions,
	type FauxResponseInput,
	fauxModel,
	type Harness,
} from "./test-harness.js";

const WHOLE = preparationFor(conversationRegion(8));
const PROVIDER_ERROR: FauxResponseInput = { stopReason: "error", error: "Invalid request" };
const timestamp = new Date(0).toISOString();
const summaryEntries: SessionEntry[] = [
	{
		type: "message",
		id: "old",
		parentId: null,
		timestamp,
		message: { role: "user", content: "history", timestamp: 0 },
	},
	{
		type: "message",
		id: "tail",
		parentId: "old",
		timestamp,
		message: { role: "user", content: "recent".repeat(20000), timestamp: 1 },
	},
];

function fallbackContext(
	fallbackModels: string[] = ["test/fallback"],
	overrides: Partial<{
		getModel: (provider: string, id: string) => Model<Api> | undefined;
		isFallbackModelAllowed: (model: Model<Api>, effort: string | undefined) => boolean;
	}> = {},
) {
	const models = [plannerModel, fallbackModel];
	return {
		fallbackModels,
		preferredProvider: "test",
		sessionThinkingLevel: "off" as const,
		registry: {
			getAvailableSnapshot: () => models,
			getModel:
				overrides.getModel ??
				((provider: string, id: string) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id)),
			hasConfiguredAuth: () => true,
		},
		...(overrides.isFallbackModelAllowed ? { isFallbackModelAllowed: overrides.isFallbackModelAllowed } : {}),
	};
}

async function compact(
	responses: FauxResponseInput[],
	options: Partial<CompactionRunRequest> & { preparation?: VerbatimCompactionPreparation; model?: Model<Api> } = {},
): Promise<{ result: CompactionRungResult; models: string[] }> {
	const { preparation = WHOLE, model = plannerModel, ...request } = options;
	const { streamFn } = createFauxStreamFn(responses);
	const models: string[] = [];
	const result = await runVerbatimCompaction(preparation, model, {
		streamFn: (candidate, context, streamOptions) => {
			models.push(candidate.id);
			return streamFn(candidate, context, streamOptions);
		},
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		...request,
	});
	return { result, models };
}

test("a provider's aborted stop advances to the fallback model instead of cancelling the run (#4977)", async () => {
	const { result, models } = await compact([{ stopReason: "aborted", error: "upstream stream closed" }, "1:1,3"], {
		fallback: fallbackContext(),
	});

	assert.equal(result.rung, "planned");
	assert.equal(result.model, "test/fallback");
	assert.deepEqual(models, ["primary", "fallback"]);
});

test("a load-bearing planned result over the hard input limit continues to the next model, then a fresh window (#4977)", async () => {
	// The session model's window holds the region only once roughly half of it is deleted.
	const narrow = { ...plannerModel, contextWindow: Math.floor(WHOLE.region.tokenEstimate * 0.8) };
	const { result, models } = await compact(["1:1,1", "1:1,1"], {
		model: narrow,
		urgency: "load_bearing",
		fallback: fallbackContext(),
	});

	assert.deepEqual(models, ["primary", "fallback"]);
	assert.equal(result.rung, "fresh");
	assert.ok(result.stats.tokensAfter <= narrow.contextWindow);
	assert.match(result.freshReason ?? "", /does not fit/);
});

test("a split part that fails without a refusal keeps the other parts' verbatim deletions (#4977)", async () => {
	const { result, models } = await compact(
		[REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "1:1,3", "not a range record at all", "checkpoint"],
		{ summaryEntries },
	);

	assert.equal(result.backend, "planner");
	assert.equal(result.summary, undefined);
	assert.deepEqual(result.ranges, [{ start: 1, end: 3 }]);
	assert.equal(models.length, 4);
});

test("a dense-token kept tail that does not fit is dropped by the fresh rung (#4977)", () => {
	const cjk = "漢字テキスト".repeat(500);
	const entries: SessionEntry[] = [
		{ type: "message", id: "old", parentId: null, timestamp, message: { role: "user", content: "x", timestamp: 0 } },
		{
			type: "message",
			id: "tail",
			parentId: "old",
			timestamp,
			message: { role: "user", content: cjk, timestamp: 1 },
		},
	];
	const preparation = prepareCompactionBoundary(
		entries,
		DEFAULT_COMPACTION_SETTINGS,
		{ preserve_recent: 1 },
		{ allowSmallRegion: true },
	);
	assert.ok(preparation);
	// chars/4 puts the tail at 750 tokens; dense text costs about one token per character.
	const window = { ...plannerModel, contextWindow: 1_000 };

	return compact(["unused"], { preparation, model: window, urgency: "load_bearing" }).then(({ result }) => {
		assert.equal(result.rung, "fresh");
		assert.equal(result.keptTail, false);
	});
});

test("a fallback candidate whose lookup throws is skipped and the next candidate plans (#4977)", async () => {
	const { result, models } = await compact([PROVIDER_ERROR, "1:1,3"], {
		urgency: "load_bearing",
		fallback: fallbackContext(["test/broken", "test/denied", "test/fallback"], {
			getModel: (provider, id) => {
				if (id === "broken") throw new Error("auth store is corrupt");
				if (id === "denied") return { ...fallbackModel, id: "denied" };
				return [plannerModel, fallbackModel].find(
					(candidate) => candidate.provider === provider && candidate.id === id,
				);
			},
			isFallbackModelAllowed: (model) => {
				if (model.id === "denied") throw new Error("policy lookup failed");
				return true;
			},
		}),
	});

	assert.equal(result.rung, "planned");
	assert.equal(result.model, "test/fallback");
	assert.deepEqual(models, ["primary", "fallback"]);
});

// Session-level commit and extension behaviour, through the real AgentSession.

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function seeded(harness: Harness): Promise<Harness> {
	harnesses.push(harness);
	for (let index = 0; index < 8; index++) {
		const text = Array.from({ length: 40 }, (_, line) => `message ${index} line ${line}`).join("\n");
		if (index % 2 === 0) {
			await harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: index });
		} else {
			await harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text }],
				api: fauxModel.api,
				provider: fauxModel.provider,
				model: fauxModel.id,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: index,
			});
		}
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

function boundaries(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

const NO_BACKGROUND = { compaction: { background: false } } as const;

test("a failed backup write still commits the boundary without a backup path (#4977)", async () => {
	const harness = await seeded(await createHarness({ responses: ["2:1,30"], settings: NO_BACKGROUND }));
	harness.sessionManager.writeBackupSnapshot = async () => {
		throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
	};

	const result = await harness.session.compact();

	assert.equal(boundaries(harness), 1);
	assert.equal(result.backupPath, undefined);
});

test("a cancel that arrives during the backup write leaves the session unchanged and reports aborted (#4977)", async () => {
	const harness = await seeded(await createHarness({ responses: ["2:1,30"], settings: NO_BACKGROUND }));
	const writeBackup = harness.sessionManager.writeBackupSnapshot.bind(harness.sessionManager);
	harness.sessionManager.writeBackupSnapshot = async (label?: string) => {
		harness.session.abortCompaction();
		return writeBackup(label);
	};

	await assert.rejects(harness.session.compact(), /Compaction cancelled/);

	assert.equal(boundaries(harness), 0);
	assert.equal(harness.eventsOfType("compaction_end").at(-1)?.aborted, true);
});

test("an extension returning empty text falls through to the planner (#4977)", async () => {
	const emptyText: ExtensionFactory = (pi) => pi.on("session_before_compact", () => ({ compactedText: "  \n" }));
	const harness = await seeded(
		await createHarnessWithExtensions({
			responses: ["2:1,30"],
			settings: NO_BACKGROUND,
			extensionFactories: [emptyText],
		}),
	);

	const result = await harness.session.compact();

	assert.equal(result.rung, "planned");
	assert.equal(harness.faux.callCount, 1);
	assert.equal(boundaries(harness), 1);
});
