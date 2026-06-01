# Development

See [AGENTS.md](https://github.com/bastani-inc/atomic/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/bastani-inc/atomic
cd atomic
bun install
bun run typecheck
```

Run package scripts from the monorepo root or package directory with Bun, for example:

```bash
bun run test:unit
bun --cwd packages/coding-agent run build
```

Atomic keeps the caller's current working directory when launched from development wrappers.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "atomicConfig": {
    "name": "atomic",
    "configDir": ".atomic"
  }
}
```

Change `name`, `configDir`, and the `bin` field for your fork. The app-specific `<appName>Config` key is preferred; legacy `piConfig` remains a backwards-compatible shim. Atomic sets these to `atomic`, `.atomic`, and the `atomic` executable. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: package-manager install, standalone binary, and source checkout.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.atomic/agent/atomic-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
bun run typecheck                 # Type-check the monorepo
bun run test:unit                 # Run unit tests
bun run test:integration          # Run integration tests
bun run test:all                  # Run all tests
# Run package Vitest tests
bun --cwd packages/coding-agent run test -- test/specific.test.ts
```

## Project Structure

```
packages/
  coding-agent/ # Atomic CLI, agent loop, providers, TUI, and core runtime
  workflows/    # First-party workflow extension bundled into Atomic
  subagents/    # Built-in subagent orchestration and reusable agents
  mcp/          # Built-in MCP adapter extension
  web-access/   # Built-in web search and content extraction tools
  intercom/     # Built-in cross-session coordination channel
```
