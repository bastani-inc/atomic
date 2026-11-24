---
title: "Embed Atomic in a web server"
sidebarTitle: "Web server guide"
description: "Run Atomic sessions behind a Next.js App Router endpoint and stream newline-delimited JSON output to a browser."
---

This guide puts an Atomic agent behind an HTTP endpoint using Next.js App Router. The same pattern works in any long-running Node.js server: keep one session per conversation, start a prompt per request, and stream session events back as newline-delimited JSON (NDJSON).

Read [TypeScript SDK](/sdk) first for `createAgentSession()`, `AgentSession`, `AgentSessionRuntime`, and session events. For servers that release idle sessions and rehydrate them on later requests, wrap sessions with `createAgentSessionRuntime()` instead (see [Releasing idle sessions](/sdk#releasing-idle-sessions)).

## Install

```bash
npm install @bastani/atomic
```

Atomic requires Node.js 22.19 or newer. Dependency install scripts are not required; if your package manager blocks install scripts, leave them disabled.

On Node 22, pass `--experimental-async-context-frame` on the server's `node` command line (not in `NODE_OPTIONS`) to avoid `AsyncLocalStorage` promise-hook overhead across concurrent HTTP requests; see [Node 22 hosts](/sdk#node-22-hosts).

## Keep Atomic out of the server bundle

Atomic resolves its bundled resources and native modules relative to `node_modules`, so keep it outside Next.js's server bundle using `serverExternalPackages` (Next.js 15 and later):

```typescript
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@bastani/atomic", "@bastani/atomic-natives", "@bastani/atomic-ai"],
};

export default nextConfig;
```

Once `@bastani/atomic` is external, its dependencies load from `node_modules`. List any other Atomic packages your application imports directly.

Import TypeBox for custom tool schemas from `@bastani/atomic/typebox` (and its subpaths such as `/value`, `/compile`, and `/format`) rather than `typebox` directly so custom formats and settings share Atomic's TypeBox registry.

Every route that imports Atomic must run on the Node.js runtime:

```typescript
export const runtime = "nodejs";
```

Import Atomic only from server code. Client components may use `import type` from `@bastani/atomic`, which adds zero bytes to the browser bundle.

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

`SessionManager.inMemory()` keeps history in process memory. To persist conversations across restarts, pass a SQLite, JSONL, or database-backed `SessionManager` or `sessionStore` (see [Sessions](/sessions)). Call `closeConversation()` when a conversation finishes or goes idle, and run `closeAllConversations()` on `SIGTERM`/`SIGINT` so session stores and child processes close cleanly.

Sessions on `globalThis` live in one server process. Run this on a long-lived Node.js server with sticky routing per conversation if you scale to multiple instances; short-lived serverless functions discard process memory between requests.

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
- **Error sanitization:** Log raw errors server-side and send sanitized user-safe error messages to the browser.

`createTranscript()` returns a tool result's text by default. To send structured `details` for specific tools instead, pass `createTranscript({ toolResult: (toolName) => (toolName === "todo" ? "details" : "content") })`.

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

Any route driving an agent session lets callers run tools with the server process's OS permissions. Atomic has [no built-in sandbox](/security#no-built-in-sandbox).

- **Require authentication** on every route that creates sessions or sends prompts, and scope conversation IDs to the authenticated user.
- **Allow only needed tools.** `tools` is an allowlist; the example enables only read-only `read`, `find`, and `search`. Omit `bash`, `edit`, and `write` unless the agent must mutate files or run commands. `excludedTools` removes tools, and `noTools: "all"` exposes none. Omit `ask_user_question` in headless sessions. See [Tools](/sdk/reference#tools).
- **Disable unused builtins.** Turn off `subagents`, `mcp`, `web-access`, and `intercom` via `builtins` when not required.
- **Choose `cwd` deliberately.** `cwd` sets the starting directory for relative tool paths and project discovery, but does not jail file access (tools can read absolute paths outside `cwd`). Point `cwd` at a controlled directory, never user input.
- **Isolate the process** in a container, VM, or restricted OS account whenever callers must not reach other server files or when write/shell tools are enabled. See [Containerization](/containerization).
- **Keep credentials server-side.** Provider keys live in the server's `ModelRuntime`. Never forward them to browsers or accept raw keys from untrusted clients.

## Next steps

- [TypeScript SDK](/sdk): sessions, prompting, storage, and events.
- [SDK API reference](/sdk/reference): every `createAgentSession()` option and export.
- [Orchestration](/orchestration): multi-step workflows with codemode and subagents.
- [Migrating workflows](/orchestration/migrating-workflows): replacing older workflow definitions.
