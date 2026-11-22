---
title: "MCP Servers"
description: "Configure MCP servers, discover tools and resources, and authenticate connections."
---

# MCP Servers

Atomic includes [Model Context Protocol](https://modelcontextprotocol.io) support in npm and binary installations. It connects to servers over stdio or streamable HTTP. No separate extension install is needed.

## Quick setup

Add a local server, check the connection, then start Atomic:

```sh
atomic mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
atomic mcp list
atomic
```

For a remote server:

```sh
atomic mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
```

Commands write user-level configuration by default. Add `--local` or `-l` to write `.atomic/mcp.json` in the current project instead. Start Atomic and grant project trust before using project servers.

Use `/mcp` to inspect connections and manage servers. After changing configuration outside the session, run `/reload` or restart Atomic.

## Configure servers

Atomic reads user-level servers from `~/.atomic/agent/mcp.json` and project servers from `.atomic/mcp.json`. Project configuration is read only after [project trust](/security) is granted. A project entry replaces a user-level entry with the same name.

A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure` of the user-level server with the same name and keeps the rest, including `env`, `headers`, and `auth`. For example, this turns off a user-level server in one project:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

Both files use a top-level `mcpServers` object. Keep personal servers and credentials in the user-level file. `ATOMIC_CODING_AGENT_DIR` relocates the Atomic agent directory.

Stdio servers use `command`, `args`, `env`, and `cwd`. `command` is one executable, not a shell command string. A `command` with a path runs as written; one named without a path is looked up in the absolute directories on `PATH` from `env`, and on Windows first in `cwd` when that lies outside the project folder (the project folder counts only when `PATH` names it).

On Windows, variables in `env` (such as `PATH`) replace inherited variables case-insensitively (for example overriding `Path`) both when locating `command` and inside the spawned server. A `command` found nowhere fails with `spawn <command> ENOENT`. Relative `cwd` values resolve against the session directory.

HTTP servers use `url`, optional `headers`, and optional `oauth`. For bearer authentication:

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

URLs support `${NAME}` and `$env:NAME` environment references. Atomic resolves them in memory before validating the URL, without rewriting configuration files. `env`, `headers`, and `oauth.clientSecret` support `${NAME}` environment references and whole-value `!command` expressions, for example `"Authorization": "!echo Bearer $(gh auth token)"`. Only use commands from configuration you trust. Use `$$` for a literal `$` and `$!` for a literal `!`. When resolution fails, Atomic never echoes `!command` text; braced `${NAME}` references report the unset variable name, while unbraced `$NAME` references report the name only when it reads like a POSIX environment variable name so literal secrets containing `$` do not leak fragments.

Both transports support:

- `timeout`: per-request inactivity timeout in seconds, default 60. Progress notifications reset it; it is not a total execution deadline.
- `enabled: false`: keep a server listed without connecting to it.
- `exposure` and `toolExposure`: control how tools reach the model.
- `description`: a short server summary for the system prompt, tool search, and `describeNamespace()`. Without it, Atomic uses the first line of server instructions once connected.

Server names may contain letters, digits, `_`, and `-`. Names that differ only in `-` and `_` identify the same namespace. Invalid entries are reported and skipped without preventing other servers from connecting.

`type` is optional: `command` selects stdio and `url` selects streamable HTTP. If present, it must be `stdio`, `http`, or `streamable-http`. SSE is not supported; use the server's streamable HTTP endpoint, commonly `/mcp` rather than `/sse`.

### Servers from packages and extensions

Installed [packages](/packages/authoring#mcp-servers) and extensions can contribute servers with the same configuration shape. File-configured servers take precedence over contributions with the same normalized name. Project packages load only after the project is trusted.

`/mcp` shows each server's source. Enabled-state and exposure changes for file-configured servers are saved without replacing unrelated configuration. In a trusted project, "Enable in this project" and "Disable in this project" add a project override for a user-level server; later changes to that server are saved to the override. `atomic mcp list` shows the override. Changes to extension-contributed servers apply to the current session.

## Manage servers

`/mcp` is the single slash command for managing MCP servers. Run `/mcp` to open the server manager with connection state, tool count, exposure, and source, even while startup connections are still pending.

Select a server to inspect tools and details, sign in or out, reconnect, enable or disable it, or change exposure. Servers needing attention appear first. Enable, disable, and reconnect run in the background while the manager updates live, so you can keep navigating or close it. Use `↑`/`↓` to select, `Enter` to open, `Esc` to go back, and type to filter lists longer than one screen.

| Command | Action |
| --- | --- |
| `/mcp` | Open the manager in the TUI, or show status outside it. |
| `/mcp login [server]` | Sign in with OAuth. |
| `/mcp logout [server]` | Remove stored OAuth credentials. |
| `/mcp reconnect [server]` | Reconnect a server and refresh its tools. |

Command completion suggests subcommands and eligible server names. When a server name is omitted, Atomic selects an eligible server if only one matches; otherwise it asks you to choose. Session login requires an interactive UI; run `atomic mcp login` in your shell before unattended work.

Enabled servers connect in the background at session startup. The first prompt waits up to 10 seconds for servers with `direct` tools, while codemode, tool search, and resource calls wait for the servers they need. Dropped connections reconnect on the next call, and server-announced tool changes take effect automatically.

When you resume a session, its previously used MCP tools stay available and keep their system-prompt summaries while servers reconnect, provided the server stays defined in the same scope with the same command and `cwd` (or same URL scheme, host, port, and path; argument and query changes do not invalidate it). Calls wait for reconnect and run only if the tool still exists. Tools from servers that fail to reconnect, require sign-in, or withdrew them update on the next turn.

### Shell commands

Shell commands operate on file-configured servers and do not load extensions:

```sh
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [-l] [--timeout <seconds>]
atomic mcp logout <server> [-l]
```

`add` replaces an existing entry with the same name. `add` and `remove` accept `--local` (`-l`) to write `.atomic/mcp.json`; `login` and `logout` accept `-l` to require a project-defined server (otherwise they search both files).

For stdio servers, pass repeatable `--env KEY=VALUE` and `--cwd`. For HTTP servers, pass repeatable `--header KEY=VALUE`, `--bearer-token-env-var NAME`, and `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, or `--oauth-client-name`. Both transports accept `--exposure` and `--description`. Passing `--help` or `-h` after `--` (for example `atomic mcp add srv -- cmd --help`) or as the value of a value-taking flag passes through to the command or option instead of printing MCP help. Run `atomic mcp --help` for full usage.

`list` connects to enabled servers and reports state, tools, and errors, exiting `1` on invalid config or any disconnected enabled server. Pass `--json` for machine-readable output. `login` times out after 300 seconds by default (`--timeout` caps the entire sign-in, including authorization-server requests, not MCP server request timeouts). Running sessions pick up new credentials on their next turn.

Resource-capable servers show "offers resources" rather than resource counts. In `--json` output, `resources: true` indicates resource support; resource and template counts are not included. Use the resource tools below to list them on demand.

## Find and call tools

Tools are named `mcp__<server>__<tool>`, with punctuation replaced by `_`. Names that collide after normalization receive deterministic hash suffixes. Use names returned by discovery rather than constructing them yourself.

### Control tool exposure

| Exposure | Behavior |
| --- | --- |
| `codemode`, the default | Callable from codemode scripts, but not declared to the model or listed in the codemode description. Discover with `searchTools()`, `describeTool()`, or `ALL_TOOLS`. |
| `deferred` | Not declared until `tool_search` loads a matching tool for the next model call. |
| `direct` | Declared like a built-in tool and also callable from codemode. |
| `hidden` | Unreachable. |

`codemode-deferred` is accepted as an alias for `codemode`. Atomic activates `codemode` for codemode servers and `tool_search` for deferred servers. An explicit `-codemode` in `defaultTools` or `--tools` takes precedence: MCP leaves it off. Merely omitting it from a `defaultTools` list does not prevent MCP activation. Set `"autoEnableCodemode": false` beside `mcpServers` to disable MCP's automatic activation without removing codemode from the ordinary defaults. A project value overrides a user-level value.

`toolExposure` overrides individual tools. Keys are original server tool names or patterns where `*` matches any characters. Exact names win; among patterns, the first match wins:

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

Codemode and deferred tools can be reached through either indirect mechanism. Server summaries appear in the `mcp_servers` system prompt section. Scripts can read instructions and tool names with `describeNamespace("mcp__github")`.

`--tools` keeps MCP tools unless an entry starts with `mcp__`. For example, `atomic --tools read,codemode` can still call non-hidden MCP tools with codemode or deferred exposure from scripts, but unmatched MCP tools are not declared directly. Unmatched direct-exposure tools remain registered but inactive. Include `tool_search` to load unmatched tools with non-direct exposure. To restrict the server tools, use `atomic --tools read,codemode,'mcp__docs__*'`. `--exclude-tools` accepts the same `*` patterns and also applies to MCP resource tools.

`--no-mcp` disables built-in MCP support for one run. No built-in servers connect, MCP tools load, or `/mcp` command registers. A replacement extension is unaffected.

Codemode receives the complete MCP result, including `content`, `structuredContent`, and `isError`. Text over 20 KB is shortened for the model, with the complete text saved to a temporary file named in the result. Every MCP call passes through Atomic's tool pipeline, including permission hooks.

## Use resources

When a connected server offers resources, Atomic registers:

- `list_mcp_resources`, to list resources. Use `server` for one server and `cursor` for its next page; without `server`, it lists resources across servers.
- `list_mcp_resource_templates`, to list URI templates.
- `read_mcp_resource`, to read by `server` and `uri`. Text and images reach the model directly; other binary content is saved to a temporary file.

These tools reach enabled, non-hidden resource servers. Their exposure is the widest exposure among those servers. Resource links in tool results identify the server and `read_mcp_resource`.

MCP Apps resources (`ui://` URIs or `text/html;profile=mcp-app`) are omitted because Atomic does not render them.

## Authentication

For a remote OAuth server, configure its URL and run `/mcp login my-server`, or select **Sign in** in `/mcp`. Atomic opens the authorization page and displays a clickable URL. If the browser runs on another machine, paste the complete URL it was redirected to into the sign-in prompt. Press Esc to cancel a sign-in at any step; requests to the authorization server time out after 15 seconds. Treat authorization and redirect URLs as sensitive.

Atomic registers OAuth clients as `atomic`, stores credentials in `~/.atomic/agent/mcp-auth.json`, and refreshes tokens when they expire or are rejected. A successful sign-in reconnects the server. If additional scope is required, sign in again. `/mcp logout my-server` or `atomic mcp logout my-server` deletes stored credentials. Old adapter credential files are not imported; sign in through the native client.

Credentials belong to a server name and URL. Servers with the same URL under different names, such as one per account, sign in separately; servers with the same name and URL in different `mcp.json` files share one sign-in.

OAuth applies to HTTP servers without an `Authorization` header or provider-token configuration. For a pre-registered client:

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

`clientSecret` is optional. `callbackPort` uses `http://127.0.0.1:<port>/callback`. For another registered redirect URI, set `callbackUrl`; it must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Atomic sends it as written. If it has no port, Atomic adds `callbackPort` or a free port. The URI must match the client's registration.

When pasting a redirect URL, keep its scheme, host, port, and path unchanged. Atomic rejects a URL that does not match the redirect URI for the current sign-in, even if its authorization code and state are present.

Use `oauth.clientName` when a server requires a known registration name. Sign out before signing in again to register with a changed name. Use `oauth.scope` for servers that do not advertise their required scopes; later scope requests are added to it.

### Override OAuth authorization server discovery

If a server advertises the wrong authorization server or none, set `oauth.authServerMetadataUrl` to a trusted RFC 8414 or OpenID Connect metadata document:

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

Atomic uses the document instead of authorization server discovery and trusts its issuer as configured. Point it only at a document you trust. The URL must use HTTPS, except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`.

Atomic rejects authorization responses whose `iss` names another issuer, before exchanging the code. If the server promises the RFC 9207 issuer parameter, the response must include it. Empty or null optional token and registration fields count as absent. An empty refresh token does not replace a previously stored one, and `expires_in: null` does not immediately expire the access token.

### Authenticate with a provider login

An HTTP server can use your current provider login token instead of MCP OAuth:

```json
{ "mcpServers": { "gateway": { "url": "https://gateway.example/mcp", "auth": { "provider": "openrouter" } } } }
```

Atomic reads the current token for every request and does not copy it into MCP credential storage. If the token is missing or rejected, run `/login <provider>` and retry the MCP call.

`atomic mcp list` also sends the provider token, refreshing an expired login, and its sign-in hint names `/login <provider>`. `atomic mcp login` and `atomic mcp logout` do not apply to these servers; they point to `atomic auth login <provider>` and `atomic auth logout <provider>`.

Because the credential goes to the configured server, provider-token authentication has these limits:

- It is accepted only from global configuration and extension registrations, not project configuration or package manifests.
- The URL must use HTTPS, except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
- Tokens are sent only to the server's origin. Only same-origin `307` and `308` redirects are followed.

## Native configuration only

The old adapter has been replaced by the native client. Only `~/.atomic/agent/mcp.json` and trusted `.atomic/mcp.json` files are read; shared configuration files and client imports are not supported. Use the native fields documented above. Old adapter fields are not translated, and old OAuth credential files are not imported.

Tools use `mcp__<server>__<tool>` names and default to `codemode` exposure. The old gateway tool, configurable prefixes, lazy/idle lifecycle settings, metadata cache, SSE transport, MCP Apps rendering, and setup command are not available. All enabled servers connect in the background.

## Troubleshooting

- Run `/mcp` to inspect connection errors, server tools, and the tail of a failed stdio server's stderr.
- After editing configuration, run `/reload` or restart Atomic. Use `/mcp reconnect my-server` to retry a connection and refresh tools.
- For a missing tool, check server and per-tool exposure. `hidden` tools cannot be called; codemode or deferred tools need an active discovery tool.
- For OAuth redirect failures, check `callbackPort` and `callbackUrl` against the registered URI. Over SSH, paste the complete redirected URL into the waiting sign-in prompt.
- If `/mcp` shows a server as failed because its authorization server is temporarily unavailable, your sign-in is still valid. Atomic keeps the stored tokens and retries a few times; run `/mcp reconnect my-server` once the authorization server is back. Only a rejected or revoked sign-in asks you to sign in again.
- For an issuer mismatch, check the authorization server's metadata and callback configuration before retrying. Do not disable issuer checks to accept an unexpected response.
- For slow calls, adjust `timeout` in seconds. Progress resets this inactivity timer.

## Local documentation

This guide ships at `docs/mcp-servers.md` under Atomic's installation root in npm and binary installations.
