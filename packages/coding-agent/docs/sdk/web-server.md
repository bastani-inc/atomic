---
title: "Embedding Atomic in a web server"
sidebarTitle: "Web server"
description: "Run Atomic sessions and workflows behind a Next.js App Router route and stream their output to a browser."
---

# Embedding Atomic in a web server

This guide puts an Atomic agent behind an HTTP endpoint, using a Next.js App Router project as the example. The same pattern works in any long-running Node.js server: keep one session per conversation, start a prompt per request, and stream the session's events back as newline-delimited JSON (NDJSON).

Read the [SDK](/sdk) page first for `createAgentSession()` and session events.

The examples use `createTranscript()`, `createAgentSessionAdapter()`, and `RunOpts.onStageSessionEvent`, which require an Atomic release newer than 0.9.28-alpha.1. Check the [changelog](/changelog) for your installed version.

## Install

```bash
npm install @bastani/atomic
```

Atomic needs Node.js 22.19 or newer and does not require dependency install scripts.

Bun blocks the install scripts of some dependencies, such as `@embedded-postgres/<platform>`, `protobufjs`, and `@google/genai`, and reports them after `bun add @bastani/atomic`. You don't need to add them to `trustedDependencies` in `package.json`: Atomic prepares the embedded Postgres runtime itself the first time it starts it, and it doesn't depend on the other scripts.

## Keep Atomic out of the server bundle

Atomic finds its bundled resources and native modules relative to its installed package, so it must load from `node_modules` rather than from Next.js's server bundle. List it in `serverExternalPackages` (Next.js 15 and later):

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@bastani/atomic", "@bastani/atomic-natives", "@bastani/pi-ai", "typebox"],
};

export default nextConfig;
```

Atomic's own dependencies load from `node_modules` once `@bastani/atomic` is external. The other entries cover packages your app may import directly, such as `typebox` for workflow schemas, so your code and Atomic share one copy. Add any other Atomic dependency you import yourself.

Every route that imports Atomic must use the Node.js runtime:

```ts
export const runtime = "nodejs";
```

Import Atomic only from server code. Client components may use `import type` from `@bastani/atomic`, which adds nothing to the browser bundle.

## Keep one session per conversation

An `AgentSession` holds the conversation's history, so create one per conversation and reuse it across requests. Keep sessions on `globalThis`: in `next dev`, module-level variables reset on every hot reload, but `globalThis` survives, so open conversations don't vanish and old sessions aren't leaked. Restart the dev server after changing session options; existing sessions keep the options they were created with.

```ts
// lib/atomic.ts
import "server-only";
import { type AgentSession, createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

export const WORKSPACE = process.env.AGENT_WORKSPACE ?? "/srv/agent-workspace";

export interface Conversation {
  session: AgentSession;
  busy: boolean;
}

interface AtomicState {
  modelRuntime: Promise<ModelRuntime>;
  conversations: Map<string, Promise<Conversation>>;
}

const shared = globalThis as typeof globalThis & { atomicState?: AtomicState };
const state = (shared.atomicState ??= {
  modelRuntime: ModelRuntime.create(),
  conversations: new Map(),
});

export function getConversation(id: string): Promise<Conversation> {
  let conversation = state.conversations.get(id);
  if (!conversation) {
    conversation = state.modelRuntime.then(async (modelRuntime) => {
      const { session } = await createAgentSession({
        cwd: WORKSPACE,
        sessionManager: SessionManager.inMemory(WORKSPACE),
        modelRuntime,
        tools: ["read", "find", "search"],
        builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
      });
      return { session, busy: false };
    });
    conversation.catch(() => state.conversations.delete(id));
    state.conversations.set(id, conversation);
  }
  return conversation;
}

export async function closeConversation(id: string): Promise<void> {
  const conversation = state.conversations.get(id);
  state.conversations.delete(id);
  if (conversation) await (await conversation).session.dispose();
}
```

`SessionManager.inMemory()` keeps history in process memory. To keep conversations across restarts, pass a file-backed `SessionManager` instead; see [Sessions](/sessions). Call `closeConversation()` when a conversation ends or has been idle for a while, because each open session holds resources until it is disposed.

Sessions on `globalThis` live in one server process. Run this on a long-lived Node.js server, and route each conversation to the same instance if you run several. Short-lived serverless functions lose the session between requests.

## Stream a prompt

The route below starts one prompt and streams the assistant's output as NDJSON. `createTranscript()` turns session events into ordered, JSON-serializable parts (text, thinking, and tool calls joined to their results), so each line carries the complete output so far and the client simply replaces what it shows.

```ts
// app/api/chat/route.ts
import { createTranscript, type TranscriptPart } from "@bastani/atomic";
import { getConversation } from "@/lib/atomic";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";

export type ChatLine =
  | { type: "parts"; parts: TranscriptPart[] }
  | { type: "done" }
  | { type: "error"; message: string };

export async function POST(request: Request): Promise<Response> {
  const user = await authenticate(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { conversationId, message } = (await request.json()) as { conversationId: string; message: string };
  const conversation = await getConversation(`${user.id}:${conversationId}`);
  const { session } = conversation;
  if (conversation.busy || session.isStreaming) {
    return new Response("This conversation is already answering a prompt.", { status: 409 });
  }
  if (request.signal.aborted) return new Response(null, { status: 499 });
  conversation.busy = true;

  const encoder = new TextEncoder();
  const transcript = createTranscript();
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: ChatLine) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };
      const stop = () => void session.abort();
      request.signal.addEventListener("abort", stop, { once: true });

      const unsubscribe = session.subscribe((event) => {
        transcript.apply(event);
        if (
          event.type === "message_update" ||
          event.type === "message_end" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end"
        ) {
          send({ type: "parts", parts: transcript.parts() });
        }
      });

      session
        .prompt(message)
        .then(() => send({ type: "done" }))
        .catch((error: Error) => send({ type: "error", message: error.message }))
        .finally(() => {
          unsubscribe();
          request.signal.removeEventListener("abort", stop);
          conversation.busy = false;
          if (open) {
            open = false;
            controller.close();
          }
        });
    },
    cancel() {
      open = false;
      void session.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
```

A few details matter here:

- **One prompt at a time.** `session.prompt()` rejects while the session is already streaming. The route answers `409` instead. `busy` is set synchronously, so two requests that arrive together can't both start a prompt. To queue a message instead of rejecting it, call `session.prompt(message, { streamingBehavior: "followUp" })`.
- **Stop on disconnect.** When the browser disconnects or aborts its `fetch`, `request.signal` aborts and the stream is cancelled. Both call `session.abort()`, which stops the current turn and its tools but keeps the session usable.
- **Payload size.** Each line repeats the whole output so far. For long answers, send lines on a timer instead of on every event, or send only the parts that changed.

`createTranscript()` reports a tool result's text by default. To send a tool's structured `details` instead, pass `createTranscript({ toolResult: (toolName) => (toolName === "todo" ? "details" : "content") })`.

## Read the stream in the browser

```tsx
// app/chat/send-message.ts
import type { TranscriptPart } from "@bastani/atomic";
import type { ChatLine } from "@/app/api/chat/route";

export async function sendMessage(
  conversationId: string,
  message: string,
  onParts: (parts: TranscriptPart[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text());

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const text of lines) {
      if (!text) continue;
      const line = JSON.parse(text) as ChatLine;
      if (line.type === "parts") onParts(line.parts);
      if (line.type === "error") throw new Error(line.message);
    }
  }
}
```

Render each part by `type`: `text` and `thinking` are strings, and a `toolCall` part has `name`, `arguments`, and, once the tool reports progress or finishes, a `result` with `content`, `isError`, and `isPartial`. Pass an `AbortController`'s signal to stop the agent from the page.

## Run a workflow from a route

`run()` from `@bastani/atomic/workflows` runs a workflow definition in the server process. Each stage runs as an in-process Atomic session, so `run()` needs no adapters. Use `createAgentSessionAdapter()` when every stage should share session options, such as the same tool restrictions as your chat sessions:

```ts
// app/api/review/route.ts
import { createTranscript, type Transcript } from "@bastani/atomic";
import { createAgentSessionAdapter, run } from "@bastani/atomic/workflows";
import { WORKSPACE } from "@/lib/atomic";
import { authenticate } from "@/lib/auth";
import { reviewWorkflow } from "@/workflows/review";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!(await authenticate(request))) return new Response("Unauthorized", { status: 401 });
  const { topic } = (await request.json()) as { topic: string };
  if (request.signal.aborted) return new Response(null, { status: 499 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: object) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };
      const stages = new Map<string, Transcript>();

      try {
        const result = await run(reviewWorkflow, { topic }, {
          cwd: WORKSPACE,
          signal: abort.signal,
          durability: { mode: "memory" },
          adapters: {
            agentSession: createAgentSessionAdapter({ cwd: WORKSPACE, tools: ["read", "find", "search"] }),
          },
          onStageSessionEvent: (runId, stageId, event) => {
            let transcript = stages.get(stageId);
            if (!transcript) stages.set(stageId, (transcript = createTranscript()));
            transcript.apply(event);
            if (event.type === "message_update" || event.type === "tool_execution_end") {
              send({ type: "stage", runId, stageId, parts: transcript.parts() });
            }
          },
        });
        send({ type: "done", status: result.status, result: result.result, error: result.error });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
```

`onStageSessionEvent` receives every stage's session events tagged with its run and stage ids, including stages that switch to a fallback model and stages of nested workflows. Aborting `signal`, here when the client disconnects, cancels the run.

### Choose workflow durability

By default, `run()` makes workflow state durable by starting a managed local Postgres, so a run can resume after the process exits. Request-scoped servers rarely want that:

- **`durability: { mode: "memory" }`** keeps state in memory for this call only. No Postgres starts, and the run can't resume after the process exits. Use it when the request owns the run.
- **`durability: { mode: "durable", systemDatabaseUrl }`** stores state in a Postgres database you run, such as a hosted one, and Atomic doesn't start its own. Use it in deployments that need runs to survive restarts. `DBOS_SYSTEM_DATABASE_URL`, when set, overrides the URL.

One process uses one workflow database. See [Choosing the durable backend](/workflows/api-reference#choosing-the-durable-backend) for the full rules, and [Workflows](/workflows) for writing workflow definitions.

## Secure the endpoint

A route that drives an agent session lets whoever calls it run tools on your server with the server process's permissions. Atomic has [no built-in sandbox](/security#no-built-in-sandbox).

- **Require authentication** on every route that creates sessions, sends prompts, or starts workflows, and scope conversation ids to the authenticated user, as `getConversation()` does above.
- **Allow only the tools you need.** `tools` is an allowlist; the examples allow only the read-only `read`, `find`, and `search`. Leave out `bash`, `edit`, and `write` unless the agent must change files or run commands. `excludedTools` removes tools, and `noTools: "all"` exposes none. `ask_user_question` needs a person to answer, so leave it out of headless sessions. See [Tools](/sdk/reference#tools).
- **Disable builtins you don't use.** `builtins` turns off the shipped workflows, subagents, MCP, web access, and Intercom packages, along with their tools.
- **Choose the working directory deliberately.** `cwd` sets the starting directory for tool paths and controls which project settings, context files, and extensions Atomic discovers. It does not restrict file access: tools can use absolute paths and paths outside `cwd`. Point it at a directory you control, never at an upload or a user-supplied path.
- **Isolate the process** in a container, VM, or restricted OS account when callers must not access other server files, even with read-only tools, or when the agent can write files or run commands. See [Containerization](/containerization).
- **Keep credentials on the server.** Provider keys come from the server's `ModelRuntime`. Never send them to the browser or accept them from requests.

## Next steps

- [SDK](/sdk) for sessions, prompting, and events.
- [SDK API reference](/sdk/reference) for every `createAgentSession()` option.
- [Workflow API reference](/workflows/api-reference) for `run()` and `RunOpts`.
