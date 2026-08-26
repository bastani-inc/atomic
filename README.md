<h1 align="center">Atomic</h1>

<p align="center"><img width="800" height="450" alt="Atomic coding agent runtime" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>The verifiable coding agent runtime. Build your engineering process as explicit, checkable execution graphs.</b>
</p>

<p align="center">
  <b>Run verifiable engineering loops with control, alignment, and confidence.</b>
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#how-atomic-works">How it works</a>
  &nbsp;·&nbsp;
  <a href="#what-you-get">What you get</a>
  &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Docs</a>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img src="https://img.shields.io/badge/join%20community-discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://deepwiki.com/bastani-inc/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  If Atomic is useful to you, star the repository ⭐
</p>

**Users are reporting:**

- ⚡ A 1–1.5 hour reduction in manual verification per task compared to traditional coding agents, not including time saved from fewer follow-up fixes and reverts
- 🔀 ~95% merge rate on Atomic-generated PRs, with reduced follow-ups and a 0% revert rate
- 🛡️ Production incidents caught that CI did not cover

<!-- feature-wall:featured:start -->

## Atomic Verifiable Runtime

Every row is a real Atomic session recorded from the installed product. Open the Atomic docs for reference or follow the crash course step by step.

<table>
<tr>
<td width="42%" valign="top">
<h4>Create a workflow in plain English</h4>
<p>Describe inputs, parallel stages, synthesis, and outputs in prose; Atomic writes and reloads the runnable TypeScript graph.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a8-natural-language-workflow-authoring"><sub>Crash course · A.8 Natural-language workflow authoring</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a8-natural-language-workflow-authoring">
<picture>
<source srcset="assets/feature-wall/38-natural-language-workflow-authoring.gif" type="image/gif">
<img src="assets/feature-wall/38-natural-language-workflow-authoring.jpg" alt="Atomic turning a prose review-changes graph contract into a project workflow file and reloading it in the installed product" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Steer and control a live run</h4>
<p>Attach to a running stage, watch it stream, and steer, pause, or abort it mid-flight.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#62-steer-and-control-a-live-run"><sub>Crash course · 6.2 Steer and control a live run</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#62-steer-and-control-a-live-run">
<picture>
<source srcset="assets/feature-wall/23-steer-a-live-run.gif" type="image/gif">
<img src="assets/feature-wall/23-steer-a-live-run.jpg" alt="The Atomic workflow graph with a live stage streaming, receiving a steering message from the operator" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Durability and resume</h4>
<p>Runs checkpoint as they go, so killing the process leaves them retained and resumable instead of lost.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#65-durability-and-resume"><sub>Crash course · 6.5 Durability and resume</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#65-durability-and-resume">
<picture>
<source srcset="assets/feature-wall/26-durability-and-resume.gif" type="image/gif">
<img src="assets/feature-wall/26-durability-and-resume.jpg" alt="The Atomic resume picker after a killed run, listing retained workflow runs with their checkpoint counts" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Human-in-the-loop gates</h4>
<p>Put an approval gate anywhere in the graph and the run waits for a person before it proceeds.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#64-human-in-the-loop-gates"><sub>Crash course · 6.4 Human-in-the-loop gates</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#64-human-in-the-loop-gates">
<picture>
<source srcset="assets/feature-wall/25-human-in-the-loop-gates.gif" type="image/gif">
<img src="assets/feature-wall/25-human-in-the-loop-gates.jpg" alt="A workflow run pausing at a human approval gate and waiting for the operator's decision" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Planner-worker intercom coordination</h4>
<p>Separate sessions message each other over intercom to split a job and agree on the answer.</p>
<p><a href="https://docs.bastani.ai/intercom"><sub>Atomic docs · Intercom</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#53-plannerworker-intercom-coordination"><sub>Crash course · 5.3 Planner-worker intercom coordination</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#53-plannerworker-intercom-coordination">
<picture>
<source srcset="assets/feature-wall/18-planner-worker-intercom.gif" type="image/gif">
<img src="assets/feature-wall/18-planner-worker-intercom.jpg" alt="Two Atomic sessions coordinating over intercom, one sending a question and the other replying" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Verification built in</h4>
<p>Executable checks and fresh reviewers produce evidence; failures route into bounded repair until the gate passes.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#66-security-review-with-a-repair-loop"><sub>Crash course · 6.6 Security review with a repair loop</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#66-security-review-with-a-repair-loop">
<picture>
<source srcset="assets/feature-wall/27-security-review-repair-loop.gif" type="image/gif">
<img src="assets/feature-wall/27-security-review-repair-loop.jpg" alt="Atomic security-review workflow graph with the hardcoded API key audit finding, repair-1 running, and the header reaching four-of-four complete" width="100%">
</picture>
</a>
</td>
</tr>
</table>

<p><a href="#more-atomic-capabilities"><strong>Explore 32 more Atomic capabilities ↓</strong></a></p>

<!-- feature-wall:featured:end -->

Build your process as workflows with scoped context, model choice, tools, handoffs, artifacts, retries, executable checks, review gates, and human approvals.

Atomic’s primitives are built for the software engineering lifecycle. Verification is built into the execution model.

Atomic is open so you can inspect and adapt it. You own the workflow, the evidence, and the rules for completion.

Own your intelligence. Build in the open. Question the defaults. Keep control of the process. ☠︎

<!-- readme-badges:start -->

### Works with your engineering stack

<p align="center">
  <a href="https://github.com/"><img src="assets/readme-badges/stack/github.svg" alt="Connect Atomic with GitHub"></a>
  <a href="https://gitlab.com/"><img src="assets/readme-badges/stack/gitlab.svg" alt="Connect Atomic with GitLab"></a>
  <a href="https://git-scm.com/"><img src="assets/readme-badges/stack/git.svg" alt="Use Git with Atomic"></a>
  <a href="https://www.atlassian.com/software/jira"><img src="assets/readme-badges/stack/jira.svg" alt="Connect Atomic with Jira"></a>
  <a href="https://linear.app/"><img src="assets/readme-badges/stack/linear.svg" alt="Connect Atomic with Linear"></a>
  <a href="https://www.notion.so/"><img src="assets/readme-badges/stack/notion.svg" alt="Connect Atomic with Notion"></a>
  <a href="https://slack.com/"><img src="assets/readme-badges/stack/slack.svg" alt="Connect Atomic with Slack"></a>
  <a href="https://www.docker.com/"><img src="assets/readme-badges/stack/docker.svg" alt="Use Docker with Atomic"></a>
  <a href="https://kubernetes.io/"><img src="assets/readme-badges/stack/kubernetes.svg" alt="Use Kubernetes with Atomic"></a>
  <a href="https://aws.amazon.com/"><img src="assets/readme-badges/stack/aws.svg" alt="Connect Atomic with AWS"></a>
  <a href="https://cloud.google.com/"><img src="assets/readme-badges/stack/google-cloud.svg" alt="Connect Atomic with Google Cloud"></a>
  <a href="https://azure.microsoft.com/"><img src="assets/readme-badges/stack/azure.svg" alt="Connect Atomic with Azure"></a>
  <a href="https://sentry.io/"><img src="assets/readme-badges/stack/sentry.svg" alt="Connect Atomic with Sentry"></a>
  <a href="https://www.datadoghq.com/"><img src="assets/readme-badges/stack/datadog.svg" alt="Connect Atomic with Datadog"></a>
  <a href="https://www.postgresql.org/"><img src="assets/readme-badges/stack/postgresql.svg" alt="Use PostgreSQL with Atomic"></a>
  <a href="https://playwright.dev/"><img src="assets/readme-badges/stack/playwright.svg" alt="Use Playwright with Atomic"></a>
  <a href="https://www.google.com/chrome/"><img src="assets/readme-badges/stack/chrome.svg" alt="Use Chrome with Atomic"></a>
  <a href="https://modelcontextprotocol.io/"><img src="assets/readme-badges/stack/mcp.svg" alt="Connect Atomic through MCP servers"></a>
  <a href="https://docs.bastani.ai/extensions"><img src="assets/readme-badges/stack/any-cli-or-api.svg" alt="Connect Atomic with any CLI or API"></a>
</p>

Atomic connects through installed CLIs, MCP servers, APIs, scripts, and custom extensions; you supply the credentials and permissions.

### Works with your models

<p align="center">
  <a href="https://platform.openai.com/docs/"><img src="assets/readme-badges/providers/openai.svg" alt="OpenAI provider badge for Atomic"></a>
  <a href="https://docs.anthropic.com/"><img src="assets/readme-badges/providers/anthropic.svg" alt="Anthropic provider badge for Atomic"></a>
  <a href="https://github.com/features/copilot"><img src="assets/readme-badges/providers/github-copilot.svg" alt="GitHub Copilot provider badge for Atomic"></a>
  <a href="https://openrouter.ai/"><img src="assets/readme-badges/providers/openrouter.svg" alt="OpenRouter provider badge for Atomic"></a>
  <a href="https://www.kimi.com/code"><img src="assets/readme-badges/providers/kimi.svg" alt="Kimi provider badge for Atomic"></a>
  <a href="https://x.ai/api"><img src="assets/readme-badges/providers/xai.svg" alt="xAI provider badge for Atomic"></a>
  <a href="https://radius.pi.dev/"><img src="assets/readme-badges/providers/radius.svg" alt="Radius provider badge for Atomic"></a>
  <a href="https://www.ant-ling.com/en/"><img src="assets/readme-badges/providers/ant-ling.svg" alt="Ant Ling provider badge for Atomic"></a>
  <a href="https://azure.microsoft.com/en-us/products/ai-services/openai-service"><img src="assets/readme-badges/providers/azure-openai.svg" alt="Azure OpenAI provider badge for Atomic"></a>
  <a href="https://aws.amazon.com/bedrock/"><img src="assets/readme-badges/providers/amazon-bedrock.svg" alt="Amazon Bedrock provider badge for Atomic"></a>
  <a href="https://platform.deepseek.com/"><img src="assets/readme-badges/providers/deepseek.svg" alt="DeepSeek provider badge for Atomic"></a>
  <a href="https://build.nvidia.com/"><img src="assets/readme-badges/providers/nvidia-nim.svg" alt="NVIDIA NIM provider badge for Atomic"></a>
  <a href="https://ai.google.dev/gemini-api"><img src="assets/readme-badges/providers/google-gemini.svg" alt="Google Gemini provider badge for Atomic"></a>
  <a href="https://cloud.google.com/vertex-ai"><img src="assets/readme-badges/providers/google-vertex-ai.svg" alt="Google Vertex AI provider badge for Atomic"></a>
  <a href="https://mistral.ai/"><img src="assets/readme-badges/providers/mistral.svg" alt="Mistral provider badge for Atomic"></a>
  <a href="https://groq.com/"><img src="assets/readme-badges/providers/groq.svg" alt="Groq provider badge for Atomic"></a>
  <a href="https://inference-docs.cerebras.ai/"><img src="assets/readme-badges/providers/cerebras.svg" alt="Cerebras provider badge for Atomic"></a>
  <a href="https://developers.cloudflare.com/ai/"><img src="assets/readme-badges/providers/cloudflare-ai.svg" alt="Cloudflare AI provider badge for Atomic"></a>
  <a href="https://vercel.com/ai-gateway"><img src="assets/readme-badges/providers/vercel-ai-gateway.svg" alt="Vercel AI Gateway provider badge for Atomic"></a>
  <a href="https://z.ai/model-api"><img src="assets/readme-badges/providers/z-ai.svg" alt="Z.ai provider badge for Atomic"></a>
  <a href="https://opencode.ai/"><img src="assets/readme-badges/providers/opencode.svg" alt="OpenCode provider badge for Atomic"></a>
  <a href="https://huggingface.co/"><img src="assets/readme-badges/providers/hugging-face.svg" alt="Hugging Face provider badge for Atomic"></a>
  <a href="https://fireworks.ai/"><img src="assets/readme-badges/providers/fireworks-ai.svg" alt="Fireworks AI provider badge for Atomic"></a>
  <a href="https://www.together.ai/"><img src="assets/readme-badges/providers/together-ai.svg" alt="Together AI provider badge for Atomic"></a>
  <a href="https://www.minimax.io/"><img src="assets/readme-badges/providers/minimax.svg" alt="MiniMax provider badge for Atomic"></a>
  <a href="https://www.moonshot.ai/"><img src="assets/readme-badges/providers/moonshot-ai.svg" alt="Moonshot AI provider badge for Atomic"></a>
  <a href="https://qwen.ai/"><img src="assets/readme-badges/providers/qwen.svg" alt="Qwen provider badge for Atomic"></a>
  <a href="https://platform.xiaomimimo.com/"><img src="assets/readme-badges/providers/xiaomi-mimo.svg" alt="Xiaomi MiMo provider badge for Atomic"></a>
</p>

See [provider setup and the current catalog](https://docs.bastani.ai/providers). Availability depends on your credentials, subscription, region, and the provider catalog; one login does not unlock every provider.

#### Local and open models

<p align="center">
  <a href="https://github.com/ggml-org/llama.cpp"><img src="assets/readme-badges/local/llama-cpp.svg" alt="llama.cpp local model server badge for Atomic"></a>
  <a href="https://ollama.com/"><img src="assets/readme-badges/local/ollama.svg" alt="Ollama local model server badge for Atomic"></a>
  <a href="https://lmstudio.ai/"><img src="assets/readme-badges/local/lm-studio.svg" alt="LM Studio local model server badge for Atomic"></a>
  <a href="https://docs.vllm.ai/"><img src="assets/readme-badges/local/vllm.svg" alt="vLLM local model server badge for Atomic"></a>
  <a href="https://github.com/sgl-project/sglang"><img src="assets/readme-badges/local/sglang.svg" alt="SGLang local model server badge for Atomic"></a>
  <a href="https://huggingface.co/"><img src="assets/readme-badges/local/hugging-face.svg" alt="Hugging Face model hosting badge for Atomic"></a>
  <a href="https://www.llama.com/"><img src="assets/readme-badges/local/llama.svg" alt="Llama open model family badge for Atomic"></a>
  <a href="https://ai.google.dev/gemma"><img src="assets/readme-badges/local/gemma.svg" alt="Gemma open model family badge for Atomic"></a>
  <a href="https://github.com/deepseek-ai/"><img src="assets/readme-badges/local/deepseek.svg" alt="DeepSeek open model family badge for Atomic"></a>
  <a href="https://qwen.ai/"><img src="assets/readme-badges/local/qwen.svg" alt="Qwen open model family badge for Atomic"></a>
  <a href="https://github.com/MoonshotAI/"><img src="assets/readme-badges/local/kimi.svg" alt="Kimi open model family badge for Atomic"></a>
  <a href="https://github.com/zai-org/GLM-4.5"><img src="assets/readme-badges/local/glm.svg" alt="GLM open model family badge for Atomic"></a>
  <a href="https://mistral.ai/models/"><img src="assets/readme-badges/local/mistral.svg" alt="Mistral open model family badge for Atomic"></a>
  <a href="https://github.com/MiniMax-AI/"><img src="assets/readme-badges/local/minimax.svg" alt="MiniMax open model family badge for Atomic"></a>
  <a href="https://openai.com/open-models/"><img src="assets/readme-badges/local/gpt-oss.svg" alt="gpt-oss open model family badge for Atomic"></a>
</p>

Atomic can run tool-capable models exposed through llama.cpp, Ollama, LM Studio, vLLM, SGLang, Hugging Face, or a compatible OpenAI, Anthropic, or Google endpoint. Actual model and tool support depends on the server and model.

The model-family badges are representative open families, not a closed allowlist. See [Models](https://docs.bastani.ai/models) and [llama.cpp](https://docs.bastani.ai/llama-cpp).

<!-- readme-badges:end -->
---

## Get started

### Prerequisites

- **Package install:** Node.js 22.19 or newer plus npm, pnpm, Yarn, or Bun. Use Bun 1.4.0+ for Bun installs or workflow-authoring examples.
- **Release archive install:** macOS and Linux need `tar` and either `curl` or `wget`. Windows uses built-in PowerShell commands. This path does not need Node.js or a package manager.
- **Model-provider access** — use a supported subscription login or API key.

### Install

Install with npm:

```bash
npm install -g @bastani/atomic
```

With pnpm:

```bash
pnpm add -g @bastani/atomic
```

With Bun:

```bash
bun add -g @bastani/atomic
```

Atomic does not require package install scripts. Add `--ignore-scripts` to a package install command if you want to disable dependency lifecycle scripts.

Alternatively, install the self-contained release archive, which needs no Node.js or package manager.

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

On Windows, run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The archive installer verifies `SHA256SUMS`, keeps versioned payloads, and links its launcher from `~/.local/bin/atomic` on macOS/Linux or `%LOCALAPPDATA%\atomic\bin\atomic.cmd` on Windows, printing PATH guidance when needed. It accepts a few environment variables:

- `ATOMIC_VERSION` — pin an exact release tag.
- `ATOMIC_INSTALL_DIR` / `ATOMIC_BIN_DIR` — change the install and launcher locations. On macOS/Linux, relative directories resolve against the physical directory where the installer starts.
- `GITHUB_TOKEN` / `GH_TOKEN` — optional; raises GitHub API limits on shared networks.

The Linux musl archives bundle their C++ runtime libraries and run on stock Alpine without an `apk add` step; Android and Termux remain unsupported. See the [Quickstart](https://docs.bastani.ai/quickstart) for path-resolution and Windows `PATHEXT` details.

### Authenticate and run

Start Atomic:
```bash
atomic
```
Login. Atomic supports subscription login for Codex, Claude, GitHub Copilot, xAI, as well as API-key providers such as OpenRouter:

```bash
/login   # then select your provider
```

Claude login from a third-party harness uses Anthropic extra usage billed per token rather than Claude plan limits. See [Providers & Models](./packages/coding-agent/README.md#providers--models) for integration details.

Missing a provider? [Open an issue](https://github.com/bastani-inc/atomic/issues/new) or contribute an integration.

For API-key setup, export the key before starting Atomic:

```bash
export OPENROUTER_API_KEY=sk-or-...
atomic
```

Atomic stores provider credentials in `~/.atomic/agent/auth.json` and creates the file with owner-only permissions where the platform supports them. For non-interactive use, `atomic -p "<prompt>"` prints the response and exits.

After authenticating, run `/atomic` for workflow guides, examples, and next steps. A fresh install also shows a one-time workflow-engine introduction.

> ⚠️ Atomic has no built-in sandbox or command-level shell permission gate. Tools and extensions run with your user permissions. Run autonomous work inside a devcontainer, VM, or remote development machine—not on a host with sensitive data or credentials.

<details>
<summary><b>Devcontainer, terminal, and SDK references</b></summary>

Atomic runs in a standard devcontainer or VM. Use the release-archive installer for an image without Node.js or npm, or install Node.js 22.19+ and use a package manager. Pass provider credentials through environment variables.

See [Terminal setup](./packages/coding-agent/docs/terminal-setup.md), [Security](./packages/coding-agent/docs/security.md), and [Programmatic Usage](./packages/coding-agent/README.md#programmatic-usage) for the SDK and RPC entry points.

</details>

### Bring your skill stack

Already have agent skills? Bring them into Atomic by pointing Atomic at their existing directories or placing them in its project or user skill locations. Atomic implements the Agent Skills standard, and configured Claude Code or Codex skill directories can be used without rewriting them. See [Skills](./packages/coding-agent/docs/skills.md#using-skills-from-other-harnesses).

When a skill captures a repeatable process, ask Atomic to author it as a durable workflow. Atomic inspects the skill and writes reviewable TypeScript using the [workflow guide](./packages/coding-agent/docs/workflows.md) and its examples.

```text
Inspect the existing skill `<skill-name-or-path>`—including its SKILL.md, scripts, references, and assets—and consult Atomic’s workflow docs and runnable TypeScript examples; then author a reusable TypeScript `workflow({...})` that preserves the skill’s intent while turning its repeatable process into durable multi-stage execution with precise typed inputs and declared outputs, artifact-backed handoffs for substantial context, explicit validation gates, and bounded retries or stop conditions where appropriate; add and run representative tests or smoke cases for the applicable success, validation-failure, and retry/stop paths, reload and verify workflow discovery, and ask me only questions whose answers materially change the design—otherwise state sensible assumptions and proceed.
```

### Migrating from another coding agent

Atomic publishes an agent-readable **[`llms.txt`](https://docs.bastani.ai/llms.txt)**. Ask your current coding agent to:

```text
Install and set up Atomic by following https://docs.bastani.ai/llms.txt.
```

<!-- feature-wall:more:start -->

## More Atomic capabilities

Explore the rest of Atomic’s real recorded capabilities, with public docs and crash-course links for each one.

<table>
<tr>
<td width="42%" valign="top">
<h4>Launch a workflow in plain English</h4>
<p>Ask in normal chat and Atomic routes the request through its workflow tool into a real registered run - no command syntax required.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#part-6--workflows"><sub>Crash course · W.1 Launch a workflow in plain English</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#part-6--workflows">
<picture>
<source srcset="assets/feature-wall/28-launch-workflow-plain-english.gif" type="image/gif">
<img src="assets/feature-wall/28-launch-workflow-plain-english.jpg" alt="Atomic receiving a normal chat request and launching the registered plain-english-demo workflow through the real workflow tool" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Autonomous implementation loops</h4>
<p><code>ralph</code> refines, researches, implements, reviews, and repairs against a bounded loop contract.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a10-autonomous-implementation-loops"><sub>Crash course · A.10 Autonomous implementation loops</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a10-autonomous-implementation-loops">
<picture>
<source srcset="assets/feature-wall/40-autonomous-implementation-loops.gif" type="image/gif">
<img src="assets/feature-wall/40-autonomous-implementation-loops.jpg" alt="Atomic inspecting the ralph contract, launching a one-loop validation task, and opening its live research-first workflow graph" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Inspect and control workflows</h4>
<p>List definitions, inspect input contracts, check live status, and connect to a run graph from the same <code>/workflow</code> surface.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins"><sub>Crash course · W.3 Inspect and control workflows</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins">
<picture>
<source srcset="assets/feature-wall/30-inspect-control-workflows.gif" type="image/gif">
<img src="assets/feature-wall/30-inspect-control-workflows.jpg" alt="Atomic using workflow list, inputs, status, and connect commands before opening the live control-demo graph" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Worktree-isolated parallel work</h4>
<p>Parallel agents each get their own git worktree, so concurrent edits cannot collide.</p>
<p><a href="https://docs.bastani.ai/subagents"><sub>Atomic docs · Subagents</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#52-worktree-isolated-parallel-work"><sub>Crash course · 5.2 Worktree-isolated parallel work</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#52-worktree-isolated-parallel-work">
<picture>
<source srcset="assets/feature-wall/17-worktree-parallel-work.gif" type="image/gif">
<img src="assets/feature-wall/17-worktree-parallel-work.jpg" alt="Atomic running parallel subagents in separate git worktrees and reporting a per-worktree diff" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Escalating to a human supervisor</h4>
<p>A delegate that hits a real product decision stops, asks the human supervising the run, and waits for the answer.</p>
<p><a href="https://docs.bastani.ai/intercom"><sub>Atomic docs · Intercom</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#54-escalating-to-a-human-supervisor"><sub>Crash course · 5.4 Escalating to a human supervisor</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#54-escalating-to-a-human-supervisor">
<picture>
<source srcset="assets/feature-wall/19-escalate-to-supervisor.gif" type="image/gif">
<img src="assets/feature-wall/19-escalate-to-supervisor.jpg" alt="One Atomic session escalating a null-email decision to its human supervisor over intercom, then applying the answer it receives" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Nesting builtin workflows</h4>
<p>Compose imported workflow definitions with <code>ctx.workflow(...)</code>; child stages flatten into one inspectable parent graph.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a9-nesting-builtin-workflows"><sub>Crash course · A.9 Nesting builtin workflows</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a9-nesting-builtin-workflows">
<picture>
<source srcset="assets/feature-wall/39-nesting-builtin-workflows.gif" type="image/gif">
<img src="assets/feature-wall/39-nesting-builtin-workflows.jpg" alt="Atomic showing nested fan-out builtin stages flattened into the live research-and-verify parent workflow graph" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Intercom context handoff</h4>
<p>Hand a task to another session with the context attached, instead of pasting it by hand.</p>
<p><a href="https://docs.bastani.ai/intercom"><sub>Atomic docs · Intercom</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#55-intercom-context-handoff"><sub>Crash course · 5.5 Intercom context handoff</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#55-intercom-context-handoff">
<picture>
<source srcset="assets/feature-wall/20-intercom-context-handoff.gif" type="image/gif">
<img src="assets/feature-wall/20-intercom-context-handoff.jpg" alt="One Atomic session handing a task to another over intercom with file and snippet attachments" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Delegating to bundled specialists</h4>
<p>Fan work out to scoped subagents that do the reading, so the main context stays small.</p>
<p><a href="https://docs.bastani.ai/subagents"><sub>Atomic docs · Subagents</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#51-delegating-to-bundled-specialists"><sub>Crash course · 5.1 Delegating to bundled specialists</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#51-delegating-to-bundled-specialists">
<picture>
<source srcset="assets/feature-wall/16-bundled-specialists.gif" type="image/gif">
<img src="assets/feature-wall/16-bundled-specialists.jpg" alt="Atomic delegating to bundled specialist subagents and collecting their findings" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Writing your own workflow</h4>
<p>Stages, schemas, and gates are versioned TypeScript you review, not per-run improvisation.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#63-writing-your-own-workflow"><sub>Crash course · 6.3 Writing your own workflow</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#63-writing-your-own-workflow">
<picture>
<source srcset="assets/feature-wall/24-write-your-own-workflow.gif" type="image/gif">
<img src="assets/feature-wall/24-write-your-own-workflow.jpg" alt="A project-local workflow defined in TypeScript with stages and an output schema, then run by Atomic" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Touring the builtins</h4>
<p>Bundled workflows for research, planning, implementation, and review, ready before you write one.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins"><sub>Crash course · 6.1 Touring the builtins</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins">
<picture>
<source srcset="assets/feature-wall/22-touring-the-builtins.gif" type="image/gif">
<img src="assets/feature-wall/22-touring-the-builtins.jpg" alt="The Atomic workflow picker listing the bundled workflows and their stages" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Run a workflow with typed inputs</h4>
<p>Use <code>/workflow &lt;name&gt; key=value</code> to validate static inputs against TypeBox before a run starts.</p>
<p><a href="https://docs.bastani.ai/workflows"><sub>Atomic docs · Workflows</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins"><sub>Crash course · W.2 Run a workflow with typed inputs</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#61-touring-the-builtins">
<picture>
<source srcset="assets/feature-wall/29-workflow-typed-inputs.gif" type="image/gif">
<img src="assets/feature-wall/29-workflow-typed-inputs.jpg" alt="Atomic showing the typed-input-demo input contract, launching it with a string path and integer depth, and listing its live run status" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Verbatim compaction</h4>
<p>Compaction deletes low-value transcript lines without rewriting what survives; <code>&lt;keepContext&gt;</code> pins exact text.</p>
<p><a href="https://docs.bastani.ai/compaction"><sub>Atomic docs · Compaction</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#22-verbatim-compaction"><sub>Crash course · 2.2 Verbatim compaction</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#22-verbatim-compaction">
<picture>
<source srcset="assets/feature-wall/06-verbatim-compaction.gif" type="image/gif">
<img src="assets/feature-wall/06-verbatim-compaction.jpg" alt="Atomic answering after compaction by quoting the pinned keepContext repo rule back byte-exact" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Hashline edits</h4>
<p>Edits are anchored to a 4-hex snapshot tag, so a file that changed behind the model's back fails loudly instead of being overwritten.</p>
<p><a href="https://docs.bastani.ai/tools"><sub>Atomic docs · Built-in tools</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#12-hashline-edits"><sub>Crash course · 1.2 Hashline edits</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#12-hashline-edits">
<picture>
<source srcset="assets/feature-wall/02-hashline-edits.gif" type="image/gif">
<img src="assets/feature-wall/02-hashline-edits.jpg" alt="Atomic applying a hashline edit anchored to a snapshot tag, showing the replace operation and the fresh tag it returns" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>The agent interviews you</h4>
<p><code>ask_user_question</code> replaces the editor with a structured question UI mid-task, and your answers land in the transcript as data.</p>
<p><a href="https://docs.bastani.ai/tools"><sub>Atomic docs · Built-in tools</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#13-the-agent-interviews-you"><sub>Crash course · 1.3 The agent interviews you</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#13-the-agent-interviews-you">
<picture>
<source srcset="assets/feature-wall/03-agent-interviews-you.gif" type="image/gif">
<img src="assets/feature-wall/03-agent-interviews-you.jpg" alt="Atomic replacing the editor with a structured multiple-choice question UI that asks which config format to use" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Permission gate extension</h4>
<p>A <code>tool_call</code> hook catches a risky shell call before execution and asks the operator to allow or block it.</p>
<p><a href="https://docs.bastani.ai/extensions"><sub>Atomic docs · Extensions</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a2-permission-gate-extension"><sub>Crash course · A.2 Permission gate extension</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a2-permission-gate-extension">
<picture>
<source srcset="assets/feature-wall/32-permission-gate-extension.gif" type="image/gif">
<img src="assets/feature-wall/32-permission-gate-extension.jpg" alt="Atomic opening the permission-gate extension select dialog for sudo echo hi and blocking the bash tool call when No is chosen" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Block a dangerous command</h4>
<p>A tool-call hook inspects the arguments and rejects the call before it ever reaches your shell.</p>
<p><a href="https://docs.bastani.ai/extensions"><sub>Atomic docs · Extensions</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#32-block-a-dangerous-command"><sub>Crash course · 3.2 Block a dangerous command</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#32-block-a-dangerous-command">
<picture>
<source srcset="assets/feature-wall/09-block-a-dangerous-command.gif" type="image/gif">
<img src="assets/feature-wall/09-block-a-dangerous-command.jpg" alt="Atomic refusing a destructive shell command because a project-local hook rejected the tool call" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Full-screen TUI tool</h4>
<p>An extension can take over the whole screen with its own interactive component, then hand control back.</p>
<p><a href="https://docs.bastani.ai/tui"><sub>Atomic docs · TUI components</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#33-full-screen-tui-tool"><sub>Crash course · 3.3 Full-screen TUI tool</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#33-full-screen-tui-tool">
<picture>
<source srcset="assets/feature-wall/10-full-screen-tui-tool.gif" type="image/gif">
<img src="assets/feature-wall/10-full-screen-tui-tool.jpg" alt="A project-local extension taking over the Atomic screen with its own full-screen interactive component" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Embed the agent with the SDK</h4>
<p>Drive the same agent loop from your own TypeScript program, with your own tools and your own UI.</p>
<p><a href="https://docs.bastani.ai/sdk"><sub>Atomic docs · SDK</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#43-embed-the-agent-with-the-sdk"><sub>Crash course · 4.3 Embed the agent with the SDK</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#43-embed-the-agent-with-the-sdk">
<picture>
<source srcset="assets/feature-wall/15-embed-with-the-sdk.gif" type="image/gif">
<img src="assets/feature-wall/15-embed-with-the-sdk.jpg" alt="A TypeScript program using the Atomic SDK to run the agent loop and print its streamed output" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Build an extension</h4>
<p>Drop a TypeScript file into <code>.atomic/extensions/</code> and the agent gains a new tool in the running session.</p>
<p><a href="https://docs.bastani.ai/extensions"><sub>Atomic docs · Extensions</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#31-build-an-extension"><sub>Crash course · 3.1 Build an extension</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#31-build-an-extension">
<picture>
<source srcset="assets/feature-wall/08-build-an-extension.gif" type="image/gif">
<img src="assets/feature-wall/08-build-an-extension.jpg" alt="Atomic writing a project-local extension and then calling the new tool it registered" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Write a skill</h4>
<p>A <code>SKILL.md</code> file teaches the agent a procedure it loads on demand - the same format Claude Code and Codex use.</p>
<p><a href="https://docs.bastani.ai/skills"><sub>Atomic docs · Skills</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#34-write-a-skill"><sub>Crash course · 3.4 Write a skill</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#34-write-a-skill">
<picture>
<source srcset="assets/feature-wall/11-write-a-skill.gif" type="image/gif">
<img src="assets/feature-wall/11-write-a-skill.jpg" alt="Atomic discovering a project-local SKILL.md and following the procedure it describes" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Local models via models.json</h4>
<p>Point Atomic at Ollama or any OpenAI-compatible endpoint by declaring it in <code>models.json</code>.</p>
<p><a href="https://docs.bastani.ai/models"><sub>Atomic docs · Custom models</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#42-local-models-via-modelsjson"><sub>Crash course · 4.2 Local models via models.json</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#42-local-models-via-modelsjson">
<picture>
<source srcset="assets/feature-wall/14-local-models.gif" type="image/gif">
<img src="assets/feature-wall/14-local-models.jpg" alt="A models.json entry declaring a local OpenAI-compatible endpoint, and Atomic listing the model it adds" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Headless print and JSON mode</h4>
<p><code>-p</code> prints one answer and exits; <code>--mode json</code> streams structured events, so Atomic drops into scripts and CI.</p>
<p><a href="https://docs.bastani.ai/json"><sub>Atomic docs · JSON event stream</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#41-headless-print-and-json-mode"><sub>Crash course · 4.1 Headless print and JSON mode</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#41-headless-print-and-json-mode">
<picture>
<source srcset="assets/feature-wall/13-headless-print-and-json.gif" type="image/gif">
<img src="assets/feature-wall/13-headless-print-and-json.jpg" alt="Atomic running headless with -p printing a single answer, then with --mode json streaming structured events" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Branching with tree, fork, clone</h4>
<p>Fork a session at any point and try a second approach without losing the first; <code>/tree</code> shows the whole shape.</p>
<p><a href="https://docs.bastani.ai/sessions"><sub>Atomic docs · Sessions</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#21-branching-with-tree-fork-clone"><sub>Crash course · 2.1 Branching with tree, fork, clone</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#21-branching-with-tree-fork-clone">
<picture>
<source srcset="assets/feature-wall/05-branching-tree-fork-clone.gif" type="image/gif">
<img src="assets/feature-wall/05-branching-tree-fork-clone.jpg" alt="Atomic showing the session tree after a fork, with the branch points listed" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Sessions are just JSONL</h4>
<p>Every session is an append-only JSONL file on disk, so you can grep it, diff it, and script against it.</p>
<p><a href="https://docs.bastani.ai/session-format"><sub>Atomic docs · Session format</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#23-sessions-are-just-jsonl"><sub>Crash course · 2.3 Sessions are just JSONL</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#23-sessions-are-just-jsonl">
<picture>
<source srcset="assets/feature-wall/07-sessions-are-jsonl.gif" type="image/gif">
<img src="assets/feature-wall/07-sessions-are-jsonl.jpg" alt="Atomic walking its own session JSONL one event per line, showing each event's type, id, and parent id" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Your first session</h4>
<p>One editor for prompts, <code>@</code> file references, and <code>!</code> shell commands, with steering you can type while the agent works.</p>
<p><a href="https://docs.bastani.ai/usage"><sub>Atomic docs · Using Atomic</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#11-your-first-session"><sub>Crash course · 1.1 Your first session</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#11-your-first-session">
<picture>
<source srcset="assets/feature-wall/01-first-session.gif" type="image/gif">
<img src="assets/feature-wall/01-first-session.jpg" alt="Atomic session answering a question about greeter.ts through an @ file reference, then running the file with an inline ! shell command" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>File-based todos</h4>
<p>Plans are durable files under <code>.atomic/todos/</code>: plain text you can grep, review, and commit alongside the code.</p>
<p><a href="https://docs.bastani.ai/tools"><sub>Atomic docs · Built-in tools</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#14-file-based-todos"><sub>Crash course · 1.4 File-based todos</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#14-file-based-todos">
<picture>
<source srcset="assets/feature-wall/04-file-based-todos.gif" type="image/gif">
<img src="assets/feature-wall/04-file-based-todos.jpg" alt="Atomic creating todos with the todo tool and then listing the resulting plain-text files under .atomic/todos" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>A handoff command of your own</h4>
<p>Package a repeatable handoff as a project-local slash command your whole team can run.</p>
<p><a href="https://docs.bastani.ai/prompt-templates"><sub>Atomic docs · Prompt templates</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#56-a-handoff-command-of-your-own"><sub>Crash course · 5.6 A handoff command of your own</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#56-a-handoff-command-of-your-own">
<picture>
<source srcset="assets/feature-wall/21-your-own-handoff-command.gif" type="image/gif">
<img src="assets/feature-wall/21-your-own-handoff-command.jpg" alt="A project-local slash command running a packaged intercom handoff from the Atomic editor" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Intercom group isolation</h4>
<p>Sessions in different groups cannot message each other; only an explicit read-only group peek crosses the boundary.</p>
<p><a href="https://docs.bastani.ai/intercom"><sub>Atomic docs · Intercom</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a7-intercom-group-isolation"><sub>Crash course · A.7 Intercom group isolation</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a7-intercom-group-isolation">
<picture>
<source srcset="assets/feature-wall/37-intercom-group-isolation.gif" type="image/gif">
<img src="assets/feature-wall/37-intercom-group-isolation.jpg" alt="Two Atomic sessions in separate Intercom groups, with the default session peeking at redteam before its cross-group send is rejected" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Prompt templates with arguments</h4>
<p>Project Markdown becomes a slash command with autocomplete hints and positional argument expansion.</p>
<p><a href="https://docs.bastani.ai/prompt-templates"><sub>Atomic docs · Prompt templates</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a4-prompt-templates-with-arguments"><sub>Crash course · A.4 Prompt templates with arguments</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a4-prompt-templates-with-arguments">
<picture>
<source srcset="assets/feature-wall/34-prompt-templates-arguments.gif" type="image/gif">
<img src="assets/feature-wall/34-prompt-templates-arguments.jpg" alt="Atomic finding the project component prompt template and expanding Button, onClick handler, and disabled support into the submitted prompt" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Runtime system-prompt mutation</h4>
<p>A live command toggles extension state, and <code>before_agent_start</code> rewrites the system prompt on the next turn.</p>
<p><a href="https://docs.bastani.ai/extensions"><sub>Atomic docs · Extensions</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a3-runtime-system-prompt-mutation"><sub>Crash course · A.3 Runtime system-prompt mutation</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a3-runtime-system-prompt-mutation">
<picture>
<source srcset="assets/feature-wall/33-runtime-system-prompt.gif" type="image/gif">
<img src="assets/feature-wall/33-runtime-system-prompt.jpg" alt="Atomic enabling the shipped pirate extension at runtime and answering the next TypeScript question with the mutated system prompt" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Keybindings and hot reload</h4>
<p>Every TUI action is remappable in global JSON; <code>/reload</code> applies the map without restarting the session.</p>
<p><a href="https://docs.bastani.ai/keybindings"><sub>Atomic docs · Keybindings</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#a1-keybindings-and-hot-reload"><sub>Crash course · A.1 Keybindings and hot reload</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#a1-keybindings-and-hot-reload">
<picture>
<source srcset="assets/feature-wall/31-keybindings-hot-reload.gif" type="image/gif">
<img src="assets/feature-wall/31-keybindings-hot-reload.jpg" alt="Atomic listing hotkey action ids, reloading a global keybinding map, and showing Ctrl+J insert a newline in the editor" width="100%">
</picture>
</a>
</td>
</tr>
<tr>
<td width="42%" valign="top">
<h4>Custom theme</h4>
<p>Theme the entire TUI from a project-local file and switch to it live with <code>/theme</code>.</p>
<p><a href="https://docs.bastani.ai/themes"><sub>Atomic docs · Themes</sub></a></p>
<p><a href="https://github.com/bastani-inc/atomic-crash-course#35-custom-theme"><sub>Crash course · 3.5 Custom theme</sub></a></p>
</td>
<td width="58%" valign="top">
<a href="https://github.com/bastani-inc/atomic-crash-course#35-custom-theme">
<picture>
<source srcset="assets/feature-wall/12-custom-theme.gif" type="image/gif">
<img src="assets/feature-wall/12-custom-theme.jpg" alt="Atomic displaying project-local theme JSON and offering my-theme in the live theme picker" width="100%">
</picture>
</a>
</td>
</tr>
</table>

<!-- feature-wall:more:end -->

---

## How Atomic works

Atomic is the runtime. Workflows encode durable processes through stages, tools, prompts, checks, artifacts, gates, and approvals. Skills supply reusable expert instructions. Specialized subagents handle focused work while a parent agent or workflow controls the larger task.

Atomic is a fork of Pi, so it works with the providers, tools, MCP servers, skills, and extensions already in your Pi stack.

Workflow stage dependencies must form a directed acyclic graph. Because imperative `workflow({ run })` definitions materialize topology from runtime branches, loops, and nested calls, module discovery cannot prove arbitrary acyclicity. Cyclic workflow graphs are unsupported: authored loop and repair iterations must create distinct tracked work per iteration and must never create self-edges or back-edges to ancestors. Retries within one `ctx.tool(...)` call remain attempts on that tool node rather than separate graph work.

```text
issue or goal → research → plan → agent stages → artifacts → checks → review gate → final output
```

A stage can prompt an agent, run tools, call MCP servers, save artifacts, pass selected output forward, branch, retry, run in parallel, or pause for approval. Model output can vary. The workflow definition makes stage order, inputs, handoffs, configured checks, gates, and artifacts explicit.

Use direct chat for small, interactive work. Use a skill or bounded subagent when the parent should stay in control. Use a workflow when a delegated job needs durable stages, retries, evidence, resumability, or approval gates. Phrases such as “repeat until,” “review and fix until passing,” or “run checks until green” signal that the stop condition should be encoded and bounded.

Atomic can support:

- **Engineering runs** — research, plan, implement, test, review, and release.
- **Debugging and migrations** — reproduce, diagnose, patch, migrate in waves, and verify.
- **Research and triage** — gather context, fan out analysis, classify issues, and synthesize findings.
- **QA, docs, and compliance** — run repeatable checks with evidence and approval points.
- **Custom agent products** — build on Atomic's runtime, SDK, tools, and workflows.

### Examples

Focused codebase research:

```text
/skill:research-codebase how the rate limiter works in src/middleware/
```

Repository-wide research with durable artifacts:

```text
/workflow fan-out-and-synthesize prompt="Partition the repository by subsystem, map every legacy auth middleware callsite, and synthesize cited migration findings"
```

A task-specific implementation and review loop:

```text
Create and run a workflow that implements specs/2026-03-rate-limit.md, runs focused tests, sends the patch to fresh verifiers, and repairs findings until burst traffic returns 429 with Retry-After or the iteration bound is reached.
```

A reviewer-gated run with Goal:

```text
/workflow goal objective="Update the CLI docs for --json, add one example, and validate the docs build"
```

A research-first implementation with Ralph:

```text
/workflow ralph prompt="Implement specs/2026-03-rate-limit.md and validate burst traffic" create_pr=true
```

Use Goal when a durable ledger, receipts, bounded sub-agent orchestration, and reviewer-gated completion fit the task. Use Ralph when the job benefits from prompt refinement, codebase research, delegated implementation, and iterative multi-model review. Both skip PR creation unless `create_pr=true` explicitly authorizes the post-approval final stage.

---

## What you get

Atomic ships three top-level building blocks: workflows, skills, and specialized subagents.

### 1. Workflows

Workflows define inputs, stages, branches, parallelism, retries, checks, artifacts, checkpoints, and human review gates. Atomic can author TypeScript `workflow({...})` definitions, import reusable project or package workflows, and nest workflows with `ctx.workflow(...)` within a configured `maxDepth`.

| Workflow | What it does | Example input |
| --- | --- | --- |
| `fan-out-and-synthesize` | Partitions independent slices, writes branch artifacts, and synthesizes their evidence. | `/workflow fan-out-and-synthesize prompt="Map payment retries by subsystem and synthesize cited findings"` |
| `adversarial-verification` | Challenges a candidate with fresh verifiers and bounded repair. | `/workflow adversarial-verification task="Verify the rate-limit migration patch"` |
| `loop-until-done` | Iterates with a durable ledger until explicit completion evidence or bound exhaustion. | `/workflow loop-until-done prompt="Repair failures until the test suite passes"` |
| `goal` | Runs bounded autonomous implementation with a durable ledger, receipts, parallel review, and reducer-gated completion. | `/workflow goal objective="Update CLI docs and validate the docs build"` |
| `ralph` | Runs research-first delegated implementation with bounded multi-model review and repair. | `/workflow ralph prompt="Implement specs/rate-limit.md" create_pr=true` |
| `open-claude-design` | Gathers requirements and references, discovers the design system, refines output, and exports a handoff. | `/workflow open-claude-design prompt="Team activity feed prototype using ./mocks/feed.png as a reference"` |
| _author your own_ | Issue-to-PR, migration, triage, release, compliance, or another process your team needs. Start with the [workflow guide](./packages/coding-agent/docs/workflows.md). | _“Create a workflow that plans, implements, runs tests and lint, reviews the diff, then stops for approval.”_ |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for input schemas. Use `/workflow status <id>`, `/workflow connect <id>`, `/workflow quit <id>`, and `/workflow resume <id>` to manage runs. Quitting pauses work so it can resume later. Runnable references live in [`packages/coding-agent/examples/`](./packages/coding-agent/examples).

### 2. Skills

Skills are reusable expert instructions and process modules. Atomic can select one from its description, or you can call it with `/skill:<name>`.

| Skill               | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `research-codebase` | Analyze a focused area and write a dated research document.                                  |
| `create-spec`       | Produce a technical execution spec grounded in research and engineer feedback.               |
| `subagent`          | Delegate work through single agents, parallel groups, or forked context.                     |
| `intercom`          | Coordinate parent, child, and peer sessions on the same machine.                             |
| `prompt-engineer`   | Refine prompts, research questions, and workflow inputs.                                     |
| `skill-creator`     | Create, improve, and evaluate reusable skills.                                               |
| `tdd`               | Apply a red-green-refactor loop and testing guidance.                                        |
| `tmux`              | Drive and verify terminal applications.                                                      |
| `playwright-cli`    | Automate browser interactions and end-to-end UI checks.                                      |
| `qlty`              | Lint, auto-format, and measure code quality across 70+ linters via the qlty CLI.              |
| `liteparse`         | Extract text, tables, and values from documents and images.                                  |
| `impeccable`        | Design, audit, and refine frontend interfaces.                                               |
| `show-me`           | Explain topics visually with concise diagrams, code-shape sketches, and focused HTML artifacts (HumanLayer, MIT). |

### 3. Specialized subagents

Subagents are purpose-built agents with scoped context, tools, and termination conditions. Atomic bundles nine definitions from [`packages/subagents/agents/`](./packages/subagents/agents/).

| Subagent                     | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `worker`                     | Implement a bounded task and return a concise result.      |
| `codebase-locator`           | Locate files and components relevant to a task.            |
| `codebase-analyzer`          | Analyze implementation details.                            |
| `codebase-pattern-finder`    | Find similar implementations and usage examples.           |
| `codebase-online-researcher` | Fetch current documentation and authoritative web sources. |
| `codebase-research-locator`  | Find relevant prior research in the repository.            |
| `codebase-research-analyzer` | Extract decisions and rationale from local research.       |
| `code-simplifier`            | Refine recent code without changing behavior.              |
| `debugger`                   | Reproduce, diagnose, and verify fixes for failures.        |

Large, mixed, or growing contexts can make attention harder. Specialized agents reduce that risk through isolation, focus, tool scoping, and deliberate handoffs. Independent tasks can also run in parallel.


---

## Documentation

Full documentation lives at **[docs.bastani.ai](https://docs.bastani.ai/)**. It covers the CLI and SDK, security, containerized execution, workflow authoring and monitoring, session management, configuration, troubleshooting, and provider setup.

The docs live in this repository under [`packages/coding-agent/docs`](./packages/coding-agent/docs). Open a pull request to suggest a change.

## FAQ

### Is Atomic another coding agent?

Atomic includes a coding-agent CLI. Its main product idea is the runtime around the agent session: scoped context, stages, tools, checks, artifacts, checkpoints, subagents, review gates, and human approvals.

### Why not use Claude Code, Codex, or OpenCode?

Use any interactive coding tool that fits the job. Use Atomic when work needs an explicit process you can inspect, version, resume, and verify. Atomic connects to model providers directly rather than running those tools underneath it.

### How is Atomic different from products that fan out many agents?

Atomic can fan work out too. The difference is not whether agents run in parallel; it is whether developers control the context, handoffs, execution graph, evidence, checks, and approval rules around that work. Parallel execution increases throughput. Assurance comes from the process you define and enforce.

### Is Atomic deterministic?

The selected model can produce different output across runs. Workflow structure, stage dependencies, inputs, handoffs, configured checks, gates, and artifact paths are explicit. Deterministic reducers can apply declared approval rules to reviewer output.

### Why not Markdown checklists or `CLAUDE.md`?

Markdown helps set context, but a model still has to follow it. An Atomic workflow runs declared stages and tools, validates configured outputs, records configured artifacts, and applies defined gates.

### Why not LangGraph or a generic agent framework?

Atomic is repo-native and focused on software engineering work: issues, research, specs, branches, diffs, tests, lint, artifacts, reviewers, approvals, and handoffs. It provides a coding-agent runtime rather than a set of generic application primitives.

### Where do artifacts live?

Research commonly lives in `research/`, specs in `specs/`, and workflow run data in the workflow run directory. A workflow can persist plans, logs, transcripts, reviewer notes, check output, and summaries for later inspection.

---

## Workflow playbook

Read the [Workflow Playbook](./docs/workflow-playbook.md) for practical guidance on writing objectives, constraining scope, steering long-running work, validating results, and producing engineering handoffs.

## Support & ideas

Join the [Atomic Discord community](https://discord.gg/9CvdXUGXR4) for questions, help, feedback, feature ideas, and examples of what you have built.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [DEV_SETUP.md](DEV_SETUP.md) for development setup and testing.

To contribute workflows, see the [atomic-workflows repository](https://github.com/lavaman131/atomic-workflows).

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Pi](https://pi.dev)
- [Superpowers](https://github.com/obra/superpowers)
- [Anthropic Skills](https://github.com/anthropics/skills)
- [Ralph Wiggum Method](https://ghuntley.com/ralph/)
- [OpenAI Codex Cookbook](https://github.com/openai/openai-cookbook)
- [HumanLayer](https://github.com/humanlayer/humanlayer)
- [Impeccable](https://github.com/pbakaus/impeccable)
