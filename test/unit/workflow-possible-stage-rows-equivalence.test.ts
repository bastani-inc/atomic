/**
 * Incremental possible-stage rows equal the rows recomputed from scratch.
 *
 * The root run's route announcement carries its possible-future rows and every sticky entry's delivery
 * state on every matching stage. The incremental index reuses rows and statuses between announcements,
 * so these tests mutate random invocations in place, the way the store does, and compare the index and
 * the bridge's announcements against verbatim copies of the code that recomputed everything.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createJournalProjection, type DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import {
	boundPossibleStageDeliveryStates,
	type PossibleStageRow,
	PossibleStageRowsIndex,
	WorkflowTopologyIndex,
} from "../../packages/workflows/src/shared/possible-stage-rows.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
	RunSnapshot,
	StageSnapshot,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import { possibleStageRows } from "../helpers/reference-possible-stage-rows/possible-stage-rows.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT_RUN_ID = testRunId("possible-stage-rows-equivalence-root");
const OTHER_ROOT_RUN_ID = testRunId("possible-stage-rows-equivalence-other");
const STATUSES: readonly StageStatus[] = ["pending", "running", "completed", "failed", "skipped", "awaiting_input"];
const NAMES = ["worker", "reviewer", "fixer", "child-c001", "child-c002", "child-c003", "s1"];
const GLOBS = ["*", "**", "child-*", "*-c00*", "w*"];
const SEEDS = 120;
const STEPS = 60;

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A random invocation that one history mutates in place, as the store mutates its live runs. */
class History {
	readonly runs: Mutable<RunSnapshot>[] = [];
	readonly receipts: { messageId: string; delivery: PendingStageMessageDelivery; counted: boolean }[] = [];
	private readonly next: () => number;
	private serial = 0;

	constructor(seed: number) {
		this.next = random(seed);
		this.runs.push({
			id: ROOT_RUN_ID,
			name: "pool",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [this.stage("orchestrator")],
			startedAt: 1,
			possibleStages: ["child-*/worker", "reviewer", "child-c001/fixer"],
			pendingStageMessages: [],
		} as Mutable<RunSnapshot>);
		for (let child = 0; child < 3; child++) this.addChild();
		for (let entry = 0; entry < 6; entry++) this.queueSticky();
	}

	pick<T>(values: readonly T[]): T {
		return values[Math.floor(this.next() * values.length)]!;
	}

	get root(): Mutable<RunSnapshot> {
		return this.runs.find((run) => run.id === ROOT_RUN_ID)!;
	}

	private stage(id: string, extra: Partial<StageSnapshot> = {}): StageSnapshot {
		return {
			id,
			name: this.next() < 0.7 ? id : this.pick(NAMES),
			status: this.pick(STATUSES),
			parentIds: [],
			toolEvents: [],
			...(this.next() < 0.8 ? { pendingStageDeliveryAvailable: true } : {}),
			...(this.next() < 0.5 ? { sessionId: `session-${this.serial++}` } : {}),
			...extra,
		} as StageSnapshot;
	}

	addChild(): void {
		const parent = this.next() < 0.75 ? this.root : this.pick(this.runs);
		const childId = testRunId(`possible-stage-rows-child-${this.serial++}`);
		const boundaryId = `boundary-${this.serial++}`;
		parent.stages.push({
			id: boundaryId,
			name: this.next() < 0.8 ? `child-c00${1 + Math.floor(this.next() * 3)}` : this.pick(NAMES),
			status: this.next() < 0.85 ? "running" : this.pick(STATUSES),
			parentIds: [],
			toolEvents: [],
			...(this.next() < 0.9 ? { workflowChildRun: { runId: childId, alias: "child", workflow: "child" } } : {}),
		} as StageSnapshot);
		this.runs.push({
			id: childId,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: parent.id,
			parentStageId: boundaryId,
			...(this.next() < 0.9 ? { rootRunId: this.next() < 0.95 ? ROOT_RUN_ID : OTHER_ROOT_RUN_ID } : {}),
			toolNodes: [],
			stages: Array.from({ length: 1 + Math.floor(this.next() * 3) }, () => this.stage(this.pick(NAMES))),
			startedAt: 2,
		} as Mutable<RunSnapshot>);
	}

	private target(): string {
		const roll = this.next();
		if (roll < 0.08) return `workflow:${OTHER_ROOT_RUN_ID}/**`;
		if (roll < 0.15) return `workflow:${ROOT_RUN_ID}/**`;
		const segments = Array.from({ length: 1 + Math.floor(this.next() * 3) }, () =>
			this.next() < 0.35 ? this.pick(GLOBS) : this.pick(NAMES),
		);
		return `workflow:${ROOT_RUN_ID}/${segments.join("/")}`;
	}

	private set list(messages: PendingStageMessage[]) {
		this.root.pendingStageMessages = messages;
	}

	private get list(): PendingStageMessage[] {
		return this.root.pendingStageMessages ?? [];
	}

	queueSticky(): void {
		const target = this.target();
		const id = `sticky-${this.serial++}`;
		this.list = [
			...this.list,
			{
				id,
				runId: ROOT_RUN_ID,
				stageKey: target,
				...(this.next() < 0.9 ? { targetPath: target } : {}),
				from: { id: "planner", name: "planner" },
				message: { id, timestamp: 1, content: { text: id } },
				queuedAt: "2026-10-25T00:00:00.000Z",
				admissionOrder: this.serial,
				status: "queued",
				sticky: true,
				deliveries: [],
				deliveryCount: 0,
			} as PendingStageMessage,
		];
	}

	private stageRef(): { run: RunSnapshot; stage: StageSnapshot } | undefined {
		const run = this.pick(this.runs);
		return run.stages.length === 0 ? undefined : { run, stage: this.pick(run.stages) };
	}

	step(): string {
		const roll = this.next();
		const list = this.list;
		const sticky = list.flatMap((entry, index) => (entry.sticky === true ? [index] : []));
		if (roll < 0.12) {
			this.queueSticky();
			return "queue sticky";
		}
		if (roll < 0.35 && sticky.length > 0) {
			const index = this.pick(sticky);
			const ref = this.stageRef();
			if (ref === undefined) return "no stage";
			const entry = list[index]!;
			const delivery = {
				runId: ref.run.id,
				stageId: ref.stage.id,
				...(this.next() < 0.7 ? { sessionId: ref.stage.sessionId ?? `session-${this.serial++}` } : {}),
				...(this.next() < 0.85 ? { admission: this.next() < 0.6 ? "context" : "transport" } : {}),
				deliveredAt: "2026-10-25T00:00:01.000Z",
			} as PendingStageMessageDelivery;
			const next = [...list];
			next[index] = {
				...entry,
				deliveries: [...(entry.deliveries ?? []), delivery],
				deliveryCount: (entry.deliveryCount ?? 0) + 1,
			};
			this.list = next;
			return "record delivery";
		}
		if (roll < 0.42 && sticky.length > 0) {
			const index = this.pick(sticky);
			const next = [...list];
			next[index] = { ...list[index]!, status: this.next() < 0.5 ? "delivered" : "queued" };
			this.list = next;
			return "settle";
		}
		if (roll < 0.47 && list.length > 0) {
			const index = Math.floor(this.next() * list.length);
			this.list = list.filter((_, position) => position !== index);
			return "retain";
		}
		if (roll < 0.5) {
			this.list = [
				...list,
				{
					id: `exact-${this.serial++}`,
					runId: ROOT_RUN_ID,
					stageKey: "orchestrator",
					from: { id: "planner", name: "planner" },
					message: { id: `exact-${this.serial}`, timestamp: 1, content: { text: "exact" } },
					queuedAt: "2026-10-25T00:00:00.000Z",
					admissionOrder: this.serial,
					status: "queued",
				} as PendingStageMessage,
			];
			return "queue exact";
		}
		if (roll < 0.68) {
			const ref = this.stageRef();
			if (ref === undefined) return "no stage";
			const stage = ref.stage as Mutable<StageSnapshot>;
			const field = this.next();
			if (field < 0.5) stage.status = this.pick(STATUSES);
			else if (field < 0.7) stage.sessionId = this.next() < 0.3 ? undefined : `session-${this.serial++}`;
			else if (field < 0.85) stage.error = this.next() < 0.5 ? undefined : "boom";
			else stage.pendingStageDeliveryAvailable = this.next() < 0.5 ? undefined : true;
			return "stage field";
		}
		if (roll < 0.74) {
			const run = this.pick(this.runs);
			run.stages.push(this.stage(this.pick(NAMES)));
			return "stage start";
		}
		if (roll < 0.79) {
			this.addChild();
			return "child run";
		}
		if (roll < 0.83) {
			// A resumed run replaces its snapshot with a copy.
			const index = Math.floor(this.next() * this.runs.length);
			const run = this.runs[index]!;
			this.runs[index] = { ...run, stages: run.stages.map((stage) => ({ ...stage })) };
			return "replace run";
		}
		if (roll < 0.86) {
			const run = this.pick(this.runs);
			if (run.id === ROOT_RUN_ID) return "keep root";
			run.parentStageId = this.next() < 0.5 ? "missing-boundary" : run.parentStageId;
			run.rootRunId = this.next() < 0.5 ? undefined : run.rootRunId;
			return "lineage";
		}
		if (roll < 0.9) {
			this.root.possibleStages = Array.from({ length: Math.floor(this.next() * 4) }, () =>
				Array.from({ length: 1 + Math.floor(this.next() * 2) }, () =>
					this.next() < 0.3 ? this.pick(GLOBS) : this.pick(NAMES),
				).join("/"),
			);
			return "scan";
		}
		if (roll < 0.92) {
			this.root.status = this.next() < 0.5 ? "completed" : "running";
			return "root status";
		}
		const entry = list[Math.floor(this.next() * list.length)];
		const ref = this.stageRef();
		if (entry === undefined || ref === undefined) return "no receipt";
		this.receipts.push({
			messageId: entry.id,
			delivery: {
				runId: ref.run.id,
				stageId: ref.stage.id,
				...(this.next() < 0.7 ? { sessionId: ref.stage.sessionId ?? "other-session" } : {}),
				...(this.next() < 0.8 ? { admission: this.next() < 0.7 ? "context" : "transport" } : {}),
				deliveredAt: "2026-10-25T00:00:01.000Z",
			} as PendingStageMessageDelivery,
			counted: this.next() < 0.7,
		});
		return "archive receipt";
	}
}

/** The reference rows with each row's delivery states bounded, as announcements carry them. */
function bounded(rows: ReturnType<typeof possibleStageRows>): PossibleStageRow[] {
	return rows.map(({ deliveryStates, ...row }) =>
		deliveryStates === undefined ? row : { ...row, ...boundPossibleStageDeliveryStates(deliveryStates) },
	);
}

test("incremental possible-stage rows equal the rows recomputed from scratch on random histories", async () => {
	let compared = 0;
	let statuses = 0;
	let truncated = 0;
	for (let seed = 1; seed <= SEEDS; seed++) {
		const history = new History(seed);
		const projection = createJournalProjection();
		const backend = projection as unknown as DurableWorkflowBackend;
		const topology = new WorkflowTopologyIndex();
		const index = new PossibleStageRowsIndex(ROOT_RUN_ID, topology);
		let archived = 0;
		for (let step = 0; step < STEPS; step++) {
			const action = step === 0 ? "start" : history.step();
			for (; archived < history.receipts.length; archived++) {
				const receipt = history.receipts[archived]!;
				await projection.archivePendingStageDeliveryReceipt(
					ROOT_RUN_ID,
					receipt.messageId,
					receipt.delivery,
					receipt.counted ? { messageRunId: ROOT_RUN_ID, deliveryCount: archived + 1 } : undefined,
				);
			}
			topology.refresh(history.runs);
			const expected = bounded(possibleStageRows(history.runs, ROOT_RUN_ID, history.root, backend));
			const actual = index.rows(history.runs, history.root, backend);
			assert.deepEqual(actual, expected, `seed ${seed} step ${step} (${action})`);
			compared++;
			statuses += expected.reduce((total, row) => total + (row.deliveryStates?.length ?? 0), 0);
			truncated += expected.filter((row) => (row.omittedDeliveryStates ?? 0) > 0).length;
		}
	}
	// The histories must produce delivery states, or the comparison proves little.
	assert.ok(statuses > SEEDS * STEPS, `only ${statuses} delivery states compared over ${compared} announcements`);
	assert.ok(truncated > 0, "no row was long enough to be bounded");
});

test("the bridge announces the root exactly when its route or possible-stage rows change", async () => {
	let announced = 0;
	let skipped = 0;
	for (let seed = 1; seed <= 30; seed++) {
		const history = new History(seed * 31);
		const store = createStore();
		for (const run of history.runs) store.recordRunStart(run);
		// The store keeps the history's run objects, so in-place mutations reach it.
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: ROOT_RUN_ID,
			name: "pool",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
		const roots: Record<string, unknown>[] = [];
		const bridge = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event: string, payload: Record<string, unknown>) {
						if (event !== "atomic:workflow-pending-stage-route") return;
						payload.completion = Promise.resolve();
						if (payload.runId === ROOT_RUN_ID) roots.push(payload);
					},
					on: () => () => {},
				},
			},
			store,
		);
		try {
			const content = (payload: Record<string, unknown> | undefined): string | undefined => {
				if (payload === undefined) return undefined;
				const { completion: _completion, ...rest } = payload;
				return JSON.stringify(rest);
			};
			// Registration announces the root once already.
			let previous = content(roots.at(-1));
			let archived = 0;
			for (let step = 0; step < STEPS; step++) {
				const action = step === 0 ? "start" : history.step();
				const runs = store.runs() as Mutable<RunSnapshot>[];
				// Mirror run additions and replacements into the store's run list.
				for (const run of history.runs) {
					const position = runs.findIndex((candidate) => candidate.id === run.id);
					if (position < 0) store.recordRunStart(run);
					else if (runs[position] !== run) runs[position] = run;
				}
				for (; archived < history.receipts.length; archived++) {
					const receipt = history.receipts[archived]!;
					await backend.archivePendingStageDeliveryReceipt(
						ROOT_RUN_ID,
						receipt.messageId,
						receipt.delivery,
						receipt.counted ? { messageRunId: ROOT_RUN_ID, deliveryCount: archived + 1 } : undefined,
					);
				}
				const before = roots.length;
				bridge.refresh();
				const root = store.runs().find((run) => run.id === ROOT_RUN_ID)!;
				const owner = root.parentRunId === undefined;
				if (!owner) continue;
				const latest = roots.at(-1);
				const emitted = roots.length > before;
				assert.ok(latest !== undefined, `seed ${seed} step ${step}: the root was never announced`);
				const expected = bounded(possibleStageRows(store.runs(), ROOT_RUN_ID, root, backend));
				assert.deepEqual(latest.possibleStages, expected, `seed ${seed} step ${step} (${action}): rows`);
				const current = content(latest);
				assert.equal(
					emitted,
					previous === undefined || current !== previous,
					`seed ${seed} step ${step} (${action}): announced ${emitted}`,
				);
				previous = current;
				if (emitted) announced++;
				else skipped++;
			}
		} finally {
			bridge();
		}
	}
	// Both decisions must occur: unchanged roots are skipped, changed roots are announced.
	assert.ok(announced > 100 && skipped > 100, `announced ${announced}, skipped ${skipped}`);
});
