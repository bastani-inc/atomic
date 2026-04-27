/**
 * Session and status subcommand builders — atomic-CLI internal.
 *
 * These were previously in the SDK (`@bastani/atomic/workflows`); after
 * the SDK refactor each consumer composes their own CLI shape. The
 * atomic CLI uses these helpers to keep `atomic chat session ...`,
 * `atomic workflow session ...`, and `atomic session ...` in lock-step.
 */

import type { Command } from "@commander-js/extra-typings";
import type { SessionScope } from "./session.ts";

/** Commander collect helper: accumulates repeated `-a` values into an array. */
function collectAgent(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Attach the `session` subcommand group (`list` / `connect` / `kill`) to
 * a parent command. Returns the created `session` group so callers can
 * attach extra children if needed.
 */
export function addSessionSubcommand(
  parent: Command,
  scope: SessionScope = "all",
): Command {
  const sessionCmd = parent
    .command("session")
    .description("Manage running tmux sessions on the atomic socket");

  sessionCmd
    .command("list")
    .description("List running sessions on the atomic tmux socket")
    .option(
      "-a, --agent <name>",
      "Filter by agent backend (claude, copilot, opencode); repeatable",
      collectAgent,
      [] as string[],
    )
    .action(async (localOpts) => {
      const { sessionListCommand } = await import("./session.ts");
      const exitCode = await sessionListCommand(localOpts.agent, scope);
      process.exit(exitCode);
    });

  sessionCmd
    .command("connect")
    .description("Attach to a running session (interactive picker when no id given)")
    .argument("[session_id]", "Session name to connect to")
    .option(
      "-a, --agent <name>",
      "Filter picker by agent backend (claude, copilot, opencode); repeatable",
      collectAgent,
      [] as string[],
    )
    .action(async (sessionId, localOpts) => {
      if (sessionId) {
        const { sessionConnectCommand } = await import("./session.ts");
        const exitCode = await sessionConnectCommand(sessionId);
        process.exit(exitCode);
      } else {
        const { sessionPickerCommand } = await import("./session.ts");
        const exitCode = await sessionPickerCommand(localOpts.agent, scope);
        process.exit(exitCode);
      }
    });

  sessionCmd
    .command("kill")
    .description("Kill a running session (omit id to kill all in scope)")
    .argument("[session_id]", "Session name to kill (omit to kill all)")
    .option(
      "-a, --agent <name>",
      "Filter by agent backend (claude, copilot, opencode); repeatable",
      collectAgent,
      [] as string[],
    )
    .option("-y, --yes", "Skip the confirmation prompt (required for agent callers)")
    .action(async (sessionId, localOpts) => {
      const { sessionKillCommand } = await import("./session.ts");
      const exitCode = await sessionKillCommand(
        sessionId,
        localOpts.agent,
        scope,
        undefined,
        { yes: localOpts.yes === true },
      );
      process.exit(exitCode);
    });

  return sessionCmd;
}

/** Attach a top-level `status` subcommand. Mirrors `atomic workflow status`. */
export function addStatusSubcommand(parent: Command): void {
  parent
    .command("status")
    .description(
      "Query workflow status (in_progress, error, completed, needs_review); omit id to list all",
    )
    .argument("[session_id]", "Workflow tmux session id (omit to list all)")
    .option("--format <format>", "Output format: json | text", "json")
    .action(async (sessionId, localOpts) => {
      const { workflowStatusCommand } = await import("./workflow-status.ts");
      const exitCode = await workflowStatusCommand({
        id: sessionId,
        format: localOpts.format === "text" ? "text" : "json",
      });
      process.exit(exitCode);
    });
}
