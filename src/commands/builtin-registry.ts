/**
 * Atomic-CLI-specific registry of builtin workflows.
 *
 * Lives outside the SDK because the set of builtins is an atomic CLI
 * concern: third-party CLIs build their own registries with their own
 * workflows.
 */

import { createRegistry } from "../sdk/registry.ts";

// ralph
import ralphClaude from "../sdk/workflows/builtin/ralph/claude/index.ts";
import ralphCopilot from "../sdk/workflows/builtin/ralph/copilot/index.ts";
import ralphOpencode from "../sdk/workflows/builtin/ralph/opencode/index.ts";

// deep-research-codebase
import drcClaude from "../sdk/workflows/builtin/deep-research-codebase/claude/index.ts";
import drcCopilot from "../sdk/workflows/builtin/deep-research-codebase/copilot/index.ts";
import drcOpencode from "../sdk/workflows/builtin/deep-research-codebase/opencode/index.ts";

// open-claude-design
import ocdClaude from "../sdk/workflows/builtin/open-claude-design/claude/index.ts";
import ocdCopilot from "../sdk/workflows/builtin/open-claude-design/copilot/index.ts";
import ocdOpencode from "../sdk/workflows/builtin/open-claude-design/opencode/index.ts";

export function createBuiltinRegistry() {
  return createRegistry()
    .register(ralphClaude)
    .register(ralphCopilot)
    .register(ralphOpencode)
    .register(drcClaude)
    .register(drcCopilot)
    .register(drcOpencode)
    .register(ocdClaude)
    .register(ocdCopilot)
    .register(ocdOpencode);
}
