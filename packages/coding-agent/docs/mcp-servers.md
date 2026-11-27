---
title: "MCP servers"
sidebarTitle: "MCP servers"
description: "Configure stdio and streamable HTTP MCP servers, control tool exposure, read resources, and authenticate with OAuth or provider logins."
---

Atomic includes built-in [Model Context Protocol](https://modelcontextprotocol.io) support in both npm and standalone binary installations. Connect to MCP servers over stdio or streamable HTTP with no separate extension install.

## Quick setup

Add a local stdio server, verify the connection, and start Atomic:

```bash
atomic mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
atomic mcp list
atomic
```

Add a remote streamable HTTP server:

```bash
atomic mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
```

CLI commands write user-level configuration by default. Pass `--local` or `-l` to write `.atomic/mcp.json` in the current project instead, then start Atomic and grant [project trust](/security) before using project servers.

Run `/mcp` inside Atomic to inspect connections and manage servers. After editing configuration files outside a session, run `/reload` or restart Atomic.

## Configure servers

Atomic reads user-level servers from `~/.atomic/agent/mcp.json` (relocated by `ATOMIC_CODING_AGENT_DIR`) and project servers from `.atomic/mcp.json`. Project configuration loads only after [project trust](/security) is granted. Both files use a top-level `mcpServers` object. Keep personal servers and credentials in the user-level file.

### Server names and overrides

Server names may contain letters, digits, `_`, and `-` (avoid reserved JavaScript property names such as `__proto__`, `constructor`, and `prototype`, which `/mcp` rejects when updating settings). Names that differ only in `-` versus `_` share the same tool namespace, while project overrides look up user-level servers by **exact key name**:

- A full project entry replaces a user-level entry with the exact same key name.
- A project entry without `command`, `url`, or `type` acts as a lightweight override that can set **only** `enabled`, `exposure`, and `toolExposure` on a user-level server with the exact same key name while keeping the rest (`env`, `headers`, `auth`, and `oauth`). Adding any other field (such as `timeout` or `description`) or referencing a server absent from user-level `mcp.json` reports a configuration error and skips the entry.
- If user-level config defines `my-server`, a project entry named `my_server` does not match as an override and is rejected as a namespace conflict if defined as a full server. Invalid entries are reported and skipped without blocking other servers.

For example, to turn off a user-level server in one project:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

### Stdio servers

Configure `command`, `args`, `env`, and `cwd`. `command` must be one executable, not a shell command string. A `command` with a path runs as written; a bare command name is searched in the absolute directories on `PATH` from `env` (and on Windows first in `cwd` when `cwd` is outside the project folder; the project folder counts only if `PATH` lists it). On Windows, variables in `env` (such as `PATH`) replace inherited variables case-insensitively both when locating `command` and inside the spawned server. A missing executable fails with `spawn <command> ENOENT`. Relative `cwd` values resolve against the session directory.

### Streamable HTTP servers

Configure `url`, optional `headers`, and optional `oauth` or `auth`:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

### Variable and command expansion

Interpolation rules differ by field:

| Fields | Supported syntax | Escaping and caveats |
| --- | --- | --- |
| `url` | `${NAME}`, `$env:NAME` | Resolved in memory before URL validation without rewriting config files. Does **not** support unbraced `$NAME`, `!command`, or `$$` escaping. |
| `env`, `headers`, `oauth.clientSecret` | `${NAME}`, unbraced `$NAME`, whole-value `!command` (such as `"!echo Bearer $(gh auth token)"`) | **Escape literal `$` as `$$` and literal leading `!` as `$!`.** Because unbraced `$NAME` interpolates automatically, secrets containing `$word` expand or fail unless escaped as `$$word`. On failure, Atomic never echoes `!command` text; `${NAME}` reports the unset variable name, while unbraced `$NAME` reports the name only when it looks like a POSIX variable name so literal secret fragments do not leak. |
| `command`, `args`, `cwd` | Leading `~`, `~/`, and (on Windows) `~\` | Expands to your home directory. Does not interpolate environment variables or `!command`. |
| `oauth.clientId`, `oauth.scope`, `oauth.callbackUrl`, `oauth.authServerMetadataUrl` | Literal strings only | No environment variable, `!command`, or `~` expansion. |

<Warning>
Only use `!command` in MCP configuration you trust. Each `!command` runs uncached on every connect or refresh with a **10-second timeout**, a **1 MiB stdout cap**, and stderr discarded.
</Warning>

### Shared transport fields

- `timeout`: per-request inactivity timeout in seconds (default `60`). Server progress notifications reset this timer; it is not a total execution deadline.
- `enabled: false`: keep a server configured without connecting to it.
- `exposure` and `toolExposure`: control how tools reach the model.
- `description`: a short summary for the model's system prompt, tool search, and `describeNamespace()`. If omitted, Atomic uses the first line of the server's instructions once connected.
- `type`: optional (`command` selects stdio and `url` selects streamable HTTP). When present, must be `stdio`, `http`, or `streamable-http`. Legacy SSE endpoints are not supported; point to the server's streamable HTTP endpoint (typically `/mcp` rather than `/sse`).

### Servers from packages and extensions

Installed [packages](/packages/authoring#mcp-servers) and [extensions](/extensions/api-reference#atomic-registermcpserver-name-config) can contribute MCP servers using the same configuration shape. File-configured servers take precedence over package or extension contributions with the same normalized name. Project packages load only after project trust is granted.

`/mcp` shows each server's source. Enabled-state and exposure changes to file-configured servers save back to `mcp.json` while preserving formatting and unrelated settings (setting a full entry back to the defaults `enabled: true` or `exposure: "codemode"` omits those default keys on disk, while project overrides keep explicit keys). In a trusted project, **Enable in this project** and **Disable in this project** create or update a project override for a user-level server, and `atomic mcp list` displays the override. Changes to extension-contributed servers apply to the current session only.

## Manage servers

Run `/mcp` to open the interactive server manager showing connection state, tool count, exposure, and source, even while startup connections are still pending.

Select a server to inspect tools and details, sign in or out, reconnect, enable or disable it, or change exposure (the `/mcp` exposure picker offers `codemode`, `deferred`, and `direct`; set `hidden` in `mcp.json`). Servers needing attention appear first. Enable, disable, and reconnect run in the background while the manager updates live. Use `↑` and `↓` to select, `Enter` to open, `Esc` to go back, and type to filter long lists.

| Command | Action |
| --- | --- |
| `/mcp` | Open the manager in the TUI, or print status outside the TUI. |
| `/mcp login [server]` | Sign in with OAuth. |
| `/mcp logout [server]` | Remove stored OAuth credentials. |
| `/mcp reconnect [server]` | Reconnect a server and refresh its tools. |

Tab completion suggests subcommands and eligible server names. When you omit a server name, Atomic selects the only eligible server automatically or prompts you to choose. `/mcp login` requires an interactive UI; run `atomic mcp login` in your shell before unattended runs.

### Connection lifecycle, retries, and resume

- **Background startup.** Enabled servers connect in the background at startup. The first prompt waits up to 10 seconds for servers with `direct` tools, while codemode, `tool_search`, and resource calls wait for the servers they need.
- **Automatic retries and session recovery.** Streamable HTTP connections automatically retry transient failures (`408`, `429`, `5xx` except `501`, network errors, and transient OAuth failures) twice after 250 ms and 1,000 ms. Read-only resource calls retry once after 250 ms; tool calls are never retried automatically. Dropped connections reconnect on the next call, expired HTTP sessions re-initialize once automatically, and server-announced tool list changes apply automatically.
- **Session resume.** Previously used MCP tools stay available and keep their summaries while servers reconnect, as long as the server stays defined in the same scope with the same command and `cwd` (or the same URL scheme, host, port, and path; argument and query changes do not invalidate it). Calls wait for reconnect and run only if the tool still exists. Tools from servers that fail to reconnect, require sign-in, or removed them update on the next turn.

### Shell commands

CLI subcommands operate on file-configured servers and do not load extensions (see [MCP CLI commands](/reference/cli#mcp-commands)):

```bash
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [-l] [--timeout <seconds>]
atomic mcp logout <server> [-l]
```

`add` replaces an existing entry with the same name. `add` and `remove` accept `--local` (`-l`) to write `.atomic/mcp.json`; `login` and `logout` accept `-l` to require a project-defined server (otherwise they search both files).

For stdio servers, pass repeatable `--env KEY=VALUE` and `--cwd`. For HTTP servers, pass repeatable `--header KEY=VALUE`, `--bearer-token-env-var NAME`, and `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, or `--oauth-client-name`. Both transports accept `--exposure` and `--description`. Advanced options without CLI flags (`timeout`, `enabled`, `toolExposure`, `autoEnableCodemode`, `auth.provider`, `oauth.callbackUrl`, `oauth.scope`, and `oauth.authServerMetadataUrl`) can be edited directly in `mcp.json`. Passing `--help` or `-h` after `--` (for example `atomic mcp add srv -- cmd --help`) or as a flag value passes through instead of printing MCP help. Run `atomic mcp --help` for full usage.

`list` connects to enabled servers and reports state, tools, and errors, exiting `1` on invalid config or any disconnected enabled server. An untrusted `.atomic/mcp.json` is skipped with a note without causing `list` to exit nonzero. Pass `--json` for machine-readable output. `login` times out after 300 seconds by default (`--timeout` caps the entire sign-in flow, including authorization-server requests, not MCP request timeouts). Running sessions pick up new credentials on their next turn.

Resource-capable servers show `offers resources` rather than counts (`resources: true` in `--json` output). Use the resource tools below to list resources on demand.

## Find and call tools

MCP tools register as `mcp__<server>__<tool>` with punctuation replaced by `_`. Names longer than 64 characters, or names that collide after normalization, are shortened to at most 64 characters with an 8-hex SHA-256 hash suffix (`_xxxxxxxx`). Always use the names returned by discovery rather than constructing them by hand.

### Control tool exposure

| Exposure | Behavior |
| --- | --- |
| `codemode` (default) | Callable from [codemode](/codemode) scripts, but not declared directly to the model or listed in codemode's inline catalog. Discover with `await searchTools()`, `await describeTool()`, or `ALL_TOOLS`. |
| `deferred` | Not declared until [`tool_search`](/tools#tool_search) activates matching tools for the next model turn. |
| `direct` | Declared like a built-in tool and also callable from codemode. |
| `hidden` | Unreachable. |

`codemode-deferred` is accepted as an alias for `codemode`. Atomic activates `codemode` for codemode servers and `tool_search` for deferred servers automatically (in subagents, `autoEnableCodemode` is always `false`). An explicit `-codemode` in `defaultTools` or `--tools` takes precedence so MCP leaves codemode off (merely omitting `codemode` from `defaultTools` does not block MCP activation). Set `"autoEnableCodemode": false` beside `mcpServers` to turn off automatic codemode activation without changing ordinary defaults; a project setting overrides the user-level setting.

`toolExposure` overrides exposure for individual tools. Keys match the **original server tool name** (case-sensitive) before `mcp__<server>__` prefixing. `*` is the only wildcard (`?`, `[...]`, and regex syntax match literally). Exact matches win first, followed by wildcard patterns in JSON key order (first match wins):

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

Both `codemode` and `deferred` tools can be reached through either discovery mechanism. Atomic adds a short summary of connected servers to the model's system prompt (capped at 250 characters per server and 4,096 characters total). Scripts can read full server instructions and tool lists with `await describeNamespace("mcp__github")`.

`--tools` keeps MCP tools unless an entry starts with `mcp__`. For example, `atomic --tools read,codemode` still lets codemode scripts call non-hidden `codemode` and `deferred` MCP tools, while unmatched `direct` tools stay registered but inactive. Include `tool_search` to load unmatched non-direct tools, or filter explicitly with patterns such as `atomic --tools read,codemode,'mcp__docs__*'`. `--exclude-tools` accepts the same `*` patterns and applies to MCP resource tools as well.

`--no-mcp` disables built-in MCP support for one run: no built-in servers connect, no MCP tools load, and `/mcp` does not register. A custom replacement extension is unaffected.

**Output handling.** Codemode scripts receive the complete untruncated MCP result (`content`, `structuredContent`, and `isError`, with `_meta` stripped). For direct model calls, text over **20 KiB** (`20,480` bytes) is middle-truncated (keeping the start and end) with the full text saved to a temporary file whose path is printed in the result. Every MCP call passes through Atomic's tool pipeline, including permission hooks.

## Use resources

When a connected server offers resources, Atomic registers three tools:

- `list_mcp_resources`: lists resources. Pass `server` to fetch one page from a single server (and `cursor` for the next page); omit `server` to paginate through every page of every server automatically. Passing `cursor` without `server` fails with an error.
- `list_mcp_resource_templates`: lists URI templates, using the same `server` and `cursor` pagination rules.
- `read_mcp_resource`: reads a resource by `server` and `uri`. Text, images, and binary blobs with text MIME types (`text/*`, `application/json`, `*+json`, `*+xml`) reach the model directly; other binary content is saved to a temporary file.

These tools cover enabled, non-hidden resource servers, apply the same 20 KiB direct-call text truncation, and inherit the widest exposure among those servers (`direct` > `codemode` > `deferred` > `hidden`). Resource links inside tool results identify the server and `read_mcp_resource`.

MCP Apps resources (`ui://` URIs or `text/html;profile=mcp-app`) are omitted because Atomic does not render interactive web UIs inside the terminal.

## Authentication

OAuth applies to HTTP servers that do not set an `Authorization` header or `auth.provider`.

<Steps>
  <Step title="Configure the server URL">
    Add the server's `url` (and optional `oauth` settings if using a pre-registered client) in `mcp.json` or with `atomic mcp add`.
  </Step>
  <Step title="Start sign-in">
    Run `/mcp login my-server` inside Atomic (or choose **Sign in** in `/mcp`), or run `atomic mcp login my-server` in your shell before unattended runs. Atomic opens the authorization page and prints a clickable URL.
  </Step>
  <Step title="Complete browser or headless redirect">
    Approve access in your browser. If your browser runs on another machine, paste the full redirected URL into the waiting sign-in prompt. Press `Esc` to cancel at any step.
  </Step>
</Steps>

Atomic registers dynamic OAuth clients as `atomic`, stores tokens in `~/.atomic/agent/mcp-auth.json`, refreshes tokens proactively 30 seconds before expiry (with cross-process refresh locking), and reconnects the server after sign-in. Run `/mcp logout my-server` or `atomic mcp logout my-server` to remove stored credentials.

Credentials are keyed by the **normalized** server name (`-` replaced with `_`) and normalized URL. Two entries for the same URL under different normalized names sign in independently; entries with the same normalized name and URL across global and project `mcp.json` files share one sign-in.

For a pre-registered OAuth client:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "my-client",
        "clientSecret": "${EXAMPLE_SECRET}",
        "callbackPort": 8765,
        "scope": "read write"
      }
    }
  }
}
```

- `clientSecret` is optional and supports `${NAME}`, `$NAME`, and `!command` expansion (escape literal `$` as `$$`).
- `callbackPort` must be `1`–`65535` and uses `http://127.0.0.1:<port>/callback`.
- `callbackUrl` specifies another registered redirect URI (HTTP on `localhost`, `127.0.0.1`, or `[::1]`, with no `?` query string or `#` fragment). If `callbackUrl` omits a port, Atomic adds `callbackPort` or picks a free port; if both specify ports, they must match.
- Use `oauth.clientName` when a server requires a specific dynamic client registration name (sign out before signing in again after changing it). Use `oauth.scope` when a server does not advertise required scopes; later scope requests merge with it.

### Override OAuth authorization server discovery

If an MCP server advertises the wrong authorization server or none at all, set `oauth.authServerMetadataUrl` to a trusted authorization server metadata document (OAuth 2.0 or OpenID Connect):

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Atomic uses that document instead of running discovery and trusts its configured issuer. Point it only at a metadata URL you trust; it must use HTTPS (except HTTP on `localhost`, `127.0.0.1`, or `[::1]`).

### OAuth security and redirect rules

- Treat authorization and redirect URLs as sensitive. Authorization-server metadata and token requests time out after 15 seconds.
- When pasting a redirect URL manually, keep its scheme, host, port, and path unchanged—Atomic rejects URLs that do not match the active sign-in's redirect URI even when the authorization code and state are valid.
- Atomic rejects authorization responses whose `iss` parameter names another issuer before exchanging the code, and requires `iss` whenever the server advertises issuer-parameter support.
- An empty refresh token never overwrites a stored refresh token, and a missing or null `expires_in` does not expire the access token immediately.

### Authenticate with a provider login

An HTTP server can reuse an active Atomic provider login token instead of MCP OAuth:

```json
{
  "mcpServers": {
    "gateway": {
      "url": "https://gateway.example/mcp",
      "auth": { "provider": "openrouter" }
    }
  }
}
```

Atomic reads the current provider token on every request and never copies it into `mcp-auth.json`. If the token is missing or rejected, run `/login <provider>` and retry. `atomic mcp list` also sends and refreshes provider logins; use `atomic auth login <provider>` and `atomic auth logout <provider>` to manage them from the shell.

Provider-token authentication enforces three safeguards:

- Accepted only from user-level `~/.atomic/agent/mcp.json` and extension registrations—never from project `.atomic/mcp.json` or package manifests.
- Requires HTTPS, except HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
- Sends tokens only to the configured origin (following up to 10 same-origin redirects and rejecting cross-origin redirects).

## Using MCP from the SDK

`createAgentSession()` enables built-in MCP support by default and loads servers from `mcp.json`, installed packages, and extensions:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

// Disable built-in MCP support completely
const noMcp = await createAgentSession({
  builtins: { mcp: false },
});

// Allow only specific MCP tools, or exclude a server's tools
const filtered = await createAgentSession({
  tools: ["read", "codemode", "mcp__docs__*"],
  excludedTools: ["mcp__docs__delete_*"],
});

// Register an MCP server dynamically at runtime via an inline extension factory
const loader = new DefaultResourceLoader({
  extensionFactories: [
    (atomic) => {
      atomic.registerMcpServer("local-service", {
        url: "http://127.0.0.1:4321/mcp",
        exposure: "direct",
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

- **Tool filtering.** When `tools` is a non-empty allowlist with no `mcp__*` entry, MCP tools stay registered for `codemode` and `tool_search`. Adding any `mcp__*` entry switches MCP tools to explicit allowlisting. See [SDK tools](/sdk/reference#tools).
- **Dynamic registration.** Call [`atomic.registerMcpServer()`](/extensions/api-reference#atomic-registermcpserver-name-config) inside an inline extension factory when a server URL or port is computed at runtime.
- **Custom resource loaders.** Implement `getMcpServerContributions()` on a custom `ResourceLoader` to supply servers under your own trust policy. See [ResourceLoader](/sdk/reference#resourceloader).

## Supported capabilities and limits

- **Configuration sources.** Atomic reads only `~/.atomic/agent/mcp.json`, trusted `.atomic/mcp.json`, and package or extension contributions. External MCP client config files and third-party credential stores are not imported.
- **Transports and message limit.** Supports stdio and streamable HTTP with a **16 MiB** maximum per MCP message or SSE event. Legacy SSE endpoints are not supported.
- **Protocol features.** Atomic advertises MCP `roots` (the session working directory) and handles server `ping`, `notifications/tools/list_changed`, `notifications/message`, and progress notifications. MCP **prompts**, **sampling**, **elicitation**, and MCP Apps (`ui://`) rendering are not supported.

## Troubleshooting

- **Inspect connection state and logs.** Run `/mcp` or `atomic mcp list` to view connection errors, available tools, and the tail of a failed stdio server's stderr. `~/.atomic/agent/mcp.log` records server-sent `notifications/message` log notifications (and CLI provider-token warnings), truncating entries at 64 KiB and rotating to `mcp.log.1` at 5 MiB—it does not log connection handshakes or raw JSON-RPC frames.
- **Reload after config edits.** Run `/reload` or restart Atomic after editing `mcp.json`. Use `/mcp reconnect my-server` to reconnect and refresh tools.
- **Missing tools.** Check both server-level `exposure` and per-tool `toolExposure`. `hidden` tools cannot be called; `codemode` and `deferred` tools need codemode or `tool_search` enabled.
- **OAuth redirect failures.** Verify `callbackPort` and `callbackUrl` match the registered redirect URI with no query string or fragment. Over SSH, paste the complete redirected URL into the waiting sign-in prompt.
- **Temporary authorization server outage.** Stored tokens stay intact and Atomic retries automatically; run `/mcp reconnect my-server` once the authorization server recovers. You are asked to sign in again only when credentials are rejected or revoked.
- **Issuer mismatch.** Verify the authorization server's metadata and callback configuration before retrying rather than bypassing issuer validation.
- **Slow tool calls.** Increase `timeout` (in seconds). Server progress notifications reset this inactivity timer.

## Related docs

<Columns cols={2}>
  <Card title="Codemode" href="/codemode">
    Discover and call `codemode` and `deferred` MCP tools from JavaScript scripts.
  </Card>
  <Card title="CLI MCP commands" href="/reference/cli#mcp-commands">
    Reference for `atomic mcp` subcommands and `--no-mcp`.
  </Card>
  <Card title="Extensions API" href="/extensions/api-reference#atomic-registermcpserver-name-config">
    Register dynamic MCP servers at runtime with `atomic.registerMcpServer()`.
  </Card>
  <Card title="Subagent allowlists" href="/subagents/authoring#tool-and-mcp-allowlists">
    Grant `mcp:<server>` and `mcp:<server>/<tool>` access in custom subagents.
  </Card>
</Columns>
