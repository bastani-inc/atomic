---
title: Override an existing provider
description: Change the base URL or request headers of a built-in provider while keeping its models.
---

# Override an existing provider

## Override existing provider

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
    "X-Corp-Auth": "$CORP_AUTH_TOKEN" // resolves from env; omit $ for a literal
  }
});
```

When you pass only `baseUrl` or `headers` (with no `models`), Atomic keeps all existing models and authentication for that provider. To register new models or a new provider, see [Register a provider](/custom-provider/registration).
