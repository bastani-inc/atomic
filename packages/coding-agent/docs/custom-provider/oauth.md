---
title: "Add OAuth login to a provider"
sidebarTitle: "Add OAuth Login"
description: "Implement OAuth login callbacks, token refresh, rejected-login errors, and dynamic model catalog refresh."
---

Add an `oauth` configuration to `atomic.registerProvider()` to integrate browser sign-in, device-code flows, or manual token entry directly with `/login`. Atomic handles credential storage in `auth.json`, cross-session refresh locking, and automatic retries after token refresh.

## Implement OAuth login

Supply `name`, `login`, `refreshToken`, and `getApiKey` on `oauth`, alongside the provider's models:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@bastani/atomic-ai";

export default async function (atomic: ExtensionAPI) {
  await atomic.registerProvider("corporate-ai", {
    baseUrl: "https://ai.corp.com/v1",
    api: "openai-responses",
    models: [
      {
        id: "corp-chat-1",
        name: "Corporate Chat 1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
    oauth: {
      name: "Corporate AI (SSO)",

      async login(callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials> {
        // Choose the interaction matching your identity provider:
        // 1. Browser-based OAuth redirect
        callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });

        // 2. Or device authorization code flow:
        // callbacks.onDeviceCode({
        //   userCode: "ABCD-1234",
        //   verificationUri: "https://sso.corp.com/device",
        // });

        // 3. Prompt for manual authorization code or token
        const code = await callbacks.onPrompt({ message: "Enter SSO code:" });

        // Forward `signal` so cancelling /login aborts the network request
        const tokens = await exchangeCodeForTokens(code, { signal });

        return {
          refresh: tokens.refreshToken,
          access: tokens.accessToken,
          expires: Date.now() + tokens.expiresIn * 1000,
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
          expires: Date.now() + tokens.expiresIn * 1000,
        };
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },

      // Optional: adjust chat models from the token (image, classifier, and compactor models pass through unchanged)
      modifyModels(models, credentials) {
        const region = decodeRegionFromToken(credentials.access);
        return models.map((model) => ({
          ...model,
          baseUrl: `https://${region}.ai.corp.com/v1`,
        }));
      },
    },
  });
}
```

Users sign in with `/login corporate-ai`. See [`OAuthLoginCallbacks`](/custom-provider/api-reference#oauthlogincallbacks) and [`OAuthCredentials`](/custom-provider/api-reference#oauthcredentials) for the full callback and credential interfaces.

<Note>
Shell [`atomic auth login`](/reference/cli#credential-commands) does not load extensions. Users must sign in to extension-registered providers through interactive `/login <provider>`.
</Note>

## Refresh timing, callbacks, and lifecycle

For how extension OAuth interacts with `auth.json` and other credential sources, see [Token refresh](/providers#token-refresh) and [Credential resolution order](/providers/reference#resolution-order).

### Token refresh timing and locking

- **5-minute refresh window.** Atomic refreshes stored OAuth tokens whenever fewer than 5 minutes of validity remain.
- **Cross-session lock.** Concurrent sessions serialize refreshes under a credential lock held for up to 2 minutes.
- **Caller wait budgets.** Chat requests wait up to 15 seconds for pre-request auth preparation; catalog refreshes wait up to 60 seconds.

<Warning>
Pass `signal` to your network call in `refreshToken()`, and do **not** add a shorter abort timeout of your own. Atomic never aborts `signal` on a caller wait timeout because the upstream server may have already rotated the refresh token; a late response still persists, and normal exit waits up to 3 seconds for it to finish.
</Warning>

### Callbacks, dialogs, and cancellation

- **Use callbacks, never stdin/stdout.** Always prompt and notify users through `callbacks`, because login flows may run in an isolated background process.
- **Dialog customization.** Set `loginLabel` to customize the login dialog title. Set `usesCallbackServer: true` when your login flow listens on a local callback server and also accepts a pasted redirect URL as fallback.
- **Device-code confirmation.** In `/login`, pressing **Enter** on a device-code prompt opens the verification URL and copies the user code by default. Pass `openBrowserOnConfirm: false` or `copyCodeOnConfirm: false` in `onDeviceCode()` to disable either behavior.
- **Save and cancellation semantics.** Successful login persists credentials before refreshing the model catalog; catalog-refresh errors appear in `/model` without rolling back the saved login. `/logout` deletes stored credentials without calling `refreshModels()`. Pressing `Escape` or `Ctrl+C` cancels cleanly (`AbortError` or an aborted `signal` stays quiet) and leaves prior credentials untouched, while provider denials, timeouts, network failures, malformed responses, and storage errors are shown to the user. Later registrations override earlier ones with the same provider ID.

<Note>
**Native `Provider` registrations:** When using `atomic.registerProvider(provider)` instead of a config object, Atomic reads `provider.auth.oauth.usesCallbackServer` to decide whether to show the manual redirect-URL fallback alongside a local callback server. Built-in Anthropic, OpenAI, OpenAI Codex, and OpenRouter OAuth implementations already set this flag — preserve it when wrapping them, or set `false` for a replacement flow without a callback server. See [Native `Provider` registration](/custom-provider/api-reference#native-provider-registration).
</Note>

## Rejected logins

When your identity provider permanently rejects a stored refresh token (revoked access or expired login), throw `OAuthRefreshRejectedError` from `refreshToken()`:

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

Atomic first checks whether another session already saved a newer login. If not, the request fails with a clear re-login prompt:

```text
OAuth refresh failed for corporate-ai: invalid_grant (Refresh token expired). The provider rejected the stored login; run /login corporate-ai to sign in again.
```

The message includes only the provider ID, error code (or `HTTP <status>`), and safe description. Pass stored secrets as the third argument so Atomic strips any description that echoes a token, contains a URL, or exceeds length limits.

Atomic also recognizes rejected logins thrown as ordinary errors (or wrapped in `cause`) when they carry HTTP `401` or any of the standard rejection codes (`invalid_grant`, `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`):

- Errors with `error` or `code` set to a rejected-login code (`error_description` provides the description).
- Errors whose `body`, `data`, `response.data`, or `response.body` carries a rejected-login code in `error`, `error.code`, or `code` (object or JSON string).
- Errors with `status`, `statusCode`, `response.status`, or `response.statusCode` equal to `401`.
- Error messages containing one of the rejected-login codes.

Other failures (HTTP 5xx, network errors, or OAuth errors like `invalid_client`, `invalid_request`, or `server_error`) report `OAuth refresh failed for <provider>: <message>` without asking the user to log in again.

## Dynamic model catalog refresh

If a provider's available models change over time or depend on the signed-in account, implement `refreshModels(context)`. Atomic calls it during bounded asynchronous refreshes independently of login completion:

```typescript
await atomic.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  apiKey: "$CORPORATE_AI_KEY",
  models: cachedModels,
  async refreshModels({ allowNetwork, signal, force, credential }) {
    if (!allowNetwork) return cachedModels;
    return await fetchCorporateModels({ signal, force, credential });
  },
});
```

- **Config-object registration (`registerProvider(id, config)`):** Return `ProviderModelConfig[]` (chat, image, classifier, or compactor) to replace the registration's live models. When `allowNetwork` is `false` (offline or cache-only startup restore), return cached models without making network requests.
- **Native `Provider` registration (`registerProvider(provider)`):** Call `await context.publish({ persist, update })` to update `models-store.json` and provider-owned state, then expose the refreshed models from `getModels()` (or `getAllModels()` for mixed-operation providers).

The existing catalog remains selectable while a refresh runs. Each provider settles independently; if a refresh fails, times out, or sees an aborted `signal`, Atomic keeps the previous list. See [`RefreshModelsContext`](/custom-provider/api-reference#refreshmodelscontext) for every field on `context`.
