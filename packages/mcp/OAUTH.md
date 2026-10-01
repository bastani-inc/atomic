# MCP OAuth authentication

Atomic supports OAuth authorization-code login with PKCE, authorization server discovery, dynamic client registration, and token refresh for HTTP MCP servers. Most servers need only a URL:

```json
{ "mcpServers": { "sentry": { "url": "https://mcp.sentry.dev/mcp" } } }
```

OAuth applies when the server has no static `Authorization` header or provider-token configuration. Keep personal credentials in user-global configuration, not shared project files.

## Sign in and out

Run `/mcp login sentry`, select the server in `/mcp` and choose **Sign in**, or run `atomic mcp login sentry` from a shell. Session commands without a name choose an eligible server when unambiguous or ask you to select one; shell commands require a server name.

Atomic opens the browser and displays a clickable authorization URL. Approve access in the browser. If it runs on another machine, such as an SSH client, paste the complete URL it was redirected to into Atomic's waiting sign-in prompt. Atomic validates the state and issuer before exchanging the code. Treat both authorization and redirect URLs as sensitive.

Successful login reconnects the server. Session login requires an interactive UI; shell login opens the browser without starting a session. Sign in before unattended work. Shell login waits up to 300 seconds by default; use `--timeout <seconds>` to change that budget. A running session uses new credentials on its next turn. If a server requests additional scope later, sign in again.

Run `/mcp logout sentry` or `atomic mcp logout sentry` to delete its stored credentials. Signing out is also available in the manager.

## Pre-registered clients

For servers without dynamic client registration:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "registered-client",
        "clientSecret": "${EXAMPLE_SECRET}",
        "callbackPort": 8765,
        "scope": "read write"
      }
    }
  }
}
```

`clientSecret` is optional. It can reference an environment variable or use a whole-value `!command` expression. The redirect URI must match the client's registration.

| Option | Meaning |
| --- | --- |
| `clientId` | Pre-registered client ID. Omit it for dynamic registration. |
| `clientSecret` | Optional secret for a confidential client. |
| `scope` | Space-separated scopes when the server does not advertise them. Later requests are added to this value. |
| `clientName` | Dynamic registration name, default `atomic`. Sign out before registering under a changed name. |
| `callbackPort` | Port for `http://127.0.0.1:<port>/callback`. |
| `callbackUrl` | Another registered loopback redirect URI. |
| `authServerMetadataUrl` | Trusted authorization server metadata document to use instead of discovery. |

`callbackUrl` must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`, without query or fragment. Atomic sends it as written. If it omits a port, Atomic adds `callbackPort` or a free port, as allowed for loopback redirects by RFC 8252. Use a fixed port when the client registration requires an exact URI.

## Override authorization server discovery

Atomic normally finds the authorization server through protected resource metadata and checks its metadata issuer. If a server advertises the wrong authorization server or none, configure the correct metadata document:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration"
      }
    }
  }
}
```

The document may use RFC 8414 or OpenID Connect discovery. Atomic trusts it as configured, including its issuer, so only point it at a document you trust. The URL must use HTTPS except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`.

An authorization response's `iss` must name the flow's authorization server. If the metadata promises `authorization_response_iss_parameter_supported`, the response must include `iss`. Mismatched or required-but-missing issuers are rejected before code exchange under RFC 9207. Pasted redirect URLs have the same checks as browser callbacks.

## Tokens and refresh

Credentials are stored in `~/.atomic/agent/mcp-auth.json`, keyed by server URL. `ATOMIC_CODING_AGENT_DIR` relocates the agent directory. Tokens refresh when expired or rejected, and signing out removes the stored credentials.

Optional OAuth response fields that are empty or null count as absent, including `scope`, `refresh_token`, `id_token`, and `client_secret`. A refresh response with no new refresh token keeps the previous one. `expires_in: null` does not immediately expire an access token. Empty scope values fall through to the next scope source.

Old adapter credential files are not imported. Sign in through `/mcp login <server>` or `atomic mcp login <server>` to authorize the native client.

## Use a provider login instead

A server can use a provider token instead of MCP OAuth:

```json
{ "mcpServers": { "radius": { "url": "https://radius.example/mcp", "auth": { "provider": "radius" } } } }
```

Run `/login radius`, then retry the MCP call. Atomic reads the current token for every request and does not copy it into MCP credential storage.

This setting is accepted only in global configuration and extension registrations, not project files or package manifests. HTTPS is required except on exact loopback hosts. Tokens go only to the server's configured origin; only same-origin `307` and `308` redirects are followed.

## Troubleshooting

- **Sign-in required:** run `/mcp login <server>` before unattended calls.
- **Dynamic registration unavailable:** obtain a client ID from the provider and configure `oauth.clientId`.
- **Redirect mismatch or callback port busy:** compare `callbackPort` and `callbackUrl` with the registered URI. Free its port or update the registration.
- **Browser cannot reach Atomic:** paste the complete redirected URL into the waiting sign-in prompt.
- **Wrong authorization page:** check server metadata, then use `authServerMetadataUrl` only if you know the correct trusted document.
- **Issuer mismatch:** check the authorization server's metadata and callback behavior. Do not accept an unexpected issuer to bypass the failure.
- **Provider token missing or rejected:** run `/login <provider>` and retry.

For configuration, tool exposure, and connection diagnostics, see [MCP servers](../coding-agent/docs/mcp-servers.md).

## References

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [PKCE, RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)
- [Dynamic client registration, RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)
- [Authorization server metadata, RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)
- [Authorization response issuer, RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207)
- [Protected resource metadata, RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)
