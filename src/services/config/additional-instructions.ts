/**
 * Additional default instructions appended to every agent the CLI spawns.
 *
 * Lifecycle:
 *   1. On first install / lazy auto-sync, the constant below is written to
 *      `~/.atomic/AGENTS.md` if (and only if) that file is missing. Once it
 *      exists, the user owns it — atomic never overwrites it on upgrade.
 *   2. Each `atomic chat` / workflow run resolves an effective path via
 *      {@link resolveAdditionalInstructionsPath}: a project-local
 *      `.atomic/AGENTS.md` wins; otherwise the global file is used.
 *   3. Each provider surface (CLI flags, env vars, SDK options) is wired to
 *      reference the resolved path or read its contents.
 *
 * The constant ships as a seed only. Future `atomic` releases that change
 * the prompt won't affect existing users — that's intentional, since the
 * file becomes user-editable after install.
 */
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";

/**
 * Default seed contents for `~/.atomic/AGENTS.md`. Markdown-format because
 * Copilot CLI / OpenCode read instruction files as Markdown; Claude's
 * `--append-system-prompt-file` accepts arbitrary text and is happy with
 * Markdown too.
 */
export const ADDITIONAL_INSTRUCTIONS = `This section provides you with **CRITICAL** instructions that will help you to maintain coherency in long-horizon context-heavy tasks and better support users:

<user_experience>
- Always ask clarifying questions if the user's request is ambiguous or lacks necessary details. NEVER make assumptions about what the user wants.
- If you find yourself circling in thought and asking what the user "really" wants, stop and ask the user for clarification. It's better to ask than to guess.
</user_experience>

<tool_policies>
Follow these tool selection and usage rules in order of priority:

1. **Browser search and automation**:

Use playwright-cli (refer to playwright-cli skill) for ALL browser automation tasks, including web research, form filling, and UI interaction:
   - ALWAYS load the playwright-cli skill before usage with the Skill tool.
   - ALWAYS ASSUME playwright-cli is installed. If the \`playwright-cli\` command fails, fall back to \`bunx playwright-cli\`.

2. **Structural code search**:

You are operating in an environment where ast-grep is installed. For any code search that requires understanding of syntax or code structure, you should default to using \`ast-grep --lang [language] -p '<pattern>'\`. Rely on your ast-grep skill for best practices. Adjust the --lang flag as needed for the specific programming language. Avoid using text-only search tools unless a plain-text search is explicitly requested.

3. **Testing**: ALWAYS invoke your tdd skill BEFORE creating or modifying any tests.

4. **Sub-agent Orchestration**: You have a large number of tools available to you. The most important one is the one that allows you to dispatch sub-agents: either \`Agent\` or \`Task\`.

All non-trivial operations should be delegated to sub-agents. You should delegate research and codebase understanding tasks to codebase-analyzer, codebase-locator and codebase-pattern-locator sub-agents.

You should delegate running bash commands (particularly ones that are likely to produce lots of output) such as investigating with the \`aws\` CLI, using the \`gh\` CLI, digging through logs to \`Bash\` sub-agents.

You should use separate sub-agents for separate tasks, and you may launch them in parallel - but do not delegate multiple tasks that are likely to have significant overlap to separate sub-agents.

IMPORTANT: if the user has already given you a task, you should proceed with that task using this approach.
IMPORTANT: sometimes sub-agents will take a long time. DO NOT attempt to do the job yourself while waiting for the sub-agent to respond. Instead, use the time to plan out your next steps, or ask the user follow-up questions to clarify the task requirements.

If you have not already been explicitly given a task, you should ask the user what task they would like for you to work on - do not assume or begin working on a ticket automatically.

5. **Debugging**: When a user asks about debugging, ALWAYS spawn a debugger sub-agent first.
   - Do not attempt to debug or analyze code yourself without first consulting the debugger sub-agent.
   - Explain the debugger's insights to the user clearly and concisely.
   - Once the user confirms, implement the necessary code changes based on those insights.
   - If the user has follow-up questions, spawn additional debugger and research sub-agents as needed.
</tool_policies>

<engineering_principles>
Software engineering is fundamentally about **managing complexity** to prevent technical debt. When implementing features, prioritize maintainability and testability over cleverness.

**Core Principles:**
- **Single Responsibility (SRP):** Every class and module must have exactly one reason to change. If a unit does more than one job, split it.
- **Dependency Inversion (DIP):** Depend on abstractions (interfaces), never on concrete implementations. Inject dependencies; do not instantiate them internally.
- **KISS:** Keep solutions as simple as possible. Reject unnecessary abstraction layers.
- **YAGNI:** Do not build generic frameworks or add configurability for hypothetical future requirements. Solve the problem at hand.

**Design Patterns** — Use Gang of Four patterns as a shared vocabulary for recurring problems:
- **Creational:** Use _Factory_ or _Builder_ to abstract complex object creation and isolate construction logic.
- **Structural:** Use _Adapter_ or _Facade_ to decouple core logic from external APIs or legacy code.
- **Behavioral:** Use _Strategy_ to make algorithms interchangeable. Use _Observer_ for event-driven communication between decoupled components.

**Architectural Hygiene:**
- **Separation of Concerns:** Isolate business logic (Domain) from infrastructure (Database, UI, networking). Never let infrastructure details leak into domain code.
- **Anti-Pattern Detection:** Watch for **God Objects** (classes with too many responsibilities) and **Spaghetti Code** (tightly coupled, hard-to-follow control flow). Refactor them using polymorphism and clear interfaces.

Create **seams** in your software using interfaces and abstractions. This ensures code remains flexible, testable, and capable of evolving independently.
</engineering_principles>
`;

/**
 * Honors `ATOMIC_SETTINGS_HOME` so tests can redirect the global file to a
 * temp dir. Mirrors the convention used by `auto-sync.ts` and `agents.ts`.
 */
function homeRoot(): string {
  return process.env.ATOMIC_SETTINGS_HOME ?? homedir();
}

/** Path to the global seed: `~/.atomic/AGENTS.md`. */
export function getGlobalAdditionalInstructionsPath(): string {
  return join(homeRoot(), ".atomic", "AGENTS.md");
}

/** Path to the per-project override: `<projectRoot>/.atomic/AGENTS.md`. */
export function getLocalAdditionalInstructionsPath(
  projectRoot: string,
): string {
  return join(projectRoot, ".atomic", "AGENTS.md");
}

/**
 * Resolve the effective additional-instructions file for a project.
 *
 * Returns the project-local override if it exists, otherwise the global
 * seed. Returns `undefined` only if neither exists — which can happen on a
 * fresh dev checkout that hasn't yet run `autoSyncIfStale` (the seed write).
 *
 * Sync `existsSync` is intentional: this is called on every spawn and we
 * want the cost to be a single `stat` per provider, not an `await`.
 */
export function resolveAdditionalInstructionsPath(
  projectRoot: string,
): string | undefined {
  const local = getLocalAdditionalInstructionsPath(projectRoot);
  if (existsSync(local)) return local;
  const global = getGlobalAdditionalInstructionsPath();
  if (existsSync(global)) return global;
  return undefined;
}

/**
 * Read the resolved file's contents, or `undefined` if no file exists.
 * Used by SDK paths that need the raw string (Claude `systemPrompt.append`,
 * Copilot `systemMessage.content`).
 */
export async function resolveAdditionalInstructionsContent(
  projectRoot: string,
): Promise<string | undefined> {
  const path = resolveAdditionalInstructionsPath(projectRoot);
  if (!path) return undefined;
  try {
    return await readFile(path, "utf-8");
  } catch {
    // Race: file disappeared between resolve and read. Treat as absent.
    return undefined;
  }
}

/**
 * Write `~/.atomic/AGENTS.md` with {@link ADDITIONAL_INSTRUCTIONS} if (and
 * only if) the file is missing. Idempotent and safe to call on every CLI
 * start; the user is free to edit the file afterward without atomic
 * clobbering their changes on upgrade.
 */
export async function seedGlobalAdditionalInstructions(): Promise<void> {
  const path = getGlobalAdditionalInstructionsPath();
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ADDITIONAL_INSTRUCTIONS, "utf-8");
}

/**
 * Build a predicate that identifies OpenCode `instructions` entries atomic
 * owns. Matches exact equality against the two paths we ever inject — the
 * global seed (`~/.atomic/AGENTS.md`) and the project-local override
 * (`<projectRoot>/.atomic/AGENTS.md`). A tighter scope than a tail-match
 * ensures legal-but-unusual user entries like `vendor/.atomic/AGENTS.md`
 * are preserved across reconciliation passes.
 */
function buildAtomicOwnedMatcher(
  projectRoot: string,
): (entry: unknown) => entry is string {
  const owned = new Set<string>([
    getGlobalAdditionalInstructionsPath(),
    getLocalAdditionalInstructionsPath(projectRoot),
  ]);
  return (entry: unknown): entry is string =>
    typeof entry === "string" && owned.has(entry);
}

/**
 * Order-independent equality check for OpenCode's `instructions` array.
 * OpenCode treats `instructions` as an unordered set of files to load, so
 * a user reordering entries via their editor shouldn't trigger a rewrite
 * (and the resulting "fight the user" mtime churn) on the next spawn.
 * Uses `JSON.stringify` per-entry so non-string values (a malformed config
 * we'd otherwise leave alone) are compared safely without spurious matches.
 */
function sameInstructionMultiset(
  a: readonly unknown[],
  b: readonly unknown[],
): boolean {
  if (a.length !== b.length) return false;
  const aKeys = a.map((e) => JSON.stringify(e)).sort();
  const bKeys = b.map((e) => JSON.stringify(e)).sort();
  return aKeys.every((v, i) => v === bKeys[i]);
}

/**
 * Ensure the resolved `AGENTS.md` is wired into
 * `<projectRoot>/.opencode/opencode.json`'s `instructions` array.
 *
 * OpenCode (CLI and SDK alike) consumes the `instructions` field from
 * project config; there's no flag or env var that injects an instruction
 * file. Strategy:
 *   - Resolve the effective path via {@link resolveAdditionalInstructionsPath}.
 *   - Strip any prior atomic-managed entries (matches `.atomic/AGENTS.md`).
 *   - Append the absolute resolved path. Absolute is fine because OpenCode
 *     happily takes them; we don't expect the user to commit this entry
 *     across machines (and even if they do, the next run reconciles it).
 *   - When nothing resolves (file truly missing on this machine), we still
 *     run the cleanup pass so a previously-seeded entry doesn't leak.
 *
 * No-op on `.opencode/opencode.json` files we don't own (i.e. we never
 * create the file ourselves; `applyManagedOnboardingFiles` is responsible
 * for that). When the file is absent, this helper simply returns.
 *
 * Concurrency: this is a read-modify-write on `opencode.json` with no
 * cross-process lock. Two concurrent `atomic` invocations (e.g. parallel
 * `chat -a opencode` sessions, or a workflow racing the chat startup) can
 * interleave reads and writes — A reads, B reads, A writes, B writes —
 * and B's write loses any user-managed `instructions` entries A added in
 * between. The window is tiny (a single `readFile` + `JSON.parse` +
 * `writeFile`) and the damage is bounded: only concurrent edits to
 * non-atomic entries are at risk, and the next reconcile pass restores
 * the atomic entry. If this becomes a real problem in practice, wrap the
 * read-modify-write in a file lock (`proper-lockfile` or similar).
 */
export async function reconcileOpencodeInstructions(
  projectRoot: string,
): Promise<void> {
  const opencodeConfigPath = join(projectRoot, ".opencode", "opencode.json");
  if (!existsSync(opencodeConfigPath)) return;

  const raw = await readFile(opencodeConfigPath, "utf-8");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed config — leave it alone; the user's editor will surface
    // the error and our injection would only obscure it.
    return;
  }

  const existing = Array.isArray(config.instructions)
    ? (config.instructions as unknown[])
    : [];
  const isAtomicOwned = buildAtomicOwnedMatcher(projectRoot);
  const preserved = existing.filter((e) => !isAtomicOwned(e));

  const resolved = resolveAdditionalInstructionsPath(projectRoot);
  const next = resolved ? [...preserved, resolved] : preserved;

  // Skip the write when the entry set is unchanged — avoids touching mtime
  // on every spawn, keeps the file out of `git status` noise, and preserves
  // any reordering the user did in their editor (OpenCode is order-agnostic).
  if (sameInstructionMultiset(next, existing)) return;

  if (next.length > 0) {
    config.instructions = next;
  } else {
    delete config.instructions;
  }
  // Preserve the file's existing line ending. JSON.stringify always emits
  // LF; rewriting CRLF-edited config with LF would otherwise produce noisy
  // diffs in workspaces with `eol=crlf` in `.gitattributes`.
  const lineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
  const serialized =
    JSON.stringify(config, null, 2).replace(/\n/g, lineEnding) + lineEnding;
  await writeFile(opencodeConfigPath, serialized);
}
