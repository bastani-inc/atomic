---
title: Themes
description: Select built-in themes or create custom JSON themes with live reload.
---

# Themes

Themes are JSON files that define colors for the TUI.

## On this page and its reference

This page covers selecting a theme and authoring your first one. The theme file format, every color token, and the accepted color values live in the [Theme reference](/themes/reference).

## Locations

Atomic loads themes from:

- Built-in: `system`, `dark`, `light`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, `catppuccin-mocha`
- Global: `~/.atomic/agent/themes/*.json` (legacy `~/.pi/agent/themes/*.json`)
- Project: `.atomic/themes/*.json` (legacy `.pi/themes/*.json`, only after the project is trusted)
- Packages: `themes/` directories, `atomic.themes`, or legacy `pi.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable default discovery with `--no-themes`. `--theme <path>` loads a theme file; `--use-theme <name>` (see [Initial Theme](#initial-theme)) selects an already-loaded theme for this run without saving it.

## Selecting a theme

Atomic does not have a `/theme` slash command. Select a theme through `/settings`, `--use-theme`, or `settings.json`:

```json
{
  "theme": "my-theme"
}
```

Use `"theme": "system"` to derive colors from your terminal's foreground, background, and ANSI palette. It follows terminal appearance changes where supported. If the terminal does not report colors, it uses ANSI palette colors and faint secondary text. Atomic's `dark`, `light`, and Catppuccin palettes remain available.

Use `"theme": "light-theme/dark-theme"` for automatic mode. The reported background decides which theme is selected, followed by the terminal's appearance notification, `COLORFGBG`, then dark. Atomic follows terminal appearance changes when supported.

On first run, Atomic detects your terminal background and defaults to `dark` or `light`.

The main chat uses the terminal's default background, including transparency. Headers, footers, and tool cards keep their theme colors.

### Initial Theme

Start an interactive run with a theme without changing the saved setting:

```bash
atomic --use-theme light
```

To follow terminal appearance, use the `lightTheme/darkTheme` form:

```bash
atomic --use-theme light/dark
```

The CLI value sets the initial theme for that run only. Choosing another theme later in `/settings` applies it immediately and saves it normally. An unknown theme name reports the ordinary theme error.

## Creating a custom theme

1. Create a theme file:

```bash
mkdir -p ~/.atomic/agent/themes
vim ~/.atomic/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color tokens](/themes/reference#color-tokens)):

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

Atomic reloads the active custom theme automatically when you edit its file, so you can see changes right away.

Theme files are strict. Atomic accepts only the documented top-level fields and color tokens. Custom keys under `colors`, `workingIndicator`, or `export` and extra top-level metadata make the theme invalid. Define reusable custom colors under `vars`. The [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json) lists every accepted property, the required colors, and the accepted value types. Atomic reports invalid theme files during startup and `/reload`.

## Tips

**Dark terminals.** Use bright, saturated colors with higher contrast.

**Light terminals.** Use darker, muted colors with lower contrast.

**Color harmony.** Start with a base palette such as Nord, Gruvbox, or Tokyo Night, define it in `vars`, and reference it consistently.

**Testing.** Check your theme with different message types, tool states, Markdown content, and long wrapped text.

**VS Code.** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Built-in themes

Atomic ships seven built-in themes:

- `system` (generated from your terminal's reported colors and ANSI palette)
- `dark`
- `light`
- `catppuccin-frappe`
- `catppuccin-latte`
- `catppuccin-macchiato`
- `catppuccin-mocha`

## Moved sections

<a id="theme-format" />
<a id="color-tokens" />
<a id="core-ui-11-colors" />
<a id="backgrounds-&-content-11-required-3-optional" />
<a id="markdown-10-colors" />
<a id="tool-diffs-3-colors" />
<a id="syntax-highlighting-9-colors" />
<a id="thinking-level-borders-6-colors" />
<a id="bash-mode-1-color" />
<a id="html-export-optional" />
<a id="color-values" />
<a id="256-color-palette" />
<a id="terminal-compatibility" />

- Theme format, color tokens, HTML export settings, color values, 256-color palette behavior, and terminal compatibility moved to [Theme reference](/themes/reference).
