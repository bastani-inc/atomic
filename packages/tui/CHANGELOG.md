# Changelog

This package is Atomic's fork of `@earendil-works/pi-tui`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/tui/CHANGELOG.md).

## [Unreleased]

### Added

- `withoutKeyHints(line, drop)` turns the hints for the keys `drop` accepts back into plain text, keeping their text, their style and every other hint, so a click on that text reaches the component that draws it.

## [0.10.0] - 2026-11-20

### Breaking Changes

- The bundled command names no longer include `workflows` or `workflow-authoring`. If your extension uses either name, mark clickable hints explicitly with `slashCommandHint()` rather than relying on built-in command recognition ([#5926](https://github.com/bastani-inc/atomic/pull/5926)).

### Added

- A stateless component returned by a chat renderer can declare `historyReplayable: true` so that saved pages can recreate it without keeping the original instance ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).
- Components in a `WindowedContainer` can set `selectionTextMayChangeOnReplay` to keep a fullscreen selection faithful to the text the user saw, even when the component is recreated before copying ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).
- `ScrollView.scrollTo(row, { exact: true })` shows that row in the next frame even when rows above it change before then, for a jump such as going to the start of a transcript that is still being loaded ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).

### Fixed

- Hiding and showing a fullscreen dialog before the next paint cancels a held single click and any pending single-click action on that dialog. A control that took the press still receives its release; double- and triple-click text selection keeps its clipboard behavior ([#5643](https://github.com/bastani-inc/atomic/issues/5643)).
- Whole-line key hints recognize a tab or Unicode space between a named key and its label. In `esc / a destination`, an unbound `a` starts the slash key's label. In `1/2 / esc pick`, bound digits and Escape are clickable; numeric ratios stay plain ([#5656](https://github.com/bastani-inc/atomic/issues/5656)).
- A wheel or page-key scroll in a `ScrollView` over a `WindowedContainer` now moves from the rows the last frame showed when rows above them are added or removed before the next frame, so content loaded or released above the reader while they scroll no longer skips or repeats rows. While a history anchor is on screen, the rows after it keep their place, so pages mounted right after the anchor appear above what the reader sees ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).

## [0.10.0-alpha.1] - 2026-11-20

### Breaking Changes

- The bundled command names no longer include `workflows` or `workflow-authoring`. If your extension uses either name, mark clickable hints explicitly with `slashCommandHint()` rather than relying on built-in command recognition ([#5926](https://github.com/bastani-inc/atomic/pull/5926)).

### Added

- A stateless component returned by a chat renderer can declare `historyReplayable: true` so that saved pages can recreate it without keeping the original instance ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).
- Components in a `WindowedContainer` can set `selectionTextMayChangeOnReplay` to keep a fullscreen selection faithful to the text the user saw, even when the component is recreated before copying ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).
- `ScrollView.scrollTo(row, { exact: true })` shows that row in the next frame even when rows above it change before then, for a jump such as going to the start of a transcript that is still being loaded ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).

### Fixed

- Hiding and showing a fullscreen dialog before the next paint cancels a held single click and any pending single-click action on that dialog. A control that took the press still receives its release; double- and triple-click text selection keeps its clipboard behavior ([#5643](https://github.com/bastani-inc/atomic/issues/5643)).
- Whole-line key hints recognize a tab or Unicode space between a named key and its label. In `esc / a destination`, an unbound `a` starts the slash key's label. In `1/2 / esc pick`, bound digits and Escape are clickable; numeric ratios stay plain ([#5656](https://github.com/bastani-inc/atomic/issues/5656)).
- A wheel or page-key scroll in a `ScrollView` over a `WindowedContainer` now moves from the rows the last frame showed when rows above them are added or removed before the next frame, so content loaded or released above the reader while they scroll no longer skips or repeats rows. While a history anchor is on screen, the rows after it keep their place, so pages mounted right after the anchor appear above what the reader sees ([#5593](https://github.com/bastani-inc/atomic/issues/5593)).

## [0.9.90] - 2026-11-19

### Added

- `clickableHint()`, `clickableKeysHint()`, `clickableKeyTextHint()`, `clickableHintText()` and `slashCommandHint()` mark hint text with the key or slash command a click on it runs; the marks take no columns and never reach the terminal. In the fullscreen renderer a single left click on a marked hint sends its key through the input path, as a key press, to whatever has the keyboard, and a hint drawn under an overlay that has the keyboard runs nothing. A hint keeps its action on every row it wraps onto, and ends where its text does when it is truncated or an overlay covers part of it. `setHintCommandHandler()` receives the slash commands, `isHintActivation()` tells a component that the key it handles came from a click, and `keyInputData(keyId)` returns the input a key sends, including modified function keys such as Ctrl+F1. A press and release do nothing if a repaint changes the hint's action without changing its text. In a key hint such as `esc / enter`, clicking the separator presses the preceding key; in `esc / / pick`, clicking the last slash or `pick` presses `/`, whether you pass the whole hint as text or supply its label separately. `clickableHintText(text, bindings)` accepts bare letters, digits and punctuation as keys only when explicitly bound, apart from a literal slash after a recognized key; counts, ratios and paths are not shortcut hints. Only core commands and currently registered bundled commands are inferred from text; mark a custom command with `slashCommandHint()`. An unregistered command hint does not submit a message. Hint markers do not add a blank row or preserve extra trailing spaces when a label wraps
- A mouse handler can return `whenSingleClick` for a single click. It runs once the click cannot become a double- or triple-click: `MULTI_CLICK_INTERVAL_MS` (500 ms, now exported) after the press with no second press on the same spot. A second press there cancels it, so text selection by double- and triple-click never triggers it.
- `Editor.setAutocompleteProvider(provider, { preserveSelection: true })` keeps an open menu and its provider for the current choice. The next lookup uses the new provider. A lookup that has not opened a menu can retry with the new provider. Without the option, replacing the provider closes the menu as before.

### Fixed

- Holding the second press of a double-click no longer runs single-click actions on components that take their own presses. A system clock adjustment does not delay a pending single click. A wheel turn, drag or loss of terminal focus breaks the click sequence. A single click that clears a text selection still acts on the item, and clicking two different items painted at the same cell runs both single-click actions ([#5562](https://github.com/bastani-inc/atomic/issues/5562)).

## [0.9.90-alpha.1] - 2026-11-19

### Added

- `clickableHint()`, `clickableKeysHint()`, `clickableKeyTextHint()`, `clickableHintText()` and `slashCommandHint()` mark hint text with the key or slash command a click on it runs; the marks take no columns and never reach the terminal. In the fullscreen renderer a single left click on a marked hint sends its key through the input path, as a key press, to whatever has the keyboard, and a hint drawn under an overlay that has the keyboard runs nothing. A hint keeps its action on every row it wraps onto, and ends where its text does when it is truncated or an overlay covers part of it. `setHintCommandHandler()` receives the slash commands, `isHintActivation()` tells a component that the key it handles came from a click, and `keyInputData(keyId)` returns the input a key sends, including modified function keys such as Ctrl+F1. A press and release do nothing if a repaint changes the hint's action without changing its text. In a key hint such as `esc / enter`, clicking the separator presses the preceding key; in `esc / / pick`, clicking the last slash or `pick` presses `/`, whether you pass the whole hint as text or supply its label separately. `clickableHintText(text, bindings)` accepts bare letters, digits and punctuation as keys only when explicitly bound, apart from a literal slash after a recognized key; counts, ratios and paths are not shortcut hints. Only core commands and currently registered bundled commands are inferred from text; mark a custom command with `slashCommandHint()`. An unregistered command hint does not submit a message. Hint markers do not add a blank row or preserve extra trailing spaces when a label wraps
- A mouse handler can return `whenSingleClick` for a single click. It runs once the click cannot become a double- or triple-click: `MULTI_CLICK_INTERVAL_MS` (500 ms, now exported) after the press with no second press on the same spot. A second press there cancels it, so text selection by double- and triple-click never triggers it.
- `Editor.setAutocompleteProvider(provider, { preserveSelection: true })` keeps an open menu and its provider for the current choice. The next lookup uses the new provider. A lookup that has not opened a menu can retry with the new provider. Without the option, replacing the provider closes the menu as before.

### Fixed

- Holding the second press of a double-click no longer runs single-click actions on components that take their own presses. A system clock adjustment does not delay a pending single click. A wheel turn, drag or loss of terminal focus breaks the click sequence. A single click that clears a text selection still acts on the item, and clicking two different items painted at the same cell runs both single-click actions ([#5562](https://github.com/bastani-inc/atomic/issues/5562)).

## [0.9.89] - 2026-11-18

### Added

- `WindowedContainer`, a vertical list a fullscreen `ScrollView` lays out by its visible window: frames render only the children on screen and one viewport around them, the rest render in bounded background slices, and the view stays in place while content above it changes height
- `TuiStopOptions.writeInSlices` and `TUI.whenStopped()`, so stopping the fullscreen renderer can write the transcript to the main screen in bounded slices across event-loop turns; terminals may implement the optional `Terminal.flush()`
- `EditorTheme.autocompleteHint` draws one hint line under the editor's open autocomplete menu from the entries the editor passes: select (when there is more than one row), complete, run or insert, and close. An entry's optional `resolvedKeys` names keys that reach the menu when an app handles shortcuts first. The `/` menu names `run` only for a confirm key that also submits the prompt. `Editor.getHistory()` returns the prompt history, newest first, and `SelectList.getItemCount()` the number of rows after its filter ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `TUI.requestImmediateRender()` renders on the next tick, ahead of the frame pacing `requestRender()` applies, for a frame that answers the user's own keystroke.
- Slash-command autocomplete suggestions can set `completeOnConfirm: false` to submit the typed input on Enter until the user navigates the suggestion list. Tab still accepts the highlighted completion ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `Markdown` accepts per-instance `hyperlinks: false` to display links as text and URLs without OSC 8, and `images: false` to display image placeholders. Other Markdown instances keep their existing behavior ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `Container.childAtRow(width, row)` returns the child drawn at a row of the container's last render at that width, the row inside that child and the child's height
- Components can implement `paintedRowKey(row)` to name what their last render drew on a row, such as an item's id. The fullscreen renderer turns a press and release into a click only when that name, the row's text and the components drawn there are the same at both, so a repaint that puts another item with the same text under the pointer is not clicked

### Changed

- `turnPromptAbove` accepts any `WindowRows` (arrays still work), and `ScrollLayoutState` adds `isFollowingEnd` and an optional anchored scroll position for `updateLayout`
- A fuzzy `@` file suggestion no longer repeats its path as the description when the file's name already shows it; a nested file still names its folder ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- The fullscreen renderer no longer lays out the screen under an overlay that covers all of it, until the overlay stops covering it.
- A focused component whose input handler returns a promise is repainted when the promise settles, rather than right after the key is routed.
- In the fullscreen renderer, a press and release become a click only when the screen under the pointer did not change between them, and never on the pinned prompt row or the jump-to-latest row. A fast second click on empty space counts as a double-click, as on a word, and clicks count by screen position, so an overlay opening between two clicks does not split a double-click

### Fixed

- Fuzzy matching stays fast when a long query recurs throughout an item's text, with the same scores, and select lists lowercase their filter once instead of once per item
- Markdown rendering no longer stalls for seconds when an unclosed `$$` or `\[` opener, or a table delimiter row, is followed by a long run of spaces
- Path completion reads directories, the terminal write log is appended, and tmux hyperlink support is detected without blocking the event loop
- F1–F5 and Page Up/Down sent as `ESC [ [ …` (libuv on Windows, the Linux console) are read as one key instead of typing their final letter into the editor
- `ScrollView`'s default scrollbar track and thumb are plain when `NO_COLOR` is set or `FORCE_COLOR=0`, read when the view is created. Styles passed in `scrollbarTrackStyle` and `scrollbarThumbStyle` are unchanged.

## [0.9.89-alpha.2] - 2026-11-18

### Fixed

- `ScrollView`'s default scrollbar track and thumb are plain when `NO_COLOR` is set or `FORCE_COLOR=0`, read when the view is created. Styles passed in `scrollbarTrackStyle` and `scrollbarThumbStyle` are unchanged.

## [0.9.89-alpha.1] - 2026-11-18

### Added

- `WindowedContainer`, a vertical list a fullscreen `ScrollView` lays out by its visible window: frames render only the children on screen and one viewport around them, the rest render in bounded background slices, and the view stays in place while content above it changes height
- `TuiStopOptions.writeInSlices` and `TUI.whenStopped()`, so stopping the fullscreen renderer can write the transcript to the main screen in bounded slices across event-loop turns; terminals may implement the optional `Terminal.flush()`
- `EditorTheme.autocompleteHint` draws one hint line under the editor's open autocomplete menu from the entries the editor passes: select (when there is more than one row), complete, run or insert, and close. An entry's optional `resolvedKeys` names keys that reach the menu when an app handles shortcuts first. The `/` menu names `run` only for a confirm key that also submits the prompt. `Editor.getHistory()` returns the prompt history, newest first, and `SelectList.getItemCount()` the number of rows after its filter ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `TUI.requestImmediateRender()` renders on the next tick, ahead of the frame pacing `requestRender()` applies, for a frame that answers the user's own keystroke.
- Slash-command autocomplete suggestions can set `completeOnConfirm: false` to submit the typed input on Enter until the user navigates the suggestion list. Tab still accepts the highlighted completion ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `Markdown` accepts per-instance `hyperlinks: false` to display links as text and URLs without OSC 8, and `images: false` to display image placeholders. Other Markdown instances keep their existing behavior ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- `Container.childAtRow(width, row)` returns the child drawn at a row of the container's last render at that width, the row inside that child and the child's height
- Components can implement `paintedRowKey(row)` to name what their last render drew on a row, such as an item's id. The fullscreen renderer turns a press and release into a click only when that name, the row's text and the components drawn there are the same at both, so a repaint that puts another item with the same text under the pointer is not clicked

### Changed

- `turnPromptAbove` accepts any `WindowRows` (arrays still work), and `ScrollLayoutState` adds `isFollowingEnd` and an optional anchored scroll position for `updateLayout`
- A fuzzy `@` file suggestion no longer repeats its path as the description when the file's name already shows it; a nested file still names its folder ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- The fullscreen renderer no longer lays out the screen under an overlay that covers all of it, until the overlay stops covering it.
- A focused component whose input handler returns a promise is repainted when the promise settles, rather than right after the key is routed.
- In the fullscreen renderer, a press and release become a click only when the screen under the pointer did not change between them, and never on the pinned prompt row or the jump-to-latest row. A fast second click on empty space counts as a double-click, as on a word, and clicks count by screen position, so an overlay opening between two clicks does not split a double-click

### Fixed

- Fuzzy matching stays fast when a long query recurs throughout an item's text, with the same scores, and select lists lowercase their filter once instead of once per item
- Markdown rendering no longer stalls for seconds when an unclosed `$$` or `\[` opener, or a table delimiter row, is followed by a long run of spaces
- Path completion reads directories, the terminal write log is appended, and tmux hyperlink support is detected without blocking the event loop
- F1–F5 and Page Up/Down sent as `ESC [ [ …` (libuv on Windows, the Linux console) are read as one key instead of typing their final letter into the editor

## [0.9.88] - 2026-11-16

### Added

- Exported `decodePrintableKey` for printable Kitty CSI-u and modifyOtherKeys input, and `normalizePastedText` for custom inputs to apply the editor's paste normalization.
- `TuiAltScreen` takes a `scrollPinnedPrompt` option: while a follow-end primary scroll view is scrolled up, the first line of the prompt (OSC 133 `A`) that started the turn at its top is pinned over its first row ([#5224](https://github.com/bastani-inc/atomic/issues/5224))

### Changed

- Forked `@earendil-works/pi-tui` 1.5.2 as `@bastani/atomic-tui`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-tui` and `@mariozechner/pi-tui` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- The renderer reads `ATOMIC_TUI_ESC_TIMEOUT`, `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW`, `ATOMIC_TUI_WRITE_LOG`, `ATOMIC_HYPERLINKS`, `ATOMIC_IMAGE_PROTOCOL`, `ATOMIC_TRUE_COLOR` and `ATOMIC_PROGRAM_STATUS`. Their `PI_*` names keep working when the `ATOMIC_*` name is unset ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

### Fixed

- A LaTeX sub- or superscript holding a long run of spaces, such as many `\ ` in a model's answer, now renders in linear time. Removing the spaces around `=`, `+` and `-` took quadratic time, so 100,000 escaped spaces held the terminal for about twelve seconds.
- `visibleWidth`, `truncateToWidth`, text wrapping and the editor's layout now take linear time on text full of escape sequences that never end, such as a pasted terminal capture. Every unterminated CSI, OSC or APC introducer searched the rest of the text for its terminator, so 40,000 such characters took over a second to measure, truncate or lay out, and 100,000 took about ten. On printable ASCII text, `truncateToWidth` now reads only the first width + 1 characters instead of the whole text. Measuring a grapheme cluster of many combining marks that are also default-ignorable, or spacing marks that legacy `wcwidth` tables also list, took time exponential in their number and now takes linear time.
- The editor no longer overflows the call stack when one grapheme cluster is wider than its text area, such as a consonant followed by hundreds of spacing vowel signs. The cluster takes a line of its own, clipped between code points to the width, and still moves and deletes as one character.
- `wrapTextWithAnsi`, and with it `Text` and `Markdown`, clips a grapheme cluster wider than the width the same way, on a line of its own and with its styling kept, instead of returning a line wider than the width, which made the main screen stop with "Rendered line exceeds terminal width". It also no longer emits an empty line before such a cluster.
- In a one-column editor, the cursor after a line's last character takes a row of its own below that line instead of making the row two columns wide. Moving the cursor and clicking follow the rows as shown.

## [0.9.88-alpha.1] - 2026-11-16

### Added

- Exported `decodePrintableKey` for printable Kitty CSI-u and modifyOtherKeys input, and `normalizePastedText` for custom inputs to apply the editor's paste normalization.
- `TuiAltScreen` takes a `scrollPinnedPrompt` option: while a follow-end primary scroll view is scrolled up, the first line of the prompt (OSC 133 `A`) that started the turn at its top is pinned over its first row ([#5224](https://github.com/bastani-inc/atomic/issues/5224))

### Changed

- Forked `@earendil-works/pi-tui` 1.5.2 as `@bastani/atomic-tui`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-tui` and `@mariozechner/pi-tui` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- The renderer reads `ATOMIC_TUI_ESC_TIMEOUT`, `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW`, `ATOMIC_TUI_WRITE_LOG`, `ATOMIC_HYPERLINKS`, `ATOMIC_IMAGE_PROTOCOL`, `ATOMIC_TRUE_COLOR` and `ATOMIC_PROGRAM_STATUS`. Their `PI_*` names keep working when the `ATOMIC_*` name is unset ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

### Fixed

- A LaTeX sub- or superscript holding a long run of spaces, such as many `\ ` in a model's answer, now renders in linear time. Removing the spaces around `=`, `+` and `-` took quadratic time, so 100,000 escaped spaces held the terminal for about twelve seconds.
- `visibleWidth`, `truncateToWidth`, text wrapping and the editor's layout now take linear time on text full of escape sequences that never end, such as a pasted terminal capture. Every unterminated CSI, OSC or APC introducer searched the rest of the text for its terminator, so 40,000 such characters took over a second to measure, truncate or lay out, and 100,000 took about ten. On printable ASCII text, `truncateToWidth` now reads only the first width + 1 characters instead of the whole text. Measuring a grapheme cluster of many combining marks that are also default-ignorable, or spacing marks that legacy `wcwidth` tables also list, took time exponential in their number and now takes linear time.
- The editor no longer overflows the call stack when one grapheme cluster is wider than its text area, such as a consonant followed by hundreds of spacing vowel signs. The cluster takes a line of its own, clipped between code points to the width, and still moves and deletes as one character.
- `wrapTextWithAnsi`, and with it `Text` and `Markdown`, clips a grapheme cluster wider than the width the same way, on a line of its own and with its styling kept, instead of returning a line wider than the width, which made the main screen stop with "Rendered line exceeds terminal width". It also no longer emits an empty line before such a cluster.
- In a one-column editor, the cursor after a line's last character takes a row of its own below that line instead of making the row two columns wide. Moving the cursor and clicking follow the rows as shown.
