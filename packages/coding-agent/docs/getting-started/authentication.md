---
title: "Authenticate a provider"
sidebarTitle: "Authenticate a provider"
description: "Connect Atomic to a model provider using a subscription login, the CLI auth command, or an API key."
---

**Outcome:** Atomic is connected to a model provider and `/model` lists selectable models.

**Prerequisites:** [Install Atomic](/getting-started/installation) is complete.

## Choose an authentication method

| What you want | Use this |
| --- | --- |
| Sign in with a subscription or account inside Atomic | Run `/login` in interactive mode |
| Sign in from a terminal, SSH session, or setup script | Run `atomic auth login <provider>` |
| Use an API key for the current shell only | Export the provider's environment variable (such as `ANTHROPIC_API_KEY`) |
| Save an API key for all future sessions | Run `/login` → **Use an API key** (or `atomic auth login <provider> --api-key`) |
| Connect Bedrock, Vertex AI, Azure, or local `llama.cpp` | See [Model providers](/providers) or [Local models with llama.cpp](/llama-cpp) |

<Tabs>
  <Tab title="Interactive /login">
    Start Atomic and run `/login`:

    ```bash
    atomic
    ```

    ```text
    /login
    ```

    Choose **Use a subscription** (for subscriptions and OAuth accounts) or **Use an API key**, then select your provider. Supported subscription and account logins include OpenRouter, OpenAI (Sign in with ChatGPT), ChatGPT Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot, Kimi Code, Meta (Muse), and xAI.

    You can also jump directly to a provider:

    - `/login anthropic` — Sign in with Claude Pro/Max or store an Anthropic API key.
    - `/login openai` — Sign in with ChatGPT or store an API key for OpenAI's Responses API.
    - `/login openai-codex` — Sign in to the ChatGPT Plus/Pro Codex backend.
    - `/login openrouter` — Sign in with your OpenRouter account or store an OpenRouter API key.

    <Tip>
    **Remote or SSH sessions:** If your browser cannot reach Atomic's local callback port, copy the final redirect URL (or authorization code) from your browser and paste it into the login prompt. Choosing Amazon Bedrock inside `/login` opens a guided Bedrock setup dialog rather than a plain API-key prompt.
    </Tip>
  </Tab>

  <Tab title="Shell (atomic auth login)">
    Sign in without starting an interactive session:

    ```bash
    atomic auth login anthropic
    ```

    - Pass `--no-browser` on SSH or headless machines to use a non-browser flow such as a device code.
    - Pass `--api-key` to enter and store an API key without echoing it to the terminal.

    See [Credential commands](/reference/cli#credential-commands) for `atomic auth check`, `atomic auth logout`, and scripting options.
  </Tab>

  <Tab title="API key">
    Export a provider environment variable before launching Atomic:

    ```bash
    export ANTHROPIC_API_KEY=sk-ant-...
    atomic
    ```

    To persist an API key across shells instead, run `/login`, choose **Use an API key**, and select a provider. Atomic saves stored keys and OAuth tokens in `~/.atomic/agent/auth.json` with owner-only `0600` permissions.

    See [Model providers](/providers) for every provider's environment variable name and cloud setup (Amazon Bedrock, Google Vertex AI, Azure, and NVIDIA NIM).
  </Tab>
</Tabs>

## Verify authentication

<Steps>
  <Step title="Check available models">
    Start Atomic and run `/model`. Confirm your provider's models appear with an active selection marked. If the list is empty, rerun `/login` or confirm your API key is exported in the same shell.

    You can also verify credentials from your shell without starting a session:

    ```bash
    atomic auth check --provider anthropic
    ```
  </Step>
  <Step title="Send a live test prompt">
    Select a model and send a short prompt such as `Reply with hello.` A listed model or stored credential does not verify live connectivity or account quota—a completed reply confirms end-to-end access.
  </Step>
</Steps>

## How `/login` and `/logout` work

- Running bare `/login` opens **Select authentication method:** with **Use a subscription** and **Use an API key**.
- Running `/login <provider>` jumps straight to sign-in when the provider supports only one method, opens the method chooser when both OAuth and API key exist, or pre-fills the provider search filter otherwise. For OAuth providers not backed by a subscription (such as OpenRouter), the method chooser labels the OAuth choice **Use an account** instead of **Use a subscription**, and provider lists label it **account**.
- Provider status indicates whether credentials exist (`auth.json`, an environment variable, `--api-key`, or `models.json`); it does not test live connectivity.
- Pressing `Esc` or `Ctrl+C` cancels a sign-in and returns to the previous menu without altering previously saved credentials.
- `/logout [provider]` removes only credentials stored in `~/.atomic/agent/auth.json` (and legacy `~/.pi/agent/auth.json`). It does not clear environment variables, CLI flags, or `models.json` entries.

## Next step

Continue to [Run your first session](/getting-started/first-session), or see [Choose a model](/models/choose-a-model) to compare providers and set up model cycling.
