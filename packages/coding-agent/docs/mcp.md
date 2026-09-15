# MCP servers

Atomic includes MCP support in both npm and binary installations. No separate extension install is needed. Use `/mcp` to inspect servers or `/mcp setup` to configure them.

## Configure a server

Put shared project configuration in `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "path/to/mcp-server",
      "args": []
    }
  }
}
```

Replace `command` and `args` with your server's launch instructions. For a remote HTTP server, use `url` instead:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Atomic reads configuration in this order, with later files overriding earlier settings:

1. `~/.config/mcp/mcp.json`, shared user-global configuration.
2. `~/.atomic/agent/mcp.json`, Atomic user-global overrides.
3. `.mcp.json`, shared project configuration.
4. `.atomic/mcp.json`, Atomic project overrides.

The Atomic agent directory can be relocated with `ATOMIC_CODING_AGENT_DIR`. Use `/mcp setup` to inspect detected configuration and preview imports from other hosts before writing changes.

Servers connect lazily by default. Adding a server does not require an immediate connection at startup.

## Find and call tools

The `mcp` gateway discovers tools without adding every server's full tool definitions to the session:

```js
mcp({ server: "my-server" })
mcp({ search: "search" })
mcp({ describe: "my_server_search" })
mcp({ tool: "my_server_search", args: '{"query":"example"}' })
```

Use the tool names returned by discovery. `args` is a JSON string, not an object. Search may connect configured servers when their metadata has not yet been cached.

To expose a server's tools directly in the agent's tool list, add `"directTools": true` to that server's configuration. To expose only selected tools, set `directTools` to an array of the original MCP tool names. The default is gateway-only access.

## Authentication

For an OAuth server, run `/mcp-auth my-server` in an interactive session. You can also select the server in `/mcp` and press Enter or `Ctrl+A`. Run `/mcp logout my-server` to remove stored OAuth credentials and disconnect.

Automatic OAuth is opt-in through `settings.autoAuth`. Browser-based authorization requires an interactive session; authenticate before running unattended work.

## Troubleshooting

- Run `/mcp` to check server status and `/mcp tools` to list available tools.
- After editing configuration manually, restart Atomic to load it. Use `/mcp reconnect my-server` to reconnect a configured server and refresh its tools.
- If a local server cannot start, check its executable, arguments, working directory, and required environment variables. Server configuration supports `cwd` and `env`.
- If authorization fails, run `/mcp-auth my-server` again. Check the remote server's URL and authentication requirements.
- For slow tools, a server's `timeoutMs` controls the inactivity timeout. Progress notifications reset it; it is not a total execution deadline.

## Local documentation

This guide is available at `docs/mcp.md` under Atomic's installation root in both npm and binary installations. The session's documentation instructions provide the absolute docs directory. Read this guide there rather than looking inside the bundled extension directory.
