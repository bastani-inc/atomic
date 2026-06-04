## 1. Relevant external facts

No external research was necessary for this partition. The key behavior is defined by the repo’s own workflow TUI/store code, not by an external framework contract.

## 2. Local implications

This area is the **UI/runtime boundary** you’d need to replace in a Rust migration:

- `graph-view.ts` is the main graph renderer and navigation surface.
- `overlay-adapter.ts` and `store-widget-installer.ts` connect workflow state to the TUI surface.
- `widget.ts` provides the compact status line/widget behavior.
- `workflow-attach-pane.ts` and the picker/confirm overlays implement the human-in-the-loop interaction flow.
- `shared/store.ts` + `store-types.ts` are the state source of truth for pending prompts, answers, and overlay visibility.
- Foreground/background execution code (`executor.ts`, `runner.ts`, `status.ts`) drives what the UI must reflect.

For a Rust port, this means you’re not just translating rendering code—you’re also re-implementing:
- state synchronization,
- prompt lifecycle handling,
- overlay routing,
- workflow status refresh,
- foreground/background action plumbing.

## 3. Version/API assumptions

- No external API/version assumptions were needed for this partition.
- The important assumption is **local contract stability**: the Rust version must preserve the same store/event semantics exposed by the workflow runtime.

## 4. Unverified or unnecessary research

Unverified here:
- the exact TUI library on the TS side and its Rust replacement strategy,
- whether any behavior is coupled to terminal rendering quirks or host app APIs,
- how much of the overlay/widget logic is reusable as pure state machines.

If you want, I can next turn this into a **Rust migration map** for this partition: “what to port first, what can stay protocol-compatible, and what should become a shared core crate.”