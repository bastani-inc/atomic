/**
 * Multi-workflow CLI — two small Claude workflows under a single entrypoint.
 *
 * The SDK ships pure primitives (`listWorkflows`, `runWorkflow`,
 * `getInputSchema`, `getName`, `getAgent`) and the developer composes
 * them into whatever CLI library they prefer. Here we use Commander to
 * register one subcommand per workflow with each workflow's declared
 * inputs as `--<flag> <value>` options.
 *
 * Try:
 *   bun run examples/multi-workflow/cli.ts hello   --who=Alex
 *   bun run examples/multi-workflow/cli.ts goodbye --tone=melodramatic
 */

import { Command } from "@commander-js/extra-typings";
import {
  createRegistry,
  getInputSchema,
  getName,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic-sdk/workflows";
import hello from "./hello/claude.ts";
import goodbye from "./goodbye/claude.ts";

const registry = createRegistry().register(hello).register(goodbye);

const program = new Command("multi-workflow").description(
  "Two small Claude workflows under one entrypoint",
);

for (const workflow of listWorkflows(registry)) {
  const sub = program
    .command(getName(workflow))
    .description(workflow.description ?? "");

  const inputs = getInputSchema(workflow);
  for (const input of inputs) {
    const desc =
      input.description ??
      (input.type === "enum"
        ? `one of: ${(input.values ?? []).join(", ")}`
        : input.type);
    sub.option(`--${input.name} <value>`, desc);
  }

  sub.action(async (rawOpts) => {
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
}

await program.parseAsync();
