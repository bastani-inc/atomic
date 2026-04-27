import { Command } from "@commander-js/extra-typings";
import {
  getInputSchema,
  runWorkflow,
} from "@bastani/atomic/workflows";
import workflow from "./opencode/index.ts";

const program = new Command();
const inputs = getInputSchema(workflow);

for (const input of inputs) {
  const desc =
    input.description ??
    (input.type === "enum"
      ? `one of: ${(input.values ?? []).join(", ")}`
      : input.type);
  program.option(`--${input.name} <value>`, desc);
}

program.argument("[prompt...]", "Free-form prompt (joined into inputs.prompt)");
program.allowExcessArguments(true);

program.action(async function (this: Command) {
  const opts = this.opts() as Record<string, string | undefined>;
  const promptTokens: string[] = this.args;

  const collected: Record<string, string> = {};
  for (const input of inputs) {
    const camelKey = input.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = opts[camelKey] ?? opts[input.name];
    if (typeof value === "string" && value !== "") {
      collected[input.name] = value;
    }
  }

  const promptStr = promptTokens.join(" ");
  if (promptStr !== "" && inputs.length === 0) {
    collected["prompt"] = promptStr;
  }

  await runWorkflow({ workflow, inputs: collected });
});

await program.parseAsync();
