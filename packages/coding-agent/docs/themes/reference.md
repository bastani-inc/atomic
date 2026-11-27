---
title: "Theme format reference"
sidebarTitle: "Theme format"
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

- `name` is required, must be a non-empty string, must be unique, and must not contain `/`. The name `system` is reserved (a custom theme named `system` is silently ignored). Avoid reusing other built-in names (`dark`, `light`, `catppuccin-*`): they override interactive rendering, while `/export` still uses the built-in theme and live hot reload disables itself.
- `vars` is optional. Define reusable colors here and reference them from `colors`, `workingIndicator`, `export`, or other `vars` entries. Chained variable references are supported; circular references fail with `"Circular variable reference detected"`, and undefined variable names fail with `"Variable reference not found"`.
- `colors` must define all 51 required tokens. `scrollbarThumb` is optional and falls back to `selectedBg` when omitted. `searchMatchBg` and `searchMatchText` remain accepted for compatibility with older theme files and are unused.
- `workingIndicator` is optional. Atomic's busy indicator (`∀`) pulses across a 6-step brightness gradient (`dark` → `lift` → `muted` → `accent` → `bright` → `peak`) and back. Override any of those six tones; Atomic derives omitted tones from the theme's selected background, accent, and text colors.
  - Explicit numeric values from `0` through `255` stay exact terminal palette indices.
  - When a basic ANSI index (`0` through `15`) seeds an omitted tone, Atomic mixes from its built-in approximation of common ANSI RGB values while the terminal still renders the explicit index itself.
  - Both explicit and derived tones update on theme hot reload.

The `$schema` field enables editor completion and validation against the [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json). Atomic rejects unknown top-level keys or unknown properties under `colors`, `workingIndicator`, or `export`. Put reusable custom colors in `vars`.

## Color tokens

Every theme must define all 51 required color tokens. The three optional tokens fall back automatically when omitted: `scrollbarThumb` and unused `searchMatchBg` fall back to `selectedBg`, and unused `searchMatchText` falls back to `text`.

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
| `searchMatchBg` | Unused compatibility token; optional, falls back to `selectedBg` |
| `searchMatchText` | Unused compatibility token; optional, falls back to `text` |
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
- `16` to `231`: 6×6×6 RGB cube (`16 + 36*R + 6*G + B` where `R`, `G`, and `B` are `0` to `5`)
- `232` to `255`: Grayscale ramp

## Terminal compatibility

Atomic selects truecolor (24-bit RGB) or 256-color output in this precedence order:

1. `terminal.trueColor` in `settings.json` (`true` forces truecolor; `false` forces 256-color)
2. `ATOMIC_TRUE_COLOR` environment variable (`1` forces truecolor; `0` forces 256-color; legacy `PI_TRUE_COLOR` is also supported)
3. Automatic detection:
   - `COLORTERM=truecolor`, `COLORTERM=24bit`, or `WT_SESSION` selects truecolor.
   - `TERM=dumb`, empty `TERM`, `TERM=linux`, `TERM=screen*`, or `TERM_PROGRAM=Apple_Terminal` selects 256-color.
   - Other terminals default to truecolor.

When falling back to 256-color mode, Atomic maps 24-bit RGB colors to the nearest palette entry, which can turn a subtly tinted background gray. The tool status backgrounds `toolPendingBg`, `toolSuccessBg`, and `toolErrorBg` preserve their hue instead by picking the nearest palette color whose strongest RGB channel matches. Give those three tokens distinct dominant channels (for example blue, green, and red tints) or explicit 256-color indices so they remain distinguishable in 256-color terminals.

When detecting light vs. dark terminal appearance via `COLORFGBG`, Atomic reads the last `;`-separated integer: indices `0` through `6` and `8` map to `dark`, and all other integers map to `light`.

Check your terminal's advertised color capability:

```bash
echo "$COLORTERM"  # Outputs "truecolor" or "24bit" when advertised
```

### Disabling colors and `hexColorAnsi()`

- `NO_COLOR` (any value) disables every theme color (foreground and background) and text style (bold, italic, underline, inverse, strikethrough, dim) while keeping layout and text unchanged. `NO_COLOR` always takes precedence over `FORCE_COLOR`.
- `FORCE_COLOR=0` (or `FORCE_COLOR=false`) disables colors and styles the same way.
- `FORCE_COLOR=1` (or `true` or empty) and `FORCE_COLOR=2` cap truecolor themes at the 256-color palette.
- `FORCE_COLOR=3` keeps the terminal's resolved color mode for `Theme` rendering (a 256-color terminal is not upgraded to truecolor).
- Extensions painting custom `#rrggbb` colors can call `hexColorAnsi(hex, "fg")` or `hexColorAnsi(hex, "bg")` from `@bastani/atomic`. It returns `""` when color is disabled (`NO_COLOR` or `FORCE_COLOR=0`/`false`), maps to 256-color under `FORCE_COLOR=1`/`2`, forces truecolor under `FORCE_COLOR=3`, and otherwise follows the active theme's resolved color mode (including `terminal.trueColor`, `ATOMIC_TRUE_COLOR` / legacy `PI_TRUE_COLOR`, and terminal auto-detection).
