/**
 * Commander embedding — mount an atomic workflow under a parent
 * Commander CLI alongside plain Commander commands.
 *
 * The SDK exposes pure primitives — there's nothing to "embed" any more.
 * Just call `runWorkflow({ workflow, inputs })` from inside any
 * Commander action and the workflow spawns its own tmux session via the
 * SDK's orchestrator entry script. No `runCli` wrapper, no
 * orchestrator-mode env vars, no re-entry guards.
 *
 * Try:
 *   bun run examples/commander-embed/cli.ts greet --who=Alex
 *   bun run examples/commander-embed/cli.ts status
 *   bun run examples/commander-embed/cli.ts --help
 */

import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic/workflows";
import workflow from "./claude/index.ts";

const program = new Command("my-app").description(
  "Demo CLI with an atomic workflow alongside plain Commander commands",
);

// ── greet — mount the workflow's inputs as `--<input>` options ──────────
const greet = program
  .command("greet")
  .description(workflow.description);

const inputs = getInputSchema(workflow);
for (const input of inputs) {
  const desc =
    input.description ??
    (input.type === "enum"
      ? `one of: ${(input.values ?? []).join(", ")}`
      : input.type);
  greet.option(`--${input.name} <value>`, desc);
}

greet.action(async (rawOpts) => {
  const opts = rawOpts as Record<string, string | undefined>;
  const collected: Record<string, string> = {};
  for (const input of inputs) {
    const camelKey = input.name.replace(
      /-([a-z])/g,
      (_, c: string) => c.toUpperCase(),
    );
    const value = opts[camelKey] ?? opts[input.name];
    if (typeof value === "string" && value !== "") {
      collected[input.name] = value;
    }
  }
  await runWorkflow({ workflow, inputs: collected });
});

// ── A plain Commander sibling — no atomic involvement ───────────────────
program
  .command("status")
  .description("Print a trivial status line")
  .action(() => {
    console.log("ok");
  });

await program.parseAsync();
