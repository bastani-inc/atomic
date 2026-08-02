/**
 * Tests for the cross-session durable workflow resume adapter.
 *
 * Verifies /workflow resume selector behavior: resolving durable catalog
 * entries, error paths, and successful re-dispatch with the original workflow
 * id so durable checkpoints replay.
 *
 * cross-ref: issue #1498 — /workflow resume by top-level workflow id.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isDurableWorkflowResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	prepareRuntimeDurableResumable,
	resolveDurableEntry,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";

function makeEntry(workflowId: string, name: string, status: ResumableWorkflowEntry["status"]): ResumableWorkflowEntry {
	return {
		workflowId,
		name,
		status,
		completedCheckpoints: 1,
		pendingPrompts: 0,
		createdAt: 1000,
		updatedAt: 2000,
	};
}

describe("resolveDurableEntry", () => {
	const catalog: readonly ResumableWorkflowEntry[] = [
		makeEntry(testRunId("wf-aaa-001"), "alpha", "running"),
		makeEntry(testRunId("wf-bbb-002"), "beta", "paused"),
	];

	test("exact full id match", async () => {
		const fullId = testRunId("wf-aaa-001");
		const r = resolveDurableEntry(fullId, catalog);
		assert.ok(r && !("kind" in r));
		assert.equal(r!.workflowId, fullId);
	});

	test("rejects a unique prefix and accepts the full id", async () => {
		const fullId = testRunId("wf-aaa-001");
		const malformed = resolveDurableEntry(fullId.slice(0, 8), catalog);
		assert.ok(malformed && "kind" in malformed && malformed.kind === "malformed");
		assert.match(malformed.message, /full 36-character UUID/);
		const exact = resolveDurableEntry(fullId, catalog);
		assert.ok(exact && !("kind" in exact));
		assert.equal(exact.workflowId, fullId);
	});

	test("rejects a shared prefix while full ids remain independently addressable", async () => {
		const firstId = testRunId("ambiguous-first");
		const secondId = `${firstId.slice(0, 8)}-${testRunId("ambiguous-second").slice(9)}`;
		const sharedCatalog = [makeEntry(firstId, "alpha", "running"), makeEntry(secondId, "beta", "paused")];
		const malformed = resolveDurableEntry(firstId.slice(0, 8), sharedCatalog);
		assert.ok(malformed && "kind" in malformed && malformed.kind === "malformed");
		const first = resolveDurableEntry(firstId, sharedCatalog);
		const second = resolveDurableEntry(secondId, sharedCatalog);
		assert.ok(first && !("kind" in first));
		assert.ok(second && !("kind" in second));
		assert.equal(first.workflowId, firstId);
		assert.equal(second.workflowId, secondId);
	});

	test("no match returns undefined", async () => {
		assert.equal(resolveDurableEntry(testRunId("wf-zzz"), catalog), undefined);
	});
});

describe("resumeDurableWorkflow", () => {
	let backend: InMemoryDurableBackend;
	let store: ReturnType<typeof createStore>;
	let cancellation: ReturnType<typeof createCancellationRegistry>;
	let jobs: ReturnType<typeof createJobTracker>;

	beforeEach(() => {
		backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		store = createStore();
		cancellation = createCancellationRegistry();
		jobs = createJobTracker();
	});

	afterEach(() => {
		setDurableBackend(undefined);
	});

	function makeDef(): WorkflowDefinition {
		return workflow({
			name: "resumable-pipeline",
			description: "",
			inputs: { topic: Type.String() },
			outputs: { done: Type.Optional(Type.Boolean()) },
			run: async () => ({ done: true }),
		}) as unknown as WorkflowDefinition;
	}

	function makeRegistryWith(def: WorkflowDefinition): WorkflowRegistry {
		return {
			register: () => makeRegistryWith(def),
			merge: () => makeRegistryWith(def),
			get: (name: string) => (name === def.name || name === def.normalizedName ? def : undefined),
			has: (name: string) => name === def.name || name === def.normalizedName,
			remove: () => makeRegistryWith(def),
			names: () => [def.normalizedName],
			all: () => [def],
		};
	}

	function deps() {
		return {
			registry: makeRegistryWith(makeDef()),
			baseRunOpts: { store, cancellation, jobs },
			durableBackend: backend,
		};
	}

	test("returns not_registered when id is unknown", async () => {
		const unknownId = testRunId("wf-does-not-exist");
		const result = await resumeDurableWorkflow(unknownId, deps());
		assert.equal(result.ok, false);
		assert.equal(result.reason, "not_registered");
	});

	test("rejects a unique prefix before exact-id loadability checks", async () => {
		class ExactOnlyLoadableBackend extends InMemoryDurableBackend {
			override isWorkflowLoadable(workflowId: string): boolean {
				return this.getWorkflow(workflowId) !== undefined;
			}
		}
		const exactBackend = new ExactOnlyLoadableBackend();
		const fullId = testRunId("wf-prefix-current");
		exactBackend.registerWorkflow({
			workflowId: fullId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});

		const result = await resumeDurableWorkflow(fullId.slice(0, 8), { ...deps(), durableBackend: exactBackend });

		assert.equal(result.ok, false);
		assert.equal(result.reason, "not_registered");
		assert.match(result.message, /full 36-character UUID/);
	});

	test("rejects a shared prefix while full workflow ids remain independently addressable", async () => {
		const firstId = testRunId("ambiguous-first");
		const secondId = `${firstId.slice(0, 8)}-${testRunId("ambiguous-second").slice(9)}`;
		backend.registerWorkflow({
			workflowId: firstId,
			name: "resumable-pipeline",
			inputs: { topic: "a" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		backend.registerWorkflow({
			workflowId: secondId,
			name: "resumable-pipeline",
			inputs: { topic: "b" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		const result = await resumeDurableWorkflow(firstId.slice(0, 8), deps());
		assert.equal(result.ok, false);
		assert.equal(result.reason, "not_registered");
		assert.match(result.message, /full 36-character UUID/);
		const first = resolveDurableEntry(firstId, backend.listResumableWorkflows());
		const second = resolveDurableEntry(secondId, backend.listResumableWorkflows());
		assert.ok(first && !("kind" in first));
		assert.ok(second && !("kind" in second));
		assert.equal(first.workflowId, firstId);
		assert.equal(second.workflowId, secondId);
	});

	test("returns not_resumable when status is completed", async () => {
		const workflowId = testRunId("wf-done-1");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "a" },
			createdAt: 1,
			status: "completed",
		});
		// Pass an explicit catalog containing the completed entry (the backend's
		// resumable list would filter it out) to exercise the not_resumable branch.
		const catalog = [makeEntry(workflowId, "resumable-pipeline", "completed")];
		const result = await resumeDurableWorkflow(workflowId, deps(), catalog);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "not_resumable");
	});

	test("rejects when authoritative backend state is ineligible despite stale catalog progress", async () => {
		const workflowId = testRunId("wf-zero-progress");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "paused",
		});
		const staleCatalog = [makeEntry(workflowId, "resumable-pipeline", "paused")];

		const result = await resumeDurableWorkflow(workflowId, deps(), staleCatalog);

		assert.equal(result.ok, false);
		assert.equal(result.reason, "not_resumable");
		assert.equal(backend.getWorkflow(workflowId)?.status, "paused");
	});

	test("returns workflow_not_found when definition is missing", async () => {
		const workflowId = testRunId("wf-ghost-1");
		backend.registerWorkflow({
			workflowId,
			name: "missing-workflow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, false);
		assert.equal(result.reason, "workflow_not_found");
	});

	test("rediscovers an on-the-fly project workflow from its persisted invocation cwd", async () => {
		const workflowId = testRunId("wf-reloaded-project");
		const definition = makeDef();
		const conflicting = workflow({
			name: definition.name,
			description: "wrong current project",
			inputs: { topic: Type.String() },
			outputs: { wrong: Type.Boolean() },
			run: async () => ({ wrong: true }),
		}) as unknown as WorkflowDefinition;
		backend.registerWorkflow({
			workflowId,
			name: definition.name,
			inputs: { topic: "fresh" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: "/persisted/project",
		});
		let resolvedCwd: string | undefined;
		const result = await resumeDurableWorkflow(workflowId, {
			...deps(),
			registry: makeRegistryWith(conflicting),
			resolveDefinition: async (name, cwd) => {
				resolvedCwd = cwd;
				return name === definition.name ? definition : undefined;
			},
		});
		assert.equal(result.ok, true);
		assert.equal(resolvedCwd, "/persisted/project");
		await jobs.get(workflowId)?.promise;
	});

	test("returns invalid_inputs when cached inputs fail schema validation", async () => {
		const workflowId = testRunId("wf-bad-in-1");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, false);
		assert.equal(result.reason, "invalid_inputs");
	});

	test("successfully re-dispatches with the ORIGINAL workflow id", async () => {
		const workflowId = testRunId("wf-resume-target");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "failed",
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.workflowId, workflowId);
			assert.equal(result.runId, workflowId); // runId == original workflowId for replay
			assert.match(result.message, /Resuming durable workflow/);
		}
		// Backend status flipped back to running.
		assert.equal(backend.getWorkflow(workflowId)!.status, "running");
	});
	test("includes the full workflow id in a successful resume message", async () => {
		const workflowId = "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f";
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "failed",
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);
		if (result.ok) assert.ok(result.message.includes(workflowId));
		await jobs.get(workflowId)?.promise;
	});

	test("resume succeeds when the backend has durable checkpoint state for the workflow", async () => {
		const workflowId = testRunId("wf-has-state");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.runId, workflowId);
		assert.equal(backend.getWorkflow(workflowId)?.status, "running");
	});

	test("resume refuses only when a running handle has an active live run in this session", async () => {
		const workflowId = testRunId("wf-active");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "running",
			completedCheckpoints: 1,
		});
		// No live run → crash recovery: resume is allowed even though the durable
		// handle says `running`.
		let result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);

		// With an active live run in this session, resume is refused.
		backend.setWorkflowStatus(workflowId, "running");
		store.recordRunStart({
			id: workflowId,
			name: "resumable-pipeline",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "not_resumable");
			assert.match(result.message, /already running/);
			assert.match(result.message, /\/workflow connect/);
			assert.match(result.message, /\/workflow quit/);
			assert.doesNotMatch(result.message, /\/workflow kill/);
		}
		store.removeRun(workflowId);
	});

	test("running and paused workflows are both resumable at the catalog level", async () => {
		const runningId = testRunId("wf-running");
		const pausedId = testRunId("wf-paused");
		backend.registerWorkflow({
			workflowId: runningId,
			name: "resumable-pipeline",
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 1,
		});
		backend.registerWorkflow({
			workflowId: pausedId,
			name: "resumable-pipeline",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		const ids = backend.listResumableWorkflows().map((e) => e.workflowId);
		assert.ok(ids.includes(runningId), "running is resumable (crash recovery)");
		assert.ok(ids.includes(pausedId));
	});

	test("resume removes stale quit store shadow before reusing workflow id", async () => {
		const workflowId = testRunId("wf-shadow");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		store.recordRunStart({
			id: workflowId,
			name: "stale-shadow",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			exitReason: "quit",
			resumable: true,
		});

		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);
		const matching = store.runs().filter((run) => run.id === workflowId);
		assert.equal(matching.length, 1);
		assert.equal(matching[0]?.name, "resumable-pipeline");
	});

	test("successful resume result includes runId for overlay connection (issue #1498)", async () => {
		const workflowId = testRunId("wf-overlay-connect");
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "overlay" },
			createdAt: 1,
			status: "failed",
		});
		const result = await resumeDurableWorkflow(workflowId, deps());
		assert.equal(result.ok, true);
		if (result.ok) {
			// runId is the original workflow id so the overlay connects to the
			// re-dispatched run.
			assert.equal(result.runId, workflowId);
			assert.equal(result.workflowId, workflowId);
		}
	});

	test("prepareRuntimeDurableResumable hydrates fresh persistent backend before resume", async () => {
		class HydratingBackend extends InMemoryDurableBackend {
			override readonly persistent = true;
			hydrated = false;
			async hydrateResumableWorkflows(): Promise<void> {
				this.hydrated = true;
				this.registerWorkflow({
					workflowId: testRunId("wf-hydrated"),
					name: "resumable-pipeline",
					inputs: { topic: "data" },
					createdAt: 1,
					status: "paused",
					completedCheckpoints: 1,
				});
			}
		}
		const hydrating = new HydratingBackend();
		const catalog = await prepareRuntimeDurableResumable(() => hydrating);
		assert.equal(hydrating.hydrated, true);
		assert.equal(catalog.length, 1);
		const workflowId = testRunId("wf-hydrated");
		const result = await resumeDurableWorkflow(workflowId, { ...deps(), durableBackend: hydrating });
		assert.equal(result.ok, true);
	});
});

describe("durable resume eligibility", () => {
	test("a zero-progress paused workflow is not resumable even when marked resumable", () => {
		// Policy retained from the restored-orphan contract: `resumable: true` alone
		// never manufactures a resume target. A quit with unfinished tool work
		// relies on ordinary durable progress from its completed calls.
		assert.equal(
			isDurableWorkflowResumable({
				workflowId: testRunId("zero-progress"),
				status: "paused",
				completedCheckpoints: 0,
				pendingPrompts: 0,
				resumable: true,
			}),
			false,
		);
	});

	test("a paused workflow with checkpoint progress is resumable unless refused", () => {
		assert.equal(
			isDurableWorkflowResumable({
				workflowId: testRunId("quit-with-progress"),
				status: "paused",
				completedCheckpoints: 1,
				pendingPrompts: 0,
				resumable: true,
			}),
			true,
		);
		assert.equal(
			isDurableWorkflowResumable({
				workflowId: testRunId("refused"),
				status: "paused",
				completedCheckpoints: 1,
				pendingPrompts: 0,
				resumable: false,
			}),
			false,
		);
	});

	test("a nested child workflow is never a resume target", () => {
		assert.equal(
			isDurableWorkflowResumable({
				workflowId: testRunId("child"),
				rootWorkflowId: "root",
				status: "paused",
				completedCheckpoints: 1,
				pendingPrompts: 0,
				resumable: true,
			}),
			false,
		);
	});
});
