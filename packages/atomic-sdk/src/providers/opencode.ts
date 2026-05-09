/**
 * OpenCode workflow source validation + headless env helper.
 *
 * Checks that OpenCode workflow source files use the runtime-managed
 * `s.client` and `s.session` instead of manual SDK client creation, and
 * exports the `OPENCODE_CLIENT` override used to keep the interactive
 * `question` tool out of headless stages.
 */

import type { OffloadResumeMetadata } from "../runtime/offload-types.ts";
import { createProviderValidator } from "../types.ts";

/**
 * Client identifier passed to SDK-spawned OpenCode subprocesses in headless
 * stages.
 *
 * OpenCode only registers its interactive `question` tool when
 * `OPENCODE_CLIENT` is one of `"app" | "cli" | "desktop"` (see
 * `packages/opencode/src/tool/registry.ts` upstream — the `questionEnabled`
 * gate). In unattended runs nobody is attached to answer, so we identify
 * ourselves as `"sdk"` to keep the tool off the registry entirely. This
 * mirrors how the upstream ACP integration excludes the tool by default
 * (`packages/opencode/src/cli/cmd/acp.ts` sets `OPENCODE_CLIENT=acp`).
 */
export const HEADLESS_OPENCODE_CLIENT_ID = "sdk";

/**
 * Run `fn` with `process.env.OPENCODE_CLIENT` set to
 * `HEADLESS_OPENCODE_CLIENT_ID`, restoring the prior value afterward. The
 * SDK spawns `opencode serve` via `cross-spawn` and inherits the parent's
 * env at spawn time, so scoping the override around `createOpencode(...)`
 * is enough to influence the subprocess without leaking into later work.
 *
 * A reference counter keeps the override in place while any concurrent
 * headless spawn is still running — otherwise two parallel stages can
 * race, and the second one restores the first one's already-overridden
 * value as if it were the original. The captured "pre-override" state is
 * only read on the outermost entry and only replayed on the outermost
 * exit.
 *
 * Prior value handling is explicit so we distinguish "was unset" from
 * "was set to empty string".
 */
let headlessEnvDepth = 0;
let headlessEnvHadPrior = false;
let headlessEnvPrior: string | undefined;

export async function withHeadlessOpencodeEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (headlessEnvDepth === 0) {
    headlessEnvHadPrior = Object.prototype.hasOwnProperty.call(
      process.env,
      "OPENCODE_CLIENT",
    );
    headlessEnvPrior = process.env.OPENCODE_CLIENT;
  }
  headlessEnvDepth++;
  try {
    process.env.OPENCODE_CLIENT = HEADLESS_OPENCODE_CLIENT_ID;
    return await fn();
  } finally {
    headlessEnvDepth--;
    if (headlessEnvDepth === 0) {
      if (headlessEnvHadPrior) process.env.OPENCODE_CLIENT = headlessEnvPrior;
      else delete process.env.OPENCODE_CLIENT;
    }
  }
}

// ---------------------------------------------------------------------------
// Resume adapter
// ---------------------------------------------------------------------------

/**
 * Build the `opencode` CLI argv fragment needed to resume an offloaded session.
 *
 * `meta.chatFlags` is the effective merged spawn-time flag set captured by
 * `OffloadManager.registerSession` (RFC §5.4). It is required by the schema —
 * there is no legacy fallback.
 *
 * Produces: ["--port", "0", "--session", "<sessionId>", ...meta.chatFlags]
 *
 * `--port 0` mirrors the original spawn (executor.ts buildSpawnArgs for
 * `opencode`) — without it the resumed server doesn't bind a TCP port and
 * `waitForServer` times out at 15s.
 */
export function buildOpencodeResumeArgs(
  meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
  if (meta.agentSessionId == null || meta.agentSessionId === "") {
    throw new Error("empty agentSessionId on resume");
  }
  return ["--port", "0", "--session", meta.agentSessionId, ...meta.chatFlags];
}

/**
 * Validate an OpenCode workflow source file for common mistakes.
 */
export const validateOpenCodeWorkflow = createProviderValidator([
  {
    pattern: /\bcreateOpencodeClient\b/,
    rule: "opencode/manual-client",
    message:
      "Manual createOpencodeClient() call detected. Use s.client instead — " +
      "the runtime auto-creates the client. Pass client config as the second arg to ctx.stage().",
  },
  {
    pattern: /\bclient\.session\.create\b/,
    rule: "opencode/manual-session",
    message:
      "Manual client.session.create() call detected. Use s.session instead — " +
      "the runtime auto-creates the session. Pass session config as the third arg to ctx.stage().",
  },
]);
