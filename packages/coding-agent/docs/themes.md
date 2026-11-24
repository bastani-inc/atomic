---
title: "Customize themes"
sidebarTitle: "Themes"
description: "Switch built-in terminal themes, follow system light or dark appearance, and author custom JSON themes with hot reload."
---

Themes are JSON files that define colors for the Atomic terminal UI.

This page covers selecting a theme and authoring your own. See [Theme reference](/themes/reference) for the file schema, every color token, accepted color formats, and terminal color overrides.

## Built-in themes

Atomic ships seven built-in themes:

- `system`: derives colors from your terminal's reported foreground, background, and ANSI palette, and follows terminal appearance changes where supported. If the terminal does not report colors, it uses ANSI palette colors and faint secondary text. `system` is reserved and cannot be overridden by a custom theme.
- `dark`
- `light`
- `catppuccin-frappe`
- `catppuccin-latte`
- `catppuccin-macchiato`
- `catppuccin-mocha`

## Locations and precedence

Atomic loads custom themes from these sources:

- **Global:** `~/.atomic/agent/themes/*.json` (legacy `~/.pi/agent/themes/*.json`)
- **Project** (only after you trust the project): `.atomic/themes/*.json` (legacy `.pi/themes/*.json`)
- **Packages:** `themes/` directories, `atomic.themes`, or legacy `pi.themes` entries in `package.json`
- **Settings:** `themes` array in global or project `settings.json`, which accepts files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--theme <path>` (repeatable) loads a theme file; `--use-theme <name>` (see [Initial theme](#initial-theme)) selects an already-loaded theme for one run without saving it

Discovery rules:

- Auto-discovery in `~/.atomic/agent/themes/` and `.atomic/themes/` is non-recursive and skips dotfiles, `node_modules`, and files matched by `.gitignore`, `.ignore`, or `.fdignore`.
- Disable custom and package theme discovery with `--no-themes` (no short flag). Built-in themes and explicit `--theme <path>` files remain available.
- When multiple custom themes share the same `"name"`, Atomic keeps the first match and reports a collision diagnostic at startup or `/reload`. Precedence order:
  1. Packages passed with `-e` / `--extension`
  2. Project `settings.json` `themes` array
  3. Project auto-discovered directories (`.atomic/themes/`, then legacy `.pi/themes/`)
  4. Global `settings.json` `themes` array
  5. Global auto-discovered directories (`~/.atomic/agent/themes/`, then legacy `~/.pi/agent/themes/`)
  6. Configured packages (project packages, then global packages)
  7. Bundled packages
  8. Explicit CLI `--theme <path>` paths

## Selecting a theme

Atomic does not have a `/theme` slash command. Select a theme through `/settings`, `--use-theme`, or `settings.json`:

```json
{
  "theme": "my-theme"
}
```

Use `"theme": "light-theme/dark-theme"` for automatic mode. Specify exactly one `/`, with non-empty names on both sides (surrounding spaces are trimmed). Atomic selects the matching theme using this fallback order:

1. Terminal-reported background color (waits up to 100 ms at startup, and applies late terminal replies asynchronously if they arrive after startup)
2. Terminal appearance change notifications
3. `COLORFGBG` environment variable (uses the last `;`-separated number; indices `0` to `6` and `8` map to dark, all other integers map to light)
4. Dark theme fallback

A malformed auto value with extra `/` characters or an empty side falls back to the terminal default (`dark` or `light`). On first run, Atomic detects your terminal background and defaults to `dark` or `light`.

The main chat uses the terminal's default background, including transparency. Headers, footers, and tool cards keep their theme colors.

### Initial theme

Start an interactive run with a theme without changing the saved setting:

```bash
atomic --use-theme light
```

To follow terminal appearance for one run, pass `lightTheme/darkTheme`:

```bash
atomic --use-theme light/dark
```

`--use-theme` applies in interactive mode only (ignored in print, JSON, and RPC modes). Choosing another theme later in `/settings` applies it immediately and saves it normally. If the requested theme name is unknown or fails to load, Atomic prints an error (`Failed to load theme "<name>": ...`) and falls back to `dark`.

## Creating a custom theme

1. Create a theme file:

```bash
mkdir -p ~/.atomic/agent/themes
vim ~/.atomic/agent/themes/my-theme.json
```

2. Define the theme with all 51 required color tokens (see [Color tokens](/themes/reference#color-tokens)):

```json
{
  "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/theme.schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarThumb": "#555566",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "bashMode": "#ffaa00"
  }
}
```

3. Select the theme via `/settings`.

### Live hot reload

Atomic watches the active custom theme's actual file path and reloads it automatically when you save edits (debounced by 100 ms). Hot reload works for global themes, project themes, package themes, `--theme <path>` files, and custom themes whose filename differs from their JSON `"name"`. If you save invalid JSON mid-edit, Atomic ignores the broken save and keeps the last valid theme active until the next valid save.

Theme files are strict. Atomic accepts only the documented top-level fields and color tokens. Extra top-level metadata or unknown keys under `colors`, `workingIndicator`, or `export` make the theme invalid. Define reusable custom colors under `vars`. The [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json) lists every accepted property, required token, and value type. Atomic reports invalid theme files during startup and `/reload`.

## Tips

**Dark terminals.** Use bright, saturated colors with higher contrast.

**Light terminals.** Use darker, muted colors with lower contrast.

**Color harmony.** Start with a base palette such as Nord, Gruvbox, or Tokyo Night, define it in `vars`, and reference it consistently.

**Testing.** Check your theme with different message types, tool states, Markdown content, and long wrapped text.

**VS Code.** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.
