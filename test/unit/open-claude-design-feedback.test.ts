// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, test } from "vitest";
import {
	assertUserAnnotationsThreaded,
	buildUserAnnotationsSection,
	feedbackArtifactPath,
	persistPreviewFeedback,
	previewFeedbackSchema,
	toPreviewFeedback,
	userAnnotationsBlock,
} from "../../packages/workflows/builtin/open-claude-design-feedback.js";

function structuredResult(payload: object, text = "stage prose is not feedback data") {
	return { text, structured: payload };
}

function declaredTopLevel(artifactPath: string): Record<string, unknown> {
	const { meta: _meta, ...declared } = JSON.parse(readFileSync(artifactPath, "utf8"));
	return declared;
}

describe("open-claude-design feedback threading (#1464)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("threads structured user notes and accepted live changes into the next generate stage", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["Simplify the hero background.", "Match the Apple website polish."],
				live_changes: ["Accepted variant 2 for the hero."],
			}),
		});
		const block = userAnnotationsBlock([feedback]);
		assert.equal(block.hasNotes, true);
		assert.match(block.text, /Simplify the hero background/);
		assert.match(block.text, /Apple website/);
		assert.match(block.text, /Accepted live variants\/edits/);
		assert.match(block.text, /Accepted variant 2 for the hero/);

		assert.doesNotThrow(() =>
			assertUserAnnotationsThreaded(
				"brief includes: Simplify the hero background.\nMatch the Apple website polish.\nAccepted variant 2 for the hero.",
				[feedback],
				"generate-2",
			),
		);
		assert.throws(
			() => assertUserAnnotationsThreaded("nothing relevant", [feedback], "generate-2"),
			/were not threaded into the refinement context/,
		);
	});

	test("buildUserAnnotationsSection orders latest feedback first", () => {
		const first = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["Simplify the hero background."],
				live_changes: [],
			}),
		});
		const second = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "revise", user_notes: ["Fix the footer spacing."], live_changes: [] }),
		});
		const section = buildUserAnnotationsSection([first, second]);
		assert.ok(section.toLowerCase().indexOf("footer spacing") < section.toLowerCase().indexOf("simplify the hero"));
	});

	test("userAnnotationsBlock falls back when no annotations are captured", () => {
		const empty = userAnnotationsBlock([
			toPreviewFeedback({
				iteration: 0,
				stageName: "user-feedback-1",
				result: structuredResult({ decision: "approve", user_notes: [], live_changes: [] }),
			}),
		]);
		assert.equal(empty.hasNotes, false);
		assert.match(empty.text, /No interactive user annotations were captured/);
	});

	test("assertUserAnnotationsThreaded enforces accepted live-change threading", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: [],
				live_changes: ["Accepted variant 2 for the hero (committed accent)."],
			}),
		});
		assert.doesNotThrow(() =>
			assertUserAnnotationsThreaded(
				"brief includes: Accepted variant 2 for the hero (committed accent).",
				[feedback],
				"generate-2",
			),
		);
		assert.throws(
			() => assertUserAnnotationsThreaded("nothing relevant", [feedback], "generate-2"),
			/accepted live variants .* were not threaded/,
		);
	});

	test("persistPreviewFeedback writes the durable record on every round", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const withNotes = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["Simplify the hero background."],
				live_changes: [],
			}),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: withNotes });
		const mdPath = join(dir, "feedback", "iteration-0.md");
		const jsonPath = feedbackArtifactPath(dir, 0);
		assert.ok(existsSync(mdPath));
		assert.match(readFileSync(mdPath, "utf8"), /Simplify the hero background/);
		const json = JSON.parse(readFileSync(jsonPath, "utf8"));
		assert.deepEqual(json.user_notes, ["Simplify the hero background."]);
		assert.deepEqual(json.live_changes, []);
		assert.equal(json.decision, "revise");
		assert.deepEqual(Object.keys(json.meta).sort(), ["captured_at", "iteration", "stage_name"]);
		assert.equal(json.meta.stage_name, "user-feedback-1");
		assert.equal(Value.Check(previewFeedbackSchema, declaredTopLevel(jsonPath)), true);

		const approval = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "approve", user_notes: [], live_changes: [] }),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: approval });
		assert.ok(existsSync(join(dir, "feedback", "iteration-1.md")));
		const approvalJson = JSON.parse(readFileSync(feedbackArtifactPath(dir, 1), "utf8"));
		assert.equal(approvalJson.decision, "approve");
		assert.deepEqual(approvalJson.user_notes, []);
		assert.deepEqual(approvalJson.live_changes, []);
		assert.equal(Value.Check(previewFeedbackSchema, declaredTopLevel(feedbackArtifactPath(dir, 1))), true);
	});

	test("persistPreviewFeedback persists live_changes-only feedback", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const liveOnly = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: structuredResult({
				decision: "revise",
				user_notes: [],
				live_changes: ["Accepted variant 1 for the pricing table."],
			}),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: liveOnly });
		const json = JSON.parse(readFileSync(feedbackArtifactPath(dir, 2), "utf8"));
		assert.deepEqual(json.live_changes, ["Accepted variant 1 for the pricing table."]);
		assert.deepEqual(json.user_notes, []);
	});

	test("persistPreviewFeedback copies the annotated snapshot artifact", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const snapshot = join(dir, "annotations-test.png");
		writeFileSync(snapshot, "fake-png-bytes");
		writeFileSync(join(dir, "annotations-test.yaml"), "annotations: []");
		const feedback = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["Simplify the hero."],
				live_changes: [],
				annotated_snapshot: snapshot,
			}),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback });
		assert.ok(existsSync(join(dir, "feedback", "iteration-0-annotations.png")));
		assert.ok(existsSync(join(dir, "feedback", "iteration-0-annotations.yaml")));
	});

	test("persistPreviewFeedback does not copy a snapshot outside the project/artifact dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		const outside = mkdtempSync(join(tmpdir(), "ocd-outside-"));
		tempDirs.push(dir, outside);
		const snapshot = join(outside, "evil.png");
		writeFileSync(snapshot, "fake-png-bytes");
		const feedback = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["Simplify the hero."],
				live_changes: [],
				annotated_snapshot: snapshot,
			}),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback });
		assert.equal(existsSync(join(dir, "feedback", "iteration-0-annotations.png")), false);
		assert.ok(existsSync(join(dir, "feedback", "iteration-0.md")));
	});
});

describe("open-claude-design structured feedback deliverable (#2401)", () => {
	test("declares the structured final-answer schema the stage must return", () => {
		assert.equal(previewFeedbackSchema.additionalProperties, false);
		assert.deepEqual(Object.keys(previewFeedbackSchema.properties).sort(), [
			"annotated_snapshot",
			"decision",
			"live_changes",
			"user_notes",
		]);
		for (const property of Object.values(previewFeedbackSchema.properties)) {
			assert.equal(typeof property.description, "string");
		}
		assert.deepEqual(previewFeedbackSchema.required, ["decision", "user_notes", "live_changes"]);
	});

	test("uses the structured payload rather than the stage text", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult(
				{
					decision: "revise",
					user_notes: ["The hero background is too busy."],
					live_changes: ["Accepted variant 2 for the pricing table."],
					annotated_snapshot: ".playwright-cli/annotations-1.png",
				},
				"The stage's final prose does not determine the review outcome.",
			),
		});
		assert.equal(feedback.decision, "revise");
		assert.equal(feedback.userNotes, "The hero background is too busy.");
		assert.equal(feedback.liveChanges, "Accepted variant 2 for the pricing table.");
		assert.equal(feedback.annotatedSnapshot, ".playwright-cli/annotations-1.png");
		assert.doesNotMatch(feedback.text, /final prose/);
	});

	test("coerces approval carrying captured work to revise", () => {
		const notes = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "approve",
				user_notes: ["Fix the masthead contrast."],
				live_changes: [],
			}),
		});
		assert.equal(notes.decision, "revise");
		assert.equal(notes.userNotes, "Fix the masthead contrast.");

		const liveOnly = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "approve",
				user_notes: [],
				live_changes: ["Accepted the tighter density."],
			}),
		});
		assert.equal(liveOnly.decision, "revise");
		assert.equal(liveOnly.liveChanges, "Accepted the tighter density.");

		const clean = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: structuredResult({ decision: "approve", user_notes: [], live_changes: [] }),
		});
		assert.equal(clean.decision, "approve");
	});

	test("writes only schema fields plus the small round metadata block", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "revise",
				user_notes: ["The hero background is too busy.", "Tighten the footer."],
				live_changes: ["Accepted variant 2 for the pricing table."],
			}),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback });
		const artifact = JSON.parse(readFileSync(feedbackArtifactPath(dir, 1), "utf8"));
		assert.deepEqual(Object.keys(artifact).sort(), ["decision", "live_changes", "meta", "user_notes"]);
		assert.deepEqual(artifact.user_notes, ["The hero background is too busy.", "Tighten the footer."]);
		assert.deepEqual(artifact.live_changes, ["Accepted variant 2 for the pricing table."]);
		assert.deepEqual(Object.keys(artifact.meta).sort(), ["captured_at", "iteration", "stage_name"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("persistPreviewFeedback throws instead of leaving a stale round readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		const artifactPath = feedbackArtifactPath(dir, 1);
		const approval = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "approve", user_notes: [], live_changes: [] }),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: approval });
		assert.equal(existsSync(artifactPath), true);

		const revise = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "revise", user_notes: ["The hero needs work."], live_changes: [] }),
		});
		const unwritable = {
			...revise,
			get decision(): never {
				throw new Error("simulated durable-write failure");
			},
		};
		assert.throws(
			() => persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: unwritable }),
			(error: Error) =>
				/failed to write the feedback deliverable/.test(error.message) &&
				error.message.includes(artifactPath) &&
				error.message.includes("user-feedback-1"),
		);
		assert.equal(existsSync(artifactPath), false, "the stale approval must not survive a failed write");

		mkdirSync(artifactPath, { recursive: true });
		assert.throws(
			() => persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: revise }),
			(error: Error) =>
				/failed to write the feedback deliverable/.test(error.message) && error.message.includes(artifactPath),
		);
		rmSync(artifactPath, { recursive: true, force: true });
		assert.equal(existsSync(artifactPath), false);
		rmSync(dir, { recursive: true, force: true });
	});
});
