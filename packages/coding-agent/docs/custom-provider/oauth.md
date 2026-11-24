---
title: "Add OAuth login to a provider"
sidebarTitle: "OAuth login"
description: "Implement OAuth login callbacks, token refresh, rejected-login errors, and dynamic model catalog refresh."
---

## OAuth support

Add OAuth or SSO login integrated with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@bastani/atomic-ai";

await atomic.registerProvider("corporate-ai", {
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

    // Optional: adjust chat models based on the user's token (image and classifier models pass through unchanged)
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

Refresh and callback behavior:

- **Refresh timing and locking.** Atomic refreshes stored OAuth tokens when fewer than **5 minutes** of validity remain and serializes concurrent refreshes across sessions under a credential lock held for up to **2 minutes**. Catalog refreshes wait up to **60 seconds**, while chat requests allow **15 seconds** for pre-request authentication preparation. Atomic never aborts the `signal` passed to `refreshToken` on caller timeout because the provider may have already rotated the refresh token; a late response still saves, and normal exit waits up to **3 seconds** for it. Do not add a shorter abort timeout to your token refresh call.
- **Callback isolation.** Always use the provided callbacks for user prompts and notices instead of reading stdin or writing directly to stdout or stderr, because login callbacks may run in a separate background process.
- **Dialog options.** Set `loginLabel` to customize the login dialog title. Set `usesCallbackServer: true` to show a redirect-URL paste field alongside a local callback server.
- **Two registration forms.** Config-object registration (`atomic.registerProvider(id, config)`) reads `config.oauth.usesCallbackServer`. Native `Provider` registration (`atomic.registerProvider(provider)`) reads `provider.auth.oauth.usesCallbackServer` when racing a local callback server against `interaction.prompt({ type: "manual_code", message: "Paste redirect URL:" })`. The built-in Anthropic, OpenAI, OpenAI Codex, and OpenRouter OAuth objects already set this flag; keep it when wrapping them, or set `false` for a replacement flow without a callback server. See [Native `Provider` registration](/custom-provider/api-reference#native-provider-registration).
- **Lifecycle and cancellation.** Successful login saves credentials before refreshing the model catalog. Logout removes stored credentials without calling `refreshModels`. Pressing Escape or Ctrl+C cancels login cleanly and keeps prior credentials and models unchanged. Later registrations override earlier ones by provider ID. Intentional cancellation (native `AbortError`, an aborted `signal`, nested abort causes, or the legacy exact `Login cancelled` error) stays quiet, whereas provider denials, timeouts, network errors, malformed responses, token exchange failures, and storage errors remain visible. Catalog-refresh errors appear in `/model` while keeping cached models usable and never roll back a saved login.

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

The message displays only the provider ID, error code (or `HTTP <status>`), and description. Pass stored tokens as the third argument so Atomic strips any description that echoes a secret, contains a URL, or exceeds safe length bounds.

Atomic also recognizes rejected logins thrown as plain errors or wrapped in `cause` when they match built-in rejection codes (`invalid_grant`, `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`) or HTTP 401:

- Errors with `error` or `code` set to a rejected-login code (`error_description` supplies the description).
- Errors whose `body`, `data`, `response.data`, or `response.body` carries a rejected-login code in `error`, `error.code`, or `code` (object or JSON string).
- Errors with `status`, `statusCode`, `response.status`, or `response.statusCode` equal to `401`.
- Error messages containing a rejected-login code.

Other failures (HTTP 5xx, network failures, or OAuth errors such as `invalid_client`, `invalid_request`, or `server_error`) report `OAuth refresh failed for <provider>: <message>` without prompting for re-login.

## Dynamic model catalog refresh

Providers whose model lists change at runtime can implement `refreshModels(context)`. Atomic calls it during the model picker's bounded asynchronous refresh independently of login completion:

```typescript
await atomic.registerProvider("corporate-ai", {
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

- **Config-object registration (`registerProvider(id, config)`):** `refreshModels(context)` returns `ProviderModelConfig[]` definitions (chat, image, or classifier) that replace that registration's live models. When `allowNetwork` is `false` (offline or cache-only startup restore), return cached models to populate initial availability without making network requests.
- **Native `Provider` registration (`registerProvider(provider)`):** `refreshModels(context)` calls `await context.publish({ persist, update })` to persist an optional `ModelsStoreEntry` in `models-store.json` and install provider-owned state, then exposes the latest models from `getModels()` (or `getAllModels()` for mixed-operation providers).

The existing catalog stays usable while a refresh runs. Each provider's refresh settles independently; if one fails, times out, or sees an aborted `signal`, it keeps its previous list. For all `RefreshModelsContext` fields (`credential`, `stored`, `publish`, `allowNetwork`, `force`, `signal`, `baseUrl`, and `updateCredential`), see [`RefreshModelsContext`](/custom-provider/api-reference#refreshmodelscontext).

## OAuthLoginCallbacks

`callbacks` exposes the full user-interaction surface for `config.oauth.login()`:

```typescript
interface OAuthLoginCallbacks {
  /** Open a URL in the browser (for OAuth redirects). */
  onAuth(info: { url: string; instructions?: string }): void;

  /** Show a device code (for device authorization flows). */
  onDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    openBrowserOnConfirm?: boolean; // default true
    copyCodeOnConfirm?: boolean; // default true
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;

  /** Prompt the user for input (for manual code or token entry). */
  onPrompt(prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }): Promise<string>;

  /** Report non-blocking status updates during login. */
  onProgress?(message: string): void;

  /** Read a manually pasted redirect URL or authorization code. */
  onManualCodeInput?(): Promise<string>;

  /** Let the user pick from a list of options (for example tenant or workspace). */
  onSelect(prompt: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }): Promise<string | undefined>;

  /** Cancellation signal for the active login attempt. */
  signal?: AbortSignal;
}
```

In `/login`, pressing Enter (`tui.select.confirm`) opens the device verification URL and copies the code by default. Disable either action with `openBrowserOnConfirm: false` or `copyCodeOnConfirm: false` in `onDeviceCode` or native `AuthEvent` notifications.

## OAuthCredentials

OAuth credentials save to `~/.atomic/agent/auth.json` (Atomic may also read legacy `~/.pi/agent/auth.json`):

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token passed to refreshToken()
  access: string;    // Access token returned by getApiKey()
  expires: number;   // Expiration timestamp in milliseconds
}
```
