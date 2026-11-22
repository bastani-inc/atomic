---
title: Provider OAuth
description: OAuth login callbacks, credential storage, rejected logins, and dynamic catalog refresh.
---

# Provider OAuth

## OAuth support

Add OAuth or SSO login integrated with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@bastani/atomic-ai";

await pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [],
  oauth: {
    name: "Corporate AI (SSO)",

    async login(callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials> {
      // Option 1: Browser-based OAuth
      callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });

      // Option 2: Device code flow
      callbacks.onDeviceCode({
        userCode: "ABCD-1234",
        verificationUri: "https://sso.corp.com/device"
      });

      // Option 3: Prompt for token/code
      const code = await callbacks.onPrompt({ message: "Enter SSO code:" });

      // Forward `signal` so cancelling /login aborts the in-flight network request.
      const tokens = await exchangeCodeForTokens(code, { signal });

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    async refreshToken(
      credentials: OAuthCredentials,
      signal: AbortSignal
    ): Promise<OAuthCredentials> {
      const tokens = await refreshAccessToken(credentials.refresh, { signal });
      return {
        refresh: tokens.refreshToken ?? credentials.refresh,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },

    // Optional: adjust models based on the user's token
    modifyModels(models, credentials) {
      const region = decodeRegionFromToken(credentials.access);
      return models.map((model) => ({
        ...model,
        baseUrl: `https://${region}.ai.corp.com/v1`
      }));
    }
  }
});
```

Users can then sign in with `/login corporate-ai`.

Atomic serializes OAuth refreshes so concurrent sessions do not overwrite each other's credentials. Atomic never aborts the `signal` passed to `refreshToken` on timeout because the provider may have already rotated the refresh token; a late response still saves, and normal exit waits up to three seconds for it. Do not add a shorter abort timeout to your token refresh call.

OAuth callbacks run in the engine process in isolated interactive mode. Use the provided callbacks for all prompts and notices instead of reading terminal process state.

Set `loginLabel` to customize the login dialog title. Set `usesCallbackServer: true` to show a redirect-URL paste field alongside the local callback server.

For a native `pi.registerProvider(provider)` registration, set `provider.auth.oauth.usesCallbackServer: true` when your flow races a local callback server against `interaction.prompt({ type: "manual_code", message: "Paste redirect URL:" })`. The built-in Anthropic, OpenAI, OpenAI Codex, and OpenRouter OAuth objects already set this flag; keep it when wrapping them, or set `false` for a replacement flow without a callback server. `pi.registerProvider(id, config)` reads `config.oauth.usesCallbackServer`.

Successful login saves credentials before refreshing the model catalog. Logout removes stored credentials without calling `refreshModels`. Pressing Escape or Ctrl+C cancels login cleanly and keeps prior credentials and models unchanged. Later registrations override earlier ones by provider ID.

Intentional cancellation (native `AbortError`, an aborted `signal`, nested abort causes, or the legacy exact `Login cancelled` error) stays quiet. Provider denials, timeouts, network errors, malformed responses, token exchange failures, and storage errors remain visible. Catalog-refresh errors appear in `/model` while keeping cached models usable and never roll back a saved login.

## Rejected logins

When the provider rejects a stored refresh token (revoked access or expired login), throw `OAuthRefreshRejectedError` from `refreshToken`:

```typescript
import { OAuthRefreshRejectedError } from "@bastani/atomic";

async refreshToken(credentials, signal) {
  const response = await fetch("https://sso.corp.com/token", {
    method: "POST",
    body: refreshBody(credentials),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || body.error === "invalid_grant") {
      throw new OAuthRefreshRejectedError(
        `Corporate AI token refresh failed (${response.status})`,
        { status: response.status, code: body.error, description: body.error_description },
        [credentials.refresh, credentials.access],
      );
    }
    throw new Error(`Token refresh failed (${response.status})`);
  }
  // Return refreshed credentials
}
```

Atomic checks whether another session saved a newer login first. If not, the request fails with:

```text
OAuth refresh failed for corporate-ai: invalid_grant (Refresh token expired). The provider rejected the stored login; run /login corporate-ai to sign in again.
```

The message displays only the provider ID, error code (or `HTTP <status>`), and description. Pass stored tokens as the third argument so Atomic strips any description that leaks a token, contains a URL, or is too long.

Atomic also recognizes rejected logins thrown as plain errors or wrapped in `cause` when they match built-in rejection codes (`invalid_grant`, `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`) or HTTP 401:

- Errors with `error` or `code` set to a rejected-login code (`error_description` supplies the description).
- Errors whose `body`, `data`, `response.data`, or `response.body` carries a rejected-login code in `error`, `error.code`, or `code` (object or JSON string).
- Errors with `status`, `statusCode`, `response.status`, or `response.statusCode` equal to `401`.
- Error messages containing a rejected-login code.

Other failures (HTTP 5xx, network failures, or OAuth errors such as `invalid_client`, `invalid_request`, or `server_error`) report `OAuth refresh failed for <provider>: <message>` without prompting for re-login.

## Dynamic model catalog refresh

Providers whose model lists change at runtime can implement `refreshModels(context)`. Atomic calls it during the model picker's bounded asynchronous refresh independently of login completion:

```typescript
await pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  apiKey: "$CORPORATE_AI_KEY",
  models: cachedModels,
  async refreshModels({ allowNetwork, signal, force, credential }) {
    if (!allowNetwork) return cachedModels;
    return await fetchCorporateModels({ signal, force, credential });
  }
});
```

Legacy `ProviderConfig.refreshModels(context)` returns mixed-operation `ProviderModelConfig[]` definitions that replace that registration's live models. A native `Provider` registered with `pi.registerProvider(provider)` calls `await context.publish({ persist, update })` to persist an optional `ModelsStoreEntry` and install provider-owned model state, then returns the latest list from `getModels()` (or `getAllModels()` for mixed-operation providers).

The existing catalog stays usable while a refresh runs. Each provider's refresh settles independently; if one fails, times out, or sees an aborted `signal`, it keeps its previous list. Pass `persist` to `context.publish()` only when the catalog should persist across sessions in `models-store.json`.

### OAuthLoginCallbacks

`callbacks` exposes three user-interaction methods:

```typescript
interface OAuthLoginCallbacks {
  // Open URL in browser (for OAuth redirects)
  onAuth(params: { url: string }): void;

  // Show device code (for device authorization flow)
  onDeviceCode(params: {
    userCode: string;
    verificationUri: string;
    openBrowserOnConfirm?: boolean; // default true
    copyCodeOnConfirm?: boolean; // default true
  }): void;

  // Prompt user for input (for manual token entry)
  onPrompt(params: { message: string }): Promise<string>;
}
```

In `/login`, pressing Enter (`tui.select.confirm`) opens the device verification URL and copies the code by default. Disable either action with `openBrowserOnConfirm: false` or `copyCodeOnConfirm: false` in `onDeviceCode` or native `AuthEvent` notifications.

### OAuthCredentials

OAuth credentials save to `~/.atomic/agent/auth.json` (Atomic may also read legacy `~/.pi/agent/auth.json`):

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token passed to refreshToken()
  access: string;    // Access token returned by getApiKey()
  expires: number;   // Expiration timestamp in milliseconds
}
```
