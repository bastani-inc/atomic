/**
 * Pane-navigation demo CLI — drives the SDK's tmux navigation primitives
 * against a running pane-navigation workflow session.
 *
 * Usage:
 *   bun run examples/pane-navigation/cli.ts start --agent claude
 *   bun run examples/pane-navigation/cli.ts list
 *   bun run examples/pane-navigation/cli.ts status <session-id>
 *   bun run examples/pane-navigation/cli.ts next   <session-id>
 *   bun run examples/pane-navigation/cli.ts prev   <session-id>
 *   bun run examples/pane-navigation/cli.ts home   <session-id>
 *   bun run examples/pane-navigation/cli.ts attach <session-id>
 *   bun run examples/pane-navigation/cli.ts stop   <session-id>
 *
 * Recommended flow:
 *   1. Run `start --agent <agent>` — prints the tmux session id.
 *   2. In a *second* terminal, run
 *        tmux -L atomic attach -t <session-id>
 *      so you can watch the active window change in real time.
 *   3. Back in the first terminal, run `next` / `prev` / `home` against
 *      the id. Each command sends the corresponding tmux verb to the
 *      session and returns immediately; the second terminal reflects
 *      the change live.
 *
 *      The navigation primitives are pure — they never auto-attach.
 *      Use the `attach` subcommand explicitly when you want to take
 *      over the terminal.
 */

import { Command } from "@commander-js/extra-typings";
import {
  attachSession,
  getSessionStatus,
  gotoOrchestrator,
  listSessions,
  nextWindow,
  previousWindow,
  runWorkflow,
  SessionNotFoundError,
  stopSession,
  type AgentType,
} from "@bastani/atomic-sdk";
import claudeWorkflow from "./claude/index.ts";
import copilotWorkflow from "./copilot/index.ts";
import opencodeWorkflow from "./opencode/index.ts";

const WORKFLOWS = {
  claude: claudeWorkflow,
  copilot: copilotWorkflow,
  opencode: opencodeWorkflow,
} as const satisfies Record<AgentType, unknown>;

const program = new Command("pane-navigation").description(
  "Spawn the demo workflow and exercise the SDK pane-navigation primitives",
);

program
  .command("start")
  .description("Spawn the pane-navigation workflow detached and print its session id")
  .requiredOption(
    "--agent <agent>",
    "agent backend (claude | copilot | opencode)",
  )
  .action(async (opts) => {
    const agent = opts.agent as AgentType;
    const workflow = WORKFLOWS[agent];
    if (!workflow) {
      console.error(`Unknown agent: ${agent}`);
      process.exit(1);
    }
    const result = await runWorkflow({ workflow, detach: true });
    console.log(result.runId);
  });

program
  .command("list")
  .description("List workflow sessions on the atomic socket")
  .action(async () => {
    const sessions = await listSessions({ scope: "workflow" });
    if (sessions.length === 0) {
      console.log("(no workflow sessions)");
      return;
    }
    for (const s of sessions) {
      const flag = s.attached ? "*" : " ";
      console.log(`${flag} ${s.id}  agent=${s.agent ?? "?"}  created=${s.created}`);
    }
  });

program
  .command("status <id>")
  .description("Print the on-disk status snapshot for a workflow session")
  .action(async (id: string) => {
    const snapshot = await getSessionStatus(id);
    if (!snapshot) {
      console.log("(no status snapshot yet)");
      return;
    }
    console.log(JSON.stringify(snapshot, null, 2));
  });

program
  .command("next <id>")
  .description("Move the session's current-window pointer to the next window")
  .action((id: string) => handleErrors(() => nextWindow(id)));

program
  .command("prev <id>")
  .description("Move the session's current-window pointer to the previous window")
  .action((id: string) => handleErrors(() => previousWindow(id)));

program
  .command("home <id>")
  .description("Jump to the orchestrator window (window 0) of the session")
  .action((id: string) => handleErrors(() => gotoOrchestrator(id)));

program
  .command("attach <id>")
  .description("Attach this terminal to the session interactively")
  .action((id: string) => handleErrors(async () => { await attachSession(id); }));

program
  .command("stop <id>")
  .description("Kill the session (best-effort; idempotent)")
  .action(async (id: string) => {
    await stopSession(id);
  });

/**
 * Run an SDK call and translate `SessionNotFoundError` into a clean exit
 * with an actionable hint. Any other error bubbles up unchanged.
 */
async function handleErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      console.error(`session not found: ${err.id}`);
      console.error("run `pane-navigation list` to see what's running");
      process.exit(1);
    }
    throw err;
  }
}

await program.parseAsync();
