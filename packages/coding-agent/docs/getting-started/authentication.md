---
title: "Authenticate a provider"
sidebarTitle: "Authentication"
description: "Connect Atomic to a model provider using a subscription login, the CLI auth command, or an API key."
---

**Outcome:** Atomic is connected to a model provider and `/model` lists selectable models.

**Prerequisites:** [Install Atomic](/getting-started/installation) is complete.

## Choose an authentication method

Connect with a subscription login (`/login`), the shell login command (`atomic auth login`), or an API key (via an environment variable or `~/.atomic/agent/auth.json`).

### Sign in with a subscription

Start Atomic and run `/login`:

```bash
atomic
```

```text
/login
```

Choose **Use a subscription**, then select your provider (such as Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot, OpenRouter, Kimi Code, or xAI). You can also pass a provider name directly, such as `/login anthropic` or `/login openai`.

On remote or SSH sessions where the browser cannot reach Atomic's local callback port, paste the final redirect URL or authorization code into the prompt instead. Choosing Amazon Bedrock inside `/login` opens a guided Bedrock setup dialog rather than a plain API-key prompt.

### Sign in from the shell

Authenticate from your terminal without starting an interactive session:

```bash
atomic auth login anthropic
```

Pass `--no-browser` on SSH or headless machines to use a non-browser flow such as a device code, or pass `--api-key` to store an API key without echoing it. See [Credential commands](/reference/cli#credential-commands).

### Use an API key

Export an API key before launching Atomic:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

Or save a key in `~/.atomic/agent/auth.json` (written with owner-only `0600` permissions) by running `/login`, choosing **Use an API key**, and selecting a provider.

See [Providers](/providers) for all supported providers, environment variables, and cloud setup for Amazon Bedrock, Google Vertex AI, and Azure.

## Verify authentication

1. Start Atomic and run `/model`. Confirm models appear for your provider with an active selection marked. If the list is empty, rerun `/login` or check that your API key is exported in the same shell.
2. Select a model and send a test prompt such as `Reply with hello.` A listed model or stored credential does not prove connectivity or quota; a live response confirms access.

### How `/login` and `/logout` work

- `/login` opens **Select authentication method:** with **Use a subscription** and **Use an API key**.
- `/login <provider>` jumps straight to sign-in when the provider offers one method, opens the method selector when both subscription and API key exist, or prefills the search filter otherwise.
- Provider status shows whether credentials exist (stored in `auth.json`, set in an environment variable, passed via `--api-key`, or configured in `models.json`); it does not test live connectivity.
- OAuth sign-ins not backed by a subscription are labeled **account**.
- Cancelling a sign-in returns to the previous menu.
- `/logout [provider]` removes only credentials stored in `~/.atomic/agent/auth.json`. It does not clear environment variables or `models.json` entries.

## Next step

Continue to [Run your first session](/getting-started/first-session).
