---
title: "Theme reference"
sidebarTitle: "Themes"
description: "Reference for theme JSON structure, all 51 required and 3 optional color tokens, color formats, and terminal color modes."
---

## Theme format

```json
{
  "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/theme.schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "accentColor": "blue",
    "gray": 242
  },
  "colors": {
    "accent": "accentColor",
    "muted": "gray",
    "text": "",
    "border": "blue"
  },
  "workingIndicator": {
    "dark": "#70759f",
    "lift": "#7f849c",
    "muted": "#789bd0",
    "accent": "blue",
    "bright": "#b8d2ff",
    "peak": "#eef4ff"
  },
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

- `name` is required, must be a non-empty string, must be unique, and must not contain `/`. The name `system` is reserved and cannot be overridden.
- `vars` is optional. Define reusable colors here and reference them from `colors`, `workingIndicator`, `export`, or other `vars` entries. Chained variable references are supported; circular references fail validation with `"Circular variable reference detected"`, and undefined variable names fail with `"Variable reference not found"`.
- `colors` must define all 51 required tokens. `scrollbarThumb` is optional and falls back to `selectedBg` when omitted. `searchMatchBg` and `searchMatchText` remain accepted for older theme files but are unused.
- `workingIndicator` is optional. It can override any of the six tones in the outward half of the ordinary `∀` ramp. Atomic derives omitted tones from selected background, accent, and text roles, then mirrors the palette back after `peak`.
  - Explicit numeric values from `0` through `255` remain exact terminal palette indices.
  - When an index from `0` through `15` seeds an omitted tone, Atomic mixes from its built-in approximation of the common ANSI RGB value. The terminal still controls the explicit index's actual appearance.
  - Both explicit and derived tones update on theme hot reload.

The `$schema` field enables editor completion and validation against the [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json). Atomic rejects theme files with unknown top-level fields or unknown properties under `colors`, `workingIndicator`, or `export`. Define reusable custom colors under `vars` instead.

## Color tokens

Every theme must define all 51 required color tokens. The three optional tokens preserve compatibility with older theme files: `scrollbarThumb` and unused `searchMatchBg` fall back to `selectedBg`, and unused `searchMatchText` falls back to `text`.

### Core UI (11 colors)

| Token | Purpose |
| --- | --- |
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

### Backgrounds and content (11 required, 3 optional)

| Token | Purpose |
| --- | --- |
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
| --- | --- |
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
| --- | --- |
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax highlighting (9 colors)

| Token | Purpose |
| --- | --- |
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
| --- | --- |
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high and `max` thinking |

### Bash mode (1 color)

| Token | Purpose |
| --- | --- |
| `bashMode` | Editor border in bash mode (`!` prefix) |

### HTML export (optional)

The `export` section controls background colors for `/export` HTML output. Each field accepts hex, OKHSL, 256-color integers, or `vars` references. Omitted fields (or `""`) derive from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

In HTML exports, an empty string `""` color token renders as `#000000` for built-in light themes (`light`, `catppuccin-latte`, or `system` on a light terminal) and `#e5e5e7` for all other themes.

## Color values

Five value formats are supported:

| Format | Example | Validation rules |
| --- | --- | --- |
| Hex | `"#ff0000"` | Strictly 6 hex digits (`#rrggbb`, case-insensitive). 3-digit shorthand (`#f00`) and 8-digit hex with alpha (`#ff000080`) are rejected. |
| OKHSL | `"okhsl(295 0.6 0.5)"` or `"okhsl(295deg 60% 50%)"` | Case-insensitive, whitespace-separated only (commas are rejected). Hue accepts optional `deg`; saturation and lightness must be in `0` to `1` or `0%` to `100%` or loading fails. Converted to hex for rendering and HTML export. Other CSS color functions such as `oklch(...)` are not accepted. |
| 256-color | `39` | Must be a JSON integer from `0` to `255`. Floats (such as `39.5`) fail validation, and quoted strings (such as `"39"`) are treated as variable references instead of palette indices. |
| Variable | `"primary"` | References a key in `vars`. Chained references work; circular or missing references fail theme loading. |
| Default | `""` | Uses the terminal's default foreground or background color. |

### 256-color palette

- `0` to `15`: Basic ANSI colors (terminal-dependent)
- `16` to `231`: 6x6x6 RGB cube (`16 + 36*R + 6*G + B` where `R`, `G`, and `B` are `0` to `5`)
- `232` to `255`: Grayscale ramp

### Terminal compatibility

Atomic selects truecolor (24-bit RGB) or 256-color output in this precedence order:

1. `terminal.trueColor` in `settings.json` (`true` forces truecolor; `false` forces 256-color)
2. `ATOMIC_TRUE_COLOR` environment variable (`1` forces truecolor; `0` forces 256-color; legacy `PI_TRUE_COLOR` is also supported)
3. Automatic detection:
   - `COLORTERM=truecolor`, `COLORTERM=24bit`, or `WT_SESSION` selects truecolor.
   - `TERM=dumb`, empty `TERM`, `TERM=linux`, `TERM=screen*`, or `TERM_PROGRAM=Apple_Terminal` selects 256-color.
   - Other terminals default to truecolor.

When falling back to 256-color mode, Atomic maps 24-bit RGB colors to the nearest palette color, which can turn a slightly tinted background into gray. The tool status backgrounds `toolPendingBg`, `toolSuccessBg`, and `toolErrorBg` preserve their hue instead by picking the nearest palette color whose strongest RGB channel matches. Give these three tokens different dominant channels (for example blue, green, and red tints) to keep them distinguishable in 256-color terminals, or set a 256-color index directly.

Check your terminal's advertised color capability:

```bash
echo "$COLORTERM"  # Outputs "truecolor" or "24bit" when advertised
```

Turning colors off or overriding ANSI output:

- `NO_COLOR` (any value) turns off every theme color, foreground and background, and text styles such as bold, italic, underline, inverse, strikethrough, and dim. Layout and text stay the same.
- `FORCE_COLOR=0` (or `FORCE_COLOR=false`) does the same. `FORCE_COLOR=1` (or `true` or empty) and `FORCE_COLOR=2` limit truecolor themes to the 256-color palette, and `FORCE_COLOR=3` keeps the terminal's resolved color mode. `NO_COLOR` wins when both are set.
- An extension painting custom `#rrggbb` colors can call `hexColorAnsi(hex, "fg")` or `hexColorAnsi(hex, "bg")` from `@bastani/atomic` to get the ANSI sequence respecting `NO_COLOR` and `FORCE_COLOR` (empty string when colors are off). Note that `hexColorAnsi()` respects `NO_COLOR` and `FORCE_COLOR` (`1`/`2` -> 256-color, `3`/unset -> truecolor), and does not read `terminal.trueColor` or `ATOMIC_TRUE_COLOR`.
