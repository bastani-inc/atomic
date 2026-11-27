---
title: "Override a built-in provider"
sidebarTitle: "Override a Provider"
description: "Route a built-in provider through a proxy or attach custom request headers from an extension while keeping its models."
---

Use an extension override when you want to route a built-in provider through a corporate proxy, compute endpoints dynamically, or attach custom headers without redefining its model catalog. For static overrides with no code, configure [`~/.atomic/agent/models.json`](/models) instead.

## Proxy or attach headers {#override-existing-provider}

Call `atomic.registerProvider()` with the built-in provider's ID and only the fields you want to override (`baseUrl` and/or `headers`):

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  // Route all Anthropic requests through a proxy
  await atomic.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com",
  });

  // Add custom headers to OpenAI requests
  await atomic.registerProvider("openai", {
    headers: {
      "X-Custom-Header": "value",
    },
  });

  // Override both baseUrl and headers on Google
  await atomic.registerProvider("google", {
    baseUrl: "https://ai-gateway.corp.com/google",
    headers: {
      // Supports $ENV_VAR, ${ENV_VAR}, !command, or literal values ($$ for $, $! for leading !)
      "X-Corp-Auth": "$CORP_AUTH_TOKEN",
    },
  });
}
```

When you omit `models`, Atomic keeps every built-in model and existing authentication flow for that provider.

<Note>
Supplying a `models` array switches from an override to a full replacement across chat, image, classifier, and compactor models for that provider. To register new models or a brand-new provider, see [Register a custom provider](/custom-provider/registration).
</Note>

## How overrides merge and revert

- **Header merging.** Extension `headers` merge over `models.json` `headers` and over provider authentication headers, with extension values winning on key collision. Header values support `$ENV_VAR`, `${ENV_VAR}`, `!command`, `$$`, and `$!` ([Value resolution](/models/reference#value-resolution)).
- **Incremental re-registration.** Calling `registerProvider("anthropic", { headers })` after `registerProvider("anthropic", { baseUrl })` keeps `baseUrl`, because defined fields merge over the previous registration.
- **Derived fast variants.** Overriding `baseUrl` or `headers` on built-in `anthropic`, `anthropic-api`, `openai`, `openai-api`, `openai-codex`, or `xai` preserves derived `-fast` (and eligible `-ultrafast`) variants as long as you do not replace `models` or supply a custom `streamSimple` handler for that API.
- **Reverting an override.** Call `await atomic.unregisterProvider("anthropic")` to remove the extension override and restore the built-in provider (along with any `models.json` configuration) immediately without running `/reload`.
