---
title: Authentication
description: Connect Atomic to a provider with a subscription login or an API key.
---

# Authentication

**Outcome:** Atomic is connected to a model provider and `/model` lists selectable models.

**Prerequisites:** [Installation](/getting-started/installation) is complete.

## Authenticate

Connect with a subscription login (`/login`) or an API key (via an environment variable or `~/.atomic/agent/auth.json`).

### Option 1: subscription login

Start Atomic and run `/login`:

```bash
atomic
```

```text
/login
```

Choose **Use a subscription**, then select your provider (such as Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot, OpenRouter, Kimi Code, or xAI).

### Option 2: API key

Export an API key before launching Atomic:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

Or store a key in `~/.atomic/agent/auth.json` by running `/login`, choosing **Use an API key**, and selecting a provider.

See [Providers](/providers) for all supported providers, environment variables, and cloud setup for Amazon Bedrock, Google Vertex AI, and Azure.

## Verify authentication

1. Start Atomic and run `/model`. Confirm models appear for your provider with an active selection marked. If the list is empty, rerun `/login` or check that your API key is exported in the same shell.
2. Select a model and send a test prompt such as `Reply with hello.` A listed model or stored credential does not prove connectivity or quota; a live response confirms access.

### How `/login` menus work

- `/login` opens **Select authentication method:** with **Use a subscription** and **Use an API key**.
- Provider status shows whether credentials exist (stored, environment, runtime, or config); it does not test connectivity.
- OAuth sign-ins not backed by a subscription are labeled **account**.
- Cancelling a sign-in returns to the previous menu.

## Next step

Continue to [First session](/getting-started/first-session).
