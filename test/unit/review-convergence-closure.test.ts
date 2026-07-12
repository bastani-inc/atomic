import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  closureGapSummary,
  consolidateFindingsBatch,
  findingBlocksClosure,
  MAX_BLOCKING_PRIORITY,
  unresolvedClosureFindings,
  type ConsolidatableFinding,
} from "../../packages/workflows/builtin/review-convergence.js";

function finding(
  overrides: Partial<ConsolidatableFinding> & { readonly title?: string } = {},
): ConsolidatableFinding {
  return {
    title: "[P2] A concrete defect",
    objective_alignment: "consistent_with_objective",
    priority: 2,
    code_location: { absolute_file_path: "/repo/src/file.ts" },
    ...overrides,
  };
}

describe("findingBlocksClosure", () => {
  test("required_by_objective blocks at every priority, including P3 and null", () => {
    for (const priority of [0, 1, 2, 3, null, undefined]) {
      assert.equal(
        findingBlocksClosure({ objective_alignment: "required_by_objective", priority }),
        true,
        `priority ${String(priority)}`,
      );
    }
  });

  test("consistent_with_objective blocks P0-P2 and unprioritized, not P3", () => {
    assert.equal(findingBlocksClosure(finding({ priority: 0 })), true);
    assert.equal(findingBlocksClosure(finding({ priority: MAX_BLOCKING_PRIORITY })), true);
    assert.equal(findingBlocksClosure(finding({ priority: null })), true);
    assert.equal(findingBlocksClosure(finding({ priority: undefined })), true);
    assert.equal(findingBlocksClosure(finding({ priority: 3 })), false);
  });

  test("beyond_objective and contradicts_objective never block, preserving literal-contract scope controls", () => {
    for (const alignment of ["beyond_objective", "contradicts_objective"]) {
      assert.equal(
        findingBlocksClosure({ objective_alignment: alignment, priority: 0 }),
        false,
        alignment,
      );
    }
  });

  test("missing or unknown alignment blocks so ambiguity never silently approves", () => {
    assert.equal(findingBlocksClosure({ priority: 3 }), true);
    assert.equal(
      findingBlocksClosure({ objective_alignment: "made_up_alignment", priority: 3 }),
      true,
    );
  });
});

describe("consolidateFindingsBatch", () => {
  test("merges the same finding reported by multiple reviewers into one batch entry", () => {
    const shared = finding({ title: "[P2] Missing boundary check" });
    const batch = consolidateFindingsBatch([
      { reviewer: "reviewer-a", findings: [shared] },
      { reviewer: "reviewer-b", findings: [finding({ title: "[P1] Missing boundary check", priority: 1 })] },
    ]);
    assert.equal(batch.length, 1);
    assert.deepEqual(batch[0]?.reviewers, ["reviewer-a", "reviewer-b"]);
    assert.equal(batch[0]?.blocking, true);
  });

  test("keeps distinct findings separate and sorts blocking entries first", () => {
    const batch = consolidateFindingsBatch([
      {
        reviewer: "reviewer-a",
        findings: [
          finding({ title: "[P3] Cosmetic nit", priority: 3 }),
          finding({ title: "[P0] Data loss on retry", priority: 0 }),
        ],
      },
    ]);
    assert.equal(batch.length, 2);
    assert.equal(batch[0]?.blocking, true);
    assert.equal(batch[0]?.finding.title, "[P0] Data loss on retry");
    assert.equal(batch[1]?.blocking, false);
  });

  test("blocking is the OR of merged duplicates so relabeling one copy cannot dismiss it", () => {
    const batch = consolidateFindingsBatch([
      { reviewer: "reviewer-a", findings: [finding({ title: "[P3] Same defect", priority: 3 })] },
      {
        reviewer: "reviewer-b",
        findings: [
          finding({
            title: "[P3] Same defect",
            priority: 3,
            objective_alignment: "required_by_objective",
          }),
        ],
      },
    ]);
    assert.equal(batch.length, 1);
    assert.equal(batch[0]?.blocking, true);
  });
});

describe("unresolvedClosureFindings / closureGapSummary", () => {
  test("returns only blocking findings across all reviewers", () => {
    const unresolved = unresolvedClosureFindings([
      { reviewer: "reviewer-a", findings: [finding({ title: "[P3] Nit", priority: 3 })] },
      { reviewer: "reviewer-b", findings: [finding({ title: "[P1] Real gap", priority: 1 })] },
    ]);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.finding.title, "[P1] Real gap");
  });

  test("summary is inspectable and bounded", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      finding({ title: `[P1] Gap ${index + 1}`, priority: 1 }),
    );
    const unresolved = unresolvedClosureFindings([{ reviewer: "reviewer-a", findings: many }]);
    const summary = closureGapSummary(unresolved);
    assert.match(summary, /^7 unresolved objective-relevant blocking finding\(s\): /);
    assert.match(summary, /Gap 5/);
    assert.doesNotMatch(summary, /Gap 6/);
    assert.match(summary, /…$/);
  });
});
