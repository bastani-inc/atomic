// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	assertUserAnnotationsThreaded,
	buildUserAnnotationsSection,
	extractAnnotatedSnapshot,
	extractLiveChanges,
	extractUserNotes,
	feedbackArtifactPath,
	loadPreviewFeedback,
	persistPreviewFeedback,
	previewFeedbackSchema,
	toPreviewFeedback,
	userAnnotationsBlock,
} from "../../packages/workflows/builtin/open-claude-design-feedback.js";

describe("open-claude-design feedback threading (#1464)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("extracts user_notes across markdown label styles", () => {
		const colonBlock = [
			"display_method: playwright-cli",
			"user_notes:",
			"- Simplify the hero background.",
			"- Match the Apple website polish.",
			"next_action_hint: refine",
		].join("\n");
		assert.match(extractUserNotes(colonBlock) ?? "", /Simplify the hero background/);
		assert.match(extractUserNotes(colonBlock) ?? "", /Apple website/);

		const headingBlock = [
			"## display_method",
			"playwright-cli",
			"## user_notes",
			"The masthead text is too light; fix contrast.",
			"## next_action_hint",
			"refine",
		].join("\n");
		assert.match(extractUserNotes(headingBlock) ?? "", /too light/);

		const inlineBold = "**user_notes:** The copy button font is too generic.";
		assert.match(extractUserNotes(inlineBold) ?? "", /too generic/);

		const backtick = "`user_notes`: keep the CTA, polish everything else.";
		assert.match(extractUserNotes(backtick) ?? "", /keep the CTA/);
	});

	test("treats placeholder / missing notes as absent", () => {
		assert.equal(extractUserNotes("user_notes: none"), undefined);
		assert.equal(extractUserNotes("user_notes: (not available)"), undefined);
		assert.equal(extractUserNotes("user_notes: N/A"), undefined);
		assert.equal(extractUserNotes("display_method: manual\npreview_path: /tmp/x.html"), undefined);
		assert.equal(extractUserNotes(""), undefined);
		// A one-character real note must survive (no longer treated as a placeholder).
		assert.equal(extractUserNotes("user_notes: a"), "a");
	});

	test("extracts the annotated_snapshot path", () => {
		const text = ["user_notes: simplify the hero", "annotated_snapshot: .playwright-cli/annotations-test.png"].join(
			"\n",
		);
		assert.equal(extractAnnotatedSnapshot(text), ".playwright-cli/annotations-test.png");
	});

	test("captures and threads live_changes from an impeccable live QA session", () => {
		const liveText = [
			"display_method: live",
			"preview_path: /tmp/preview.html",
			"live_changes:",
			"- Accepted variant 2 for the hero: tighter density, committed accent.",
			"- Accepted a new footer layout.",
			"user_notes: none",
			"next_action_hint: proceed",
		].join("\n");
		// live_changes parses even when user_notes is the `none` placeholder.
		assert.match(extractLiveChanges(liveText) ?? "", /Accepted variant 2 for the hero/);
		assert.match(extractLiveChanges(liveText) ?? "", /new footer layout/);
		assert.equal(extractUserNotes(liveText), undefined);

		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: liveText },
		});
		assert.match(feedback.liveChanges ?? "", /tighter density/);

		// Accepted live variants thread into the user-annotations block so the
		// generate stage honors them even with no typed notes.
		const block = userAnnotationsBlock([feedback]);
		assert.equal(block.hasNotes, true);
		assert.match(block.text, /Accepted live variants\/edits/);
		assert.match(block.text, /tighter density/);
	});

	test("buildUserAnnotationsSection orders latest feedback first", () => {
		const first = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: { text: "user_notes: simplify the hero background" },
		});
		const second = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: "user_notes: now fix the footer spacing" },
		});
		const section = buildUserAnnotationsSection([first, second]);
		assert.ok(section.indexOf("footer spacing") < section.indexOf("simplify the hero"));
	});

	test("userAnnotationsBlock falls back when no notes captured", () => {
		const empty = userAnnotationsBlock([
			toPreviewFeedback({
				iteration: 0,
				stageName: "user-feedback-1",
				result: { text: "display_method: manual fallback" },
			}),
		]);
		assert.equal(empty.hasNotes, false);
		assert.match(empty.text, /No interactive user annotations were captured/);
	});

	test("assertUserAnnotationsThreaded throws when notes are dropped", () => {
		const feedback = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: { text: "user_notes: simplify the hero background" },
		});
		// Threaded prompt -> no throw.
		assert.doesNotThrow(() =>
			assertUserAnnotationsThreaded("context includes: simplify the hero background", [feedback], "generate-2"),
		);
		// Missing notes -> throws a clear workflow error.
		assert.throws(
			() => assertUserAnnotationsThreaded("nothing relevant", [feedback], "generate-2"),
			/were not threaded into the refinement context/,
		);
	});

	test("assertUserAnnotationsThreaded also enforces accepted live-change threading", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: [
					"display_method: live",
					"live_changes: Accepted variant 2 for the hero (committed accent).",
					"user_notes: none",
				].join("\n"),
			},
		});
		// Threaded live changes -> no throw.
		assert.doesNotThrow(() =>
			assertUserAnnotationsThreaded(
				"brief includes: Accepted variant 2 for the hero (committed accent).",
				[feedback],
				"generate-2",
			),
		);
		// Dropped live changes -> throws, even though there are no typed notes.
		assert.throws(
			() => assertUserAnnotationsThreaded("nothing relevant", [feedback], "generate-2"),
			/accepted live variants .* were not threaded/,
		);
	});

	test("persistPreviewFeedback writes the durable artifact on every round", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const withNotes = toPreviewFeedback({
			iteration: 0,
			stageName: "user-feedback-1",
			result: { text: "user_notes: simplify the hero background" },
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: withNotes });
		const mdPath = join(dir, "feedback", "iteration-0.md");
		assert.ok(existsSync(mdPath));
		assert.match(readFileSync(mdPath, "utf8"), /simplify the hero background/);
		const json = JSON.parse(readFileSync(feedbackArtifactPath(dir, 0), "utf8"));
		// Top level is the declared schema shape; run metadata is nested under `meta`.
		assert.deepEqual(json.user_notes, ["simplify the hero background"]);
		assert.deepEqual(json.live_changes, []);
		assert.equal(json.decision, "revise");
		assert.equal(json.meta.stage_name, "user-feedback-1");
		assert.equal(json.meta.source, "text");

		// A round with nothing parseable is still persisted (#2401): the loop reads
		// the artifact, and a missing file must not be confused with an empty one.
		const noNotes = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: "display_method: manual fallback" },
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: noNotes });
		assert.ok(existsSync(join(dir, "feedback", "iteration-1.md")));
		const indeterminate = JSON.parse(readFileSync(feedbackArtifactPath(dir, 1), "utf8"));
		assert.equal(indeterminate.decision, "indeterminate");
	});

	test("persistPreviewFeedback persists live_changes-only feedback", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
		tempDirs.push(dir);
		const liveOnly = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: {
				text: [
					"display_method: live",
					"live_changes: Accepted variant 1 for the pricing table.",
					"user_notes: none",
				].join("\n"),
			},
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: liveOnly });
		const jsonPath = feedbackArtifactPath(dir, 2);
		assert.ok(existsSync(jsonPath));
		const json = JSON.parse(readFileSync(jsonPath, "utf8"));
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
			result: {
				text: ["user_notes: simplify the hero", `annotated_snapshot: ${snapshot}`].join("\n"),
			},
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
			result: {
				text: ["user_notes: simplify the hero", `annotated_snapshot: ${snapshot}`].join("\n"),
			},
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback });
		// The out-of-tree snapshot must NOT be copied into the feedback dir...
		assert.equal(existsSync(join(dir, "feedback", "iteration-0-annotations.png")), false);
		// ...but the notes themselves are still persisted.
		assert.ok(existsSync(join(dir, "feedback", "iteration-0.md")));
	});
});

/**
 * The user-feedback stage returns a schema-validated structured value, and the
 * workflow drives the loop from the durable artifact rather than from the
 * stage's final prose. cross-ref: issue #2401.
 */
describe("open-claude-design structured feedback deliverable (#2401)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	/** The labeled report `user-feedback-1` emitted before the continuation turn. */
	const LABELED_REPORT = [
		"display_method: live",
		"preview_path: /tmp/preview.html",
		"user_notes:",
		"- The hero background is too busy.",
		"live_changes:",
		"- Accepted variant 2 for the pricing table.",
		"next_action_hint: refine",
	].join("\n");

	/** The short wrap-up the synthetic continuation turn produced 15 ms later. */
	const CONTINUATION_WRAP_UP = "All set — the live review session is closed and the preview is ready.";

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

	test("prefers a valid structured payload over the stage text", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: CONTINUATION_WRAP_UP,
				structured: {
					decision: "revise",
					user_notes: ["The hero background is too busy."],
					live_changes: ["Accepted variant 2 for the pricing table."],
					annotated_snapshot: ".playwright-cli/annotations-1.png",
				},
			},
		});
		assert.equal(feedback.source, "structured");
		assert.equal(feedback.decision, "revise");
		assert.equal(feedback.userNotes, "The hero background is too busy.");
		assert.equal(feedback.liveChanges, "Accepted variant 2 for the pricing table.");
		assert.equal(feedback.annotatedSnapshot, ".playwright-cli/annotations-1.png");
	});

	test("coerces a structured approval that still carries captured work to revise", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: CONTINUATION_WRAP_UP,
				structured: {
					decision: "approve",
					user_notes: ["Fix the masthead contrast."],
					live_changes: [],
				},
			},
		});
		// Approval never silently discards work the user asked for.
		assert.equal(feedback.decision, "revise");
		assert.equal(feedback.userNotes, "Fix the masthead contrast.");

		const clean = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: { text: "", structured: { decision: "approve", user_notes: [], live_changes: [] } },
		});
		assert.equal(clean.decision, "approve");
	});

	test("the issue transcript order keeps the labeled feedback when structured output exists", () => {
		// Transcript: labeled report -> synthetic continuation turn -> unlabeled
		// wrap-up returned as `result.text`. The structured value was finalized
		// with the report, so the wrap-up cannot erase it.
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: CONTINUATION_WRAP_UP,
				structured: {
					decision: "revise",
					user_notes: [extractUserNotes(LABELED_REPORT) ?? ""],
					live_changes: [extractLiveChanges(LABELED_REPORT) ?? ""],
				},
			},
		});
		assert.equal(feedback.decision, "revise");
		assert.match(feedback.userNotes ?? "", /hero background is too busy/);
		assert.match(feedback.liveChanges ?? "", /Accepted variant 2 for the pricing table/);
	});

	test("the same transcript without structured output is indeterminate, never approved", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: CONTINUATION_WRAP_UP },
		});
		assert.equal(feedback.source, "text");
		assert.equal(feedback.decision, "indeterminate");
		assert.equal(feedback.userNotes, undefined);

		// Empty text is indeterminate too.
		assert.equal(
			toPreviewFeedback({ iteration: 1, stageName: "user-feedback-1", result: { text: "" } }).decision,
			"indeterminate",
		);
		// A malformed structured payload falls back to text without approving.
		assert.equal(
			toPreviewFeedback({
				iteration: 1,
				stageName: "user-feedback-1",
				result: { text: CONTINUATION_WRAP_UP, structured: { decision: "yes", notes: "everything is fine" } },
			}).decision,
			"indeterminate",
		);
	});

	test("an explicit labeled approval with no captured work approves", () => {
		const feedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: ["decision: approve", "user_notes: none", "live_changes: none"].join("\n") },
		});
		assert.equal(feedback.decision, "approve");
		assert.equal(feedback.source, "text");

		// The same label with notes present is a revision, not an approval.
		assert.equal(
			toPreviewFeedback({
				iteration: 1,
				stageName: "user-feedback-1",
				result: { text: ["review_decision: approve", "user_notes: tighten the footer"].join("\n") },
			}).decision,
			"revise",
		);
	});

	test("decorated labels parse without over-capturing the next field", () => {
		const decorated = [
			"```user_notes```",
			"- The hero background is too busy.",
			"**live_changes:**",
			"- Accepted variant 2 for the pricing table.",
			"- `annotated_snapshot` (verbatim):",
			".playwright-cli/annotations-1.png",
		].join("\n");
		assert.equal(extractUserNotes(decorated), "- The hero background is too busy.");
		assert.equal(extractLiveChanges(decorated), "- Accepted variant 2 for the pricing table.");
		assert.equal(extractAnnotatedSnapshot(decorated), ".playwright-cli/annotations-1.png");

		const bulletedBacktick = [
			"- `user_notes`:",
			"Simplify the hero.",
			"- `live_changes` (verbatim):",
			"Accepted the tighter density.",
		].join("\n");
		assert.equal(extractUserNotes(bulletedBacktick), "Simplify the hero.");
		assert.equal(extractLiveChanges(bulletedBacktick), "Accepted the tighter density.");
	});

	test("persist/load round-trips revise, approve, and indeterminate rounds", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		tempDirs.push(dir);

		const revise = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: CONTINUATION_WRAP_UP,
				structured: {
					decision: "revise",
					user_notes: ["The hero background is too busy.", "Tighten the footer."],
					live_changes: ["Accepted variant 2 for the pricing table."],
				},
			},
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: revise });
		const loadedRevise = loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" });
		assert.deepEqual(loadedRevise, revise);

		const approve = toPreviewFeedback({
			iteration: 2,
			stageName: "user-feedback-2",
			result: { text: "decision: approve", structured: { decision: "approve", user_notes: [], live_changes: [] } },
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: approve });
		const loadedApprove = loadPreviewFeedback({ artifactDir: dir, iteration: 2, stageName: "user-feedback-2" });
		assert.deepEqual(loadedApprove, approve);

		const indeterminate = toPreviewFeedback({
			iteration: 3,
			stageName: "user-feedback-3",
			result: { text: CONTINUATION_WRAP_UP },
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: indeterminate });
		const loadedIndeterminate = loadPreviewFeedback({
			artifactDir: dir,
			iteration: 3,
			stageName: "user-feedback-3",
		});
		assert.deepEqual(loadedIndeterminate, indeterminate);
	});

	test("loadPreviewFeedback returns undefined for a missing or malformed artifact", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		tempDirs.push(dir);
		assert.equal(loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" }), undefined);

		mkdirSync(join(dir, "feedback"), { recursive: true });
		writeFileSync(feedbackArtifactPath(dir, 1), "{ not json");
		assert.equal(loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" }), undefined);

		writeFileSync(feedbackArtifactPath(dir, 2), JSON.stringify({ decision: "maybe", user_notes: [] }));
		assert.equal(loadPreviewFeedback({ artifactDir: dir, iteration: 2, stageName: "user-feedback-2" }), undefined);

		writeFileSync(feedbackArtifactPath(dir, 3), JSON.stringify({ decision: "revise", user_notes: "not-an-array" }));
		assert.equal(loadPreviewFeedback({ artifactDir: dir, iteration: 3, stageName: "user-feedback-3" }), undefined);
	});
});
