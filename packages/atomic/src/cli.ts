#!/usr/bin/env bun
/**
 * Atomic CLI - Configuration management for coding agents
 *
 * Built with Commander.js for robust argument parsing and type-safe options.
 *
 * Usage:
 *   atomic chat -a <agent>                    Start interactive chat with an agent
 *   atomic chat session list                  List running chat/workflow sessions
 *   atomic chat session connect <id>          Attach to a session
 *   atomic workflow list                      List available workflows
 *   atomic workflow inputs <name> -a <agent>  Print a workflow's input schema (JSON)
 *   atomic workflow status [<id>]             Query workflow status (JSON)
 *   atomic workflow session list              List running sessions
 *   atomic workflow session connect <id>      Attach to a session
 *   atomic session list                       List all running sessions
 *   atomic session connect [id]               Interactive session picker
 *   atomic session kill [id] [--all] [-y]     Kill sessions; no id opens multi-select
 *   atomic config set <key> <value>           Set configuration value
 *   atomic --version                          Show version
 *   atomic --help                             Show help
 */

import { Command, Option } from "@commander-js/extra-typings";
import { VERSION } from "./version.ts";
import { COLORS } from "@bastani/atomic-sdk/theme/colors";
import { AGENT_CONFIG, isValidAgent } from "./services/config/index.ts";
import { SUPPORTED_SHELLS, type Shell } from "./completions/index.ts";
import { workflowCommand } from "./commands/cli/workflow.ts";
import { addSessionSubcommand } from "./commands/cli/management-commands.ts";

// The SDK ships its own orchestrator entry script; the dev's CLI never
// has to opt in to re-entry handling. Session subcommand builders live
// in `./commands/cli/management-commands.ts` so `atomic chat session`,
// `atomic workflow session`, and `atomic session` share one
// implementation.

// ─── Program ────────────────────────────────────────────────────────────────

/**
 * Create and configure the main CLI program
 */
export function createProgram() {
    const program = new Command()
        .name("atomic")
        .description("Configuration management CLI for coding agents")
        .version(VERSION, "-v, --version", "Show version number")
        // Required so subcommands (workflow list, session connect) can define
        // their own options without the parent absorbing them first.
        .enablePositionalOptions()

        // Global options available to all commands
        .option("-y, --yes", "Auto-confirm all prompts (non-interactive mode)")
        .option("--no-banner", "Skip ASCII banner display")

        // Configure error output with colors
        .configureOutput({
            writeErr: (str) => {
                process.stderr.write(`${COLORS.red}${str}${COLORS.reset}`);
            },
            outputError: (str, write) => {
                write(`${COLORS.red}${str}${COLORS.reset}`);
            },
        });

    // Build agent choices string for help text
    const agentChoices = Object.keys(AGENT_CONFIG).join(", ");

    // ── Chat command (default) ──────────────────────────────────────────────
    const chatCmd = program
        .command("chat", { isDefault: true })
        .description("Start an interactive chat session with a coding agent")
        .option("-a, --agent <name>", `Agent to chat with (${agentChoices})`)
        // Internal flag — exercised by the verdaccio smoke test and the
        // cross-platform runtime-assets matrix in CI to run onboarding
        // preflight (global-config sync + project setup) without spawning
        // the agent or checking executables. Hidden from `--help` so
        // end users aren't tempted to use it.
        .addOption(
            new Option("--preflight-only").hideHelp(),
        )
        .allowUnknownOption()
        .allowExcessArguments(true)
        .enablePositionalOptions()
        .passThroughOptions()
        .addHelpText(
            "after",
            `
All arguments after -a <agent> are forwarded to the native agent CLI.

Examples:
  $ atomic chat -a claude                           Start Claude interactively
  $ atomic chat -a copilot                          Start Copilot interactively
  $ atomic chat -a opencode                         Start OpenCode interactively
  $ atomic chat -a claude "fix the bug"             Claude with initial prompt
  $ atomic chat session list                        List running sessions
  $ atomic chat session connect <id>                Attach to a session
  $ atomic chat session kill [id]                   Kill a chat session (multi-select when no id)`,
        )
        .action(async (localOpts, cmd) => {
            const agentType = localOpts.agent;

            if (!agentType) {
                console.error(
                    `${COLORS.red}Error: Missing agent.${COLORS.reset}`,
                );
                console.error(
                    "Start chat with an explicit provider, for example: atomic chat -a claude",
                );
                process.exit(1);
            }

            if (!isValidAgent(agentType)) {
                console.error(
                    `${COLORS.red}Error: Unknown agent '${agentType}'${COLORS.reset}`,
                );
                console.error(`Valid agents: ${agentChoices}`);
                process.exit(1);
            }

            const { chatCommand } = await import("./commands/cli/chat.ts");
            const exitCode = await chatCommand({
                agentType,
                passthroughArgs: cmd.args,
                preflightOnly: localOpts.preflightOnly,
            });

            process.exit(exitCode);
        });

    // Chat session subcommands: atomic chat session list / connect
    addSessionSubcommand(chatCmd, "chat");

    // ── Workflow command ─────────────────────────────────────────────────────
    //
    // The base Command (with -n, -a, -d flags and workflow dispatch) is
    // produced by the SDK dispatcher. Subcommands (list, inputs, status,
    // session) are attached here so they live under `atomic workflow *`.
    //
    // `enablePositionalOptions()` on the dispatcher is what makes
    // `atomic workflow list -a claude` route `-a` to the `list`
    // subcommand instead of the parent dispatcher (which *also* declares
    // `-a/--agent` for the dispatch path). Without it, Commander would
    // greedily bind the flag to the parent and the subcommand would
    // never see it.
    workflowCommand
        .description("Run a multi-session agent workflow")
        .enablePositionalOptions()
        .addHelpText(
            "after",
            `
Examples:
  $ atomic workflow list                            List available workflows
  $ atomic workflow list -a claude                  List Claude workflows only
  $ atomic workflow -a claude                       Open the interactive picker
  $ atomic workflow -n ralph -a claude "fix bug"    Run a free-form workflow
  $ atomic workflow -n ralph -a claude -d "fix bug" Run detached in the background
  $ atomic workflow inputs <name> -a claude         Print a workflow's input schema (JSON)
  $ atomic workflow status                          List status for all running workflows
  $ atomic workflow status <id>                     Query a single workflow's status
  $ atomic workflow session list                    List running sessions
  $ atomic workflow session connect <id>            Attach to a session
  $ atomic workflow session kill --all -y           Kill all workflow sessions, no prompt`,
        );

    program.addCommand(workflowCommand);

    // Workflow list subcommand: atomic workflow list [-a <agent>]
    // Prints the builtin registry. `-a` filters to one agent so users
    // can narrow to workflows runnable with their configured provider.
    workflowCommand
        .command("list")
        .description("List available workflows (optionally filter by agent)")
        .option("-a, --agent <name>", `Filter by agent backend (${agentChoices})`)
        .action(async (localOpts) => {
            const { workflowListCommand } = await import(
                "./commands/cli/workflow-list.ts"
            );
            const exitCode = await workflowListCommand({
                agent: localOpts.agent,
            });
            process.exit(exitCode);
        });

    // Workflow inputs subcommand: atomic workflow inputs <name> -a <agent>
    // Exposes the declared input schema so an orchestrating agent can build
    // a valid `atomic workflow -n ...` invocation without reading source.
    workflowCommand
        .command("inputs")
        .description("Print a workflow's declared input schema (JSON by default)")
        .argument("<name>", "Workflow name")
        .requiredOption("-a, --agent <name>", `Agent backend (${agentChoices})`)
        .option("--format <format>", "Output format: json | text", "json")
        .action(async (name, localOpts) => {
            const { workflowInputsCommand } = await import(
                "./commands/cli/workflow-inputs.ts"
            );
            const exitCode = await workflowInputsCommand({
                name,
                agent: localOpts.agent,
                format: localOpts.format === "text" ? "text" : "json",
            });
            process.exit(exitCode);
        });

    // Workflow status subcommand: atomic workflow status [<id>]
    // Returns one of in_progress | error | completed | needs_review.
    // Defaults to JSON so agents can parse it without screen-scraping.
    workflowCommand
        .command("status")
        .description(
            "Query workflow status (in_progress, error, completed, needs_review)",
        )
        .argument("[session_id]", "Workflow tmux session id (omit to list all)")
        .option("--format <format>", "Output format: json | text", "json")
        .action(async (sessionId, localOpts) => {
            const { workflowStatusCommand } = await import(
                "./commands/cli/workflow-status.ts"
            );
            const exitCode = await workflowStatusCommand({
                id: sessionId,
                format: localOpts.format === "text" ? "text" : "json",
            });
            process.exit(exitCode);
        });

    // Workflow session subcommands: atomic workflow session list / connect
    addSessionSubcommand(workflowCommand, "workflow");

    // ── Top-level session command ───────────────────────────────────────────
    addSessionSubcommand(program);

    // ── Config command ──────────────────────────────────────────────────────
    const configCmd = program
        .command("config")
        .description("Manage atomic configuration");

    // Add 'set' subcommand to config
    configCmd
        .command("set")
        .description("Set a configuration value")
        .argument("<key>", "Configuration key (telemetry | scm)")
        .argument("<value>", "Value to set (telemetry: true|false; scm: github|azure-devops|sapling)")
        .action(async (key: string, value: string) => {
            const { configCommand } = await import("./commands/cli/config.ts");
            const exitCode = await configCommand("set", key, value);
            process.exit(exitCode);
        });

    // ── Internal: orchestrator entry (spawned in the workflow tmux pane) ───
    //
    // Mirrors OpenCode's "every fresh-process entry is a CLI sub-command"
    // model. The launcher script written by `executeWorkflow()` runs:
    //   <bun> <cli.ts> _orchestrator-entry <name> <agent> <inputsB64> <source>
    // in dev, or
    //   <atomic-binary> _orchestrator-entry <name> <agent> <inputsB64> <source>
    // in compiled-binary mode. The SDK never ships a separately-runnable
    // bundle that a sub-process would `bun run` from outside the package's
    // module resolution context — that pattern broke `@opentui/core`'s
    // dynamic platform-binding import.
    //
    // Why both `name` and `source`: in a `bun build --compile` binary every
    // bundled module's `import.meta.path` collapses to `/$bunfs/root/<binary>`,
    // so the `definition.source` captured at workflow-module-eval time is
    // the binary itself, and dynamic-importing it would re-load cli.ts
    // (no default export). In compiled-binary mode we resolve the workflow
    // by `name + agent` against the builtin registry that's already linked
    // into the binary; in dev / installed-package mode we fall back to
    // dynamic import so third-party SDK consumers can spawn workflows
    // whose definitions aren't in the builtin registry.
    program
        .command("_orchestrator-entry", { hidden: true })
        .description("Internal: load a workflow definition and run the orchestrator panel")
        .argument("<workflowName>", "Workflow name (matches builtin registry)")
        .argument("<agent>", "claude | copilot | opencode")
        .argument("[inputsB64]", "Base64-encoded JSON record of structured inputs", "")
        .argument("[workflowSource]", "Workflow source path (dynamic-import fallback for non-builtin workflows in dev)", "")
        .action(async (
            workflowName: string,
            agent: string,
            inputsB64: string,
            workflowSource: string,
        ) => {
            const { isCompiledBinaryRuntime } = await import(
                "@bastani/atomic-sdk/lib/runtime-env"
            );

            // Compiled binary: source path is bunfs-collapsed and can't
            // be dynamic-imported. Resolve by name+agent in the builtin
            // registry, which is statically linked into the binary.
            if (isCompiledBinaryRuntime(workflowSource)) {
                if (!isValidAgent(agent)) {
                    console.error(
                        `${COLORS.red}[atomic/orchestrator-entry] Invalid agent "${agent}".${COLORS.reset}`,
                    );
                    process.exit(1);
                }
                const { createBuiltinRegistry } = await import(
                    "./commands/builtin-registry.ts"
                );
                const def = createBuiltinRegistry().resolve(workflowName, agent);
                if (!def) {
                    console.error(
                        `${COLORS.red}[atomic/orchestrator-entry] No workflow named "${workflowName}" for agent "${agent}" in the builtin registry.${COLORS.reset}`,
                    );
                    process.exit(1);
                }
                const { runOrchestratorWithDefinition } = await import(
                    "@bastani/atomic-sdk/runtime/orchestrator-entry"
                );
                await runOrchestratorWithDefinition(def, inputsB64);
                return;
            }

            // Dev / installed-package: dynamic-import the workflow file.
            // Preserves third-party SDK use where the workflow lives at
            // an arbitrary on-disk path that the builtin registry doesn't
            // know about.
            const { runOrchestratorEntry } = await import(
                "@bastani/atomic-sdk/runtime/orchestrator-entry"
            );
            await runOrchestratorEntry(workflowSource, agent, inputsB64);
        });

    // ── Internal: cc-debounce (called by tmux.conf on every Ctrl+C) ────────
    program
        .command("_cc-debounce", { hidden: true })
        .description("Internal: debounce Ctrl+C presses inside Atomic-managed tmux panes")
        .argument("<paneId>", "tmux pane id (e.g. %0)")
        .action(async (paneId: string) => {
            const { runCcDebounce } = await import(
                "@bastani/atomic-sdk/runtime/cc-debounce"
            );
            process.exit(runCcDebounce(paneId));
        });

    // ── Internal: Claude Stop hook handler ────────────────────────────────
    program
        .command("_claude-stop-hook", { hidden: true })
        .description("Internal: Claude Code Stop hook handler — writes a marker file for idle detection")
        .action(async () => {
            const { claudeStopHookCommand } = await import("@bastani/atomic-sdk/providers/claude-stop-hook");
            const exitCode = await claudeStopHookCommand();
            process.exit(exitCode);
        });

    // ── Internal: Claude SessionStart hook handler ────────────────────────
    program
        .command("_claude-session-start-hook", { hidden: true })
        .description("Internal: Claude Code SessionStart hook handler — writes a ready-marker file")
        .action(async () => {
            const { claudeSessionStartHookCommand } = await import("./commands/cli/claude-session-start-hook.ts");
            const exitCode = await claudeSessionStartHookCommand();
            process.exit(exitCode);
        });

    // ── Internal: Claude AskUserQuestion hook handler ─────────────────────
    program
        .command("_claude-ask-hook", { hidden: true })
        .description("Internal: Claude Code AskUserQuestion hook handler — writes/removes HIL marker")
        .argument("<mode>", "enter (PreToolUse) or exit (PostToolUse / PostToolUseFailure)")
        .action(async (mode: string) => {
            if (mode !== "enter" && mode !== "exit") {
                console.error(`[claude-ask-hook] Invalid mode: ${mode}`);
                process.exit(0);
            }
            const { claudeAskHookCommand } = await import("./commands/cli/claude-ask-hook.ts");
            const exitCode = await claudeAskHookCommand(mode);
            process.exit(exitCode);
        });

    // ── Internal: runtime-assets smoke check (CI cross-platform harness) ─
    //
    // Verifies that bundled runtime assets (tmux.conf, debounce script,
    // orchestrator entry) materialize out of `/$bunfs/` to a real on-disk
    // path and that tmux can actually load the conf. Headless — no TTY,
    // no agent CLI, no auth.
    program
        .command("_runtime-assets-smoke", { hidden: true })
        .description("Internal: verify bundled runtime assets are subprocess-readable")
        .action(async () => {
            const { runtimeAssetsSmokeCommand } = await import(
                "./commands/cli/runtime-assets-smoke.ts"
            );
            const exitCode = await runtimeAssetsSmokeCommand();
            process.exit(exitCode);
        });

    // ── Internal: Claude Subagent / TeammateIdle lifecycle hook handler ───
    program
        .command("_claude-inflight-hook", { hidden: true })
        .description("Internal: Claude Code Subagent/TeammateIdle lifecycle hook handler — touches/removes inflight markers, or waits for them to drain")
        .argument("<mode>", "start (SubagentStart), stop (SubagentStop), or wait (TeammateIdle)")
        .action(async (mode: string) => {
            if (mode !== "start" && mode !== "stop" && mode !== "wait") {
                // Silent exit-0 to match the handler's contract — never red
                // hook errors in transcripts.
                process.exit(0);
            }
            const { claudeInflightHookCommand } = await import("@bastani/atomic-sdk/providers/claude-inflight-hook");
            const exitCode = await claudeInflightHookCommand(mode);
            process.exit(exitCode);
        });

    // ── Install command ────────────────────────────────────────────────────
    //
    // Used by the bootstrap installers (install.ps1 / install.cmd /
    // install.sh): they download a verified binary into a temp dir
    // and then invoke `<temp>/atomic install`, which copies the binary
    // into place, persists PATH, and wires up completions.
    program
        .command("install")
        .description("Install atomic to PATH and set up shell completions")
        .option("--no-completions", "Skip shell completion setup")
        .action(async (localOpts: { completions?: boolean }) => {
            const { installCommand } = await import("./commands/cli/install.ts");
            const exitCode = await installCommand({
                noCompletions: localOpts.completions === false,
            });
            process.exit(exitCode);
        });

    program
        .command("uninstall")
        .description("Remove atomic launcher, PATH entries, and shell completions")
        .option("--purge", "Also remove ~/.atomic (config, downloads, cache)")
        .action(async (localOpts: { purge?: boolean }) => {
            const { uninstallCommand } = await import("./commands/cli/install.ts");
            const exitCode = await uninstallCommand({ purge: localOpts.purge === true });
            process.exit(exitCode);
        });

    program
        .command("update")
        .description("Update atomic to the latest release (or a pinned version)")
        .option("--check", "Print current vs target without installing")
        .option("--version <v>", "Pin a target version (default: latest)")
        .action(async (localOpts: { check?: boolean; version?: string }) => {
            const { updateCommand } = await import("./commands/cli/update.ts");
            const exitCode = await updateCommand({
                check: localOpts.check === true,
                version: localOpts.version,
            });
            process.exit(exitCode);
        });

    // ── Completions command ────────────────────────────────────────────────
    program
        .command("completions")
        .description("Output shell completion script")
        .argument("<shell>", `Shell type (${SUPPORTED_SHELLS.join(", ")})`)
        .addHelpText(
            "after",
            `
Install completions for your shell:

  Bash   eval "$(atomic completions bash)"     # add to ~/.bashrc
  Zsh    eval "$(atomic completions zsh)"      # add to ~/.zshrc
  Fish   atomic completions fish | source      # or save to ~/.config/fish/completions/atomic.fish
  PowerShell  atomic completions powershell | Invoke-Expression  # add to $PROFILE`,
        )
        .action(async (shell) => {
            if (!SUPPORTED_SHELLS.includes(shell as Shell)) {
                console.error(
                    `${COLORS.red}Error: Unknown shell '${shell}'${COLORS.reset}`,
                );
                console.error(`Supported shells: ${SUPPORTED_SHELLS.join(", ")}`);
                process.exit(1);
            }
            const { completionsCommand } = await import("./commands/cli/completions.ts");
            const exitCode = completionsCommand(shell as Shell);
            process.exit(exitCode);
        });

    return program;
}

// Create the program instance for use by main() and tests
export const program = createProgram();

/**
 * Main entry point for the CLI.
 *
 * The SDK owns orchestrator re-entry now (see
 * `src/sdk/runtime/orchestrator-entry.ts`), so the atomic CLI just
 * runs its bootstrap, parses argv, and exits.
 */
async function main(): Promise<void> {
    try {
        // Bootstrap `~/.atomic/settings.json` on every invocation if absent,
        // so users always have a file to edit with JSON Schema intellisense
        // wired up. Idempotent; swallows FS errors internally.
        const { ensureGlobalAtomicSettings } = await import(
            "./services/config/settings.ts"
        );
        await ensureGlobalAtomicSettings();

        // Sync tooling deps and global skills on first launch after install
        // or upgrade. Runs at most once per version bump (gated on a marker
        // file under ~/.atomic). Skipped for `--version` / `--help` so info
        // paths stay instant, and for `install` / `uninstall` so the
        // installer's own mux-detection branch isn't shadowed by the
        // autosync's lazy psmux install (which adds ~/.atomic/bin to PATH
        // before installCommand can register a planted stub dir).
        const argv = process.argv.slice(2);
        const isInfoCommand =
            argv.includes("--version") ||
            argv.includes("-v") ||
            argv.includes("--help") ||
            argv.includes("-h") ||
            argv[0] === "install" ||
            argv[0] === "uninstall" ||
            argv[0] === "update" ||
            argv[0] === "completions" ||
            argv[0] === "_orchestrator-entry" ||
            argv[0] === "_cc-debounce" ||
            argv[0] === "_claude-stop-hook" ||
            argv[0] === "_claude-ask-hook" ||
            argv[0] === "_claude-session-start-hook" ||
            argv[0] === "_claude-inflight-hook";

        if (!isInfoCommand) {
            const { autoSyncIfStale } = await import(
                "./services/system/auto-sync.ts"
            );
            await autoSyncIfStale();
        }

        await program.parseAsync();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${COLORS.red}Error: ${message}${COLORS.reset}`);
        process.exit(1);
    }
}

// Run the CLI
if (import.meta.main) {
    await main();
}
