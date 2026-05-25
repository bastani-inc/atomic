import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isWorkflowRuntimeFrame,
  normalizedPromptCallsiteFrame,
  selectPromptCallsiteFrame,
} from "../../packages/workflows/src/runs/shared/prompt-callsite.js";

describe("prompt callsite stack frame filtering", () => {
  test("filters source workflow runtime frames", () => {
    const runtimePath = join(process.cwd(), "packages/workflows/src/runs/foreground/executor.ts");
    const frame = normalizedPromptCallsiteFrame(
      `    at promptReplayKey (${runtimePath}:262:13)`,
    );

    assert.equal(frame, undefined);
  });

  test("filters packaged workflow runtime frames", () => {
    const frame = normalizedPromptCallsiteFrame(
      "    at promptReplayKey (/repo/packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts:262:13)",
    );

    assert.equal(frame, undefined);
  });

  test("filters node_modules workflow runtime frames", () => {
    const frame = normalizedPromptCallsiteFrame(
      "    at promptReplayKey (/repo/node_modules/@bastani/workflows/src/runs/foreground/executor.ts:262:13)",
    );

    assert.equal(frame, undefined);
  });

  test("filters Windows packaged workflow runtime frames after slash normalization", () => {
    const frame = normalizedPromptCallsiteFrame(
      "    at promptReplayKey (C:\\repo\\packages\\coding-agent\\dist\\builtin\\workflows\\src\\runs\\foreground\\executor.ts:262:13)",
    );

    assert.equal(frame, undefined);
  });

  test("filters file URL workflow runtime frames", () => {
    const runtimePath = join(process.cwd(), "packages/workflows/src/runs/foreground/executor.ts");
    const frame = normalizedPromptCallsiteFrame(`    at promptReplayKey (${pathToFileURL(runtimePath).href}:262:13)`);

    assert.equal(frame, undefined);
  });

  test("preserves workflow author frames", () => {
    assert.equal(
      normalizedPromptCallsiteFrame("    at workflow (.atomic/workflows/review.ts:10:5)"),
      ".atomic/workflows/review.ts:10:5",
    );
    assert.equal(
      normalizedPromptCallsiteFrame("    at workflow (.atomic/workflows/packages/workflows/src/review.ts:10:5)"),
      ".atomic/workflows/packages/workflows/src/review.ts:10:5",
    );
    assert.equal(
      normalizedPromptCallsiteFrame("    at workflow (test/unit/executor.test.ts:800:20)"),
      "test/unit/executor.test.ts:800:20",
    );
    assert.equal(
      normalizedPromptCallsiteFrame("    at workflow (packages/workflows/builtin/ralph.ts:618:12)"),
      "packages/workflows/builtin/ralph.ts:618:12",
    );
    assert.equal(
      normalizedPromptCallsiteFrame("    at workflow (packages/coding-agent/dist/builtin/workflows/builtin/ralph.ts:618:12)"),
      "packages/coding-agent/dist/builtin/workflows/builtin/ralph.ts:618:12",
    );
  });

  test("classifies only workflow implementation roots as runtime frames", () => {
    assert.equal(isWorkflowRuntimeFrame("packages/workflows/src/runs/foreground/executor.ts"), true);
    assert.equal(isWorkflowRuntimeFrame("packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts"), true);
    assert.equal(isWorkflowRuntimeFrame("node_modules/@bastani/workflows/src/runs/foreground/executor.ts"), true);
    assert.equal(isWorkflowRuntimeFrame(".atomic/workflows/packages/workflows/src/review.ts"), false);
    assert.equal(isWorkflowRuntimeFrame("packages/workflows/builtin/ralph.ts"), false);
    assert.equal(isWorkflowRuntimeFrame("packages/coding-agent/dist/builtin/workflows/builtin/ralph.ts"), false);
  });

  test("selects an author frame from a real Bun Error stack", () => {
    function captureAuthorFrame(): string | undefined {
      return selectPromptCallsiteFrame(new Error().stack ?? "");
    }

    const frame = captureAuthorFrame();

    assert.match(frame ?? "", /test\/unit\/prompt-callsite\.test\.ts:\d+:\d+$/);
  });

  test("selects different author callsites behind packaged runtime frames", () => {
    const stackForLine10 = [
      "Error",
      "    at promptReplayKey (/repo/packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts:239:70)",
      "    at Object.confirm (/repo/packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts:1731:25)",
      "    at workflow (/repo/.atomic/workflows/review.ts:10:5)",
    ].join("\n");
    const stackForLine20 = [
      "Error",
      "    at promptReplayKey (/repo/packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts:239:70)",
      "    at Object.confirm (/repo/packages/coding-agent/dist/builtin/workflows/src/runs/foreground/executor.ts:1731:25)",
      "    at workflow (/repo/.atomic/workflows/review.ts:20:5)",
    ].join("\n");

    const line10Frame = selectPromptCallsiteFrame(stackForLine10);
    const line20Frame = selectPromptCallsiteFrame(stackForLine20);

    assert.match(line10Frame ?? "", /\.atomic\/workflows\/review\.ts:10:5$/);
    assert.match(line20Frame ?? "", /\.atomic\/workflows\/review\.ts:20:5$/);
    assert.notEqual(line10Frame, line20Frame);
  });
});
