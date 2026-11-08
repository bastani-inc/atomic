/**
 * Planning and committing a verbatim compaction are separate steps so a background task can plan while turns
 * continue. Every field the planner reports must reach both the durable boundary and the reported result, and every
 * compaction path must hand the planner the session's credentials (#4330).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { type CompactionRungResult, runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { convertToLlm } from "../src/core/messages.js";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.js";
import type { Settings } from "../src/core/settings-manager.js";
import { createHarnessWithExtensions, type FauxResponseInput, type Harness } from "./test-harness.js";

vi.mock("../src/core/compaction/compaction-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/compaction/compaction-runner.js")>();
	return { ...actual, runVerbatimCompaction: vi.fn(actual.runVerbatimCompaction) };
});

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");

const PLANNER_USAGE = {
	input: 40,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 44,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RUN: CompactionRungResult = {
	text: "[User]: kept",
	ranges: [],
	keptRanges: [],
	stats: {
		linesBefore: 26,
		linesDeleted: 25,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 300,
		tokensAfter: 10,
		percentReduction: 96.7,
	},
	rung: "fresh",
	keptTail: true,
	plannerModel: { provider: "faux", id: "borrowed" },
	usage: PLANNER_USAGE,
	backend: "summary",
	model: "faux/borrowed",
	summary: { readFiles: ["read.ts"], modifiedFiles: ["changed.ts"] },
	freshReason: "Compaction planning timed out after 1 ms",
	droppedProtected: {
		count: 2,
		lines: 7,
		ranges: [
			{ start: 3, end: 5 },
			{ start: 9, end: 12 },
		],
	},
};

const { summary: _summary, freshReason: _freshReason, droppedProtected: _droppedProtected, ...plannedFields } = RUN;
const PLANNED_RUN: CompactionRungResult = { ...plannedFields, rung: "planned", backend: "planner" };

interface AuthRequest {
	readonly apiKey: string | undefined;
	readonly signalProvided: boolean;
}

/** Resolve the planner's credentials the way a real run does, without a signal, and record what came back. */
function plannerResolvingAuth(requests: AuthRequest[]): void {
	vi.mocked(runVerbatimCompaction).mockImplementation(async (_preparation, model, request) => {
		const auth = await request.resolveAuth?.(model as Model<Api>, undefined);
		requests.push({ apiKey: auth?.apiKey, signalProvided: signals.at(-1) instanceof AbortSignal });
		return PLANNED_RUN;
	});
}

const signals: Array<AbortSignal | undefined> = [];

async function createSession(
	responses: FauxResponseInput[],
	settings: Partial<Settings>,
	sessionManager?: SessionManager,
): Promise<Harness> {
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings,
		responses,
		...(sessionManager ? { sessionManager } : {}),
	});
	harness.agent.convertToLlm = convertToLlm;
	harness.session.setActiveToolsByName([]);
	const model = harness.session.model;
	assert.ok(model);
	harness.session.modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: model.api,
		models: [model],
	});
	const resolveAuth = harness.session._getRequiredRequestAuth.bind(harness.session);
	harness.session._getRequiredRequestAuth = (candidate, signal) => {
		signals.push(signal);
		return resolveAuth(candidate, signal);
	};
	return harness;
}

const compaction = (background: boolean): Partial<Settings> => ({
	compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 0, background },
});

function boundaryOf(harness: Harness): CompactionEntry {
	const boundary = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
	assert.ok(boundary?.type === "compaction");
	return boundary;
}

describe("verbatim compaction plan and commit (#4330)", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(() => {
		vi.mocked(runVerbatimCompaction).mockReset();
		signals.splice(0);
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	test("every planner field reaches the boundary and the reported result", async () => {
		vi.mocked(runVerbatimCompaction).mockResolvedValue(RUN);
		const harness = await createSession(["first answer"], compaction(false));
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		const result = await harness.session.compact();

		assert.deepEqual(result.plannerModel, RUN.plannerModel);
		assert.equal(result.backend, "summary");
		assert.equal(result.model, "faux/borrowed");
		assert.deepEqual(result.summary, RUN.summary);
		assert.equal(result.freshReason, RUN.freshReason);
		assert.deepEqual(result.droppedProtected, RUN.droppedProtected);
		assert.deepEqual(result.usage, PLANNER_USAGE);
		assert.equal(vi.mocked(runVerbatimCompaction).mock.calls[0]?.[2].sessionId, harness.session.sessionId);

		const boundary = boundaryOf(harness);
		const details = boundary.details as Record<string, unknown>;
		assert.deepEqual(details.plannerModel, RUN.plannerModel);
		assert.equal(details.backend, "summary");
		assert.equal(details.model, "faux/borrowed");
		assert.deepEqual(details.summary, RUN.summary);
		assert.equal(details.freshReason, RUN.freshReason);
		assert.deepEqual(details.droppedProtected, RUN.droppedProtected);
		assert.deepEqual(boundary.usage, PLANNER_USAGE);
	});

	test("threshold, post-tool, and background compaction plan with the session's credentials", async () => {
		const threshold: AuthRequest[] = [];
		plannerResolvingAuth(threshold);
		const foreground = await createSession(
			[
				{ text: "first answer", usage: { input: 300, output: 10 } },
				{ text: "large", usage: { input: 850, output: 10 } },
			],
			compaction(false),
		);
		harnesses.push(foreground);
		await foreground.session.prompt(longPrompt);
		await foreground.session.prompt(`${longPrompt}\nsecond`);
		assert.deepEqual(threshold, [{ apiKey: "faux-key", signalProvided: true }]);

		const postTool: AuthRequest[] = [];
		plannerResolvingAuth(postTool);
		const directory = mkdtempSync(join(tmpdir(), "post-tool-compaction-backup-"));
		directories.push(directory);
		const preflight = await createSession(
			["first answer"],
			compaction(false),
			await SessionManager.create(directory, join(directory, "sessions")),
		);
		harnesses.push(preflight);
		await preflight.session.prompt(longPrompt);
		const oversized = Array.from({ length: 40 }, (_, index) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text: `filler ${index} ${longPrompt}` }],
			timestamp: index,
		}));
		await preflight.session._preflightPostToolContext(oversized);
		preflight.session._finishPostToolCompactionPreflight(preflight.session.agent.state.messages.slice());
		assert.deepEqual(postTool, [{ apiKey: "faux-key", signalProvided: true }]);
		const backupPath = (boundaryOf(preflight).details as { backupPath?: string }).backupPath;
		assert.ok(backupPath?.endsWith(".auto-compact.bak"), backupPath);

		const background: AuthRequest[] = [];
		plannerResolvingAuth(background);
		const task = await createSession([{ text: "first answer", usage: { input: 760, output: 10 } }], compaction(true));
		harnesses.push(task);
		await task.session.prompt(longPrompt);
		assert.equal((await task.session.awaitBackgroundCompaction()).state, "ready");
		assert.deepEqual(background, [{ apiKey: "faux-key", signalProvided: true }]);
	});
});
