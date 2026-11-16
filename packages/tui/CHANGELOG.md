# Changelog

This package is Atomic's fork of `@earendil-works/pi-tui`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/tui/CHANGELOG.md).

## [Unreleased]

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
