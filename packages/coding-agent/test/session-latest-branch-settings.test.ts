import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { foldSessionResume, sessionResumeFrom, sessionResumePlan } from "../src/core/storage/session/session-resume.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionResume, SessionStore } from "../src/core/storage/session/types.js";

/** The boundary a context clear saves: everything before it leaves the window. */
const CLEARED = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 2,
		linesDeleted: 2,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 300,
		tokensAfter: 20,
		percentReduction: 93,
	},
} as const;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

type StoreKind = "jsonl" | "memory" | "sqlite";

async function newSession(kind: StoreKind): Promise<SessionManager> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-latest-settings-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	if (kind === "jsonl") return SessionManager.create(cwd, join(cwd, "sessions"));
	if (kind === "memory") return SessionManager.create(new MemorySessionStore(), cwd);
	const database = await openNodeSqliteDatabase(join(cwd, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return SessionManager.create(store, cwd);
}

async function reopen(kind: StoreKind, manager: SessionManager): Promise<SessionManager> {
	return kind === "jsonl"
		? SessionManager.open(manager.getSessionFile()!, undefined, undefined, { history: "tail" })
		: SessionManager.open(manager.getSessionStore(), manager.getSessionId(), undefined, { history: "tail" });
}

const say = (manager: SessionManager, text: string) =>
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });

/** Wrap `store` so `readResume` passes its result through `transform`. */
function wrapReadResume(store: SessionStore, transform: (resume: SessionResume) => SessionResume): SessionStore {
	const base = store.readResume!.bind(store);
	return Object.assign(Object.create(store) as SessionStore, {
		readResume: async (sessionId: string, leafId?: string, options?: { deferChildRecords: true }) =>
			transform(await base(sessionId, leafId, options)),
	});
}

/** Readable summary of the 0.10.4 `getLatestBranchSettings` shape. */
function describedLegacy(settings: ReturnType<SessionManager["getLatestBranchSettings"]>) {
	return {
		model: settings.model && `${settings.model.entry.provider}/${settings.model.entry.modelId}@${settings.model.seq}`,
		thinkingLevel:
			settings.thinkingLevel && `${settings.thinkingLevel.entry.thinkingLevel}@${settings.thinkingLevel.seq}`,
	};
}

/** Readable summary of the three-way `getLatestBranchSettingsWithProvenance` result. */
function describedProvenance(settings: ReturnType<SessionManager["getLatestBranchSettingsWithProvenance"]>) {
	return {
		model:
			settings.model.status === "found"
				? `found:${settings.model.entry.provider}/${settings.model.entry.modelId}@${settings.model.seq}`
				: settings.model.status,
		thinkingLevel:
			settings.thinkingLevel.status === "found"
				? `found:${settings.thinkingLevel.entry.thinkingLevel}@${settings.thinkingLevel.seq}`
				: settings.thinkingLevel.status,
	};
}

describe("the latest settings a session holds for its active branch", () => {
	for (const kind of ["memory", "jsonl", "sqlite"] as const) {
		test(`keep the 0.10.4 getLatestBranchSettings contract and carry three-way provenance after a context clear and reopen (${kind})`, async () => {
			const session = await newSession(kind);
			await session.appendModelChange("anthropic", "first");
			await session.appendThinkingLevelChange("high");
			await say(session, "one");
			const modelId = await session.appendModelChange("anthropic", "second");
			await say(session, "two");
			await session.appendCompaction("The context was cleared.", null, 300, CLEARED);
			await say(session, "three");
			const modelSeq = session.getEntrySeq(modelId)!;
			const thinkingSeq = session.getEntrySeq(
				session.getBranch().find((e) => e.type === "thinking_level_change")!.id,
			)!;
			const expectedLegacy = {
				model: `anthropic/second@${modelSeq}`,
				thinkingLevel: `high@${thinkingSeq}`,
			};
			const expectedProvenance = {
				model: `found:anthropic/second@${modelSeq}`,
				thinkingLevel: `found:high@${thinkingSeq}`,
			};

			const resume = await session.getSessionStore().readResume!(session.getSessionId());
			assert.deepEqual(resume.retainedSettings, {
				model: { status: "held", seq: modelSeq },
				thinkingLevel: { status: "held", seq: thinkingSeq },
			});

			const opened = await reopen(kind, session);

			assert.ok(opened.getHeldTail().fromSeq > modelSeq + 1, "both changes are before the window it holds");
			// 0.10.4 API contract: exact `{ model?: { entry, seq }, thinkingLevel?: { entry, seq } }` shape (no `status`).
			const legacyLive = session.getLatestBranchSettings();
			const legacyOpened = opened.getLatestBranchSettings();
			assert.equal("status" in (legacyOpened.model ?? {}), false, "0.10.4 shape has no status property");
			assert.equal("status" in (legacyOpened.thinkingLevel ?? {}), false, "0.10.4 shape has no status property");
			assert.deepEqual(describedLegacy(legacyLive), expectedLegacy);
			assert.deepEqual(describedLegacy(legacyOpened), expectedLegacy);
			assert.deepEqual(opened.getLatestBranchSettings(modelSeq), {});

			// Three-way provenance API: exact `found | none | not-held` per axis.
			assert.deepEqual(describedProvenance(session.getLatestBranchSettingsWithProvenance()), expectedProvenance);
			assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance()), expectedProvenance);
			assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(modelSeq)), {
				model: "none",
				thinkingLevel: "none",
			});
		});
	}

	test("are those of the active branch, not of a branch it left", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "first");
		const forkPoint = await say(session, "one");
		await session.appendModelChange("anthropic", "abandoned");
		await session.appendThinkingLevelChange("low");
		await session.branch(forkPoint);
		await say(session, "two");

		const legacy = describedLegacy(session.getLatestBranchSettings());
		assert.match(legacy.model ?? "", /^anthropic\/first@/);
		assert.equal(legacy.thinkingLevel, undefined);

		const provenance = describedProvenance(session.getLatestBranchSettingsWithProvenance());
		assert.match(provenance.model, /^found:anthropic\/first@/);
		assert.equal(provenance.thinkingLevel, "none");
	});

	test("a 0.10.4 custom SessionStore omitting retainedSettings keeps main's exact behavior across compaction", async () => {
		const session = await newSession("memory");
		const launchId = await say(session, "launch");
		const modelId = await session.appendModelChange("anthropic", "custom-store-model");
		const thinkingId = await session.appendThinkingLevelChange("xhigh");
		await say(session, "work");
		await session.appendCompaction("cleared", null, 300, CLEARED);
		await say(session, "after clear");
		const launchSeq = (await session.findEntrySeq(launchId))!;
		const modelSeq = (await session.findEntrySeq(modelId))!;
		const thinkingSeq = (await session.findEntrySeq(thinkingId))!;

		// Valid 0.10.4 custom store: retains settings in `state` across compaction, but does not emit `retainedSettings`.
		const customStore = wrapReadResume(session.getSessionStore(), (resume) => {
			const { retainedSettings: _omitted, ...legacyResume } = resume;
			return legacyResume;
		});
		const opened = await SessionManager.open(customStore, session.getSessionId(), undefined, { history: "tail" });

		assert.ok(opened.getHeldTail().fromSeq > thinkingSeq, "both settings lie before the held window");
		assert.deepEqual(describedLegacy(opened.getLatestBranchSettings(launchSeq)), {
			model: `anthropic/custom-store-model@${modelSeq}`,
			thinkingLevel: `xhigh@${thinkingSeq}`,
		});
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(launchSeq)), {
			model: `found:anthropic/custom-store-model@${modelSeq}`,
			thinkingLevel: `found:xhigh@${thinkingSeq}`,
		});
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(thinkingSeq)), {
			model: "none",
			thinkingLevel: "none",
		});
	});

	test("sessionResumeFrom marks an axis not-held when the returned entries omit the planned setting, independently per axis", async () => {
		const session = await newSession("memory");
		const modelId = await session.appendModelChange("anthropic", "opus");
		const thinkingId = await session.appendThinkingLevelChange("high");
		await say(session, "before clear");
		await session.appendCompaction("cleared", null, 300, CLEARED);
		await say(session, "after clear");

		const snapshot = await session.getSessionStore().load(session.getSessionId());
		const index = foldSessionResume(undefined, snapshot.entries);
		const plan = sessionResumePlan(index);
		const branch = plan.branch.flatMap(([a, b]) =>
			snapshot.entries.slice(a - 1, b).map((entry, i) => ({ seq: a + i, entry })),
		);
		const fullState = plan.state.map((seq) => ({ seq, entry: snapshot.entries[seq - 1]! }));
		const modelSeq = snapshot.entries.findIndex((e) => e.id === modelId) + 1;
		const thinkingSeq = snapshot.entries.findIndex((e) => e.id === thinkingId) + 1;

		// Omit only model_change from state -> model is not-held, thinkingLevel stays held.
		const withoutModel = sessionResumeFrom(
			index,
			snapshot.header,
			branch,
			fullState.filter((row) => row.entry.type !== "model_change"),
			snapshot.entries.at(-1)!.id,
		);
		assert.deepEqual(withoutModel.retainedSettings, {
			model: { status: "not-held" },
			thinkingLevel: { status: "held", seq: thinkingSeq },
		});

		// Omit only thinking_level_change from state -> thinkingLevel is not-held, model stays held.
		const withoutThinking = sessionResumeFrom(
			index,
			snapshot.header,
			branch,
			fullState.filter((row) => row.entry.type !== "thinking_level_change"),
			snapshot.entries.at(-1)!.id,
		);
		assert.deepEqual(withoutThinking.retainedSettings, {
			model: { status: "held", seq: modelSeq },
			thinkingLevel: { status: "not-held" },
		});
	});

	test("reports not-held per axis when a store plan explicitly marks an axis not-held, rejects stale state entries, and keeps the retained axis accurate", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "stale-older");
		const launchId = await say(session, "launch");
		await session.appendModelChange("anthropic", "newer-omitted");
		const thinkingId = await session.appendThinkingLevelChange("xhigh");
		await say(session, "work");
		await session.appendCompaction("cleared", null, 300, CLEARED);
		await say(session, "after clear");
		const launchSeq = (await session.findEntrySeq(launchId))!;
		const thinkingSeq = (await session.findEntrySeq(thinkingId))!;
		const snapshot = await session.getSessionStore().load(session.getSessionId());
		const staleEntry = snapshot.entries[0]!;

		// Store explicitly reports model as not-held while a stale earlier model_change sits in state.
		const omitModelStore = wrapReadResume(session.getSessionStore(), (resume) => ({
			...resume,
			state: [
				...resume.state.filter((row) => row.entry.type !== "model_change"),
				{ seq: 1, entry: staleEntry, onBranch: true },
			],
			retainedSettings: {
				model: { status: "not-held" },
				thinkingLevel: resume.retainedSettings!.thinkingLevel,
			},
		}));
		const opened = await SessionManager.open(omitModelStore, session.getSessionId(), undefined, {
			history: "tail",
		});

		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(0)), {
			model: "not-held",
			thinkingLevel: `found:xhigh@${thinkingSeq}`,
		});
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(launchSeq)), {
			model: "not-held",
			thinkingLevel: `found:xhigh@${thinkingSeq}`,
		});
		// Legacy 0.10.4 method omits the not-held axis rather than returning a status object or the stale entry.
		assert.deepEqual(describedLegacy(opened.getLatestBranchSettings(0)), {
			model: undefined,
			thinkingLevel: `xhigh@${thinkingSeq}`,
		});

		// Loading full history recovers full provenance for every axis.
		await opened.loadFullHistory();
		assert.equal(opened.getLatestBranchSettingsWithProvenance(launchSeq).model.status, "found");
	});

	test("fails closed to not-held when a store's retainedSettings contradicts the returned branch entries", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "before-clear");
		await say(session, "work");
		await session.appendCompaction("cleared", null, 300, CLEARED);
		await say(session, "after clear");

		// Store claims model is held at seq 1, but dropped seq 1 from state.
		const lyingHeldStore = wrapReadResume(session.getSessionStore(), (resume) => ({
			...resume,
			state: resume.state.filter((row) => row.entry.type !== "model_change"),
			retainedSettings: {
				model: { status: "held", seq: 1 },
				thinkingLevel: { status: "none" },
			},
		}));
		const openedLyingHeld = await SessionManager.open(lyingHeldStore, session.getSessionId(), undefined, {
			history: "tail",
		});
		assert.deepEqual(describedProvenance(openedLyingHeld.getLatestBranchSettingsWithProvenance(0)), {
			model: "not-held",
			thinkingLevel: "none",
		});

		// Store claims thinkingLevel is "none" while the returned branch actually contains a thinking_level_change.
		await session.appendThinkingLevelChange("high");
		const lyingNoneStore = wrapReadResume(session.getSessionStore(), (resume) => ({
			...resume,
			retainedSettings: {
				model: resume.retainedSettings!.model,
				thinkingLevel: { status: "none" },
			},
		}));
		const openedLyingNone = await SessionManager.open(lyingNoneStore, session.getSessionId(), undefined, {
			history: "tail",
		});
		assert.equal(openedLyingNone.getLatestBranchSettingsWithProvenance(0).thinkingLevel.status, "not-held");
	});

	test("an in-window branch rewind that drops an in-window setting exposes unretained pre-window history as not-held", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "pre-clear");
		await session.appendThinkingLevelChange("low");
		await say(session, "before clear");
		await session.appendCompaction("cleared", null, 300, CLEARED);
		const inWindowTargetId = await say(session, "rewind target");
		await session.appendModelChange("anthropic", "in-window-model");
		await say(session, "after in-window model");

		const opened = await reopen("memory", session);
		const targetSeq = opened.getEntrySeq(inWindowTargetId)!;
		const tailStart = opened.getHeldTail().fromSeq;
		// Before rewind, in-window model is found and pre-window thinking (held in state) is found.
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).model.status, "found");
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).thinkingLevel.status, "found");

		// Rewind inside the window past "in-window-model": "pre-clear" was never held in state because
		// "in-window-model" shadowed it, while "low" (thinking) IS still held in state!
		await opened.branch(inWindowTargetId);
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).model.status, "not-held");
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).thinkingLevel.status, "found");
		// After a position inside the held window, no model change happened in [tailStart..targetSeq] -> genuinely none.
		assert.equal(opened.getLatestBranchSettingsWithProvenance(tailStart - 1).model.status, "none");
		assert.equal(opened.getLatestBranchSettingsWithProvenance(targetSeq).model.status, "none");
	});

	test("compacting an unvouched partial manager preserves not-held, while a root-complete branch and resetLeaf keep exact provenance", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "pre-clear");
		await say(session, "one");
		await session.appendCompaction("cleared 1", null, 300, CLEARED);
		await say(session, "two");

		const omitModelStore = wrapReadResume(session.getSessionStore(), (resume) => ({
			...resume,
			state: resume.state.filter((row) => row.entry.type !== "model_change"),
			retainedSettings: {
				model: { status: "not-held" },
				thinkingLevel: resume.retainedSettings!.thinkingLevel,
			},
		}));
		const opened = await SessionManager.open(omitModelStore, session.getSessionId(), undefined, {
			history: "tail",
		});
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).model.status, "not-held");

		// A live compaction must not fabricate provenance for an axis that was already not-held.
		await opened.appendCompaction("cleared 2", null, 300, CLEARED);
		await say(opened, "three");
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).model.status, "not-held");
		assert.equal(opened.getLatestBranchSettingsWithProvenance(0).thinkingLevel.status, "none");

		// Switching to a brand-new root branch and compacting it has complete root-to-leaf history -> none, never not-held.
		await opened.branchWithSummary(null, "fresh root");
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(0)), {
			model: "none",
			thinkingLevel: "none",
		});
		await opened.appendCompaction("cleared fresh root", null, 300, CLEARED);
		await say(opened, "after fresh clear");
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(0)), {
			model: "none",
			thinkingLevel: "none",
		});

		// Resetting leaf to null has an empty active branch -> none.
		await opened.resetLeaf();
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(0)), {
			model: "none",
			thinkingLevel: "none",
		});
	});

	test("a root-complete active branch still resolves found and none even when an abandoned side branch was omitted", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "abandoned-root");
		await session.resetLeaf();
		const activeModelId = await session.appendModelChange("anthropic", "active-model");
		const activeModelSeq = session.getEntrySeq(activeModelId)!;
		// Compaction places activeModel (the branch root, parentId === null) in `state` before `tailFrom`, while the
		// active branch `[activeModel, compaction]` remains completely gap-free from root to leaf.
		await session.appendCompaction("cleared", null, 300, CLEARED);

		const storeWithNotHeld = wrapReadResume(session.getSessionStore(), (resume) => ({
			...resume,
			retainedSettings: {
				model: { status: "not-held" },
				thinkingLevel: { status: "none" },
			},
		}));
		const opened = await SessionManager.open(storeWithNotHeld, session.getSessionId(), undefined, {
			history: "tail",
		});

		assert.equal(opened.hasFullHistory(), false, "abandoned root branch was omitted");
		assert.ok(opened.getHeldTail().fromSeq > activeModelSeq, "root setting lies before tailFrom");
		assert.deepEqual(describedProvenance(opened.getLatestBranchSettingsWithProvenance(0)), {
			model: `found:anthropic/active-model@${activeModelSeq}`,
			thinkingLevel: "none",
		});
	});
});
