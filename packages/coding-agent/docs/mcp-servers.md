---
title: "MCP Servers"
description: "Configure MCP servers, discover tools, and authenticate connections."
---

# MCP Servers

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

Remote `url` values support `${VAR}` and `$env:VAR` environment variable interpolation in both project and user configuration. For example, commit this server entry and set `MY_SERVICE_URL` and `MY_SERVICE_TOKEN` in the environment that launches Atomic:

```json
{ "url": "${MY_SERVICE_URL}/mcp", "auth": "bearer", "bearerTokenEnv": "MY_SERVICE_TOKEN" }
```

With `MY_SERVICE_URL=https://example.com`, the endpoint is `https://example.com/mcp`. Unset variables become empty strings.

The resolved endpoint must be a non-empty HTTP(S) URL. If Atomic reports a configuration error before connecting, check the variables in its environment and the URL suffix. Restart Atomic after changing its environment.

Atomic reads configuration in this order, with later files overriding earlier settings:

1. `~/.config/mcp/mcp.json`, shared user-global configuration.
2. `~/.atomic/agent/mcp.json`, Atomic user-global overrides.
3. `.mcp.json`, shared project configuration.
4. `.atomic/mcp.json`, Atomic project overrides.

The Atomic agent directory can be relocated with `ATOMIC_CODING_AGENT_DIR`. Use `/mcp setup` to inspect detected configuration and preview imports from other hosts before writing changes.

Servers connect lazily by default. Adding a server does not require an immediate connection at startup.

## Servers from packages and extensions

Installed [packages](/packages/authoring#mcp-servers) and extensions can contribute MCP servers. Contributed servers sit below all four configuration files: a server with the same name in any of them replaces the contributed entry completely. To turn a contributed server off, give its name an entry with only `disabled`:

```json
{
  "mcpServers": {
    "acme-search": { "disabled": true }
  }
}
```

`"disabled": true` removes any server from the effective configuration, contributed or not.

`/mcp` shows where each contributed server came from next to its name: `(package npm:@acme/tools)` for a package manifest, `(extension from package npm:@acme/tools)` for a package's extension, or `(extension /path/to/extension.ts)` for a local extension. Connection errors name the same source. Turning on direct tools for a contributed server in `/mcp` copies its definition into `~/.atomic/agent/mcp.json`, where it then overrides the contributed version.

To choose which servers one package contributes, add `mcpServers` patterns to its [package filter](/packages/reference#package-filtering). Project packages contribute servers only after the project is trusted. Workflow stages see the same contributed servers as the session that starts them.

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

In a headless SDK session, cached direct tools are available at startup, but discovery does not connect uncached lazy servers. Call the `mcp` gateway when you need them. Set the server's `lifecycle` to `"eager"` or `"keep-alive"` if it must connect during startup.

## Authentication

For an OAuth server, run `/mcp-auth my-server` in an interactive session. You can also select the server in `/mcp` and press Enter or `Ctrl+A`. Run `/mcp logout my-server` to remove stored OAuth credentials and disconnect.

Automatic OAuth is opt-in through `settings.autoAuth`. Browser-based authorization requires an interactive session; authenticate before running unattended work.

## Troubleshooting

- Run `/mcp` to check server status and `/mcp tools` to list available tools.
- After editing configuration manually, restart Atomic to load it. Use `/mcp reconnect my-server` to reconnect a configured server and refresh its tools.
- If Atomic cannot open the authorization browser, use the complete URL it displays for manual login. **Treat it as sensitive**: it includes all paths, parameters, and any credentials. Login instructions are not redacted; transport and RPC error diagnostics are.
  Browser-launch failure cancels the pending attempt, so its callback cannot complete authentication. Check your default browser and retry `/mcp-auth my-server`.
- If a local server cannot start, check its executable, arguments, working directory, and required environment variables. Server configuration supports `cwd` and `env`.
- If authorization fails, run `/mcp-auth my-server` again. Check the remote server's URL and authentication requirements.
- For slow tools, a server's `timeoutMs` controls the inactivity timeout. Progress notifications reset it; it is not a total execution deadline.

## Local documentation

This guide is available at `docs/mcp-servers.md` under Atomic's installation root in both npm and binary installations. The session's documentation instructions provide the absolute docs directory. Read this guide there rather than looking inside the bundled extension directory.
