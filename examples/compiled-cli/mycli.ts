/**
 * compiled-cli — third-party CLI built on @bastani/atomic-sdk.
 *
 * Workflows are statically imported and bundled into the compiled binary.
 * `bun build --compile` (see ./build.ts) produces a single self-contained
 * executable that ships without requiring users to install bun or atomic.
 */
import { Command } from "@commander-js/extra-typings";
import { hostLocalWorkflows, runWorkflow, getInputSchema } from "@bastani/atomic-sdk";
import hello from "./workflows/hello.ts";

// `_atomic-run` and `_emit-workflow-meta` token-gated dispatch — exits
// here when atomic invokes this binary as a workflow runner.
await hostLocalWorkflows([hello]);

const program = new Command("compiled-cli").description(
  "Demo CLI built on @bastani/atomic-sdk",
);

const helloCmd = program.command("hello").description(hello.description);

// Mount the workflow's declared inputs as `--<name>` flags.
const inputs = getInputSchema(hello);
for (const input of inputs) {
  helloCmd.option(`--${input.name} <value>`, input.description ?? input.type);
}

helloCmd.action(async (rawOpts) => {
  const opts = rawOpts as Record<string, string | undefined>;
  const collected: Record<string, string> = {};
  for (const input of inputs) {
    const value = opts[input.name];
    if (typeof value === "string" && value !== "") {
      collected[input.name] = value;
    }
  }
  await runWorkflow({ workflow: hello, inputs: collected });
});

await program.parseAsync();
