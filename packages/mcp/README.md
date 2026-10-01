# Atomic MCP

Atomic's bundled [Model Context Protocol](https://modelcontextprotocol.io) support connects to servers over stdio and streamable HTTP. It provides a server manager, shell commands, OAuth, codemode and deferred tool discovery, direct tools, and standard resource tools. No separate installation is needed with Atomic.

See the [MCP servers guide](../coding-agent/docs/mcp-servers.md) for configuration and [OAuth](OAUTH.md) for authentication.

## Quick setup

```sh
atomic mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
atomic mcp add docs --url https://example.com/mcp
atomic mcp list
atomic
```

Commands write `~/.atomic/agent/mcp.json` by default. Add `--local` (`-l`) to use `.atomic/mcp.json` in the current project. Project servers are read only after project trust is granted; a project entry replaces a user-level entry of the same name.

Both files use this shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "description": "Search and read the product documentation"
    }
  }
}
```

## Commands

Run `/mcp` to inspect connection state, tools, exposure, source, and errors. Select a server to sign in or out, reconnect, change exposure, or enable and disable it. File-backed changes are saved to the defining file; extension-server changes apply only to the session. Run `/reload` or restart Atomic after editing configuration outside the session.

| Session command | Action |
| --- | --- |
| `/mcp` | Open the manager, or show status outside the TUI. |
| `/mcp login [server]` | Sign in with OAuth. |
| `/mcp logout [server]` | Remove stored OAuth credentials. |
| `/mcp reconnect [server]` | Reconnect one server and refresh tools. |

Completion suggests actions and eligible server names. Omitting the name selects an eligible server when unambiguous, otherwise opens a picker. Session login requires an interactive UI. If the browser is on another machine, paste its complete redirected URL into the waiting sign-in prompt.

Shell commands work without a session and do not load extensions:

```sh
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [--timeout <seconds>]
atomic mcp logout <server>
```

`list` connects to enabled servers and exits with status 1 for invalid entries or an enabled server that is not connected. Shell login opens the browser and waits up to 300 seconds by default. Run `atomic mcp --help` for all options.

## Configuration

Stdio uses `command`, `args`, `env`, and `cwd`. HTTP uses `url`, `headers`, and `oauth`. URLs support `${NAME}` and `$env:NAME` environment references, resolved in memory before validation without rewriting files. `env`, `headers`, and `oauth.clientSecret` support `${NAME}` references and whole-value `!command` expressions. Only use commands from configuration you trust.

| Setting | Meaning |
| --- | --- |
| `description` | Short summary used in discovery and the system prompt. |
| `timeout` | Inactivity timeout in seconds, default 60. Progress resets it. |
| `enabled: false` | Keep the server listed without connecting. |
| `exposure` | `codemode`, `deferred`, `direct`, or `hidden`. |
| `toolExposure` | Per-tool overrides, with exact names or `*` patterns. |

Package and extension contributions use the same server shape and sit below file-configured servers. `ATOMIC_CODING_AGENT_DIR` relocates the Atomic agent directory.

## Tools and resources

Tools use names such as `mcp__github__search_code`. Collisions after identifier normalization receive deterministic hash suffixes. Call names returned by discovery instead of constructing them.

The default exposure is `codemode`: scripts discover tools through `searchTools()`, `describeTool()`, and `ALL_TOOLS`, then call them. `deferred` tools become declared after `tool_search` loads a match. `direct` tools are declared immediately; `hidden` tools are unreachable. `toolExposure` overrides the server's default. Exact names win over patterns; among patterns, the first match wins.

Atomic activates codemode for codemode servers and tool search for deferred servers. Set `"autoEnableCodemode": false` beside `mcpServers` to prevent automatic codemode activation. A project value overrides the user-level value. Scripts read server instructions with `describeNamespace("mcp__github")`.

Enabled servers connect in the background. The first prompt waits up to 10 seconds for direct-tool servers. Discovery and calls wait for the servers they need. Dropped connections reconnect on the next call, and tool-list notifications update registrations.

The resource tools are `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`. They reach enabled, non-hidden resource servers. Text and image resources are returned directly; other binary content is saved to temporary files. MCP Apps UI resources are omitted because Atomic does not render them.

MCP calls pass through Atomic's permission pipeline, including nested calls from codemode. Scripts receive the full MCP result. Model-facing text over 20 KB is shortened, with its full text saved to a temporary file named in the result.

## Authentication

Run `/mcp login <server>`, choose **Sign in** in the manager, or run `atomic mcp login <server>`. HTTP servers without an `Authorization` header or provider-token configuration use OAuth when challenged. Atomic registers as `atomic` and stores credentials in `~/.atomic/agent/mcp-auth.json`.

OAuth options include `clientId`, `clientSecret`, `scope`, `clientName`, `callbackPort`, `callbackUrl`, and `authServerMetadataUrl`. See [OAuth](OAUTH.md) for examples and troubleshooting.

An HTTP server may instead set `"auth": { "provider": "radius" }` to use the current `/login radius` token. This is allowed only in global configuration and extension registrations, not project files or package manifests. HTTPS is required except on loopback hosts, and credentials are sent only to the configured origin.

## Native configuration only

The old adapter has been replaced by the native client. Only `~/.atomic/agent/mcp.json` and trusted `.atomic/mcp.json` files are read. Shared configuration files, client imports, old-field translations, and imports of old OAuth credential files are not supported. Sign in through the native client.

The old gateway tool, configurable prefixes, lazy/idle lifecycle settings, metadata cache, SSE transport, MCP Apps rendering, and setup command are no longer available. Use the native configuration, tools, and commands documented above.
