import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { planVerbatimCompaction } from "../src/core/agent-session-compaction.ts";
import { authForStream } from "../src/core/agent-session-models.ts";
import { COMPACTION_RECALL_HEADING } from "../src/core/compaction/history-recall.js";
import { stripVerbatimCompactionPrefix, VERBATIM_COMPACTION_PREFIX, verbatimRecallHint } from "../src/core/messages.js";
import type { CompactionEntry } from "../src/core/session-manager-types.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import {
	appendMessages,
	assistantMessage,
	boundaryText,
	type CompactingSession,
	CYCLE_ONE_DECISION,
	compactOnce,
	createCompactingSession,
	failingLoadStore,
	firstCycleMessages,
	historyTools,
	KEPT_NOTE,
	LATEST_REQUEST,
	OTHER_SESSION_FINDING,
	OTHER_SESSION_ID,
	RUN_ERROR_LINE,
	RUN_ID,
	recalledLines,
	recalledSection,
	recalledSources,
	SESSION_STORES,
	STAGE_FINDING,
	STAGE_SESSION_ID,
	secondCycleMessages,
	seedOtherHistory,
	thirdCycleMessages,
	withoutRecalledSection,
	workflowRunControl,
} from "./history-recall-test-helpers.ts";

useTemporaryAgentDir();

const LATER_NOTE = "zebra_cache_eviction stays tied to the ttl_sweeper_v2 timer";
const FIRST_CYCLE_PLAN = "2,2\n";
const SECOND_CYCLE_PLAN = "3,5\n";
const THIRD_CYCLE_PLAN = "3,3\n";

function assertIncludes(text: string, part: string): void {
	assert.ok(text.includes(part), `expected ${JSON.stringify(part)} in:\n${text}`);
}

function lineOf(transcript: string, needle: string): number {
	const index = transcript.split("\n").findIndex((line) => line.includes(needle));
	assert.ok(index >= 0, `expected a line with ${JSON.stringify(needle)}`);
	return index + 1;
}

describe.each(SESSION_STORES)("history recall during compaction over $name (#4568)", (backend) => {
	let dir: string;
	let cwd: string;
	const open: Array<() => Promise<void>> = [];
	const sessions: CompactingSession[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-history-recall-step-"));
		cwd = join(dir, "project");
	});
	afterEach(async () => {
		for (const { session } of sessions.splice(0)) session.dispose();
		for (const close of open.splice(0)) await close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function seededStore() {
		const { store, close } = await backend.open(dir);
		open.push(close);
		await seedOtherHistory(store, cwd);
		return store;
	}

	async function twiceCompacted(
		options: {
			settings?: Parameters<typeof createCompactingSession>[0]["settings"];
			internal?: boolean;
			sessionCwd?: string;
		} = {},
	) {
		const store = await seededStore();
		const stageIds = (): string[] =>
			compacting ? [STAGE_SESSION_ID, compacting.session.sessionId] : [STAGE_SESSION_ID];
		const workflows = workflowRunControl(stageIds);
		const compacting: CompactingSession = await createCompactingSession({
			store,
			cwd: options.sessionCwd ?? cwd,
			plannerResponses: [FIRST_CYCLE_PLAN, SECOND_CYCLE_PLAN, THIRD_CYCLE_PLAN],
			workflows,
			...(options.settings ? { settings: options.settings } : {}),
			...(options.internal ? { internal: true } : {}),
		});
		sessions.push(compacting);
		await appendMessages(compacting, firstCycleMessages());
		const first = await compactOnce(compacting);
		await appendMessages(compacting, secondCycleMessages());
		const second = await compactOnce(compacting);
		return { compacting, store, workflows, first, second };
	}

	it("adds sourced snippets from an earlier cycle, another session, a workflow run and its stage (#4568)", async () => {
		const { compacting, workflows, first, second } = await twiceCompacted();
		const id = compacting.session.sessionId;
		assert.ok(!first.includes(COMPACTION_RECALL_HEADING), "the first cycle has no task terms to recall with");
		assert.ok(
			!withoutRecalledSection(second).includes(CYCLE_ONE_DECISION),
			"cycle 2's kept text no longer holds the line cycle 1 removed",
		);

		const sources = recalledSources(second);
		const lines = recalledLines(second);
		assert.deepEqual(
			lines.slice().sort(),
			[CYCLE_ONE_DECISION, OTHER_SESSION_FINDING, STAGE_FINDING, RUN_ERROR_LINE].sort(),
			`the section holds one snippet per earlier source:\n${recalledSection(second).join("\n")}`,
		);
		assert.deepEqual(
			sources.map((source) => source.replace(/:\d+-\d+$/, "")).sort(),
			[
				`history://sessions/${id}`,
				`history://sessions/${OTHER_SESSION_ID}`,
				`history://sessions/${STAGE_SESSION_ID}`,
				`history://workflows/${RUN_ID}`,
			].sort(),
		);

		const { read } = historyTools(compacting.session, cwd, workflows);
		for (const source of sources) {
			const opened = await read(source);
			const snippet = lines[sources.indexOf(source)];
			assertIncludes(opened, snippet);
		}
	});

	it("opens a recalled earlier-cycle line from the original transcript with the source it names (#4568)", async () => {
		const { compacting, workflows, second } = await twiceCompacted();
		const id = compacting.session.sessionId;
		const source = recalledSources(second).find((entry) => entry.startsWith(`history://sessions/${id}:`));
		assert.ok(source, "the earlier cycle is among the sources");
		const transcript = await historyTools(compacting.session, cwd, workflows).read(`history://sessions/${id}`);
		const line = lineOf(transcript, CYCLE_ONE_DECISION);
		assert.equal(source, `history://sessions/${id}:${line}-${line}`);
		assertIncludes(await historyTools(compacting.session, cwd, workflows).read(source), CYCLE_ONE_DECISION);
	});

	it("commits the section into the persisted boundary and the model-facing context once (#4568)", async () => {
		const { compacting, second } = await twiceCompacted();
		const [entry] = compacting.session.sessionManager
			.getBranch()
			.filter((candidate): candidate is CompactionEntry => candidate.type === "compaction")
			.slice(-1);
		assert.equal(entry.summary, second);
		const boundary = boundaryText(compacting.session);
		assertIncludes(boundary, second);
		assert.equal(boundary.split(COMPACTION_RECALL_HEADING).length - 1, 1);
		assert.equal(
			stripVerbatimCompactionPrefix(boundary.slice(0, boundary.indexOf(second) + second.length)),
			second,
			"the TUI strips the whole multi-line recall note and shows the compacted text",
		);
	});

	it("never repeats a kept line, including the kept tail and the kept note (#4568)", async () => {
		const { compacting, second } = await twiceCompacted();
		const kept = withoutRecalledSection(second).split("\n");
		assertIncludes(second, KEPT_NOTE);
		for (const line of recalledLines(second)) {
			assert.ok(!kept.includes(line), `a kept line was recalled: ${line}`);
			assert.notEqual(line, KEPT_NOTE);
		}
		const boundary = boundaryText(compacting.session);
		assert.equal(boundary.split(KEPT_NOTE).length - 1, 1, "the kept note appears once");
		assert.equal(
			boundary.split(LATEST_REQUEST).length - 1,
			1,
			"the latest request is kept in the tail, not recalled",
		);
	});

	it("adds nothing when compaction.historyRecall is false (#4568)", async () => {
		const { first, second } = await twiceCompacted({ settings: { compaction: { historyRecall: false } } });
		assert.ok(!first.includes(COMPACTION_RECALL_HEADING));
		assert.ok(!second.includes(COMPACTION_RECALL_HEADING));
		assert.ok(!second.includes("history://sessions/"));
	});

	it("keeps recalling across a third cycle without repeating anything it already shows (#4568)", async () => {
		const { compacting } = await twiceCompacted();
		await appendMessages(compacting, thirdCycleMessages());
		const third = await compactOnce(compacting);
		const boundary = boundaryText(compacting.session);
		for (const line of [CYCLE_ONE_DECISION, OTHER_SESSION_FINDING, STAGE_FINDING, RUN_ERROR_LINE]) {
			assert.equal(boundary.split(line).length - 1, 1, `${line} appears once in the context`);
		}
		const recalled = recalledLines(third);
		assert.equal(new Set(recalled).size, recalled.length, "no recalled line repeats within the section");
	});

	it("treats entries added after a background compaction's frozen history as kept (#4568)", async () => {
		const store = await seededStore();
		const compacting = await createCompactingSession({
			store,
			cwd,
			plannerResponses: [FIRST_CYCLE_PLAN],
			workflows: workflowRunControl(),
		});
		sessions.push(compacting);
		await appendMessages(compacting, firstCycleMessages());
		const frozenHistory = compacting.manager.getBranch();
		await appendMessages(compacting, [
			{ role: "user", content: `Later note: ${LATER_NOTE}`, timestamp: 20 },
			assistantMessage("later answer", 21),
		]);
		const { session } = compacting;
		const abortController = new AbortController();
		const planned = await planVerbatimCompaction.call(
			session as never,
			{
				reason: "threshold",
				urgency: "recoverable",
				query: LATEST_REQUEST,
				abortController,
				resolvePlannerAuth: async (candidate, signal) =>
					authForStream(
						session as never,
						await session._getRequiredRequestAuth(candidate, signal ?? abortController.signal),
					),
			},
			frozenHistory,
		);
		assert.ok(planned);
		assert.ok(
			recalledLines(planned.text).includes(CYCLE_ONE_DECISION),
			"the frozen history's removed line is recalled",
		);
		assert.ok(!planned.text.includes(LATER_NOTE), "the later entry replays after the boundary, so it is kept");
	});

	it("compacts normally and adds no section when the history store cannot be read (#4568)", async () => {
		const { store: seeded, close } = await backend.open(join(dir, "failing"));
		open.push(close);
		await seedOtherHistory(seeded, cwd);
		const failing = failingLoadStore(seeded);
		const compacting = await createCompactingSession({
			store: failing.store,
			cwd,
			plannerResponses: [FIRST_CYCLE_PLAN, SECOND_CYCLE_PLAN],
			workflows: workflowRunControl(),
		});
		sessions.push(compacting);
		await appendMessages(compacting, firstCycleMessages());
		await compactOnce(compacting);
		await appendMessages(compacting, secondCycleMessages());
		failing.arm();
		const second = await compactOnce(compacting);
		assertIncludes(second, KEPT_NOTE);
		assert.ok(!second.includes(COMPACTION_RECALL_HEADING));
	});

	it("recalls for a workflow stage session whose directory differs from the project's (#4568)", async () => {
		const worktree = join(dir, "stage-worktree");
		const { compacting, second } = await twiceCompacted({ internal: true, sessionCwd: worktree });
		assert.equal(compacting.session.sessionManager.getHeader()?.internal, true);
		const id = compacting.session.sessionId;
		const lines = recalledLines(second);
		assert.ok(lines.includes(CYCLE_ONE_DECISION), "its own earlier cycle");
		assert.ok(lines.includes(RUN_ERROR_LINE), "the workflow run");
		assert.ok(lines.includes(STAGE_FINDING), "a sibling stage's transcript");
		assert.ok(!lines.includes(OTHER_SESSION_FINDING), "another directory's sessions stay out of view");
		assert.equal(
			lines.filter((line) => line === CYCLE_ONE_DECISION).length,
			1,
			"reached through two routes, shown once",
		);
		assert.ok(recalledSources(second).some((source) => source.startsWith(`history://sessions/${id}:`)));
	});
});

describe.each(SESSION_STORES)(
	"the recall note's URLs work from a twice-compacted session over $name (#4568)",
	(backend) => {
		let dir: string;
		const cleanups: Array<() => Promise<void> | void> = [];

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "atomic-history-recall-urls-"));
		});
		afterEach(async () => {
			for (const cleanup of cleanups.splice(0)) await cleanup();
			rmSync(dir, { recursive: true, force: true });
		});

		async function twiceCompactedSession(extraSessions = 0) {
			const cwd = join(dir, "project");
			const { store, close } = await backend.open(dir);
			cleanups.push(close);
			await seedOtherHistory(store, cwd);
			for (let index = 0; index < extraSessions; index++) {
				const createdAt = Date.parse("2026-10-10T00:00:00.000Z") + index * 60_000;
				await store.create(
					{
						id: `newer-${index}`,
						version: SESSION_FORMAT_VERSION,
						createdAt: new Date(createdAt).toISOString(),
						cwd,
					},
					[
						{
							type: "message",
							id: `n${index}`,
							parentId: null,
							timestamp: new Date(createdAt).toISOString(),
							message: { role: "user", content: `unrelated work ${index}`, timestamp: createdAt },
						},
					],
				);
			}
			const workflows = workflowRunControl();
			const compacting = await createCompactingSession({
				store,
				cwd,
				plannerResponses: [FIRST_CYCLE_PLAN, SECOND_CYCLE_PLAN],
				workflows,
				settings: { compaction: { historyRecall: false } },
			});
			cleanups.push(() => compacting.session.dispose());
			await appendMessages(compacting, firstCycleMessages());
			await compactOnce(compacting);
			await appendMessages(compacting, secondCycleMessages());
			await compactOnce(compacting);
			return { compacting, tools: historyTools(compacting.session, cwd, workflows) };
		}

		it("tells the agent where to recall from and when (#4568)", async () => {
			const { compacting } = await twiceCompactedSession();
			const id = compacting.session.sessionId;
			const hint = verbatimRecallHint(id);
			assert.ok(hint.split("\n").filter((line) => line !== "").length <= 4, "the note stays a few lines");
			for (const part of [
				`history://sessions/${id}`,
				"`search` on that URL",
				"earlier compaction cycles",
				"`read` with `:N-M`",
				"`search history://sessions`",
				"`search history://workflows`",
				"`search history://`",
				"before redoing an investigation",
				"removed decision, error message, file path or result",
				"newest",
				"`?offset=`",
			]) {
				assertIncludes(hint, part);
			}
			assertIncludes(boundaryText(compacting.session), hint);
			assert.equal(stripVerbatimCompactionPrefix(`${VERBATIM_COMPACTION_PREFIX}${hint}body`), "body");
		});

		it("searches and reads this session's earlier compaction cycle through its own URL (#4568)", async () => {
			const { compacting, tools } = await twiceCompactedSession();
			const url = `history://sessions/${compacting.session.sessionId}`;
			assert.ok(!boundaryText(compacting.session).includes(CYCLE_ONE_DECISION), "cycle 1's line left the context");
			const found = await tools.search("zebra_cache_eviction", url);
			const match = new RegExp(`${url.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}:(\\d+): ${CYCLE_ONE_DECISION}`).exec(
				found,
			);
			assert.ok(match, `search finds the earlier cycle's line in:\n${found}`);
			assertIncludes(await tools.read(`${url}:${match[1]}-${match[1]}`), CYCLE_ONE_DECISION);
		});

		it("searches and reads another session through history://sessions (#4568)", async () => {
			const { tools } = await twiceCompactedSession();
			const found = await tools.search("zebra_cache_eviction", "history://sessions");
			const match = new RegExp(`history://sessions/${OTHER_SESSION_ID}:(\\d+): ${OTHER_SESSION_FINDING}`).exec(
				found,
			);
			assert.ok(match, `search finds the other session's line in:\n${found}`);
			assertIncludes(
				await tools.read(`history://sessions/${OTHER_SESSION_ID}:${match[1]}-${match[1]}`),
				OTHER_SESSION_FINDING,
			);
		});

		it("searches and reads a workflow run and its stage through history://workflows (#4568)", async () => {
			const { tools } = await twiceCompactedSession();
			const found = await tools.search("zebra_cache_eviction", "history://workflows");
			const run = new RegExp(`history://workflows/${RUN_ID}:(\\d+): ${RUN_ERROR_LINE}`).exec(found);
			assert.ok(run, `search finds the run's error in:\n${found}`);
			assertIncludes(await tools.read(`history://workflows/${RUN_ID}:${run[1]}-${run[1]}`), RUN_ERROR_LINE);
			const stage = new RegExp(`history://sessions/${STAGE_SESSION_ID}:(\\d+): ${STAGE_FINDING}`).exec(found);
			assert.ok(stage, `search finds the stage transcript in:\n${found}`);
			assertIncludes(
				await tools.read(`history://sessions/${STAGE_SESSION_ID}:${stage[1]}-${stage[1]}`),
				STAGE_FINDING,
			);
		});

		it("searches sessions and workflow runs together through history:// (#4568)", async () => {
			const { tools } = await twiceCompactedSession();
			const found = await tools.search("zebra_cache_eviction", "history://");
			assertIncludes(found, `history://sessions/${OTHER_SESSION_ID}:`);
			assertIncludes(found, `history://workflows/${RUN_ID}:`);
			assertIncludes(found, `history://sessions/${STAGE_SESSION_ID}:`);
		});

		it("covers the newest records first and pages on with ?offset= (#4568)", async () => {
			const { tools } = await twiceCompactedSession(25);
			const newest = await tools.search("zebra_cache_eviction", "history://sessions");
			assert.ok(!newest.includes(OTHER_SESSION_ID), "the oldest session is past the default window");
			assertIncludes(newest, "searched sessions 1-25 of 26; continue with history://sessions?offset=25");
			const next = await tools.search("zebra_cache_eviction", "history://sessions?offset=25");
			assertIncludes(next, `history://sessions/${OTHER_SESSION_ID}:`);
		});
	},
);
