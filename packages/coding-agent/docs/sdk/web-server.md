---
title: "Stream from a web server"
sidebarTitle: "Stream over HTTP"
description: "Run Atomic sessions behind a Next.js App Router endpoint and stream newline-delimited JSON output to a browser."
---

This guide puts an Atomic agent behind an HTTP endpoint using Next.js App Router. The same pattern works in any long-running Node.js server: keep one session per conversation, start one prompt per request, and stream session events back as newline-delimited JSON (NDJSON).

Read [Use the TypeScript SDK](/sdk) first for `createAgentSession()`, `AgentSession`, `AgentSessionRuntime`, and session events. For servers that release idle sessions and rehydrate them on later requests, wrap sessions with `createAgentSessionRuntime()` instead (see [Releasing idle sessions](/sdk#releasing-idle-sessions)).

## Prerequisites and setup

<Steps>
  <Step title="Install @bastani/atomic">
    Atomic requires Node.js 24.20 or newer. Dependency install scripts are not required; if your package manager blocks install scripts, leave them disabled.

    ```bash
    npm install @bastani/atomic
    ```
  </Step>
  <Step title="Keep Atomic external to the server bundle">
    Atomic resolves its bundled resources and native modules relative to `node_modules`, so list it in `serverExternalPackages` (Next.js 15 and later):

    ```typescript
    // next.config.ts
    import type { NextConfig } from "next";

    const nextConfig: NextConfig = {
      serverExternalPackages: ["@bastani/atomic", "@bastani/atomic-natives", "@bastani/atomic-ai"],
    };

    export default nextConfig;
    ```

    List any other Atomic packages your server imports directly, including [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) when storing sessions in PostgreSQL (see [Configure session storage](/sdk/storage)).
  </Step>
  <Step title="Use the Node.js runtime and Atomic's TypeBox subpath">
    Every route handler that imports Atomic must run on the Node.js runtime, not Edge:

    ```typescript
    export const runtime = "nodejs";
    ```

    Import Atomic only from server code (client components may use `import type` from `@bastani/atomic`, which adds zero bytes to the browser bundle). When defining custom tool schemas, import TypeBox from `@bastani/atomic/typebox` (and its subpaths such as `/value`, `/compile`, and `/format`) so custom formats share Atomic's validation registry.
  </Step>
</Steps>

## Keep one session per conversation

An `AgentSession` owns the conversation history, so create one per conversation and reuse it across requests. Store shared state on `globalThis` so `next dev` hot reloads preserve active sessions without leaking them. Restart the dev server after changing session options because existing sessions keep their creation options.

```typescript
// lib/atomic.ts
import "server-only";
import { type AgentSession, createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

export const WORKSPACE = process.env.AGENT_WORKSPACE ?? "/srv/agent-workspace";

export interface Conversation {
  session: AgentSession;
  busy: boolean;
}

interface AtomicState {
  modelRuntime?: Promise<ModelRuntime>;
  conversations: Map<string, Promise<Conversation>>;
  shutdownRegistered?: boolean;
}

const shared = globalThis as typeof globalThis & { atomicState?: AtomicState };
const state = (shared.atomicState ??= {
  conversations: new Map(),
});

function getModelRuntime(): Promise<ModelRuntime> {
  if (!state.modelRuntime) {
    // Clear cached promise on startup failure so a later request can retry.
    state.modelRuntime = ModelRuntime.create().catch((error) => {
      state.modelRuntime = undefined;
      throw error;
    });
  }
  return state.modelRuntime;
}

export function getConversation(id: string): Promise<Conversation> {
  let conversation = state.conversations.get(id);
  if (!conversation) {
    conversation = getModelRuntime().then(async (modelRuntime) => {
      const { session } = await createAgentSession({
        cwd: WORKSPACE,
        sessionManager: SessionManager.inMemory(WORKSPACE),
        modelRuntime,
        tools: ["read", "find", "search"],
        builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
      });
      return { session, busy: false };
    });
    conversation.catch(() => state.conversations.delete(id));
    state.conversations.set(id, conversation);
  }
  return conversation;
}

export async function closeConversation(id: string): Promise<void> {
  const pending = state.conversations.get(id);
  state.conversations.delete(id);
  if (!pending) return;
  const conversation = await pending.catch(() => undefined);
  if (!conversation) return;
  // Abort active work with pauseQueuedMessages so dispose() does not wait for a running turn.
  await conversation.session.abort({ pauseQueuedMessages: true });
  await conversation.session.dispose();
}

export async function closeAllConversations(): Promise<void> {
  const ids = [...state.conversations.keys()];
  await Promise.allSettled(ids.map((id) => closeConversation(id)));
}

if (!state.shutdownRegistered) {
  state.shutdownRegistered = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void closeAllConversations().finally(() => process.exit(0));
    });
  }
}
```

<Warning>
Sessions stored on `globalThis` live in one Node.js server process. Run this pattern on a long-lived server with sticky routing per conversation if you scale to multiple instances; short-lived serverless functions discard process memory between requests.
</Warning>

`SessionManager.inMemory()` keeps history only in RAM. To persist conversations across restarts or share them across servers, pass a SQLite, JSONL, or PostgreSQL `SessionManager` or `sessionStore` (see [Configure session storage](/sdk/storage)). Call `closeConversation()` when a conversation finishes or goes idle, and run `closeAllConversations()` on `SIGTERM`/`SIGINT` so session stores and child processes close cleanly.

## Stream a prompt

This route starts one prompt and streams the assistant's output as NDJSON. `createTranscript()` converts session events into ordered JSON-serializable parts (`text`, `thinking`, and `toolCall` paired with its `result`). Tool calls appear in `message_end` before execution begins and gain their `result` as `tool_execution_update` and `tool_execution_end` arrive, so each line carries the full output so far and the browser replaces its rendered list.

```typescript
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
        .catch((error: unknown) => {
          console.error("Prompt failed:", error);
          // Sanitize errors in production instead of exposing internal paths or stack details.
          send({ type: "error", message: "The request could not be completed." });
        })
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

Key behaviors:

- **One prompt at a time:** `session.prompt()` rejects while streaming, so the route returns `409` and flips `busy` synchronously to prevent races. To queue prompts instead of rejecting, call `session.prompt(message, { streamingBehavior: "followUp" })`.
- **Stop on disconnect:** When the browser disconnects or aborts `fetch`, `request.signal` and `cancel()` call `session.abort()`, stopping the current turn and tools while keeping the session reusable.
- **Payload throttling:** Each line emits the complete transcript so far. For long responses, throttle updates on a short timer or send incremental diffs.
- **Structured tool details:** `createTranscript()` returns a tool result's text by default. Pass `createTranscript({ toolResult: (toolName) => (toolName === "todo" ? "details" : "content") })` to emit structured `details` for specific tools.
- **Error sanitization:** Log raw errors server-side and return generic user-safe messages to the browser.

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

Render each part by `type`: `text` and `thinking` hold strings, and a `toolCall` part has `name`, `arguments`, and (once progress or completion arrives) `result` (`content`, `isError`, `isPartial`). Pass an `AbortController` signal to cancel from the UI.

## Secure the endpoint

<Warning>
Atomic has [no built-in sandbox](/security#no-built-in-sandbox). Any HTTP route driving an agent session lets callers execute enabled tools with the server process's OS permissions, and `cwd` does not jail file tools to that directory.
</Warning>

- **Require authentication** on every route that creates sessions or sends prompts, and scope conversation IDs to the authenticated user.
- **Allow only needed tools.** `tools` is an allowlist; the example enables only read-only `read`, `find`, and `search`. Omit `bash`, `edit`, and `write` unless the agent must mutate files or run commands. Use `excludedTools` to strip specific tools or `noTools: "all"` to expose none, and omit `ask_user_question` in headless servers. See [Tools](/sdk/reference#tools).
- **Disable unused builtins.** Turn off `subagents`, `mcp`, `web-access`, and `intercom` via `builtins` when not required.
- **Choose `cwd` deliberately.** `cwd` sets the starting directory for relative paths and project discovery, but tools can still access absolute paths outside `cwd`. Point `cwd` at a controlled directory, never user input.
- **Isolate the process** in a container, VM, or restricted OS account whenever callers must not reach other server files or when write/shell tools are enabled. See [Containerization](/containerization).
- **Keep credentials server-side.** Provider keys live in the server's `ModelRuntime`. Never forward them to browsers or accept raw keys from untrusted clients.

## Next steps

<Columns cols={2}>
  <Card title="Use the TypeScript SDK" href="/sdk">
    Sessions, prompting, workspaces, Intercom policies, and lifecycle hooks.
  </Card>
  <Card title="Configure session storage" href="/sdk/storage">
    Persist server sessions in SQLite, JSONL, or PostgreSQL and wire `createAgentSessionRuntime()`.
  </Card>
  <Card title="SDK API reference" href="/sdk/reference">
    Every `createAgentSession()` option, runtime method, error class, and export.
  </Card>
  <Card title="Orchestration" href="/orchestration">
    Multi-step workflows with codemode and subagents, plus [migrating older workflows](/orchestration/migrating-workflows).
  </Card>
</Columns>
