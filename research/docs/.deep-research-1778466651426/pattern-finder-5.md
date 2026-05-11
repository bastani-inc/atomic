# Pattern Finder Results: Atomic CLI Examples Directory

## Scope
`examples/` directory (55 files, 3,435 LOC) — canonical reference implementations for pi-coding-agent rewrite

---

## Patterns Found

#### Pattern 1: Basic defineWorkflow with CLI Worker Scripts
**Where:** `examples/hello-world/claude/index.ts:16-67`
**What:** Foundational single-stage workflow with structured inputs (string, enum, text) and CLI parameter parsing via Commander.

```typescript
export default defineWorkflow({
    name: "hello-world",
    description: "A simple single-session hello world workflow (two turns)",
    inputs: [
      {
        name: "greeting",
        type: "string",
        required: true,
        description: "the opening phrase the agent should echo back",
        placeholder: "Hello, world!",
      },
      {
        name: "style",
        type: "enum",
        required: true,
        description: "tone of the response",
        values: ["formal", "casual", "robotic"],
        default: "casual",
      },
      {
        name: "notes",
        type: "text",
        description: "extra guidance for the agent (optional)",
        placeholder: "anything you want to add…",
      },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(
      { name: "hello", description: "Say hello to the world" },
      {},
      {},
      async (s) => {
        await s.session.query(prompt);
        await s.session.query("Now translate your previous greeting into pig latin. One line only.");
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

**Variations / call-sites:**
- Claude variant: `hello-world/claude/index.ts:16`
- OpenCode variant: `hello-world/opencode/index.ts:16` (uses `s.client.session.prompt()` and permission config)
- Copilot variant: `hello-world/copilot/index.ts:16` (uses `s.session.send()` and `getMessages()`)
- Worker script: `hello-world/claude-worker.ts:1-44` (parses CLI options, calls `runWorkflow`)

---

#### Pattern 2: Multi-Workflow CLI with Registry
**Where:** `examples/multi-workflow/cli.ts:26-64`
**What:** Compose multiple workflows under one CLI entrypoint using `createRegistry` and Commander subcommands.

```typescript
const registry = createRegistry().register(hello).register(goodbye);

const program = new Command("multi-workflow").description(
  "Two small Claude workflows under one entrypoint",
);

for (const workflow of listWorkflows(registry)) {
  const sub = program
    .command(getName(workflow))
    .description(workflow.description);

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
```

**Variations / call-sites:**
- Individual workflows: `multi-workflow/hello/claude.ts` and `multi-workflow/goodbye/claude.ts`
- Package: `multi-workflow/package.json` (scripts: "bun run multi-workflow/cli.ts")

---

#### Pattern 3: Headless Background Stages
**Where:** `examples/headless-test/claude/index.ts:20-111`
**What:** Mixed visible and headless stages with parallel execution and transcript handoff using `Promise.all()`.

```typescript
// ── Visible stage: seed ──
const seed = await ctx.stage(
  { name: "seed", description: "Generate a topic overview" },
  {},
  {},
  async (s) => {
    const result = await s.session.query(
      `In one short paragraph, describe what "${prompt}" is.`,
    );
    s.save(s.sessionId);
    return extractAssistantText(result, 0);
  },
);

// ── Three parallel headless background stages ──
const [prosHandle, consHandle, usesHandle] = await Promise.all([
  ctx.stage(
    { name: "pros", headless: true },
    {},
    {},
    async (s) => {
      const result = await s.session.query(
        `Given this topic overview, list 3 pros:\n\n${seed.result}`,
        { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      );
      s.save(s.sessionId);
      return extractAssistantText(result, 0);
    },
  ),
  // ... two more stages ...
]);

// ── Visible stage: merge results from background stages ──
const mergeHandle = await ctx.stage(
  { name: "merge", description: "Combine background results" },
  {},
  {},
  async (s) => {
    const result = await s.session.query(
      [
        "Combine these three analyses into a concise summary:\n",
        `## Pros\n${prosHandle.result}`,
        `## Cons\n${consHandle.result}`,
        `## Use Cases\n${usesHandle.result}`,
      ].join("\n\n"),
    );
    s.save(s.sessionId);
    return extractAssistantText(result, 0);
  },
);
```

**Variations / call-sites:**
- Parallel execution: `headless-test/claude/index.ts:35-75`
- Headless mode validation: `hil-favorite-color-headless/claude/index.ts` (verify AskUserQuestion is blocked)
- OpenCode headless: `hil-favorite-color-headless/opencode/index.ts` (scopes `OPENCODE_CLIENT=sdk` to disable question tool)

---

#### Pattern 4: Sequential Stage Handoff with Transcripts
**Where:** `examples/sequential-describe-summarize/claude/index.ts:32-62`
**What:** Two-stage pipeline where stage 1 produces a result, persists it via `s.save()`, and stage 2 reads it via `s.transcript()`.

```typescript
// Stage 1: produce a detailed description
const describe = await ctx.stage(
  { name: "describe", description: "Produce a detailed paragraph about the topic" },
  {},
  {},
  async (s) => {
    await s.session.query(
      `Write one detailed paragraph (4–6 sentences) explaining ${topic} to an engineering audience.`,
    );
    s.save(s.sessionId);
  },
);

// Stage 2: read stage 1's transcript file off disk and compress it
await ctx.stage(
  { name: "summarize", description: "Compress the description into two bullets" },
  {},
  {},
  async (s) => {
    const prior = await s.transcript(describe);
    await s.session.query(
      `Read the description in ${prior.path} and condense it into exactly two bullet points.`,
    );
    s.save(s.sessionId);
  },
);
```

**Variations / call-sites:**
- Parallel variant: `parallel-hello-world/claude/index.ts:34-84` (two parallel stages read from seed)
- Copilot variant: `parallel-hello-world/copilot/index.ts:50-54` (reads `prior.content` directly instead of path)
- Loop variant: `review-fix-loop/claude/index.ts:45-101` (loop with early exit and state tracking via `lastHandle`)

---

#### Pattern 5: Multi-Agent Workflow (Claude, Copilot, OpenCode)
**Where:** `examples/hello-world/{claude,copilot,opencode}/index.ts` (agent-specific implementations)
**What:** Same workflow shape with agent-specific session API (Claude: `.query()`, Copilot: `.send()`, OpenCode: `.prompt()`).

Claude variant (lines 44-65):
```typescript
  .for("claude")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(...async (s) => {
      await s.session.query(prompt);
      s.save(s.sessionId);
    });
  })
```

OpenCode variant (lines 44-61):
```typescript
  .for("opencode")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(
      ...,
      { title: "hello", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: prompt }],
        });
        s.save(result.data!);
      },
    );
  })
```

Copilot variant (lines 44-55):
```typescript
  .for("copilot")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(...async (s) => {
      await s.session.send({ prompt });
      s.save(await s.session.getMessages());
    });
  })
```

**Variations / call-sites:**
- Structured output: `structured-output-demo/{claude,opencode,copilot}/index.ts`
- HIL (Human-in-the-loop): `hil-favorite-color/{claude,opencode}/index.ts`
- Parallel: `parallel-hello-world/{claude,copilot,opencode}/index.ts`

---

#### Pattern 6: Structured Output with Zod Schema
**Where:** `examples/structured-output-demo/helpers/schema.ts:21-51` and `structured-output-demo/claude/index.ts:40-79`
**What:** Define Zod schema, convert to JSON Schema, validate against agent's structured output.

Schema definition (lines 21-36):
```typescript
export const LanguageFactsSchema = z.object({
  name: z.string().describe("Canonical language name, e.g. 'Python'"),
  year_created: z.number().int().describe("Year the language was first released"),
  paradigms: z.array(z.string()).describe("Programming paradigms"),
  statically_typed: z.boolean().describe("True if statically typed by default"),
  summary: z.string().describe("One-sentence summary"),
});

export const LANGUAGE_FACTS_JSON_SCHEMA = z.toJSONSchema(LanguageFactsSchema, {
  target: "openapi-3.0",
});
```

Claude validation (lines 45-76):
```typescript
const result = await s.session.query(buildPrompt(topic), {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  outputFormat: {
    type: "json_schema",
    schema: LANGUAGE_FACTS_JSON_SCHEMA,
  },
});
s.save(s.sessionId);

const parsed = LanguageFactsSchema.safeParse(
  s.session.lastStructuredOutput,
);
const facts: LanguageFacts | null = parsed.success ? parsed.data : null;
logFacts("claude", facts);
```

**Variations / call-sites:**
- OpenCode variant: `structured-output-demo/opencode/index.ts:48-73` (reads from `result.data.info.structured`)
- Copilot variant: `structured-output-demo/copilot/index.ts` (defineTool with `parameters: LanguageFactsSchema`)

---

#### Pattern 7: Human-in-the-Loop (HIL) Stages
**Where:** `examples/hil-favorite-color/claude/index.ts:17-59`
**What:** Stage with `AskUserQuestion` tool that blocks execution until user responds; state tracked via transcript.

```typescript
export default defineWorkflow({
    name: "hil-favorite-color",
    description:
      "Test HIL: stage 1 asks the user for their favorite color via AskUserQuestion; stage 2 describes it",
  })
  .for("claude")
  .run(async (ctx) => {
    const askColor = await ctx.stage(
      {
        name: "ask-color",
        description: "Ask the user for their favorite color (HIL)",
      },
      {},
      {},
      async (s) => {
        await s.session.query(
          [
            "You must use the AskUserQuestion tool exactly once to ask the user:",
            '"What is your favorite color?"',
            "",
            "Allow a free-form text answer. Do not guess — wait for the user's response.",
            "After they answer, echo back a single sentence acknowledging their choice.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );

    await ctx.stage(
      {
        name: "describe-color",
        description: "Write a short description of the chosen color",
      },
      {},
      {},
      async (s) => {
        const prior = await s.transcript(askColor);
        await s.session.query(
          [
            `Read ${prior.path}. It contains a transcript in which the user named their favorite color.`,
            "Write a short (2–3 sentence) evocative description of that color.",
            "Do not ask any follow-up questions.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

**Variations / call-sites:**
- Headless regression test: `hil-favorite-color-headless/claude/index.ts` (verifies tool is blocked in headless mode)
- OpenCode variant: `hil-favorite-color/opencode/index.ts` (uses client's question tool)

---

#### Pattern 8: Pane Navigation CLI (SDK Primitives)
**Where:** `examples/pane-navigation/cli.ts:30-147`
**What:** SDK primitives for spawning workflows detached and navigating tmux windows programmatically.

```typescript
const WORKFLOWS = {
  claude: claudeWorkflow,
  copilot: copilotWorkflow,
  opencode: opencodeWorkflow,
} as const satisfies Record<AgentType, unknown>;

program
  .command("start")
  .description("Spawn the pane-navigation workflow detached and print its session id")
  .requiredOption("--agent <agent>", "agent backend (claude | copilot | opencode)")
  .action(async (opts) => {
    const agent = opts.agent as AgentType;
    const workflow = WORKFLOWS[agent];
    const result = await runWorkflow({ workflow, detach: true });
    console.log(result.tmuxSessionName);
  });

program
  .command("list")
  .description("List workflow sessions on the atomic socket")
  .action(() => {
    const sessions = listSessions({ scope: "workflow" });
    for (const s of sessions) {
      const flag = s.attached ? "*" : " ";
      console.log(\`${flag} ${s.id}  agent=${s.agent ?? "?"}  created=${s.created}\`);
    }
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
  .action((id: string) => handleErrors(() => attachSession(id)));

program
  .command("stop <id>")
  .description("Kill the session (best-effort; idempotent)")
  .action(async (id: string) => {
    await stopSession(id);
  });
```

**Variations / call-sites:**
- Three-stage workflow: `pane-navigation/{claude,copilot,opencode}/index.ts:16-52`

---

#### Pattern 9: Commander Embed (Headless Integration)
**Where:** `examples/commander-embed/cli.ts:17-64`
**What:** Mount a workflow as a Commander subcommand alongside plain CLI commands.

```typescript
const program = new Command("my-app").description(
  "Demo CLI with an atomic workflow alongside plain Commander commands",
);

// ── greet — mount the workflow's inputs as --<input> options ──────────
const greet = program.command("greet").description(workflow.description);

const inputs = getInputSchema(workflow);
for (const input of inputs) {
  const desc =
    input.description ??
    (input.type === "enum"
      ? \`one of: ${(input.values ?? []).join(", ")}\`
      : input.type);
  greet.option(\`--${input.name} <value>\`, desc);
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
```

**Variations / call-sites:**
- Related: `multi-workflow/cli.ts` (multiple workflows under same program)

---

#### Pattern 10: Review/Fix Loop with Bounded Iterations
**Where:** `examples/review-fix-loop/claude/index.ts:44-104`
**What:** Generate → review → (if needed) fix loop with early exit on `"clean"` verdict and state tracking.

```typescript
const draft = await ctx.stage(
  { name: "draft", description: "Produce the initial two-paragraph draft" },
  {},
  {},
  async (s) => {
    await s.session.query(
      \`Write a two-paragraph argument for ${topic}. Be concrete — cite at least two specific benefits.\`,
    );
    s.save(s.sessionId);
  },
);

let lastHandle = draft;

for (let i = 1; i <= maxIterations; i++) {
  const review = await ctx.stage(
    { name: \`review-${i}\`, description: "Judge the latest draft" },
    {},
    {},
    async (s) => {
      const prior = await s.transcript(lastHandle);
      const messages = await s.session.query(
        \`Read the draft in ${prior.path}. Reply with either "CLEAN" if ready, or "NEEDS_FIX: <issue>".\`,
      );
      s.save(s.sessionId);

      const verdict = extractAssistantText(messages, 0).toUpperCase();
      return verdict.includes("CLEAN") && !verdict.includes("NEEDS_FIX")
        ? ("clean" as const)
        : ("needs_fix" as const);
    },
  );

  if (review.result === "clean") break;

  if (i === maxIterations) break;

  const fix = await ctx.stage(
    { name: \`fix-${i}\`, description: "Address the review's top issue" },
    {},
    {},
    async (s) => {
      const priorDraft = await s.transcript(lastHandle);
      const reviewFeedback = await s.transcript(review);
      await s.session.query(
        \`Read the draft in ${priorDraft.path} and the feedback in ${reviewFeedback.path}. Produce a revised draft.\`,
      );
      s.save(s.sessionId);
    },
  );

  lastHandle = fix;
}
```

**Variations / call-sites:**
- Structured iteration: No direct variants; this is the canonical loop pattern

---

#### Pattern 11: Local Workflow Hosting (hostLocalWorkflows)
**Where:** `examples/custom-workflow-bunx/index.ts:1-33`
**What:** Self-contained script exporting workflows via `hostLocalWorkflows` for dynamic execution.

```typescript
#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

const explainFile = defineWorkflow({
  name: "explain-file",
  description: "Open a Claude pane that walks through a file",
  inputs: [
    {
      name: "path",
      type: "text",
      required: true,
      description: "absolute or relative path to the file to explain",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "explain", description: "Read the file and walk through it" },
      {},
      {},
      async (s) => {
        await s.session.query(
          \`Read ${ctx.inputs.path} and walk me through what it does. \` +
            \`Highlight any non-obvious behaviour or invariants. Keep it under 10 short sentences.\`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();

await hostLocalWorkflows([explainFile]);
```

**Variations / call-sites:**
- Standalone entry script (no separate worker needed)

---

#### Pattern 12: Background Subagents with In-Flight Gating
**Where:** `examples/claude-background-subagents/claude/index.ts:37-120`
**What:** Dispatch multiple background subagents and wait for them to finish before advancing to the next stage.

```typescript
const dispatch = await ctx.stage(
  {
    name: "dispatch",
    description: "Spawn three background subagents that each sleep 20s and write a marker file",
  },
  {},
  {},
  async (s) => {
    await s.session.query(
      [
        "Step 1: clean any stale marker files from a previous run.",
        \`  Run: rm -f ${MARKER_PATHS.join(" ")}\`,
        "",
        "Step 2: spawn three independent subagents using the Agent tool with run_in_background: true.",
        "  Each subagent must:",
        "    1. Run \`sleep 20\` via the Bash tool.",
        \`    2. Write a single line containing its own agent identifier into:\`,
        ...MARKER_PATHS.map((p, i) => \`       - subagent #${i + 1} → ${p}\`),
        "    3. Return.",
        "",
        "Step 3: end your turn IMMEDIATELY after dispatching all three subagents.",
        "  - Do NOT wait for them.",
        "  - Do NOT poll or summarize their progress.",
        "  - Use the Agent tool literally — three separate Agent tool calls, each with run_in_background: true.",
      ].join("\n"),
    );
    s.save(s.sessionId);
  },
);

void dispatch;
await ctx.stage(
  {
    name: "verify",
    description: "Confirm all three subagent marker files exist and are non-empty",
  },
  {},
  {},
  async (s) => {
    await s.session.query(
      [
        "The previous stage spawned three background subagents.",
        "",
        "Read each of the following files in turn:",
        ...MARKER_PATHS.map((p) => \`  - ${p}\`),
        "",
        "For each file, report:",
        "  - whether it exists",
        "  - the line of content it contains",
        "",
        "If any file is missing or empty, that means the harness advanced to this stage before the subagents finished.",
      ].join("\n"),
    );
    s.save(s.sessionId);
  },
);
```

**Variations / call-sites:**
- Dispatch pattern only: unique to this example

---

## Summary

The examples directory establishes **12 canonical patterns** across headless, HIL, and multi-agent flavors:

1. **defineWorkflow DSL** — structured input metadata (string, enum, text), chainable builder API (.for(), .run(), .compile())
2. **Multi-workflow registry** — createRegistry(), listWorkflows(), getName(), getInputSchema() for programmatic CLI composition
3. **Headless & visibility** — { headless: true } flag and extractAssistantText() utility for background execution
4. **Session handoff** — s.save() persists, s.transcript(handle) reads; dual return value (handle .result and .path)
5. **Agent polymorphism** — Claude .query(), Copilot .send(), OpenCode .client.session.prompt() with .for() selector
6. **Structured output** — Zod schema → JSON Schema → outputFormat config → validation via .safeParse()
7. **HIL detection** — AskUserQuestion / question tool availability per agent; stage execution holds until response
8. **Pane navigation** — SDK primitives (runWorkflow({ detach: true }), listSessions(), nextWindow(), gotoOrchestrator())
9. **CLI embedding** — Workflows as Commander subcommands; input schema auto-mapped to --<flag> options
10. **Loop logic** — Bounded iteration with .result callbacks driving control flow (early exit on "clean", state tracking)
11. **Local hosting** — hostLocalWorkflows([...]) for single-script deployments without separate workers
12. **Background gating** — run_in_background: true subagent dispatch with Stop-hook-driven waits

All patterns scale from headless (no TUI) through HIL (interactive user questions) to full multi-agent workflows across Claude, Copilot, and OpenCode backends. **Worker scripts** (*-worker.ts) are boilerplate Commander CLI wrappers over runWorkflow() with input parsing. **Package.json** scripts delegate to workers: "claude": "bun run claude-worker.ts".

