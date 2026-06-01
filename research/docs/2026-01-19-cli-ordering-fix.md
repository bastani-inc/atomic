---
date: 2026-01-19 20:28:04 UTC
researcher: Claude
git_commit: 3792ff38ae13803ded8ddad72cbe0b23e0477e78
branch: lavaman131/hotfix/init-cli
repository: atomic
topic: "Fix banner and intro text ordering when running atomic init -a [agent_name] for uninitialized agents"
tags: [research, codebase, cli, init, banner, display-order]
status: complete
last_updated: 2026-01-19
last_updated_by: Claude
---

# Research: CLI Init Banner Ordering Issue

## Research Question

Research the implementation for the CLI init when the user runs `atomic init -a [agent_name]` and agent_name is not initialized. The banner and intro text should be shown at the very beginning. Currently, the output looks like this:

```
●  .claude not found. Running setup...
┌  Atomic: Automated Procedures and Memory for AI Coding Agents
│
│  Enable multi-hour autonomous coding sessions with the Ralph Wiggum
│  Method using research, plan, implement methodology.
│
●  Configuring Claude Code...
│
◆  Install Claude Code config files to /home/alilavaee/Downloads?
│  ● Yes / ○ No
```

The issue is:

1. The ".claude not found. Running setup..." message appears before the banner
2. The ASCII banner (logo) is not displayed at all

**Requirements:**

- Banner and description text should appear first
- ".claude not found" message should appear underneath the Atomic description text
- Banner should NOT show if:
    - Terminal dimensions are less than 79 cols x 27 rows
    - User runs `atomic -a [agent_name]` when the agent is already setup

## Summary

The current implementation has a display ordering issue in `runAgentCommand()` function at [src/commands/run-agent.ts:43-50](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/commands/run-agent.ts#L43-L50).

**Current Flow:**

1. `runAgentCommand()` logs ".claude not found. Running setup..." first
2. Then calls `initCommand()` with `showBanner: false`
3. `initCommand()` shows intro and description, but no banner

**Issue Root Cause:**

- `log.info()` is called BEFORE `initCommand()`
- `showBanner: false` is passed, preventing banner display entirely

**Required Fix:**

- Move the banner display to happen BEFORE the ".claude not found" message
- Display banner and intro text first
- Then show ".claude not found" as an informational note underneath

## Detailed Findings

### 1. Entry Flow for `atomic init -a [agent_name]`

**Entry Point:** [src/index.ts:83-93](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/index.ts#L83-L93)

When user runs `atomic init -a claude-code`:

```typescript
case "init":
  // atomic init [--agent name] → init with optional pre-selection
  await initCommand({
    showBanner: !values["no-banner"],  // defaults to true
    preSelectedAgent: values.agent as AgentKey | undefined,
  });
  break;
```

This correctly passes `showBanner: true` (unless `--no-banner` is specified).

### 2. Entry Flow for `atomic -a [agent_name]` (without `init`)

**Entry Point:** [src/index.ts:95-101](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/index.ts#L95-L101)

When user runs `atomic -a claude-code` (no `init` positional):

```typescript
case undefined:
  // No positional command
  if (typeof values.agent === "string") {
    // atomic --agent [name] → run with conditional init
    const exitCode = await runAgentCommand(values.agent);
    process.exit(exitCode);
  }
  // ...
```

This calls `runAgentCommand()`, which handles the auto-init logic.

### 3. The Problem: `runAgentCommand()` Display Order

**Location:** [src/commands/run-agent.ts:42-50](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/commands/run-agent.ts#L42-L50)

```typescript
// Check if config folder exists
const configFolder = join(process.cwd(), agent.folder);
if (!(await pathExists(configFolder))) {
    // Config not found - run init with pre-selected agent
    log.info(`${agent.folder} not found. Running setup...`); // ← Problem: Logs FIRST
    await initCommand({
        preSelectedAgent: agentKey as AgentKey,
        showBanner: false, // ← Problem: Banner suppressed
    });
}
```

**Issues:**

1. `log.info()` displays before any banner/intro
2. `showBanner: false` prevents the banner from displaying
3. The result is the ".claude not found" message appearing first

### 4. The `initCommand()` Display Sequence

**Location:** [src/commands/init.ts:51-76](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/commands/init.ts#L51-L76)

```typescript
export async function initCommand(options: InitOptions = {}): Promise<void> {
  const { showBanner = true } = options;

  // Display banner
  if (showBanner) {
    displayBanner();
    console.log(); // Add spacing after banner
  }

  // Show intro
  intro("Atomic: Automated Procedures and Memory for AI Coding Agents");
  log.message(
    "Enable multi-hour autonomous coding sessions with the Ralph Wiggum\nMethod using research, plan, implement methodology."
  );

  // Select agent
  let agentKey: AgentKey;

  if (options.preSelectedAgent) {
    // Pre-selected agent - validate and skip selection prompt
    if (!isValidAgent(options.preSelectedAgent)) {
      cancel(`Unknown agent: ${options.preSelectedAgent}`);
      process.exit(1);
    }
    agentKey = options.preSelectedAgent;
    log.info(`Configuring ${AGENT_CONFIG[agentKey].name}...`);  // ← Shows AFTER intro
  } else {
    // Interactive selection
    // ...
  }
```

When `showBanner: true`:

1. `displayBanner()` shows ASCII art (if terminal size permits)
2. `intro()` shows "Atomic: Automated Procedures..."
3. `log.message()` shows description
4. `log.info()` shows "Configuring Claude Code..."

### 5. Banner Display Logic

**Location:** [src/utils/banner/banner.ts:31-43](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/utils/banner/banner.ts#L31-L43)

```typescript
export function displayBanner(): void {
    const { cols, rows } = getTerminalSize();

    if (cols < LOGO_MIN_COLS || rows < LOGO_MIN_ROWS) {
        return; // Don't show if terminal too small
    }

    if (supportsTrueColor()) {
        console.log(LOGO_TRUE_COLOR);
    } else if (supports256Color()) {
        console.log(LOGO);
    }
}
```

**Constants:** [src/utils/banner/constants.ts:46-50](https://github.com/bastani-inc/atomic/blob/3792ff38ae13803ded8ddad72cbe0b23e0477e78/src/utils/banner/constants.ts#L46-L50)

```typescript
/** Minimum terminal columns to display the logo */
export const LOGO_MIN_COLS = 79;

/** Minimum terminal rows to display the logo */
export const LOGO_MIN_ROWS = 27;
```

The banner correctly checks terminal dimensions and color support before displaying.

### 6. Expected vs Actual Output

**Expected output when running `atomic -a claude-code` with uninitialized agent:**

```
[ASCII BANNER - if terminal >= 79x27]

┌  Atomic: Automated Procedures and Memory for AI Coding Agents
│
│  Enable multi-hour autonomous coding sessions with the Ralph Wiggum
│  Method using research, plan, implement methodology.
│
●  .claude not found. Running setup...
│
●  Configuring Claude Code...
│
◆  Install Claude Code config files to /home/alilavaee/Downloads?
│  ● Yes / ○ No
```

**Actual output (current behavior):**

```
●  .claude not found. Running setup...
┌  Atomic: Automated Procedures and Memory for AI Coding Agents
│
│  Enable multi-hour autonomous coding sessions with the Ralph Wiggum
│  Method using research, plan, implement methodology.
│
●  Configuring Claude Code...
│
◆  Install Claude Code config files to /home/alilavaee/Downloads?
│  ● Yes / ○ No
```

## Code References

| File                            | Lines  | Description                                        |
| ------------------------------- | ------ | -------------------------------------------------- |
| `src/index.ts`                  | 83-93  | `init` command routing with `showBanner: true`     |
| `src/index.ts`                  | 95-101 | `--agent` flag routing to `runAgentCommand()`      |
| `src/commands/run-agent.ts`     | 42-50  | Problem area: displays message before calling init |
| `src/commands/init.ts`          | 51-76  | Init command banner/intro display sequence         |
| `src/utils/banner/banner.ts`    | 31-43  | Banner display with terminal size check            |
| `src/utils/banner/constants.ts` | 46-50  | Minimum terminal dimensions (79x27)                |

## Architecture Documentation

### Display Sequence Requirements

**When `atomic init -a [agent_name]` is run (agent NOT initialized):**

1. Display ASCII banner (if terminal >= 79 cols x 27 rows AND color supported)
2. Display intro text: "Atomic: Automated Procedures and Memory for AI Coding Agents"
3. Display description: "Enable multi-hour autonomous coding sessions..."
4. Display ".claude not found. Running setup..." note
5. Display "Configuring Claude Code..."
6. Show confirmation prompt

**When `atomic -a [agent_name]` is run (agent ALREADY initialized):**

1. Skip all banner/intro display
2. Proceed directly to spawning the agent

**When terminal is too small (< 79x27):**

1. Skip ASCII banner
2. Display intro text and description
3. Continue with normal flow

### Decision Matrix for Banner Display

| Command            | Agent Status        | Terminal Size | Show Banner | Show Intro |
| ------------------ | ------------------- | ------------- | ----------- | ---------- |
| `atomic init -a X` | Not initialized     | >= 79x27      | Yes         | Yes        |
| `atomic init -a X` | Not initialized     | < 79x27       | No          | Yes        |
| `atomic init -a X` | Already initialized | >= 79x27      | Yes         | Yes        |
| `atomic init -a X` | Already initialized | < 79x27       | No          | Yes        |
| `atomic -a X`      | Not initialized     | >= 79x27      | Yes         | Yes        |
| `atomic -a X`      | Not initialized     | < 79x27       | No          | Yes        |
| `atomic -a X`      | Already initialized | Any           | No          | No         |

## Implementation Approach

### Option A: Move display logic into `runAgentCommand()`

Modify `runAgentCommand()` to display banner/intro before the ".claude not found" message:

```typescript
// In src/commands/run-agent.ts
if (!(await pathExists(configFolder))) {
    // Show banner and intro FIRST
    displayBanner();
    console.log();
    intro("Atomic: Automated Procedures and Memory for AI Coding Agents");
    log.message(
        "Enable multi-hour autonomous coding sessions with the Ralph Wiggum\nMethod using research, plan, implement methodology.",
    );

    // THEN show the "not found" message
    log.info(`${agent.folder} not found. Running setup...`);

    // Call init without banner (already displayed)
    await initCommand({
        preSelectedAgent: agentKey as AgentKey,
        showBanner: false, // Already displayed above
    });
}
```

**Pros:** Direct fix, minimal changes
**Cons:** Duplicates display logic from `initCommand()`

### Option B: Add "config not found" message parameter to `initCommand()`

Add a new option to `initCommand()` to display a custom message after intro:

```typescript
interface InitOptions {
    showBanner?: boolean;
    preSelectedAgent?: AgentKey;
    configNotFoundMessage?: string; // NEW: Optional message to show after intro
}
```

Then in `runAgentCommand()`:

```typescript
if (!(await pathExists(configFolder))) {
    await initCommand({
        preSelectedAgent: agentKey as AgentKey,
        showBanner: true, // Let init handle banner
        configNotFoundMessage: `${agent.folder} not found. Running setup...`,
    });
}
```

And in `initCommand()`:

```typescript
// After intro and description...
if (options.configNotFoundMessage) {
    log.info(options.configNotFoundMessage);
}
```

**Pros:** Keeps display logic centralized in `initCommand()`
**Cons:** Slightly more complex interface

### Option C (Recommended): Split the message display timing

Keep `showBanner: true` and remove the `log.info()` call from `runAgentCommand()` entirely:

```typescript
// In src/commands/run-agent.ts
if (!(await pathExists(configFolder))) {
    await initCommand({
        preSelectedAgent: agentKey as AgentKey,
        showBanner: true, // Changed from false
    });
}
```

Then modify `initCommand()` to show "not found" message when `preSelectedAgent` is provided:

```typescript
// In initCommand(), after intro and description:
if (options.preSelectedAgent) {
    // Show folder not found message only when auto-init is triggered
    const agent = AGENT_CONFIG[options.preSelectedAgent];
    const configFolder = join(process.cwd(), agent.folder);
    if (!(await pathExists(configFolder))) {
        log.info(`${agent.folder} not found. Running setup...`);
    }
    agentKey = options.preSelectedAgent;
    log.info(`Configuring ${agent.name}...`);
}
```

**Pros:** Proper display order, centralized logic
**Cons:** Adds a `pathExists` check inside `initCommand()` (minor duplication)

## Historical Context (from research/)

Related research:

- `research/docs/2026-01-19-cli-auto-init-agent.md` - Documents the auto-init feature implementation

## Related Research

- `research/docs/2026-01-19-cli-auto-init-agent.md` - Original research for auto-init feature
- `research/docs/2026-01-18-atomic-cli-implementation.md` - General CLI implementation details

## Open Questions

1. **Should `atomic init -a [agent_name]` show ".claude not found" when already initialized?**
    - Current behavior: Shows "Configuring Claude Code..." but not "not found"
    - Proposed: Only show "not found" message when config doesn't exist

2. **Message wording consistency:**
    - Current: ".claude not found. Running setup..."
    - Alternative: ".claude config not found. Running setup..."
    - Should it match the intro style more closely?

3. **Should there be a visual separator between intro and "not found" message?**
    - Current: No separator
    - Could add a blank line or different log type for visual distinction
