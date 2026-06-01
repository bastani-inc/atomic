---
date: 2026-01-18 19:25:48 PST
researcher: Claude Opus 4.5
git_commit: f95c1a67afc46895c97f7b98b1590411e1ee8e9a
branch: lavaman131/feature/atomic-cli
repository: bastani-inc/atomic
topic: "Atomic CLI Implementation - figlet, @clack/prompts, ANSI colors, agent configuration"
tags: [research, cli, figlet, clack, ansi, bun, typescript]
status: complete
last_updated: 2026-01-18
last_updated_by: Claude Opus 4.5
---

# Research: Atomic CLI Implementation

## Research Question

How to create a CLI application with figlet and @clack/prompt that displays an ASCII banner on start with `atomic-logo.txt` on the left side and an ANSI-colorized version of `atomic-spirit.html`. The CLI should have a single entrypoint with options for claude, opencode, and copilot-cli agents, with expandable configuration supporting installation detection, folder copying with exclusions, and agent spawning.

## Summary

This research covers all technical aspects needed to implement the Atomic CLI:

1. **@clack/prompts** provides high-level APIs for interactive CLI prompts including `select()`, `confirm()`, `intro()`, `outro()`, and `note()`
2. **figlet.js** generates ASCII art text with both sync and async APIs, supporting multiple fonts
3. **HTML-to-ANSI conversion** requires a custom pipeline: parse HTML → extract RGB colors → convert to ANSI escape codes using libraries like `chalk` or `ansi-styles`
4. **Bun** provides built-in APIs for CLI development: `Bun.argv`/`util.parseArgs` for arguments, `Bun.spawn()`/`Bun.spawnSync()` for processes, `Bun.which()` for command detection, and `Bun.file()`/`Bun.write()` for file operations
5. **Agent config folders** follow similar structures with agents, commands/prompts, and skills directories

---

## Detailed Findings

### 1. @clack/prompts Library

Source: [bombshell-dev/clack](https://github.com/bombshell-dev/clack) via DeepWiki

#### Installation

```bash
bun add @clack/prompts
```

#### Key APIs

**Select Prompt (for agent selection)**

```typescript
import { select, isCancel, cancel } from "@clack/prompts";

const agent = await select({
    message: "Select a coding agent to configure:",
    options: [
        {
            value: "claude-code",
            label: "Claude Code",
            hint: "Anthropic AI assistant",
        },
        {
            value: "opencode",
            label: "opencode",
            hint: "Open source alternative",
        },
        {
            value: "copilot-cli",
            label: "GitHub Copilot CLI",
            hint: "GitHub AI assistant",
        },
    ],
});

if (isCancel(agent)) {
    cancel("Operation cancelled.");
    process.exit(0);
}
```

**Confirm Prompt (for Y/n confirmations)**

```typescript
import { confirm } from "@clack/prompts";

const shouldContinue = await confirm({
    message: `Install config files to ${process.cwd()}?`,
    initialValue: true, // Defaults to 'Yes'
});

// With custom labels
const overwrite = await confirm({
    message: "Folder already exists. Overwrite?",
    active: "Yes, overwrite",
    inactive: "No, cancel",
});
```

**Intro/Outro Messages**

```typescript
import { intro, outro, note } from "@clack/prompts";

intro("create-atomic-app"); // Banner at start
outro("You're all set!"); // Message at end

note("Config files installed successfully", "SUCCESS");
```

**Cancellation Handling**

```typescript
import { isCancel, cancel } from "@clack/prompts";

if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
}
```

**Spinner for Progress**

```typescript
import { spinner } from "@clack/prompts";

const s = spinner();
s.start("Copying configuration files");
// ... do work
s.stop("Configuration complete");
```

**Text Styling**
`@clack/prompts` uses `picocolors` internally for styling:

- `color.cyan()`, `color.red()`, `color.green()`, `color.yellow()`
- `color.dim()`, `color.bold()`, `color.inverse()`

---

### 2. Figlet.js Library

Source: [patorjk/figlet.js](https://github.com/patorjk/figlet.js) via DeepWiki

#### Installation

```bash
bun add figlet
bun add -d @types/figlet
```

#### Synchronous API (Preferred for CLI)

```typescript
import figlet from "figlet";

const asciiArt = figlet.textSync("ATOMIC");
console.log(asciiArt);

// With options
const styled = figlet.textSync("ATOMIC", {
    font: "Standard",
    horizontalLayout: "default",
    verticalLayout: "default",
    width: 80,
    whitespaceBreak: true,
});
```

#### Asynchronous API

```typescript
figlet.text("ATOMIC", { font: "Ghost" }, (err, data) => {
    if (err) {
        console.error("Figlet error:", err);
        return;
    }
    console.log(data);
});
```

#### Available Fonts

```typescript
const fonts = figlet.fontsSync();
// Returns array: ['1Row', '3-D', 'ANSI Shadow', 'Banner', 'Big', 'Standard', ...]
```

#### Setting Defaults

```typescript
figlet.defaults({ font: "Standard", horizontalLayout: "full" });
```

**Note**: The existing `atomic-logo.txt` already contains pre-generated ASCII art using box-drawing characters. It can be read directly instead of generating with figlet.

---

### 3. HTML to ANSI Color Conversion

Source: Multiple libraries via web research

#### The Challenge

The `atomic-spirit.html` file contains ~5600 lines of HTML with inline styles:

```html
<span style="color: rgb(255, 128, 0)">X</span>
```

This needs to be converted to ANSI escape codes for terminal output.

#### Conversion Pipeline

**Step 1: Parse HTML**

Option A - `node-html-parser` (Fast, lightweight):

```typescript
import { parse } from "node-html-parser";

const root = parse(htmlContent);
const spans = root.querySelectorAll("span");

for (const span of spans) {
    const style = span.getAttribute("style");
    const text = span.text;
}
```

Option B - `cheerio` (jQuery-like API):

```typescript
import * as cheerio from "cheerio";

const $ = cheerio.load(htmlContent);
$("span").each((i, el) => {
    const style = $(el).attr("style");
    const text = $(el).text();
});
```

**Step 2: Extract RGB Values**

```typescript
function parseRgb(styleAttr: string): [number, number, number] | null {
    const match = styleAttr?.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!match) return null;
    return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}
```

**Step 3: Convert to ANSI**

Option A - Using `chalk` (most popular):

```typescript
import chalk from "chalk";

const [r, g, b] = parseRgb(style);
const colored = chalk.rgb(r, g, b)(text);
```

Option B - Using `ansi-styles` (lower level):

```typescript
import styles from "ansi-styles";

const [r, g, b] = parseRgb(style);
const colored = `${styles.color.ansi16m(r, g, b)}${text}${styles.color.close}`;
```

Option C - Direct ANSI escape codes (no dependencies):

```typescript
function rgbToAnsi(r: number, g: number, b: number, text: string): string {
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
```

#### ANSI Escape Code Formats

**24-bit True Color (RGB)**

```
Foreground: \x1b[38;2;{r};{g};{b}m
Background: \x1b[48;2;{r};{g};{b}m
Reset: \x1b[0m
```

**256-Color Mode**

```
Foreground: \x1b[38;5;{ID}m
Background: \x1b[48;5;{ID}m
```

RGB to 256-color conversion formula:

```typescript
function rgbTo256(r: number, g: number, b: number): number {
    // Grayscale handling
    if (r === g && g === b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        return Math.round(((r - 8) / 247) * 24) + 232;
    }
    // Color cube
    return (
        16 +
        36 * Math.round((r / 255) * 5) +
        6 * Math.round((g / 255) * 5) +
        Math.round((b / 255) * 5)
    );
}
```

#### Terminal Color Support Detection

```typescript
import supportsColor from "supports-color";

if (supportsColor.stdout.has16m) {
    // Use 24-bit true color
} else if (supportsColor.stdout.has256) {
    // Use 256 colors
} else if (supportsColor.stdout) {
    // Use basic 16 colors
}

// Environment variables
// COLORTERM=truecolor - indicates true color support
// TERM=xterm-256color - indicates 256 color support
```

#### Complete Conversion Function

```typescript
import { parse } from "node-html-parser";
import chalk from "chalk";

function htmlToAnsi(html: string): string {
    const root = parse(html);
    const container = root.querySelector(".ascii-container");
    if (!container) return "";

    let result = "";

    for (const child of container.childNodes) {
        if (child.nodeType === 3) {
            // Text node
            result += child.text;
        } else if (child.rawTagName === "span") {
            const style = child.getAttribute("style") || "";
            const text = child.text;
            const rgb = parseRgb(style);

            if (rgb && text.trim()) {
                const [r, g, b] = rgb;
                result += chalk.rgb(r, g, b)(text);
            } else {
                result += text;
            }
        }
    }

    return result;
}
```

---

### 4. Bun CLI Patterns

Source: [oven-sh/bun](https://github.com/oven-sh/bun) via DeepWiki

#### Argument Parsing

**Raw Arguments**

```typescript
// bun run cli.ts init --flag value
console.log(Bun.argv);
// ['/path/to/bun', '/path/to/cli.ts', 'init', '--flag', 'value']
```

**Structured Parsing with `util.parseArgs`**

```typescript
import { parseArgs } from "util";

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2), // Skip bun and script path
    options: {
        agent: { type: "string", short: "a" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
});

// bun run cli.ts init
// positionals: ['init']

// bun run cli.ts --agent claude-code
// values: { agent: 'claude-code' }

// bun run cli.ts -v
// values: { version: true }
```

#### Command Detection with `Bun.which()`

```typescript
function isCommandInstalled(cmd: string): boolean {
    return Bun.which(cmd) !== null;
}

// Check if claude is installed
if (!Bun.which("claude")) {
    console.log(
        "Claude Code not found. Install at: https://docs.anthropic.com/en/docs/claude-code/setup",
    );
}
```

#### Version Check with Spawn

```typescript
function getCommandVersion(cmd: string): string | null {
    const cmdPath = Bun.which(cmd);
    if (!cmdPath) return null;

    const result = Bun.spawnSync({
        cmd: [cmdPath, "--version"],
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.success) {
        return result.stdout.toString().trim();
    }
    return null;
}
```

#### Spawning Agent Processes

```typescript
// Spawn agent with flags
const proc = Bun.spawn(["claude", "dangerously-skip-permissions"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
});

await proc.exited;
```

#### File Operations

**Reading Files**

```typescript
const content = await Bun.file("atomic-logo.txt").text();
```

**Writing Files**

```typescript
await Bun.write("./config.json", JSON.stringify(config, null, 2));
```

**Checking File Existence**

```typescript
const exists = await Bun.file("path/to/file").exists();
```

**Copying Files (BunFile to BunFile)**

```typescript
async function copyFile(src: string, dest: string): Promise<void> {
    const srcFile = Bun.file(src);
    await Bun.write(dest, srcFile);
}
```

**Copying Directories**

```typescript
import { readdir, mkdir } from "fs/promises";
import { join } from "path";

async function copyDir(
    src: string,
    dest: string,
    exclude: string[] = [],
): Promise<void> {
    await mkdir(dest, { recursive: true });

    const entries = await readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);

        // Check exclusions
        const relativePath = srcPath.replace(rootPath, "");
        if (
            exclude.some(
                (ex) => relativePath.startsWith(ex) || entry.name === ex,
            )
        ) {
            continue;
        }

        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath, exclude);
        } else {
            await Bun.write(destPath, Bun.file(srcPath));
        }
    }
}
```

#### Package.json bin Entry

```json
{
    "name": "atomic",
    "version": "1.0.0",
    "bin": {
        "atomic": "./dist/cli.js"
    }
}
```

With shebang in `cli.ts`:

```typescript
#!/usr/bin/env bun
// CLI code here
```

---

### 5. Agent Configuration Structure

#### AGENT_CONFIG Definition

```typescript
interface AgentConfig {
    name: string; // Display name
    cmd: string; // Command to run
    additional_flags: string[]; // Flags for spawning
    folder: string; // Config folder relative to repo root
    install_url: string; // Installation instructions URL
    exclude: string[]; // Paths to exclude when copying
}

const AGENT_CONFIG: Record<string, AgentConfig> = {
    "copilot-cli": {
        name: "GitHub Copilot CLI",
        cmd: "copilot",
        additional_flags: ["--allow-all-tools", "--allow-all-paths"],
        folder: ".github",
        install_url:
            "https://github.com/github/copilot-cli?tab=readme-ov-file#installation",
        exclude: [".github/workflows", ".github/dependabot.yml"],
    },
    "claude-code": {
        name: "Claude Code",
        cmd: "claude",
        additional_flags: ["dangerously-skip-permissions"],
        folder: ".claude",
        install_url: "https://docs.anthropic.com/en/docs/claude-code/setup",
        exclude: [],
    },
    opencode: {
        name: "opencode",
        cmd: "opencode",
        additional_flags: [],
        folder: ".opencode",
        install_url: "https://opencode.ai",
        exclude: [
            ".opencode/node_modules",
            ".opencode/.gitignore",
            ".opencode/bun.lock",
            ".opencode/package.json",
        ],
    },
};
```

#### Existing Folder Structures

**Claude (`.claude/`)**

```
.claude/
├── agents/           (7 markdown files)
├── commands/         (7 markdown files)
├── settings.json
└── skills/
    ├── prompt-engineer/
    └── testing-anti-patterns/
```

**OpenCode (`.opencode/`)**

```
.opencode/
├── agent/            (7 markdown files, singular naming)
├── command/          (10 markdown files, singular naming)
├── opencode.json
├── package.json      (excluded)
├── bun.lock          (excluded)
├── .gitignore        (excluded)
├── node_modules/     (excluded)
├── plugin/
└── skills/
```

**GitHub (`.github/`)**

```
.github/
├── agents/           (7 markdown files)
├── prompts/          (10 .prompt.md files)
├── scripts/          (8 shell scripts)
├── hooks/
├── skills/
├── workflows/        (excluded)
└── dependabot.yml    (excluded)
```

#### Additional Files to Copy

| Agent         | Additional File            |
| ------------- | -------------------------- |
| `claude-code` | `CLAUDE.md` from repo root |
| `opencode`    | `AGENTS.md` from repo root |
| `copilot-cli` | `AGENTS.md` from repo root |

Note: `AGENTS.md` is a symlink to `CLAUDE.md` in the repo.

---

### 6. CLI User Experience Flow

#### Command Structure

```
atomic                     # Same as `atomic init`
atomic init                # Interactive setup with banner
atomic --agent <name>      # Run agent directly (skip banner)
atomic --version           # Show version
atomic --help              # Show help
```

#### Init Flow

```
1. Display ASCII banner (logo + spirit side by side)
2. Show intro message
3. Select prompt: choose agent
4. Confirm prompt: confirm directory
5. If folder exists: confirm overwrite
6. Copy files with spinner
7. Show success outro
```

#### Agent Run Flow (`atomic --agent <name>`)

```
1. Validate agent name exists in config
2. Check if config folder exists in current dir
3. If not: offer to run setup first
4. Check if command is installed (Bun.which)
5. If not installed: show install URL and exit
6. Spawn agent with flags
```

---

### 7. Banner Display Implementation

#### Side-by-Side Layout

```typescript
function displayBanner(): void {
    // Load both assets
    const logo = Bun.file("assets/atomic-logo.txt").text();
    const spiritHtml = Bun.file("assets/atomic-spirit.html").text();
    const spirit = htmlToAnsi(spiritHtml);

    // Split into lines
    const logoLines = logo.split("\n");
    const spiritLines = spirit.split("\n");

    // Get max width of logo
    const logoWidth = Math.max(...logoLines.map((l) => stripAnsi(l).length));

    // Combine side by side
    const maxLines = Math.max(logoLines.length, spiritLines.length);
    const combined: string[] = [];

    for (let i = 0; i < maxLines; i++) {
        const logoLine = (logoLines[i] || "").padEnd(logoWidth + 2);
        const spiritLine = spiritLines[i] || "";
        combined.push(logoLine + spiritLine);
    }

    console.log(combined.join("\n"));
}
```

---

## Code References

| File                            | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `src/index.ts:1`                | Current entry point (placeholder)           |
| `src/assets/atomic-logo.txt`    | ASCII logo (6 lines, 742 bytes)             |
| `src/assets/atomic-spirit.html` | Colored ASCII art (5653 lines, ~300KB HTML) |
| `.claude/`                      | Claude Code config folder                   |
| `.opencode/`                    | OpenCode config folder                      |
| `.github/`                      | GitHub Copilot CLI config folder            |
| `CLAUDE.md`                     | Documentation for Claude agent              |
| `AGENTS.md`                     | Symlink to CLAUDE.md                        |

---

## Architecture Documentation

### Proposed File Structure

```
src/
├── index.ts              # Entry point, CLI argument routing
├── config.ts             # AGENT_CONFIG definition
├── commands/
│   ├── init.ts           # Init command with prompts
│   └── run-agent.ts      # Agent spawning logic
├── utils/
│   ├── banner.ts         # Banner display (logo + spirit)
│   ├── html-to-ansi.ts   # HTML color conversion
│   ├── copy.ts           # Directory copying with exclusions
│   └── detect.ts         # Command detection helpers
└── assets/
    ├── atomic-logo.txt
    └── atomic-spirit.html
```

### Dependencies to Add

```json
{
    "dependencies": {
        "@clack/prompts": "^0.7.0",
        "figlet": "^1.7.0",
        "chalk": "^5.3.0"
    },
    "devDependencies": {
        "@types/figlet": "^1.5.8"
    }
}
```

Alternative (lighter weight):

```json
{
    "dependencies": {
        "@clack/prompts": "^0.7.0",
        "node-html-parser": "^6.1.0"
    }
}
```

Using direct ANSI escape codes instead of chalk.

---

## Historical Context

This CLI is being built as part of the atomic project to simplify onboarding for multiple AI coding assistants. The project already has mature configurations for Claude Code, OpenCode, and GitHub Copilot CLI that this CLI will distribute.

---

## Related Research

- No prior research documents exist in the research/ directory for this topic.

---

## Open Questions

1. **Spirit image size**: The atomic-spirit.html is ~300KB and generates ~5600 lines of colored ASCII. This may be too large for a terminal banner. Consider:
    - Using a smaller/cropped version
    - Pre-processing to reduce redundancy
    - Making the spirit display optional

2. **Color fallback**: What should happen on terminals without true color support?
    - Degrade gracefully to 256 colors
    - Fall back to uncolored output
    - Detect and warn user

3. **Windows compatibility**: Shell scripts in `.github/scripts/` have both `.sh` and `.ps1` versions. The CLI should handle cross-platform execution.

4. **Version management**: Where should the version number be defined for `atomic --version`? Options:
    - `package.json` version field
    - Build-time constant injection
    - Separate version file
