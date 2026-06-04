## 1. Relevant external facts

- **MCP trust model (official SECURITY.md + transports spec)**  
  - MCP clients **trust the servers they connect to**.  
  - For **stdio** transport, the client launches the server as a subprocess; this is **intentional**, not a vulnerability.  
  - For **Streamable HTTP**, servers must validate `Origin`, bind locally when possible, and use auth where needed to avoid DNS rebinding / remote access issues.  
  - MCP explicitly treats **LLM-driven tool invocation**, file access, git ops, database ops, and system commands as expected capabilities when a server is configured to provide them.  
  **Source:** Model Context Protocol `SECURITY.md` and `transports` spec (2025-06-18).

- **Bun runtime behavior**  
  - Bun executes `.ts`/`.tsx` files by **transpiling on the fly**.  
  - Bun supports extensioned TS imports and runtime loaders, so the current repo’s “raw TS” model is closely tied to Bun’s runtime.  
  **Source:** Bun Runtime / TypeScript docs.

## 2. Local implications

- Your repo’s current architecture assumes **trusted local code execution**:
  - TS extensions and workflows are loaded dynamically (`jiti/static` per the locator).
  - MCP servers are spawned as subprocesses.
  - Web fetching ingests remote content into local tools/UI.
  - IPC/intercom and subagent worktrees rely on local process trust boundaries.
- If you migrate the repo to Rust, the main security question is **not just language replacement**; it’s whether you will:
  1. **Preserve trusted plugin execution** (Rust host still loads untrusted/semitrust extensions/workflows), or
  2. **Replace dynamic TS execution with a stricter ABI/sandbox model**.
- If you keep the same trust model, Rust mainly changes implementation safety/performance, not the security boundary.
- If you want stronger isolation, Rust is a good time to:
  - move extensions/workflows/MCP adapters to a **process boundary**,
  - define a **narrow IPC protocol**,
  - and treat fetched web content / tool inputs as untrusted data only.

## 3. Version/API assumptions

- MCP assumptions here are based on the **2025-06-18** transport/security docs.
- Bun assumptions are based on current Bun runtime docs showing **native TS transpilation** and extensioned imports.
- I did **not** verify the exact `jiti/static` semantics beyond the repo locator; treat it as a **dynamic local-code loading boundary** unless the implementation proves otherwise.

## 4. Unverified or unnecessary research

- I did **not** deeply inspect the local loader/spawn code in this pass.
- I did **not** verify whether your repo currently has any sandboxing/allowlist protections beyond the obvious trust boundaries.
- For the migration question, external research on Rust ecosystems is less important than deciding your **target trust model** first.