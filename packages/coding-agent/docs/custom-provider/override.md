---
title: Override an existing provider
description: Change the behavior of a provider Atomic already ships.
---

# Override an existing provider

## Override Existing Provider

The simplest use case: redirect an existing provider through a proxy.

```typescript
// All Anthropic requests now go through your proxy
await pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Add custom headers to OpenAI requests
await pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// Both baseUrl and headers
await pi.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "$CORP_AUTH_TOKEN"  // resolves from env; omit $ for a literal
  }
});
```

When only `baseUrl` and/or `headers` are provided (no `models`), all existing models for that provider are preserved with the new endpoint.
