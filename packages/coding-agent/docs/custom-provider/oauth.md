---
title: Provider OAuth
description: OAuth login callbacks, credential storage, and dynamic catalog refresh.
---

# Provider OAuth

## OAuth Support

Add OAuth/SSO authentication that integrates with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@bastani/pi-ai";

await pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
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

      // Exchange for tokens (your implementation). Forward `signal` so
      // cancelling /login aborts the in-flight network request.
      const tokens = await exchangeCodeForTokens(code, { signal });

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    async refreshToken(
      credentials: OAuthCredentials,
      signal: AbortSignal | undefined
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

    // Optional: modify models based on user's subscription
    modifyModels(models, credentials) {
      const region = decodeRegionFromToken(credentials.access);
      return models.map(m => ({
        ...m,
        baseUrl: `https://${region}.ai.corp.com/v1`
      }));
    }
  }
});
```

After registration, users can authenticate via `/login corporate-ai`.

Existing extension OAuth definitions keep their `login`, `refreshToken`, `getApiKey`, and optional `modifyModels` methods. OAuth refresh is serialized so concurrent requests do not overwrite each other's credentials. Atomic never aborts the `signal` passed to `refreshToken` on a timeout, because the provider may already have rotated the refresh token; a late result is saved, and a normal exit waits up to three seconds for it. Do not add your own timeout or abort to the token request.

OAuth callbacks run in the engine in isolated interactive mode. Use the provided callbacks for user interaction rather than relying on terminal-process state.

`loginLabel` sets the dialog title. `usesCallbackServer: true` offers a redirect-URL paste field alongside the browser callback.

For the native `pi.registerProvider(provider)` form, set `provider.auth.oauth.usesCallbackServer: true` when the flow races a callback server against `interaction.prompt({ type: "manual_code", message: "Paste redirect URL:" })`. This shows the paste field even under a custom provider ID. The built-in Anthropic, OpenAI, OpenAI Codex, and OpenRouter OAuth objects already carry this flag; preserve it when cloning or wrapping them. Set it explicitly to `false` for a replacement flow that does not use a callback server. Legacy `pi.registerProvider(id, config)` registrations continue to use `config.oauth.usesCallbackServer`.

Successful login persists credentials before refreshing the catalog. Logout removes stored credentials without calling `refreshModels`. Escape or Ctrl+C cancels the matching login and preserves the previous credentials and catalog. Later registrations still override earlier providers by ID.

Intentional cancellation is quiet, including native `AbortError`, an aborted signal or its exact reason, nested abort causes, and the legacy exact `Login cancelled` error. Provider denial, timeout, network/protocol errors, malformed responses, token exchange failures, and storage failures remain visible. Catalog-refresh failures are reported by `/model` while cached models remain selectable; they do not turn a persisted login into a failed transaction.

## Rejected logins

When the provider rejects the stored refresh token, for example because the user revoked access or the login expired, throw `OAuthRefreshRejectedError` from `refreshToken`:

```typescript
import { OAuthRefreshRejectedError } from "@bastani/atomic";

async refreshToken(credentials, signal) {
  const response = await fetch("https://sso.corp.com/token", { method: "POST", body: refreshBody(credentials), signal });
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
  // ...
}
```

Atomic then handles the refresh as it does for a built-in provider. It first uses a newer login that another session saved, if there is one. Otherwise the request fails with:

```
OAuth refresh failed for corporate-ai: invalid_grant (Refresh token expired). The provider rejected the stored login; run /login corporate-ai to sign in again.
```

The message shows only the provider ID, the error code (or `HTTP <status>` when there is none), and the description. Pass the stored tokens as the third argument: a description that contains one of them, contains a URL, or is too long is left out. Never put tokens or request bodies in the code or description.

Atomic also treats these errors from `refreshToken` as a rejected login, including when they are the `cause` of the error you throw:

- an error with an `error` or `code` property of `invalid_grant`, such as openid-client's response errors; `error_description` supplies the description
- an error whose `body`, `data`, `response.data`, or `response.body` holds an OAuth error response (`{"error":"invalid_grant", ...}`), as an object or JSON text, as HTTP clients such as axios attach it
- an error whose `status`, `statusCode`, or `response.status` is 401
- an error message that contains an OAuth error response with `invalid_grant`, as the built-in providers report it

Other failures, such as a 5xx status, a network error, or another OAuth error code, are reported as `OAuth refresh failed for <provider>: <message>` without asking the user to sign in again, because a retry may succeed.

## Dynamic model catalog refresh

Providers whose catalogs change at runtime can add `refreshModels`. Atomic calls it during the model picker's bounded asynchronous refresh, independently of authentication completion:

```typescript
await pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  apiKey: "$CORPORATE_AI_KEY",
  models: cachedModels,
  async refreshModels({ signal, force, credential, store }) {
    const models = await fetchCorporateModels({ signal, force, credential });
    await store.write({ models, checkedAt: Date.now() });
    return models;
  }
});
```

The current catalog stays readable while refresh is pending. Successful provider results are applied independently; a provider that fails, times out, or observes an aborted `signal` retains its previous list. Use the provider-scoped `store` only when the catalog should persist across sessions.

### OAuthLoginCallbacks

The `callbacks` object provides three ways to authenticate:

```typescript
interface OAuthLoginCallbacks {
  // Open URL in browser (for OAuth redirects)
  onAuth(params: { url: string }): void;

  // Show device code (for device authorization flow)
  onDeviceCode(params: { userCode: string; verificationUri: string }): void;

  // Prompt user for input (for manual token entry)
  onPrompt(params: { message: string }): Promise<string>;
}
```

### OAuthCredentials

Credentials are persisted in `~/.atomic/agent/auth.json` (legacy `~/.pi/agent/auth.json` may be read for compatibility):

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token (for refreshToken())
  access: string;    // Access token (returned by getApiKey())
  expires: number;   // Expiration timestamp in milliseconds
}
```
