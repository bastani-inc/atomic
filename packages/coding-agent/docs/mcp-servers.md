---
title: "MCP servers"
sidebarTitle: "MCP servers"
description: "Configure stdio and streamable HTTP MCP servers, control tool exposure, read resources, and authenticate with OAuth or provider logins."
---

Atomic includes built-in [Model Context Protocol](https://modelcontextprotocol.io) support in both npm and standalone binary installations. It connects to MCP servers over stdio or streamable HTTP with no separate extension install required.

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

CLI commands write user-level configuration by default. Pass `--local` or `-l` to write `.atomic/mcp.json` in the current project instead, then start Atomic and grant project trust before using project servers.

Run `/mcp` inside Atomic to inspect connections and manage servers. After editing configuration outside a session, run `/reload` or restart Atomic.

## Configure servers

Atomic reads user-level servers from `~/.atomic/agent/mcp.json` (relocated by `ATOMIC_CODING_AGENT_DIR`) and project servers from `.atomic/mcp.json`. Project configuration loads only after [project trust](/security) is granted. Both files use a top-level `mcpServers` object. Keep personal servers and credentials in the user-level file.

A full project entry replaces a user-level entry with the exact same key name. A project entry without `command`, `url`, or `type` acts as a lightweight override that can set **only** `enabled`, `exposure`, and `toolExposure` on a user-level server with the exact same key name while keeping the rest (`env`, `headers`, `auth`, and `oauth`). Adding any other field (such as `timeout` or `description`) or referencing a server not present in user-level `mcp.json` reports a configuration error and skips the entry.

For example, to turn off a user-level server in one project:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

**Server names and namespace collisions.** Server names may contain letters, digits, `_`, and `-`. Reserved JavaScript property names (`__proto__`, `constructor`, and `prototype`) are rejected. Names that differ only in `-` versus `_` share the same tool namespace, while project overrides look up user-level servers by exact key name. If user-level config defines `my-server`, a project entry named `my_server` does not match as an override and is rejected as a namespace conflict if defined as a full server. Always use the exact same key name to override or replace a user-level server. Invalid entries are reported and skipped without blocking other servers.

**Stdio servers.** Configure `command`, `args`, `env`, and `cwd`. `command` must be one executable, not a shell command string. A `command` with a path runs as written; a bare command name is searched in the absolute directories on `PATH` from `env` (and on Windows first in `cwd` when `cwd` is outside the project folder; the project folder counts only if `PATH` lists it). On Windows, variables in `env` (such as `PATH`) replace inherited variables case-insensitively both when locating `command` and inside the spawned server. A missing executable fails with `spawn <command> ENOENT`. Relative `cwd` values resolve against the session directory.

**Streamable HTTP servers.** Configure `url`, optional `headers`, and optional `oauth` or `auth`:

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

**Variable, command, and home-directory expansion.** Interpolation rules differ by field:

| Fields | Supported syntax | Escaping and caveats |
| --- | --- | --- |
| `url` | `${NAME}`, `$env:NAME` | Resolved in memory before URL validation without rewriting config files. Does **not** support unbraced `$NAME`, `!command`, or `$$` escaping. |
| `env`, `headers`, `oauth.clientSecret` | `${NAME}`, unbraced `$NAME`, whole-value `!command` (such as `"!echo Bearer $(gh auth token)"`) | **Escape literal `$` as `$$` and literal leading `!` as `$!`.** Because unbraced `$NAME` is interpolated automatically, secrets containing `$word` expand or fail unless escaped as `$$word`. Only use `!command` in configuration you trust. On failure, Atomic never echoes `!command` text; `${NAME}` reports the unset variable name, while unbraced `$NAME` reports the name only when it looks like a POSIX variable name so literal secret fragments do not leak. |
| `command`, `args`, `cwd` | Leading `~`, `~/`, and (on Windows) `~\` | Expands to your home directory. Does not interpolate environment variables or `!command`. |
| `oauth.clientId`, `oauth.scope`, `oauth.callbackUrl`, `oauth.authServerMetadataUrl` | Literal strings only | No environment variable, `!command`, or `~` expansion. |

**Fields shared by both transports:**

- `timeout`: per-request inactivity timeout in seconds (default `60`). Server progress notifications reset this timer; it is not a total execution deadline.
- `enabled: false`: keep a server configured without connecting to it.
- `exposure` and `toolExposure`: control how tools reach the model.
- `description`: a short summary for the model's system prompt, tool search, and `describeNamespace()`. If omitted, Atomic uses the first line of the server's instructions once connected.
- `type`: optional (`command` selects stdio and `url` selects streamable HTTP). When present, must be `stdio`, `http`, or `streamable-http`. SSE endpoints are not supported; point to the server's streamable HTTP endpoint (typically `/mcp` rather than `/sse`).

### Servers from packages and extensions

Installed [packages](/packages/authoring#mcp-servers) and extensions can contribute MCP servers using the same configuration shape. File-configured servers take precedence over package or extension contributions with the same normalized name. Project packages load only after project trust is granted.

`/mcp` shows each server's source. Enabled-state and exposure changes to file-configured servers save back to `mcp.json` while preserving formatting and unrelated settings (setting a full entry back to the defaults `enabled: true` or `exposure: "codemode"` omits those default keys on disk, while project overrides keep explicit keys). In a trusted project, **Enable in this project** and **Disable in this project** create or update a project override for a user-level server, and `atomic mcp list` displays the override. Changes to extension-contributed servers apply to the current session only.

## Manage servers

Run `/mcp` to open the interactive server manager showing connection state, tool count, exposure, and source, even while startup connections are still pending.

Select a server to inspect tools and details, sign in or out, reconnect, enable or disable it, or change exposure. Servers needing attention appear first. Enable, disable, and reconnect run in the background while the manager updates live, so you can keep navigating or close it. Use `↑` and `↓` to select, `Enter` to open, `Esc` to go back, and type to filter lists longer than one screen.

| Command | Action |
| --- | --- |
| `/mcp` | Open the manager in the TUI, or print status outside the TUI. |
| `/mcp login [server]` | Sign in with OAuth. |
| `/mcp logout [server]` | Remove stored OAuth credentials. |
| `/mcp reconnect [server]` | Reconnect a server and refresh its tools. |

Tab completion suggests subcommands and eligible server names. When you omit a server name, Atomic selects the only eligible server automatically or prompts you to choose. `/mcp login` requires an interactive UI; run `atomic mcp login` in your shell before unattended runs.

Enabled servers connect in the background at startup. The first prompt waits up to 10 seconds for servers with `direct` tools, while codemode, `tool_search`, and resource calls wait for the servers they need. Dropped connections reconnect on the next call, and server-announced tool list changes apply automatically.

When you resume a session, its previously used MCP tools remain available and keep their summaries while servers reconnect, as long as the server stays defined in the same scope with the same command and `cwd` (or the same URL scheme, host, port, and path; argument and query changes do not invalidate it). Calls wait for reconnect and run only if the tool still exists. Tools from servers that fail to reconnect, require sign-in, or removed them update on the next turn.

### Shell commands

CLI subcommands operate on file-configured servers and do not load extensions:

```bash
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [-l] [--timeout <seconds>]
atomic mcp logout <server> [-l]
```

`add` replaces an existing entry with the same name. `add` and `remove` accept `--local` (`-l`) to write `.atomic/mcp.json`; `login` and `logout` accept `-l` to require a project-defined server (otherwise they search both files).

For stdio servers, pass repeatable `--env KEY=VALUE` and `--cwd`. For HTTP servers, pass repeatable `--header KEY=VALUE`, `--bearer-token-env-var NAME`, and `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, or `--oauth-client-name`. Both transports accept `--exposure` and `--description`. Advanced options without CLI flags (`timeout`, `enabled`, `auth.provider`, `oauth.callbackUrl`, `oauth.scope`, and `oauth.authServerMetadataUrl`) can be edited directly in `mcp.json`. Passing `--help` or `-h` after `--` (for example `atomic mcp add srv -- cmd --help`) or as a flag value passes through instead of printing MCP help. Run `atomic mcp --help` for full usage.

`list` connects to enabled servers and reports state, tools, and errors, exiting `1` on invalid config or any disconnected enabled server. Pass `--json` for machine-readable output. `login` times out after 300 seconds by default (`--timeout` caps the entire sign-in flow, including authorization-server requests, not MCP request timeouts). Running sessions pick up new credentials on their next turn.

Resource-capable servers show `offers resources` rather than counts (`resources: true` in `--json` output). Use the resource tools below to list resources on demand.

## Find and call tools

MCP tools register as `mcp__<server>__<tool>` with punctuation replaced by `_`. Names longer than 64 characters, or names that collide after normalization, are shortened to at most 64 characters with an 8-hex SHA-256 hash suffix (`_xxxxxxxx`). Always use the names returned by discovery rather than constructing them by hand.

### Control tool exposure

| Exposure | Behavior |
| --- | --- |
| `codemode` (default) | Callable from codemode scripts, but not declared directly to the model or listed in codemode's inline catalog. Discover with `await searchTools()`, `await describeTool()`, or `ALL_TOOLS`. |
| `deferred` | Not declared until `tool_search` activates matching tools for the next model turn. |
| `direct` | Declared like a built-in tool and also callable from codemode. |
| `hidden` | Unreachable. |

`codemode-deferred` is accepted as an alias for `codemode`. Atomic activates `codemode` for codemode servers and `tool_search` for deferred servers automatically. An explicit `-codemode` in `defaultTools` or `--tools` takes precedence so MCP leaves codemode off (merely omitting `codemode` from `defaultTools` does not block MCP activation). Set `"autoEnableCodemode": false` beside `mcpServers` to turn off automatic codemode activation without changing ordinary defaults; a project setting overrides the user-level setting.

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

**Output handling.** Codemode scripts receive the complete untruncated `CallToolResult` (`content`, `structuredContent`, and `isError`, with `_meta` stripped). For direct model calls, text over 20 KiB (`20,480` bytes) is middle-truncated (keeping the start and end) with the full text saved to a temporary file (`pi-mcp*.txt`) named in the result. Every MCP call passes through Atomic's tool pipeline, including permission hooks.

## Use resources

When a connected server offers resources, Atomic registers three tools:

- `list_mcp_resources`: lists resources. Pass `server` to fetch one page from a single server (and `cursor` for the next page); omit `server` to paginate through every page of every server automatically.
- `list_mcp_resource_templates`: lists URI templates, using the same `server` and `cursor` pagination rules.
- `read_mcp_resource`: reads a resource by `server` and `uri`. Text and images reach the model directly; other binary content is saved to a temporary file.

These tools cover enabled, non-hidden resource servers. Their exposure equals the widest exposure among those servers, using the priority order `direct` > `codemode` > `deferred` > `hidden`. Resource links inside tool results identify the server and `read_mcp_resource`.

MCP Apps resources (`ui://` URIs or `text/html;profile=mcp-app`) are omitted because Atomic does not render interactive web UIs inside the terminal.

## Authentication

For a remote OAuth server, configure its `url` and run `/mcp login my-server`, or choose **Sign in** in `/mcp`. Atomic opens the authorization page and prints a clickable URL. If your browser runs on another machine, paste the full redirect URL into the waiting sign-in prompt. Press `Esc` to cancel at any step; authorization-server requests time out after 15 seconds. Treat authorization and redirect URLs as sensitive.

Atomic registers OAuth clients as `atomic`, stores tokens in `~/.atomic/agent/mcp-auth.json`, and refreshes access tokens proactively 30 seconds before expiry (or when rejected). A successful sign-in reconnects the server. If a server requests extra scopes later, sign in again. Run `/mcp logout my-server` or `atomic mcp logout my-server` to delete stored credentials.

Credentials are keyed by server name and URL. Two server entries with the same URL under different names (such as separate accounts) sign in independently; entries with the same name and URL across global and project `mcp.json` files share one sign-in.

OAuth applies to HTTP servers that do not set an `Authorization` header or `auth.provider`. For a pre-registered OAuth client:

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
- `callbackPort` must be between `1` and `65535` and uses `http://127.0.0.1:<port>/callback`.
- `callbackUrl` lets you specify another registered redirect URI. It must use HTTP on `localhost`, `127.0.0.1`, or `[::1]` and must not include a query string (`?`) or fragment (`#`). If `callbackUrl` omits a port, Atomic adds `callbackPort` or picks a free port. If both `callbackUrl` (with an explicit port) and `callbackPort` are set, their ports must match or validation fails.
- When pasting a redirect URL manually, keep its scheme, host, port, and path unchanged. Atomic rejects URLs that do not match the active sign-in's redirect URI, even when the authorization code and state are valid.
- Use `oauth.clientName` when a server requires a specific client registration name (sign out before signing in again after changing it). Use `oauth.scope` for servers that do not advertise required scopes; later scope requests are merged with it.

### Override OAuth authorization server discovery

If an MCP server advertises the wrong authorization server or none at all, set `oauth.authServerMetadataUrl` to a trusted RFC 8414 or OpenID Connect metadata document:

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

Atomic uses that document instead of running authorization server discovery and trusts its configured issuer. Point it only at a metadata URL you trust. The URL must use HTTPS, except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`.

Atomic rejects authorization responses whose `iss` names another issuer before exchanging the code. When a server advertises RFC 9207 issuer parameter support, the response must include `iss`. An empty refresh token does not overwrite a stored refresh token, and a missing or null `expires_in` value does not expire the access token immediately.

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

Atomic reads the current provider token on every request and never copies it into `mcp-auth.json`. If the token is missing or rejected, run `/login <provider>` and retry.

`atomic mcp list` also sends the provider token, refreshes expired logins, and prompts with `/login <provider>` if sign-in is required. `atomic mcp login` and `atomic mcp logout` do not manage provider logins; use `atomic auth login <provider>` and `atomic auth logout <provider>` instead.

Provider-token authentication enforces these restrictions:

- Accepted only from user-level `~/.atomic/agent/mcp.json` and extension registrations, never from project `.atomic/mcp.json` or package manifests.
- Requires HTTPS, except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
- Sends tokens only to the server's configured origin. Atomic follows same-origin `301`, `302`, `303`, `307`, and `308` redirects up to 10 hops (rewriting `POST` to `GET` on `301` and `302`, and non-`HEAD` requests to `GET` on `303`). Cross-origin redirects are rejected.

## Supported configuration and limits

- Atomic reads only `~/.atomic/agent/mcp.json`, trusted `.atomic/mcp.json`, and package or extension contributions. External MCP client config files and third-party credential stores are not imported.
- Supported transports are stdio and streamable HTTP. SSE endpoints and MCP Apps (`ui://`) rendering are not supported.
- All enabled servers connect in the background, register tools under `mcp__<server>__<tool>`, and default to `codemode` exposure.

## Troubleshooting

- **Inspect logs and stderr.** Check `~/.atomic/agent/mcp.log` for full connection and protocol logs, or run `/mcp` to inspect connection errors, server tools, and the tail of a failed stdio server's stderr.
- **Reload after config edits.** Run `/reload` or restart Atomic after editing `mcp.json`. Use `/mcp reconnect my-server` to reconnect and refresh tools.
- **Missing tools.** Check both server-level `exposure` and per-tool `toolExposure`. `hidden` tools cannot be called; `codemode` and `deferred` tools need codemode or `tool_search` enabled.
- **OAuth redirect failures.** Verify `callbackPort` and `callbackUrl` match the registered redirect URI with no query string or fragment. Over SSH, paste the complete redirected URL into the waiting sign-in prompt.
- **Temporary authorization server outage.** Stored tokens stay intact and Atomic retries automatically; run `/mcp reconnect my-server` once the authorization server recovers. You are asked to sign in again only when credentials are rejected or revoked.
- **Issuer mismatch.** Verify the authorization server's metadata and callback configuration before retrying rather than bypassing issuer validation.
- **Slow tool calls.** Increase `timeout` (in seconds). Server progress notifications reset this inactivity timer.
