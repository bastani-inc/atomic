import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

async function renderOrchestratorPrompt(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-delegation-policy-"));
  try {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx({
      prompt: "Implement a focused change",
      max_loops: 1,
      base_branch: "origin/main",
      git_worktree_dir: "",
      create_pr: false,
    });

    await mod.default.run({ ...ctx, cwd });
    return ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("Ralph orchestrator prompt preserves configured subagent model policy", async () => {
  const prompt = await renderOrchestratorPrompt();

  assert.match(prompt, /<delegated_subagent_policy>/);
  assert.match(
    prompt,
    /omit the subagent tool's explicit `model` argument so each named agent uses its declared configured model and fallback policy/,
  );
  assert.match(
    prompt,
    /only when the user explicitly requests that exact override or when a documented task-specific requirement makes it necessary/,
  );
  assert.match(
    prompt,
    /Before launching a subagent with a model override, record the exact override and reason in the running implementation notes/,
  );
  assert.match(prompt, /Never invent or select an ad hoc model ID solely for diversity/);
});

test("Ralph orchestrator prompt isolates all delegates in one run group", async () => {
  const prompt = await renderOrchestratorPrompt();

  assert.match(
    prompt,
    /create one invocation-specific literal Intercom group name that is not `default`/,
  );
  assert.match(
    prompt,
    /Pass that same group name as the explicit `group` argument to every delegated subagent for this workflow run, including parallel and follow-up delegations/,
  );
  assert.match(prompt, /never leave delegates in the `default` group/);
  assert.match(
    prompt,
    /Preserve escalation through `contact_supervisor`; it remains available to delegated children and can reach the supervisor across Intercom group boundaries/,
  );
  assert.match(prompt, /<\/delegated_subagent_policy>/);
});
