#!/usr/bin/env bun
/**
 * `bun create @bastani/atomic-cli` entry.
 *
 * Mirrors `bun init`'s shape: a positional name, optional `--template`
 * and friends, `-y` to accept defaults, interactive prompts when flags
 * are missing.
 */
import * as p from "@clack/prompts";
import {
  scaffold,
  validateName,
  type Agent,
  type ScaffoldOptions,
  type Scope,
  type Template,
} from "./index.ts";

interface ParsedArgv {
  name?: string;
  template?: Template;
  scope?: Scope;
  agent?: Agent;
  yes: boolean;
  help: boolean;
}

const HELP = `bun create @bastani/atomic-cli <name> [options]

Scaffold an atomic workflow or third-party CLI.

Templates:
  atomic-workflow  Add a workflow to atomic CLI (registers in settings.json)
  standalone-cli   Build my own CLI tool (single-binary, bun build --compile)

Options:
  --template <t>   atomic-workflow | standalone-cli
  --scope <s>      project | global   (atomic-workflow only; default project)
  --agent <a>      claude | copilot | opencode   (default claude)
  -y, --yes        accept all defaults
  -h, --help       show this message
`;

function parseArgv(raw: string[]): ParsedArgv {
  const out: ParsedArgv = { yes: false, help: false };
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (arg === "-y" || arg === "--yes") {
      out.yes = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--template" || arg.startsWith("--template=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1]! : raw[++i] ?? "";
      out.template = value as Template;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1]! : raw[++i] ?? "";
      out.scope = value as Scope;
    } else if (arg === "--agent" || arg.startsWith("--agent=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1]! : raw[++i] ?? "";
      out.agent = value as Agent;
    } else if (!arg.startsWith("-") && out.name === undefined) {
      out.name = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

const TEMPLATE_LABEL: Record<Template, string> = {
  "atomic-workflow":
    "Add a workflow to atomic CLI  (use this if you have atomic installed and want it to dispatch this workflow)",
  "standalone-cli":
    "Build my own CLI tool  (use this if you want to ship a single binary your users run directly)",
};

const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude (claude.ai/code)",
  copilot: "GitHub Copilot CLI",
  opencode: "OpenCode",
};

const SCOPE_LABEL: Record<Scope, string> = {
  project: "Project (.atomic/workflows/<name>) — checked into this repo",
  global: "Global (~/.atomic/workflows/<name>) — your user account, every project",
};

async function promptOptions(parsed: ParsedArgv): Promise<ScaffoldOptions> {
  const yes = parsed.yes;

  // ── Name ─────────────────────────────────────────────────────────────
  let name = parsed.name;
  if (!name && !yes) {
    const ans = await p.text({
      message: "Project name",
      placeholder: "my-app",
      validate: (v: string | undefined) =>
        validateName(v ?? "") ?? undefined,
    });
    if (p.isCancel(ans)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    name = ans;
  }
  name = name ?? "my-app";
  const nameErr = validateName(name);
  if (nameErr) {
    p.cancel(`Invalid name: ${nameErr}`);
    process.exit(1);
  }

  // ── Template ─────────────────────────────────────────────────────────
  let template = parsed.template;
  if (!template && !yes) {
    const ans = await p.select({
      message: "What are you building?",
      options: [
        { value: "standalone-cli", label: TEMPLATE_LABEL["standalone-cli"] },
        { value: "atomic-workflow", label: TEMPLATE_LABEL["atomic-workflow"] },
      ],
    });
    if (p.isCancel(ans)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    template = ans as Template;
  }
  template = template ?? "standalone-cli";

  // ── Scope (atomic-workflow only) ─────────────────────────────────────
  let scope: Scope | undefined = parsed.scope;
  if (template === "atomic-workflow" && !scope && !yes) {
    const ans = await p.select({
      message: "Where should this workflow live?",
      options: [
        { value: "project", label: SCOPE_LABEL.project },
        { value: "global", label: SCOPE_LABEL.global },
      ],
    });
    if (p.isCancel(ans)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    scope = ans as Scope;
  }
  if (template === "atomic-workflow") {
    scope = scope ?? "project";
  }

  // ── Agent ────────────────────────────────────────────────────────────
  let agent = parsed.agent;
  if (!agent && !yes) {
    const ans = await p.select({
      message: "Default agent",
      options: [
        { value: "claude", label: AGENT_LABEL.claude },
        { value: "copilot", label: AGENT_LABEL.copilot },
        { value: "opencode", label: AGENT_LABEL.opencode },
      ],
    });
    if (p.isCancel(ans)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    agent = ans as Agent;
  }
  agent = agent ?? "claude";

  return { name, template, scope, agent };
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }

  p.intro("create-atomic-cli");
  const opts = await promptOptions(parsed);

  const result = await scaffold(opts);

  if (opts.template === "atomic-workflow") {
    p.note(
      [
        `Workflow scaffolded at:`,
        `  ${result.projectDir}`,
        ``,
        `Registry entry ${result.settingsCreated ? "created in" : "merged into"}:`,
        `  ${result.settingsPath}`,
        ``,
        `Next steps:`,
        `  cd ${result.projectDir}`,
        `  bun install`,
        `  cd -`,
        `  atomic workflow refresh`,
        `  atomic workflow -n ${opts.name} -a ${opts.agent} --prompt "say hi"`,
      ].join("\n"),
      "Done",
    );
  } else {
    p.note(
      [
        `Project scaffolded at:`,
        `  ${result.projectDir}`,
        ``,
        `Next steps:`,
        `  cd ${result.projectDir}`,
        `  bun install`,
        `  bun run mycli.ts hello --prompt "say hi"     # run from source`,
        `  bun run build && ./dist/${opts.name} hello --prompt "say hi"   # compile + run`,
      ].join("\n"),
      "Done",
    );
  }
  p.outro("");
}

await main();
