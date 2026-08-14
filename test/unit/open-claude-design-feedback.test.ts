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

/** The artifact's top level minus `meta` — the value the declared schema owns. */
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
		// The declared schema admits only `approve` and `revise`, so an
		// indeterminate round persists the fail-closed `revise` at the top level
		// and records the truth in `meta.decision`.
		assert.equal(indeterminate.decision, "revise");
		assert.equal(indeterminate.meta.decision, "indeterminate");

		// The persisted top level IS the declared schema: strip `meta` and the
		// remainder validates. Every round, whatever its outcome.
		for (const iteration of [0, 1]) {
			assert.equal(
				Value.Check(previewFeedbackSchema, declaredTopLevel(feedbackArtifactPath(dir, iteration))),
				true,
				`iteration ${iteration} top level must validate against previewFeedbackSchema`,
			);
		}
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

		// A structured entry that merely reads like a prose placeholder is still a
		// non-empty entry the stage chose to return: it is captured work, so the
		// approval is still a contradiction and must not be dropped.
		const placeholderish = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: "", structured: { decision: "approve", user_notes: ["pending"], live_changes: [] } },
		});
		assert.equal(placeholderish.decision, "revise");
		assert.equal(placeholderish.userNotes, "pending");

		const liveOnly = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: "", structured: { decision: "approve", user_notes: [], live_changes: ["none"] } },
		});
		assert.equal(liveOnly.decision, "revise");
		assert.equal(liveOnly.liveChanges, "none");

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

		// Only the contract's canonical `approve` approves: any other spelling is
		// indeterminate rather than an approval guessed from prose.
		for (const spelling of ["approved", "approve-with-notes", "looks good", "ship it"]) {
			assert.equal(
				toPreviewFeedback({
					iteration: 1,
					stageName: "user-feedback-1",
					result: { text: `decision: ${spelling}` },
				}).decision,
				"indeterminate",
				`decision: ${spelling} must not approve`,
			);
		}
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

		// The reported form: the annotation sits *inside* the bold decoration, so
		// the parenthetical is not at the end of the candidate label. Before the
		// fix this label was unrecognized, `user_notes` swallowed the whole
		// live-changes block, and the round read as an approval.
		const boldAnnotated = [
			"- **`user_notes` (verbatim)**:",
			"The hero background is too busy.",
			"- **`live_changes` (verbatim)**:",
			"Accepted variant 2 for the pricing table.",
			"- **`annotated_snapshot` (verbatim)**: .playwright-cli/annotations-1.png",
		].join("\n");
		assert.equal(extractUserNotes(boldAnnotated), "The hero background is too busy.");
		assert.equal(extractLiveChanges(boldAnnotated), "Accepted variant 2 for the pricing table.");
		assert.equal(extractAnnotatedSnapshot(boldAnnotated), ".playwright-cli/annotations-1.png");

		const boldAnnotatedFeedback = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: boldAnnotated },
		});
		assert.equal(boldAnnotatedFeedback.decision, "revise");
		assert.equal(boldAnnotatedFeedback.userNotes, "The hero background is too busy.");
		assert.equal(boldAnnotatedFeedback.liveChanges, "Accepted variant 2 for the pricing table.");

		// A fenced label may carry the same annotation.
		const fencedAnnotated = ["```live_changes (verbatim)```", "Accepted the committed accent."].join("\n");
		assert.equal(extractLiveChanges(fencedAnnotated), "Accepted the committed accent.");
	});

	test("a repeated label terminates the value it repeats", () => {
		// The reported over-capture: the second `user_notes` label is a label like
		// any other, so it ends the first occurrence's value instead of being
		// swallowed by it.
		const repeated = ["user_notes:", "First note.", "**user_notes:** Second note."].join("\n");
		assert.equal(extractUserNotes(repeated), "First note.");

		const repeatedLive = [
			"live_changes:",
			"Accepted variant 2.",
			"- `live_changes` (verbatim):",
			"Accepted the tighter density.",
		].join("\n");
		assert.equal(extractLiveChanges(repeatedLive), "Accepted variant 2.");

		// A repeat that follows the captured field still cannot leak into it.
		const repeatAcrossFields = [
			"user_notes:",
			"First note.",
			"live_changes:",
			"Accepted variant 2.",
			"user_notes:",
			"Second note.",
		].join("\n");
		assert.equal(extractUserNotes(repeatAcrossFields), "First note.");
		assert.equal(extractLiveChanges(repeatAcrossFields), "Accepted variant 2.");
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
		assert.equal(loadedIndeterminate?.decision, "indeterminate");
		// Every persisted round's top level is the declared schema, so the loop
		// never reads a decision the stage could not have returned.
		for (const iteration of [1, 2, 3]) {
			assert.equal(
				Value.Check(previewFeedbackSchema, declaredTopLevel(feedbackArtifactPath(dir, iteration))),
				true,
				`iteration ${iteration} top level must validate against previewFeedbackSchema`,
			);
		}

		// A note that spans several lines survives as one entry: the artifact keeps
		// one entry per note and the reload is not lossy.
		const multiline = toPreviewFeedback({
			iteration: 4,
			stageName: "user-feedback-4",
			result: {
				text: CONTINUATION_WRAP_UP,
				structured: {
					decision: "revise",
					user_notes: ["First line\n\nSecond line", "A second note."],
					live_changes: ["Accepted variant 2.\nKept the tighter density."],
				},
			},
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: multiline });
		const persisted = JSON.parse(readFileSync(feedbackArtifactPath(dir, 4), "utf8"));
		assert.deepEqual(persisted.user_notes, ["First line\n\nSecond line", "A second note."]);
		assert.deepEqual(persisted.live_changes, ["Accepted variant 2.\nKept the tighter density."]);
		const loadedMultiline = loadPreviewFeedback({ artifactDir: dir, iteration: 4, stageName: "user-feedback-4" });
		assert.deepEqual(loadedMultiline, multiline);
	});

	test("loadPreviewFeedback returns undefined for a missing or malformed artifact", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		tempDirs.push(dir);
		const load = (iteration: number) =>
			loadPreviewFeedback({ artifactDir: dir, iteration, stageName: `user-feedback-${iteration}` });
		assert.equal(load(1), undefined);

		mkdirSync(join(dir, "feedback"), { recursive: true });
		const meta = {
			iteration: 1,
			stage_name: "user-feedback-1",
			captured_at: new Date().toISOString(),
			source: "structured",
			text: "",
		};
		const malformed: readonly (readonly [string, string | object])[] = [
			["invalid JSON", "{ not json"],
			["a scalar top level", "7"],
			["an unknown decision", { decision: "maybe", user_notes: [], live_changes: [], meta }],
			["a missing decision", { user_notes: [], live_changes: [], meta }],
			// The reported bypass: a bare approval with no schema fields and no
			// metadata must never read back as a clean approval.
			["a bare decision only", { decision: "approve" }],
			["missing user_notes", { decision: "approve", live_changes: [], meta }],
			["missing live_changes", { decision: "approve", user_notes: [], meta }],
			["a scalar user_notes", { decision: "revise", user_notes: "not-an-array", live_changes: [], meta }],
			["a non-string entry", { decision: "revise", user_notes: [3], live_changes: [], meta }],
			[
				"a non-string annotated_snapshot",
				{ decision: "approve", user_notes: [], live_changes: [], annotated_snapshot: 5, meta },
			],
			["missing meta", { decision: "approve", user_notes: [], live_changes: [] }],
			["a scalar meta", { decision: "approve", user_notes: [], live_changes: [], meta: "user-feedback-1" }],
			[
				"meta missing captured_at",
				{
					decision: "approve",
					user_notes: [],
					live_changes: [],
					meta: { iteration: 1, stage_name: "user-feedback-1", source: "structured", text: "" },
				},
			],
			[
				"meta with an unknown source",
				{ decision: "approve", user_notes: [], live_changes: [], meta: { ...meta, source: "guessed" } },
			],
			[
				"meta naming another round",
				{ decision: "approve", user_notes: [], live_changes: [], meta: { ...meta, iteration: 9 } },
			],
			[
				"meta naming another stage",
				{ decision: "approve", user_notes: [], live_changes: [], meta: { ...meta, stage_name: "user-feedback-9" } },
			],
			// A record whose top level carries anything beyond the declared schema
			// plus `meta` did not come from this module: its `decision` is not this
			// round's outcome, however well-formed the fields it shares look.
			[
				"an unknown top-level field",
				{ decision: "approve", user_notes: [], live_changes: [], forgotten_work: ["Fix the hero"], meta },
			],
			// An approval carrying work is the contradiction `toPreviewFeedback`
			// coerces to `revise` before persisting, so on disk it means the record
			// was rewritten. It never restores as approval.
			["an approval carrying notes", { decision: "approve", user_notes: ["Fix the hero"], live_changes: [], meta }],
			[
				"an approval carrying live changes",
				{ decision: "approve", user_notes: [], live_changes: ["Accepted variant 2."], meta },
			],
			// `indeterminate` is not a value the declared schema admits, so a record
			// carrying it at the top level did not come from this module.
			["a top-level indeterminate decision", { decision: "indeterminate", user_notes: [], live_changes: [], meta }],
			[
				"meta with an unknown decision",
				{ decision: "revise", user_notes: [], live_changes: [], meta: { ...meta, decision: "maybe" } },
			],
		];
		for (const [label, body] of malformed) {
			writeFileSync(feedbackArtifactPath(dir, 1), typeof body === "string" ? body : JSON.stringify(body));
			assert.equal(load(1), undefined, `${label} must not load`);
		}

		// The same body with every required field present does load.
		writeFileSync(
			feedbackArtifactPath(dir, 1),
			JSON.stringify({ decision: "approve", user_notes: [], live_changes: [], meta }),
		);
		assert.equal(load(1)?.decision, "approve");

		// An indeterminate round persists the fail-closed `revise` at the top level
		// and its real outcome in `meta.decision`, and reloads as `indeterminate`
		// so the loop still refuses to approve it.
		writeFileSync(
			feedbackArtifactPath(dir, 1),
			JSON.stringify({
				decision: "revise",
				user_notes: [],
				live_changes: [],
				meta: { ...meta, decision: "indeterminate" },
			}),
		);
		assert.equal(load(1)?.decision, "indeterminate");
	});

	test("persistPreviewFeedback throws instead of leaving a stale round readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ocd-artifact-"));
		tempDirs.push(dir);
		const artifactPath = feedbackArtifactPath(dir, 1);

		const approve = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: { text: "decision: approve", structured: { decision: "approve", user_notes: [], live_changes: [] } },
		});
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: approve });
		assert.equal(
			loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" })?.decision,
			"approve",
		);

		// Block the durable write for the next round. Swallowing the failure would
		// leave the approval above as round 1's answer for the next durable read.
		rmSync(artifactPath, { force: true });
		mkdirSync(artifactPath, { recursive: true });
		const revise = toPreviewFeedback({
			iteration: 1,
			stageName: "user-feedback-1",
			result: {
				text: "",
				structured: { decision: "revise", user_notes: ["The hero background is too busy."], live_changes: [] },
			},
		});
		assert.throws(
			() => persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: revise }),
			(error: Error) =>
				/failed to write the feedback deliverable/.test(error.message) &&
				error.message.includes(artifactPath) &&
				error.message.includes("user-feedback-1"),
		);
		assert.equal(loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" }), undefined);

		// With the path clear the same round persists and reloads as the revision.
		rmSync(artifactPath, { recursive: true, force: true });
		persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: revise });
		assert.deepEqual(loadPreviewFeedback({ artifactDir: dir, iteration: 1, stageName: "user-feedback-1" }), revise);
	});
});
