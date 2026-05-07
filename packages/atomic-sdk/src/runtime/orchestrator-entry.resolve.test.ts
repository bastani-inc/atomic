/**
 * Unit tests for `resolveWorkflowDefinition`.
 *
 * Verifies the post-import resolution chain that
 * `runOrchestratorEntry` relies on:
 *   1. `(name, agent)` lookup against the host-local-workflows registry
 *      (populated by `hostLocalWorkflows([…])`).
 *   2. `mod.default` fallback for the legacy worker pattern.
 *   3. `InvalidWorkflowError` when neither produces a definition.
 *
 * Each fixture lives at a distinct on-disk path so Bun's module cache
 * doesn't conflate registry-vs-default behaviour across tests.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { join } from "node:path";
import { resolveWorkflowDefinition } from "./orchestrator-entry.ts";
import { _clearLocalWorkflowRegistry } from "../lib/host-local-workflows.ts";
import { InvalidWorkflowError } from "../errors.ts";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__");

describe("resolveWorkflowDefinition", () => {
  beforeEach(() => {
    _clearLocalWorkflowRegistry();
  });

  test("prefers a workflow registered via hostLocalWorkflows over mod.default", async () => {
    const def = await resolveWorkflowDefinition(
      join(FIXTURE_DIR, "host-only.ts"),
      "host-only-wf",
      "claude",
    );

    expect(def.name).toBe("host-only-wf");
    expect(def.agent).toBe("claude");
  });

  test("falls back to mod.default when the registry has no match", async () => {
    const def = await resolveWorkflowDefinition(
      join(FIXTURE_DIR, "default-only.ts"),
      "default-only-wf",
      "claude",
    );

    expect(def.name).toBe("default-only-wf");
    expect(def.agent).toBe("claude");
  });

  test("throws InvalidWorkflowError when neither registry nor mod.default resolves", async () => {
    let caught: unknown;
    try {
      await resolveWorkflowDefinition(
        join(FIXTURE_DIR, "empty-module.ts"),
        "anything",
        "claude",
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InvalidWorkflowError);
  });

  test("empty workflowName skips registry lookup and uses mod.default directly", async () => {
    // Empty `workflowName` is the back-compat shape — older atomic CLIs
    // emit only `<agent> <inputsB64> <source>`. Resolution must still
    // succeed via `mod.default`.
    const def = await resolveWorkflowDefinition(
      join(FIXTURE_DIR, "default-only.ts"),
      "",
      "claude",
    );

    expect(def.name).toBe("default-only-wf");
  });
});
