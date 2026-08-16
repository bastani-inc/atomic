# Research: Jump-to-bottom widget for the fullscreen transcript

Date: 2026-08-13
Scope: `packages/coding-agent/src/modes/interactive/`, pi-tui (`@earendil-works/pi-tui`)

## Question

Show a centered, clickable "jump to bottom" affordance above the chat input when the
user has scrolled the fullscreen transcript away from the live end. A keybinding must
also trigger it. Atomic runs fullscreen-only, so only the alt-screen path matters.

## Findings

### 1. Scroll state is already observable

`ScrollView` (`node_modules/@earendil-works/pi-tui/dist/components/scroll-view.d.ts`) exposes:

- `get isFollowingEnd(): boolean` — true when the viewport is stuck to the live end.
- `scrollToEnd(): void` — jumps to the end and resumes following.
- `get scrollTop(): number`, `scrollBy`, `scrollTo`, `scrollToStart`.

The transcript's ScrollView is created in
`packages/coding-agent/src/modes/interactive/interactive-startup.ts:137` with
`follow: "end", primary: true` and stored as `this.transcriptScrollView`
(`interactive-mode-base.ts:169`). "User isn't at the bottom" is exactly
`!transcriptScrollView.isFollowingEnd`.

### 2. The keybinding action already exists

pi-tui declares `tui.altScreen.bottom` (default key `end`, description "Scroll viewport
to bottom") in `keybindings.d.ts:217-220` and handles it inside `TuiAltScreen`
(`tui-alt-screen.js:338`). It is remappable through the `KeybindingsManager` /
`setKeybindings` machinery the coding agent already uses (`interactive-mode-base.ts:44`).

Consequences:

- No new key handling is needed for the jump action itself; it works today.
- `ctrl+end` is a recognized `KeyId` in pi-tui's key parser (`keys.js` includes
  `"ctrl+end"`), so it can be added as an additional binding if desired. Cross-OS note:
  macOS keyboards produce End via Fn+Right; some terminals do not emit a distinct
  Ctrl+End sequence. Because bindings are remappable and terminal-dependent, the widget
  should *display* whatever key is currently bound rather than hardcoding a label.
  `interactive-hotkeys-debug.ts:25` (`getEditorKeyDisplay`) already renders a
  human-readable label for a `Keybinding` action.
- Input routing: `shouldHandleFullscreenViewportInput` (`interactive-mode-base.ts:77`)
  lets the fullscreen viewport consume `FULLSCREEN_VIEWPORT_ACTIONS` (including
  `tui.altScreen.bottom`) before the focused component unless an overlay is focused.

### 3. Clickable is feasible with an existing primitive: OSC 8 link activation

`TuiAltScreen` parses SGR mouse events and, on a primary-button click that did not drag
and did not extend a selection, hit-tests the rendered screen cell for an OSC 8
hyperlink (`getOsc8LinkAtColumn(this.previousScreen[event.y], event.x)` —
`tui-alt-screen.js:696-698`) and invokes the `openUrl` callback with the URL
(`tui-alt-screen.js:655-666`). The hit-test runs against the full composited screen,
dock rows included.

Atomic wires `openUrl: openBrowser` when constructing `AtomicTuiAltScreen`
(`packages/coding-agent/src/modes/interactive/interactive-tui.ts:329`).

Therefore: render the widget's label wrapped in an OSC 8 hyperlink carrying an internal
URL (e.g. `atomic-ui://transcript/jump-to-bottom`) and intercept that scheme in the
`openUrl` callback before it reaches `openBrowser`. Click support requires no pi-tui
changes. Caveats:

- Click activation requires mouse capture to be enabled (the `mouse` option of
  `TuiAltScreen`), which is Atomic's existing default path.
- A hover cursor / underline styling is up to the label's own styling; terminals may
  display their own link affordance (some show the URL on hover — the internal scheme
  string will be visible in that tooltip).
- pi-tui swallows the click; no coordinate plumbing or hit-testing code is needed in
  the coding agent.

### 4. Where the widget lives in the layout

`interactive-startup.ts:144-157` builds the fullscreen layout:

```
fullscreenLayoutRoot = VStack([
  ScrollView(documentContainer)   // grow: 1
  dock = VStack([
    pendingMessagesContainer,
    statusContainer,
    widgetContainerAbove,          // extension widgets, rebuilt by renderWidgets()
    usageMeter,
    editorContainer,
    footerContainer,
    widgetContainerBelow,
  ])
])
```

The natural slot for a "floating above the chat box" indicator is a new dedicated
container at the **top of the dock** (directly under the transcript, above
`pendingMessagesContainer`). `widgetContainerAbove` is unsuitable: it is cleared and
rebuilt by `renderWidgets()` (`interactive-extension-widgets.ts:13-15`) for extension
widgets, so an internal widget there would be dropped on every extension render.

Visibility can be dynamic without layout churn: the component's `render(width)` returns
`[]` when `transcriptScrollView.isFollowingEnd` is true and the centered line otherwise.
Scrolling always triggers a re-render (the screen content changes), so no extra
invalidation hook is needed. `VStack` entries also support a
`visible?: (viewport) => boolean` predicate (`layout-node.d.ts`) as an alternative.

Centering: compute padding from `width` in `render(width)`; `visibleWidth` /
`truncateToWidth` utilities are exported from pi-tui `utils`.

### 5. Main-screen fallback

`InteractiveTui = TuiMainScreen | TuiAltScreen` (`interactive-tui.ts:42`) — a guarded
fallback exists internally, but Atomic is fullscreen-only in practice. The widget's
visibility gate (`transcriptScrollView` present + `isFollowingEnd === false`) makes it
inert on any non-viewport path; `isViewportTUI(tui)` is the existing discriminator
(`interactive-mode-base.ts:5`).

### 6. Existing precedent for scroll-state-aware UI

`chat-session-host-rendering.ts:185,235` already branches on
`bodyViewport.getScrollFromBottom() !== 0` for overlay chat viewports — scroll-position-
aware rendering is an established pattern in the codebase. (Overlay viewports use
`ScrollableComponentViewport`, not `ScrollView`; they are out of scope here.)

## Difficulty assessment

- Widget + visibility + keyboard: small. All state and key handling exist; the work is
  one component, one dock slot, one label lookup.
- Clickable: small-medium. One internal URL scheme constant, OSC 8 wrapping in the
  label, and an interception branch in the `openUrl` wiring.
- Risks: terminals without OSC 8 or mouse reporting degrade to keyboard-only (label
  still shows the key); the key label must come from the live keybinding manager, not a
  hardcoded "Ctrl+End".
