// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertUserAnnotationsThreaded,
    buildRefinementBrief,
    buildUserAnnotationsSection,
    extractAnnotatedSnapshot,
    extractLiveChanges,
    extractUserNotes,
    persistPreviewFeedback,
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
        const text = [
            "user_notes: simplify the hero",
            "annotated_snapshot: .playwright-cli/annotations-test.png",
        ].join("\n");
        assert.equal(
            extractAnnotatedSnapshot(text),
            ".playwright-cli/annotations-test.png",
        );
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
            stageName: "preview-display-1",
            result: { text: liveText },
        });
        assert.match(feedback.liveChanges ?? "", /tighter density/);

        // Accepted live variants thread into the user-annotations block so the
        // apply stage honors them even with no typed notes.
        const block = userAnnotationsBlock([feedback]);
        assert.equal(block.hasNotes, true);
        assert.match(block.text, /Accepted live variants\/edits/);
        assert.match(block.text, /tighter density/);
    });

    test("buildUserAnnotationsSection orders latest feedback first", () => {
        const first = toPreviewFeedback({
            iteration: 0,
            stageName: "preview-display-initial",
            result: { text: "user_notes: simplify the hero background" },
        });
        const second = toPreviewFeedback({
            iteration: 1,
            stageName: "preview-display-1",
            result: { text: "user_notes: now fix the footer spacing" },
        });
        const section = buildUserAnnotationsSection([first, second]);
        assert.ok(section.indexOf("footer spacing") < section.indexOf("simplify the hero"));
    });

    test("userAnnotationsBlock falls back when no notes captured", () => {
        const empty = userAnnotationsBlock([
            toPreviewFeedback({
                iteration: 0,
                stageName: "preview-display-initial",
                result: { text: "display_method: manual fallback" },
            }),
        ]);
        assert.equal(empty.hasNotes, false);
        assert.match(empty.text, /No interactive user annotations were captured/);
    });

    test("buildRefinementBrief puts user annotations above internal critique", () => {
        const brief = buildRefinementBrief({
            userAnnotations: "Simplify the hero background.",
            reviewerDecision: "Not ready: honor user notes.",
            critique: "Heuristic score 3/4 on visibility.",
            screenshot: "Contrast fails WCAG AA on masthead.",
            currentDesign: "A landing page.",
        });
        assert.ok(
            brief.indexOf("## User annotations") <
                brief.indexOf("## Impeccable critique findings"),
        );
        assert.ok(
            brief.indexOf("Simplify the hero background") <
                brief.indexOf("Heuristic score"),
        );
        assert.ok(brief.includes("## Screenshot / visual QA findings"));
    });

    test("assertUserAnnotationsThreaded throws when notes are dropped", () => {
        const feedback = toPreviewFeedback({
            iteration: 0,
            stageName: "preview-display-initial",
            result: { text: "user_notes: simplify the hero background" },
        });
        // Threaded prompt -> no throw.
        assert.doesNotThrow(() =>
            assertUserAnnotationsThreaded(
                "context includes: simplify the hero background",
                [feedback],
                "apply-changes-1",
            ),
        );
        // Missing notes -> throws a clear workflow error.
        assert.throws(
            () => assertUserAnnotationsThreaded("nothing relevant", [feedback], "apply-changes-1"),
            /were not threaded into the refinement context/,
        );
    });

    test("assertUserAnnotationsThreaded also enforces accepted live-change threading", () => {
        const feedback = toPreviewFeedback({
            iteration: 1,
            stageName: "preview-display-1",
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
                "apply-changes-1",
            ),
        );
        // Dropped live changes -> throws, even though there are no typed notes.
        assert.throws(
            () => assertUserAnnotationsThreaded("nothing relevant", [feedback], "apply-changes-1"),
            /accepted live variants .* were not threaded/,
        );
    });

    test("persistPreviewFeedback writes durable artifacts only when notes exist", () => {
        const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
        tempDirs.push(dir);
        const withNotes = toPreviewFeedback({
            iteration: 0,
            stageName: "preview-display-initial",
            result: { text: "user_notes: simplify the hero background" },
        });
        persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: withNotes });
        const mdPath = join(dir, "feedback", "iteration-0.md");
        const jsonPath = join(dir, "feedback", "iteration-0.json");
        assert.ok(existsSync(mdPath));
        assert.match(readFileSync(mdPath, "utf8"), /simplify the hero background/);
        const json = JSON.parse(readFileSync(jsonPath, "utf8"));
        assert.equal(json.hasUserNotes, true);

        // No-notes feedback writes nothing.
        const noNotes = toPreviewFeedback({
            iteration: 1,
            stageName: "preview-display-1",
            result: { text: "display_method: manual fallback" },
        });
        persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: noNotes });
        assert.equal(existsSync(join(dir, "feedback", "iteration-1.md")), false);
    });

    test("persistPreviewFeedback persists live_changes-only feedback", () => {
        const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
        tempDirs.push(dir);
        const liveOnly = toPreviewFeedback({
            iteration: 2,
            stageName: "preview-display-2",
            result: {
                text: [
                    "display_method: live",
                    "live_changes: Accepted variant 1 for the pricing table.",
                    "user_notes: none",
                ].join("\n"),
            },
        });
        persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback: liveOnly });
        const jsonPath = join(dir, "feedback", "iteration-2.json");
        assert.ok(existsSync(jsonPath));
        const json = JSON.parse(readFileSync(jsonPath, "utf8"));
        assert.equal(json.hasLiveChanges, true);
        assert.equal(json.hasUserNotes, false);
    });

    test("persistPreviewFeedback copies the annotated snapshot artifact", () => {
        const dir = mkdtempSync(join(tmpdir(), "ocd-feedback-"));
        tempDirs.push(dir);
        const snapshot = join(dir, "annotations-test.png");
        writeFileSync(snapshot, "fake-png-bytes");
        writeFileSync(join(dir, "annotations-test.yaml"), "annotations: []");
        const feedback = toPreviewFeedback({
            iteration: 0,
            stageName: "preview-display-initial",
            result: {
                text: [
                    "user_notes: simplify the hero",
                    `annotated_snapshot: ${snapshot}`,
                ].join("\n"),
            },
        });
        persistPreviewFeedback({ artifactDir: dir, workflowCwd: dir, feedback });
        assert.ok(existsSync(join(dir, "feedback", "iteration-0-annotations.png")));
        assert.ok(existsSync(join(dir, "feedback", "iteration-0-annotations.yaml")));
    });
});
