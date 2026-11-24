---
title: "Override a built-in provider"
sidebarTitle: "Override provider"
description: "Change the base URL or request headers of a built-in provider from an extension while keeping its models."
---

## Override a built-in provider {#override-existing-provider}

Redirect an existing built-in provider through a proxy or attach custom headers without redefining its models:

```typescript
// Route all Anthropic requests through a proxy
await atomic.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Add custom headers to OpenAI requests
await atomic.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// Override both baseUrl and headers
await atomic.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    // Supports $ENV_VAR, ${ENV_VAR}, !command, or literal values ($$ for $, $! for leading !)
    "X-Corp-Auth": "$CORP_AUTH_TOKEN"
  }
});
```

When you pass only `baseUrl` or `headers` (with no `models`), Atomic keeps all existing models and authentication for that provider. To register new models or a new provider, see [Register a custom provider](/custom-provider/registration).

## How overrides merge and revert

- **Header merging.** Extension `headers` merge over `models.json` `headers` and over provider authentication headers (extension values win on key collision). Header values support `$ENV_VAR`, `${ENV_VAR}`, `!command`, `$$`, and `$!`. See [Value resolution](/models/reference#value-resolution).
- **Incremental re-registration.** Calling `registerProvider("anthropic", { headers })` after `registerProvider("anthropic", { baseUrl })` keeps `baseUrl`, because defined fields merge over the previous registration.
- **Derived fast variants.** Overriding `baseUrl` on `anthropic`, `openai`, or `xai` preserves derived `-fast` variants as long as you do not supply a custom `streamSimple` or replace `models`. Supplying `streamSimple` suppresses derived `-fast` variants for that API.
- **Reverting an override.** Call `await atomic.unregisterProvider("anthropic")` to remove the extension override and restore the built-in provider (along with any `models.json` configuration) immediately without running `/reload`.
