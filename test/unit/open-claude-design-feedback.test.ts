// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, test } from "vitest";
import {
	feedbackArtifactPath,
	persistPreviewFeedback,
	previewFeedbackSchema,
	toPreviewFeedback,
	userNotesBrief,
} from "../../packages/workflows/builtin/open-claude-design-feedback.js";

function structuredResult(payload: object, text = "stage prose is not feedback data") {
	return { text, structured: payload };
}

function declaredTopLevel(artifactPath: string): Record<string, unknown> {
	const { meta: _meta, ...declared } = JSON.parse(readFileSync(artifactPath, "utf8"));
	return declared;
}

describe("open-claude-design live-review feedback (#1464, #2411)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("renders the user's notes as the brief for the regeneration they asked for", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "regenerate",
				user_notes: ["Simplify the hero background.", "Match the Apple website polish."],
				live_changes: ["Accepted variant 2 for the hero."],
				annotated_snapshot: ".playwright-cli/annotations-1.png",
			}),
		});
		const brief = userNotesBrief(feedback);
		assert.match(brief, /Simplify the hero background/);
		assert.match(brief, /Apple website/);
		assert.match(brief, /Annotated snapshot: \.playwright-cli\/annotations-1\.png/);
		// Accepted variants are already in the preview, so a fresh pass is not
		// told to preserve them; the durable record still carries them (#2411).
		assert.doesNotMatch(brief, /Accepted variant 2/);
	});

	test("userNotesBrief states the absence when the user wrote no notes", () => {
		const brief = userNotesBrief(
			toPreviewFeedback({
				iteration: 1,
				stageName: "user-feedback-1",
				result: structuredResult({ decision: "regenerate", user_notes: [], live_changes: [] }),
			}),
		);
		assert.match(brief, /without writing notes/);
		assert.match(brief, /materially different/);
	});

	test("persistPreviewFeedback writes the durable record for every session", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const withNotes = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "regenerate",
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
		assert.equal(json.decision, "regenerate");
		assert.deepEqual(Object.keys(json.meta).sort(), ["captured_at", "iteration", "stage_name"]);
		assert.equal(json.meta.stage_name, "user-feedback-1");
		assert.equal(Value.Check(previewFeedbackSchema, declaredTopLevel(jsonPath)), true);

		const exported = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "export", user_notes: [], live_changes: [] }),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: exported });
		assert.ok(existsSync(join(dir, "feedback", "iteration-1.md")));
		const exportedJson = JSON.parse(readFileSync(feedbackArtifactPath(dir, 1), "utf8"));
		assert.equal(exportedJson.decision, "export");
		assert.deepEqual(exportedJson.user_notes, []);
		assert.deepEqual(exportedJson.live_changes, []);
		assert.equal(Value.Check(previewFeedbackSchema, declaredTopLevel(feedbackArtifactPath(dir, 1))), true);
	});

	test("persistPreviewFeedback persists live_changes-only feedback", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const liveOnly = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: structuredResult({
				decision: "regenerate",
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
				decision: "regenerate",
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
				decision: "regenerate",
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
		assert.deepEqual(
			previewFeedbackSchema.properties.decision.anyOf.map((option) => option.const),
			["export", "regenerate"],
		);
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
					decision: "regenerate",
					user_notes: ["The hero background is too busy."],
					live_changes: ["Accepted variant 2 for the pricing table."],
					annotated_snapshot: ".playwright-cli/annotations-1.png",
				},
				"The stage's final prose does not determine the review outcome.",
			),
		});
		assert.equal(feedback.decision, "regenerate");
		assert.equal(feedback.userNotes, "The hero background is too busy.");
		assert.equal(feedback.liveChanges, "Accepted variant 2 for the pricing table.");
		assert.equal(feedback.annotatedSnapshot, ".playwright-cli/annotations-1.png");
		assert.doesNotMatch(feedback.text, /final prose/);
	});

	test("takes the session's decision as given rather than second-guessing it", () => {
		// The live session applies accepted variants and steered edits in place,
		// so an `export` carrying captured work is the user's own decision about
		// an artifact they were just editing (#2411).
		const exportWithNotes = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "export",
				user_notes: ["Nice — the masthead contrast is fixed."],
				live_changes: ["Accepted the tighter density."],
			}),
		});
		assert.equal(exportWithNotes.decision, "export");
		assert.equal(exportWithNotes.userNotes, "Nice — the masthead contrast is fixed.");
		assert.equal(exportWithNotes.liveChanges, "Accepted the tighter density.");

		const regenerate = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: structuredResult({ decision: "regenerate", user_notes: [], live_changes: [] }),
		});
		assert.equal(regenerate.decision, "regenerate");
	});

	test("writes only schema fields plus the small session metadata block", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({
				decision: "regenerate",
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

	test("persistPreviewFeedback throws instead of leaving a stale session readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		const artifactPath = feedbackArtifactPath(dir, 1);
		const exported = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "export", user_notes: [], live_changes: [] }),
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: exported });
		assert.equal(existsSync(artifactPath), true);

		const regenerate = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: structuredResult({ decision: "regenerate", user_notes: ["The hero needs work."], live_changes: [] }),
		});
		const unwritable = {
			...regenerate,
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
		assert.equal(existsSync(artifactPath), false, "the stale export must not survive a failed write");

		mkdirSync(artifactPath, { recursive: true });
		assert.throws(
			() => persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: regenerate }),
			(error: Error) =>
				/failed to write the feedback deliverable/.test(error.message) && error.message.includes(artifactPath),
		);
		rmSync(artifactPath, { recursive: true, force: true });
		assert.equal(existsSync(artifactPath), false);
		rmSync(dir, { recursive: true, force: true });
	});
});
