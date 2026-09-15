import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createWorkflowBoundarySegmentsResolver,
	workflowBoundarySegments,
} from "../../packages/workflows/src/shared/pending-stage-status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

// #3020: repeated ctx.workflow() calls must not advertise another owner's route on fallback.
test.each(["workflow:child", "first-boundary-id"])(
	"repeated nested identities preserve routing precedence for %s",
	(firstId) => {
		const root: RunSnapshot = {
			id: "root",
			name: "root",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [firstId, "second-boundary-id"].map((id) => ({
				id,
				name: "workflow:child",
				status: "running",
				parentIds: [],
				toolEvents: [],
			})),
		};
		const children: RunSnapshot[] = root.stages.map((boundary, index) => ({
			id: `child-${index}`,
			name: "child",
			inputs: {},
			status: "running",
			startedAt: 1,
			parentRunId: root.id,
			parentStageId: boundary.id,
			stages: [
				{
					id: "workflow:grandchild",
					name: "workflow:grandchild",
					status: "running",
					parentIds: [],
					toolEvents: [],
				},
			],
		}));
		const grandchildren: RunSnapshot[] = children.map((child, index) => ({
			id: `grandchild-${index}`,
			name: "grandchild",
			inputs: {},
			status: "running",
			startedAt: 1,
			parentRunId: child.id,
			parentStageId: "workflow:grandchild",
			stages: [],
		}));
		const runs = [root, ...children, ...grandchildren];
		const firstSegment = firstId === "workflow:child" ? "workflow:child" : "child-0";
		assert.deepEqual(workflowBoundarySegments(runs, children[0]!.id), [firstSegment]);
		assert.deepEqual(workflowBoundarySegments(runs, children[1]!.id), ["child-1"]);
		assert.deepEqual(workflowBoundarySegments(runs, grandchildren[0]!.id), [firstSegment, "workflow:grandchild"]);
		assert.deepEqual(workflowBoundarySegments(runs, grandchildren[1]!.id), ["child-1", "workflow:grandchild"]);
		// A sibling can be not yet started or temporarily absent during durable hydration.
		// Its materialized boundary still reserves the shared name.
		const withoutFirstChild = runs.filter((run) => run.id !== children[0]!.id);
		assert.deepEqual(workflowBoundarySegments(withoutFirstChild, children[1]!.id), ["child-1"]);
	},
);

// PR #3026: one publication must reuse its roster index across nested stage targets.
test("boundary resolver indexes the roster once for all nested runs", () => {
	const runs: RunSnapshot[] = Array.from({ length: 32 }, (_, index) => ({
		id: `run-${index}`,
		name: "nested",
		inputs: {},
		status: "running",
		startedAt: 1,
		...(index === 0 ? {} : { parentRunId: `run-${index - 1}`, parentStageId: "boundary" }),
		stages: [{ id: "boundary", name: "child", status: "running", parentIds: [], toolEvents: [] }],
	}));
	let rosterReads = 0;
	const roster = new Proxy(runs, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) rosterReads++;
			return Reflect.get(target, key, receiver);
		},
	});
	const resolve = createWorkflowBoundarySegmentsResolver(roster);
	const indexedReads = rosterReads;
	assert.ok(indexedReads > 0);
	for (let index = 0; index < runs.length; index++) {
		const expected = Array.from({ length: index }, () => "child");
		assert.deepEqual(resolve(`run-${index}`), expected);
		assert.deepEqual(resolve(`run-${index}`), expected);
	}
	assert.equal(resolve("missing"), undefined);
	assert.equal(rosterReads, indexedReads, "resolving targets must not rescan the roster");
});

test("fresh publication resolver observes added siblings and broken lineage", () => {
	const root: RunSnapshot = {
		id: "root",
		name: "root",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: [{ id: "boundary", name: "child", status: "running", parentIds: [], toolEvents: [] }],
	};
	const child: RunSnapshot = {
		id: "child-1",
		name: "child",
		inputs: {},
		status: "running",
		startedAt: 1,
		parentRunId: root.id,
		parentStageId: "boundary",
		stages: [],
	};
	const runs = [root, child];
	assert.deepEqual(createWorkflowBoundarySegmentsResolver(runs)(child.id), ["child"]);
	// Reuse the array deliberately: an array-identity cache would retain stale ownership.
	runs.push({ ...child, id: "child-2" });
	const withSibling = createWorkflowBoundarySegmentsResolver(runs);
	assert.deepEqual(withSibling(child.id), [child.id]);
	assert.deepEqual(withSibling("child-2"), ["child-2"]);
	assert.equal(createWorkflowBoundarySegmentsResolver([child])(child.id), undefined);
	assert.equal(createWorkflowBoundarySegmentsResolver([{ ...root, stages: [] }, child])(child.id), undefined);
});
