/**
 * Fail-fast login checks for the agent CLIs atomic drives.
 *
 * Copilot exposes `CopilotClient.getAuthStatus()` — a thin JSON-RPC call
 * that returns `isAuthenticated: boolean`. Claude Agent SDK has no
 * direct "is signed in" primitive, but `query().initializationResult()`
 * returns an `account` record populated with `email`, `tokenSource`,
 * and/or `apiKeySource` whenever the CLI has valid credentials — an
 * empty record means the user never completed the OAuth flow and no
 * API key is in the environment.
 *
 * We run these probes BEFORE spawning the native CLI from `atomic chat`
 * or `atomic workflow` so the user sees a short actionable error
 * instead of dropping into an interactive agent that immediately
 * prompts for login (or, in the workflow case, silently stalls).
 */

import type { AgentKey } from "../config/index.ts";
import { COLORS } from "../../theme/colors.ts";
import { copilotSdkLaunchOptions } from "../../sdk/providers/copilot.ts";

export interface AuthCheckResult {
  /** True when the SDK reports the user is authenticated. */
  loggedIn: boolean;
  /** Optional human-readable detail — usually the SDK's status message. */
  detail?: string;
  /** Login identity if reported (GitHub login for Copilot, email for Claude). */
  identity?: string;
}

/**
 * Verify the user is authenticated for the given agent. For agents that
 * do not expose an SDK-level auth probe (currently `opencode`), returns
 * `{ loggedIn: true }` so the caller can skip the check.
 */
export async function checkAgentAuth(agent: AgentKey): Promise<AuthCheckResult> {
  if (agent === "copilot") return checkCopilotAuth();
  if (agent === "claude") return checkClaudeAuth();
  return { loggedIn: true };
}

/**
 * Print a consistent login-required banner to stderr. Exported so
 * `chatCommand` and `workflowCommand` share the same wording.
 */
export function printAuthError(agent: AgentKey, result: AuthCheckResult): void {
  const { name, loginHint } = AUTH_PROMPTS[agent];
  console.error(
    `${COLORS.red}Error: Not logged in to ${name}.${COLORS.reset}`,
  );
  if (result.detail) {
    console.error(`${COLORS.dim}${result.detail}${COLORS.reset}`);
  }
  console.error(loginHint);
}

const AUTH_PROMPTS: Record<AgentKey, { name: string; loginHint: string }> = {
  claude: {
    name: "Claude Code",
    loginHint:
      "Run `claude` and complete the /login flow (or set ANTHROPIC_API_KEY), then retry.",
  },
  copilot: {
    name: "GitHub Copilot CLI",
    loginHint: "Run `copilot` and complete the `/login` flow, then retry.",
  },
  opencode: {
    name: "OpenCode",
    loginHint: "Run `opencode auth login`, then retry.",
  },
};

async function checkCopilotAuth(): Promise<AuthCheckResult> {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient(copilotSdkLaunchOptions());
  try {
    await client.start();
    const status = await client.getAuthStatus();
    return {
      loggedIn: status.isAuthenticated,
      detail: status.statusMessage,
      identity: status.login,
    };
  } catch (err) {
    return {
      loggedIn: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await client.stop();
    } catch {
      // Best effort — a failed stop shouldn't shadow the probe result.
    }
  }
}

async function checkClaudeAuth(): Promise<AuthCheckResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { resolveHeadlessClaudeBin } = await import("../../sdk/providers/claude.ts");

  // A never-yielding iterable keeps the query idle while we probe the
  // initialization result. The SDK starts the `claude` subprocess on
  // query construction but only blocks on the stream once a prompt is
  // actually delivered.
  async function* emptyStream(): AsyncGenerator<never, void, void> {}

  const q = query({
    prompt: emptyStream(),
    options: {
      pathToClaudeCodeExecutable: resolveHeadlessClaudeBin(),
    },
  });

  try {
    const init = await q.initializationResult();
    const account = init.account ?? {};
    const loggedIn = Boolean(
      account.email || account.tokenSource || account.apiKeySource,
    );
    return {
      loggedIn,
      identity: account.email,
    };
  } catch (err) {
    return {
      loggedIn: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      q.close();
    } catch {
      // Best effort — the subprocess is torn down on process exit anyway.
    }
  }
}
