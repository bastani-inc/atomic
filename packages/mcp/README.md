# @bastani/mcp

Atomic's bundled [Model Context Protocol](https://modelcontextprotocol.io) support connects to servers over stdio and streamable HTTP. It provides an interactive manager, shell commands, OAuth, codemode and deferred tool discovery, direct tools, and standard resource tools. No separate installation is needed with Atomic.

See the [MCP servers guide](https://docs.bastani.ai/mcp-servers) for full configuration details and [OAuth](OAUTH.md) for authentication troubleshooting.

## Quick setup

```bash
atomic mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
atomic mcp add docs --url https://example.com/mcp
atomic mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-token-env-var GITHUB_TOKEN
atomic mcp list
atomic
```

Commands write `~/.atomic/agent/mcp.json` by default. Add `--local` (`-l`) to use `.atomic/mcp.json` in the current project. Project servers are read only after [project trust](https://docs.bastani.ai/security) is granted. A project entry defining `command`, `url`, or `type` replaces a user-level entry of the same name. A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure` while inheriting the user-level server's connection and credentials.

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

Pass `--no-mcp` to disable built-in MCP support for one run.

## Commands

Run `/mcp` to inspect connection state, tools, exposure, source, and errors. Select a server to sign in or out, reconnect, change exposure, or enable and disable it. File-backed changes save to the defining file; extension-server changes apply only to the current session. Run `/reload` or restart Atomic after editing configuration files outside the session.

| Session command | Action |
| --- | --- |
| `/mcp` | Open the manager, or show status outside the TUI. |
| `/mcp login [server]` | Sign in with OAuth. |
| `/mcp logout [server]` | Remove stored OAuth credentials. |
| `/mcp reconnect [server]` | Reconnect one server and refresh tools. |

Tab completion suggests actions and eligible server names. Omitting the server name selects an eligible server when unambiguous or opens a picker. Session login requires an interactive UI. If your browser runs on another machine, paste its complete redirected URL into the waiting sign-in prompt.

Shell commands work without starting a session and do not load extensions:

```bash
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [-l] [--timeout <seconds>]
atomic mcp logout <server> [-l]
```

Common `atomic mcp add` options include `-l`/`--local`, `--env KEY=VALUE`, `--cwd <dir>`, `--header "Name: Value"`, `--bearer-token-env-var <VAR>`, `--oauth-*` flags, `--exposure <mode>`, and `--description <text>`.

`list` connects to enabled servers and exits with status 1 if any entry is invalid or any enabled server fails to connect. Shell login opens the browser and waits up to 300 seconds by default. Run `atomic mcp --help` for every option.

## Configuration

Stdio servers use `command`, `args`, `env`, and `cwd`. HTTP servers use `url`, `headers`, and `oauth`. Set optional `type` to `"stdio"`, `"http"`, or `"streamable-http"` when you want to make the transport explicit.

URLs support `${NAME}` and `$env:NAME` environment references, resolved in memory before validation without rewriting files. `env`, `headers`, and `oauth.clientSecret` support `${NAME}` references and whole-value `!command` expressions. Escape literal `$` as `$$` and a leading literal `!` as `$!`. Only use `!command` expressions in configuration you trust ([Security](https://docs.bastani.ai/security)).

| Setting | Meaning |
| --- | --- |
| `type` | Optional explicit transport: `stdio`, `http`, or `streamable-http`. |
| `description` | Short summary used in discovery and the system prompt. |
| `timeout` | Inactivity timeout in seconds (default `60`). Progress updates reset it. |
| `enabled: false` | Keep the server listed without connecting. |
| `exposure` | `codemode` (default), `codemode-deferred`, `deferred`, `direct`, or `hidden`. |
| `toolExposure` | Per-tool overrides using exact tool names or `*` patterns. |

Package and extension contributions use the same server shape and sit below file-configured servers. `ATOMIC_CODING_AGENT_DIR` relocates the Atomic agent directory.

Extensions can register runtime-computed servers with [`atomic.registerMcpServer()`](https://docs.bastani.ai/extensions/api-reference#atomic-registermcpserver-name-config):

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (atomic: ExtensionAPI) {
	atomic.registerMcpServer("local-docs", {
		url: "http://127.0.0.1:4321/mcp",
		exposure: "codemode",
		description: "Local documentation server",
	});
}
```

## Tools and resources

Tools use names such as `mcp__github__search_code`. Collisions after identifier normalization receive deterministic hash suffixes. Call names returned by discovery instead of constructing them manually.

The default exposure is [`codemode`](https://docs.bastani.ai/codemode): scripts discover tools through `searchTools()`, `describeTool()`, and `ALL_TOOLS`, then call them. `deferred` tools become declared after `tool_search` loads a match (`codemode-deferred` is accepted as an alias). `direct` tools are declared immediately; `hidden` tools are unreachable. `toolExposure` overrides the server's default. Exact names win over patterns, and among patterns the first match wins.

Atomic activates `codemode` automatically for codemode servers and `tool_search` for deferred servers. An explicit `-codemode` in `defaultTools` or `--tools` prevents MCP from activating codemode; omission from a plain `defaultTools` list does not. Set `"autoEnableCodemode": false` beside `mcpServers` to disable automatic activation without removing codemode from the defaults. A project value overrides the user-level value. Scripts read server instructions with `describeNamespace("mcp__github")`:

```typescript
const server = await describeNamespace("mcp__github");
const matches = await searchTools("search code", { namespace: "mcp__github", limit: 5 });

if (server && matches.length > 0) {
	const result = await tools.mcp__github__search_code({ q: "registerMcpServer" });
	text(result);
}
```

Enabled servers connect in the background. The first prompt waits up to 10 seconds for direct-tool servers. Discovery and calls wait for the servers they need. Dropped connections reconnect on the next call, and tool-list notifications refresh registrations automatically.

The resource tools are `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`. They reach enabled, non-hidden resource servers. Text and image resources return directly; other binary content is saved to temporary files.

MCP calls pass through Atomic's tool-call hooks, including nested calls from codemode. Scripts receive the full MCP result. Model-facing text over 20 KB is truncated, with the full output saved to a temporary file named in the result.

## Authentication

Run `/mcp login <server>`, choose **Sign in** in `/mcp`, or run `atomic mcp login <server>`. HTTP servers without an `Authorization` header or provider-token configuration use OAuth when challenged. Atomic registers as `atomic` and stores credentials in `~/.atomic/agent/mcp-auth.json`.

OAuth options include `clientId`, `clientSecret`, `scope`, `clientName`, `callbackPort`, `callbackUrl`, and `authServerMetadataUrl`. See [OAuth](OAUTH.md) for examples and troubleshooting.

An HTTP server can alternatively set `"auth": { "provider": "openrouter" }` to reuse the active `/login openrouter` token (or any other built-in provider token). This option is allowed only in global configuration and extension registrations, never in project files or package manifests. HTTPS is required except on loopback hosts, and credentials are sent only to the configured origin.

## Supported transports and limits

Atomic reads `~/.atomic/agent/mcp.json` and trusted `.atomic/mcp.json` files and connects over stdio and streamable HTTP. Legacy HTTP SSE transport and MCP Apps UI resource rendering are not supported.

## License

MIT. See [LICENSE](LICENSE).
