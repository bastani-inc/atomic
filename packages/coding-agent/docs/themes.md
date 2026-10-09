> Atomic can create themes. Ask it to build one for your setup.

# Themes

Themes are JSON files that define colors for the TUI.

## On this page and its reference

This page covers selecting a theme and authoring your first one. The theme file format, every color token, and the accepted color values live in the [Theme reference](/themes/reference).

## Table of Contents

- [Locations](#locations)
- [Selecting a Theme](#selecting-a-theme)
- [Creating a Custom Theme](#creating-a-custom-theme)
- [Theme Format](/themes/reference#theme-format)
- [Color Tokens](/themes/reference#color-tokens)
- [Color Values](/themes/reference#color-values)
- [Tips](#tips)

## Locations

Atomic loads themes from:

- Built-in: `system`, `dark`, `light`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, `catppuccin-mocha`
- Global: `~/.atomic/agent/themes/*.json` (legacy `~/.pi/agent/themes/*.json`)
- Project: `.atomic/themes/*.json` (legacy `.pi/themes/*.json`, only after the project is trusted)
- Packages: `themes/` directories, `atomic.themes`, or legacy `pi.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`. `--theme <path>` loads a theme file; `--use-theme <name>` (see [Initial Theme](#initial-theme)) selects an already-loaded theme for this run without saving it.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "my-theme"
}
```

Use `"theme": "system"` to derive colors from your terminal's foreground, background, and ANSI palette. It follows terminal appearance changes where supported. If the terminal does not report colors, it uses ANSI palette colors and faint secondary text. Atomic's existing `dark`, `light`, and Catppuccin palettes remain available.

Use `"theme": "light-theme/dark-theme"` for automatic mode. The reported background decides which theme is selected, followed by the terminal's appearance notification, `COLORFGBG`, then dark. Atomic follows terminal appearance changes when supported.

On first run, Atomic detects your terminal background and defaults to `dark` or `light`.

Main chat, attached workflow-stage chat, and the workflow graph canvas use the terminal's default background, including terminal transparency. Graph node interiors share that background; headers, footers, focused title tabs, and tool cards retain their theme colors.

Truncated workflow-node labels keep the focused tab's fill, text color, and weight through the ellipsis. The surrounding border and node body retain their own styling.

### Initial Theme

Start an interactive run with a theme without changing the saved setting:

```bash
atomic --use-theme light
```

To follow terminal appearance, use the `lightTheme/darkTheme` form:

```bash
atomic --use-theme light/dark
```

The CLI value is the initial theme for that run only. Choosing another theme later in `/settings` applies it immediately and saves it normally; an unknown theme name reports the ordinary theme error.

## Creating a Custom Theme

1. Create a theme file:

```bash
mkdir -p ~/.atomic/agent/themes
vim ~/.atomic/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color Tokens](/themes/reference#color-tokens)):

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

Atomic automatically reloads the active custom theme when you edit its file, so you can see changes immediately.

Theme files are strict. Atomic accepts only the documented top-level fields and color tokens; custom keys under `colors`, `workingIndicator`, or `export` and extra top-level metadata make the theme invalid. Define reusable custom colors under `vars`. The [theme JSON schema](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/schemas/theme.schema.json) lists every accepted property, the required colors, and the accepted value types. Atomic reports invalid theme files during startup and `/reload`.

## Theme Format

Moved to [Theme reference](/themes/reference#theme-format).

## Color Tokens

Moved to [Theme reference](/themes/reference#color-tokens).

### Core UI (11 colors)

Moved to [Theme reference](/themes/reference#core-ui-11-colors).

### Backgrounds & Content (11 required, 3 optional)

Moved to [Theme reference](/themes/reference#backgrounds-&-content-11-required-3-optional).

### Markdown (10 colors)

Moved to [Theme reference](/themes/reference#markdown-10-colors).

### Tool Diffs (3 colors)

Moved to [Theme reference](/themes/reference#tool-diffs-3-colors).

### Syntax Highlighting (9 colors)

Moved to [Theme reference](/themes/reference#syntax-highlighting-9-colors).

### Thinking Level Borders (6 colors)

Moved to [Theme reference](/themes/reference#thinking-level-borders-6-colors).

### Bash Mode (1 color)

Moved to [Theme reference](/themes/reference#bash-mode-1-color).

### HTML Export (optional)

Moved to [Theme reference](/themes/reference#html-export-optional).

## Color Values

Moved to [Theme reference](/themes/reference#color-values).

### 256-Color Palette

Moved to [Theme reference](/themes/reference#256-color-palette).

### Terminal Compatibility

Moved to [Theme reference](/themes/reference#terminal-compatibility).

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

**Color harmony:** Start with a base palette (Nord, Gruvbox, Tokyo Night), define it in `vars`, and reference consistently.

**Testing:** Check your theme with different message types, tool states, markdown content, and long wrapped text.

**VS Code:** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Examples

See the built-in themes:
- [dark.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/dark.json)
- [light.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/light.json)
- [catppuccin-frappe.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/catppuccin-frappe.json)
- [catppuccin-latte.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/catppuccin-latte.json)
- [catppuccin-macchiato.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/catppuccin-macchiato.json)
- [catppuccin-mocha.json](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/theme/catppuccin-mocha.json)
