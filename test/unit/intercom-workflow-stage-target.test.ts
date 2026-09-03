import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	formatWorkflowStageTarget,
	legacyWorkflowStageTargetMigrationHint,
	parseLegacyWorkflowStageTarget,
	parseWorkflowStageTarget,
	withWorkflowStageTargetFinalSegment,
} from "../../packages/intercom/workflow-stage-target.js";
import {
	formatWorkflowStageTarget as formatWorkflowStageTargetFromWorkflows,
	legacyWorkflowStageTargetMigrationHint as legacyWorkflowStageTargetMigrationHintFromWorkflows,
	parseLegacyWorkflowStageTarget as parseLegacyWorkflowStageTargetFromWorkflows,
	parseWorkflowStageTarget as parseWorkflowStageTargetFromWorkflows,
	withWorkflowStageTargetFinalSegment as withWorkflowStageTargetFinalSegmentFromWorkflows,
} from "../../packages/workflows/src/shared/workflow-stage-target.js";

const ROOT_RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const CHILD_RUN_ID = "9abf8f8d-1e08-4af8-b54c-e48ea39a3219";

const TARGET_FIXTURES = [
	`workflow:${ROOT_RUN_ID}/reviewer-a`,
	`workflow:${ROOT_RUN_ID}/stage-123`,
	`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`,
	`workflow:${ROOT_RUN_ID}/implement-slice-2/reviewer-a`,
	`workflow:${ROOT_RUN_ID}/reviewer-*`,
	`workflow:${ROOT_RUN_ID}/slice-*/reviewer-*`,
	`workflow:${ROOT_RUN_ID}/**`,
	`workflow:${ROOT_RUN_ID}/slice/**/reviewer`,
	ROOT_RUN_ID,
	`${ROOT_RUN_ID}:reviewer`,
	"workflow:",
	`workflow:${ROOT_RUN_ID}`,
	"workflow:not-a-run/reviewer",
	`workflow:${ROOT_RUN_ID}/`,
	`workflow:${ROOT_RUN_ID}//reviewer`,
	`workflow:${ROOT_RUN_ID}/reviewer/`,
] as const;

describe("workflow-stage target grammar", () => {
	test("keeps the Intercom and workflows grammar mirrors in parity", () => {
		for (const target of TARGET_FIXTURES) {
			assert.deepEqual(parseWorkflowStageTargetFromWorkflows(target), parseWorkflowStageTarget(target), target);
			assert.deepEqual(
				parseLegacyWorkflowStageTargetFromWorkflows(target),
				parseLegacyWorkflowStageTarget(target),
				target,
			);
		}
		const canonical = formatWorkflowStageTarget(ROOT_RUN_ID, CHILD_RUN_ID, "stage-id");
		assert.equal(formatWorkflowStageTargetFromWorkflows(ROOT_RUN_ID, CHILD_RUN_ID, "stage-id"), canonical);
		assert.equal(
			withWorkflowStageTargetFinalSegmentFromWorkflows(canonical, "reviewer-a"),
			withWorkflowStageTargetFinalSegment(canonical, "reviewer-a"),
		);
		assert.equal(
			legacyWorkflowStageTargetMigrationHintFromWorkflows(canonical),
			legacyWorkflowStageTargetMigrationHint(canonical),
		);
	});
	test("parses literal stage-name, stage-id, child-run, and boundary paths", () => {
		assert.deepEqual(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/reviewer-a`), {
			rootRunId: ROOT_RUN_ID,
			segments: ["reviewer-a"],
			kind: "path",
		});
		assert.deepEqual(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/stage-123`), {
			rootRunId: ROOT_RUN_ID,
			segments: ["stage-123"],
			kind: "path",
		});
		assert.deepEqual(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`), {
			rootRunId: ROOT_RUN_ID,
			segments: [CHILD_RUN_ID, "reviewer-a"],
			kind: "path",
		});
		assert.deepEqual(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/implement-slice-2/reviewer-a`), {
			rootRunId: ROOT_RUN_ID,
			segments: ["implement-slice-2", "reviewer-a"],
			kind: "path",
		});
	});

	test("classifies embedded single-depth globs and deep globs", () => {
		assert.equal(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/reviewer-*`)?.kind, "pattern");
		assert.equal(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/slice-*/reviewer-*`)?.kind, "pattern");
		assert.equal(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/**`)?.kind, "deep-pattern");
		assert.equal(parseWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/slice/**/reviewer`)?.kind, "deep-pattern");
	});

	test("rejects invalid and empty paths", () => {
		for (const target of [
			ROOT_RUN_ID,
			`${ROOT_RUN_ID}:reviewer`,
			"workflow:",
			`workflow:${ROOT_RUN_ID}`,
			"workflow:not-a-run/reviewer",
			`workflow:${ROOT_RUN_ID}/`,
			`workflow:${ROOT_RUN_ID}//reviewer`,
			`workflow:${ROOT_RUN_ID}/reviewer/`,
		]) {
			assert.equal(parseWorkflowStageTarget(target), undefined, target);
		}
	});

	test("detects legacy targets and provides an exact migration hint", () => {
		assert.deepEqual(parseLegacyWorkflowStageTarget(`${ROOT_RUN_ID}:reviewer-a`), {
			runId: ROOT_RUN_ID,
			stageKey: "reviewer-a",
		});
		assert.equal(parseLegacyWorkflowStageTarget(`workflow:${ROOT_RUN_ID}/reviewer-a`), undefined);
		const canonical = `workflow:${ROOT_RUN_ID}/reviewer-a`;
		assert.equal(
			legacyWorkflowStageTargetMigrationHint(canonical),
			"Legacy workflow-stage targets in the `<runId>:<stageKey>` form are no longer supported. Use the canonical `workflow:<rootRunId>/<segment>` path form. Use `workflow:4ac72924-c452-4e5f-9e63-2435722109f7/reviewer-a` for this stage.",
		);
	});

	test("formats paths and replaces only the final segment", () => {
		const target = formatWorkflowStageTarget(ROOT_RUN_ID, CHILD_RUN_ID, "stage-id");
		assert.equal(target, `workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/stage-id`);
		assert.equal(
			withWorkflowStageTargetFinalSegment(target, "reviewer-a"),
			`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`,
		);
	});
});
