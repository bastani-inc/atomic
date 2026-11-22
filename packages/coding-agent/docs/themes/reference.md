---
title: Theme reference
description: Theme file format, every color token, and accepted color values.
---

# Theme reference

## Theme format

```json
{
  "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/theme.schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  },
  "workingIndicator": {
    "dark": "#70759f",
    "lift": "#7f849c",
    "muted": "#789bd0",
    "accent": "blue",
    "bright": "#b8d2ff",
    "peak": "#eef4ff"
  }
}
```

- `name` is required, must be unique, and must not contain `/`.
- `vars` is optional. Define reusable colors here, then reference them in `colors` or `workingIndicator`.
- `colors` must define all 51 required tokens. `scrollbarThumb` is optional and falls back to `selectedBg` when omitted. `searchMatchBg` and `searchMatchText` remain accepted for older theme files but are unused.
- `workingIndicator` is optional. It can override any of the six tones in the outward half of the ordinary `∀` ramp. Atomic derives omitted tones from selected background, accent, and text roles, then mirrors the palette back after `peak`.
  - Explicit numeric values from 0 through 255 remain exact terminal palette indices.
  - When an index from 0 through 15 seeds an omitted tone, Atomic mixes from its built-in approximation of the common ANSI RGB value. The terminal still controls the explicit index's actual appearance.
  - Both explicit and derived tones update on theme hot reload.

The `$schema` field enables editor auto-completion and validation against the [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json). Atomic rejects theme files with unknown top-level fields or unknown properties under `colors`, `workingIndicator`, or `export`. Define reusable custom colors under `vars` instead.

## Color tokens

Every theme must define all 51 required color tokens. The optional tokens preserve compatibility with older theme files: `scrollbarThumb` and unused `searchMatchBg` fall back to `selectedBg`, and unused `searchMatchText` falls back to `text`.

### Core UI (11 colors)

| Token | Purpose |
|-------|---------|
| `accent` | Primary accent (logo, selected items, cursor) |
| `border` | Normal borders |
| `borderAccent` | Highlighted borders |
| `borderMuted` | Subtle borders (editor) |
| `success` | Success states |
| `error` | Error states |
| `warning` | Warning states |
| `muted` | Secondary text |
| `dim` | Tertiary text |
| `text` | Default text (usually `""`) |
| `thinkingText` | Thinking block text |

### Backgrounds & content (11 required, 3 optional)

| Token | Purpose |
|-------|---------|
| `selectedBg` | Selected line background |
| `scrollbarThumb` | Fullscreen scrollbar thumb background; optional, falls back to `selectedBg` |
| `searchMatchBg` | Unused leftover token; optional, falls back to `selectedBg` |
| `searchMatchText` | Unused leftover token; optional, falls back to `text` |
| `userMessageBg` | User message background |
| `userMessageText` | User message text |
| `customMessageBg` | Extension message background |
| `customMessageText` | Extension message text |
| `customMessageLabel` | Extension message label |
| `toolPendingBg` | Tool box (pending) |
| `toolSuccessBg` | Tool box (success) |
| `toolErrorBg` | Tool box (error) |
| `toolTitle` | Tool title |
| `toolOutput` | Tool output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Headings |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border |
| `mdHr` | Horizontal rule |
| `mdListBullet` | List bullets |

### Tool diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking level borders (6 colors)

Editor border colors indicating thinking level (from subtle to prominent):

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high and `max` thinking |

### Bash mode (1 color)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |

### HTML export (optional)

The `export` section controls colors for `/export` HTML output. If omitted, colors are derived from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color values

Five formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6-digit hex RGB |
| OKHSL | `"okhsl(295 0.6 0.5)"` or `"okhsl(295deg 60% 50%)"` | Hue in degrees (optional `deg`), saturation and lightness as 0 to 1 decimals or 0% to 100% percentages. Converted to hex for rendering and HTML export. |
| 256-color | `39` | xterm 256-color palette index (0 to 255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

### 256-color palette

- `0` to `15`: Basic ANSI colors (terminal-dependent)
- `16` to `231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where `R`, `G`, and `B` are 0 to 5)
- `232` to `255`: Grayscale ramp

### Terminal compatibility

Atomic uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, Atomic falls back to the nearest palette color, which turns a slightly tinted background into a gray.

The tool status backgrounds `toolPendingBg`, `toolSuccessBg`, and `toolErrorBg` keep their hue instead. Each uses the nearest palette color whose strongest RGB channel is the same, so a green-tinted success background stays green. Give these three tokens different strongest channels (for example blue, green, and red tints) to keep them distinguishable in 256-color terminals, or set a palette index directly.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

Turning colors off:

- `NO_COLOR` (any value) turns off every theme color, foreground and background, and text styles such as bold, italic, underline, inverse, strikethrough, and dim. Layout and text stay the same.
- `FORCE_COLOR=0` (or `FORCE_COLOR=false`) does the same. `FORCE_COLOR=1` (or `true` or empty) and `FORCE_COLOR=2` limit truecolor themes to the 256-color palette, and `FORCE_COLOR=3` keeps the terminal's own color mode. `NO_COLOR` wins when both are set.
- An extension that paints its own `#rrggbb` colors can call `hexColorAnsi(hex, "fg")` or `hexColorAnsi(hex, "bg")` from `@bastani/atomic` to get the escape sequence for the current settings, which is empty when colors are off.
