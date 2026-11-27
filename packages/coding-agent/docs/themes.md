---
title: "Create themes"
sidebarTitle: "Create themes"
description: "Switch built-in terminal themes, follow system light or dark appearance, and author custom JSON themes with hot reload."
---

Themes are JSON files that control every color in the Atomic terminal UI. Switch between built-in palettes, follow your terminal's light or dark appearance automatically, or author your own theme with live hot reload.

See [Theme format reference](/themes/reference) for the complete JSON schema, all 51 required and 3 optional color tokens, accepted color formats, and terminal color modes.

## Built-in themes

Atomic ships seven built-in themes:

- `system` — derives colors from your terminal's reported foreground, background, and ANSI palette, and follows terminal appearance changes where supported. If the terminal does not report colors, it uses ANSI palette colors and faint secondary text.
- `dark`
- `light`
- `catppuccin-frappe`
- `catppuccin-latte`
- `catppuccin-macchiato`
- `catppuccin-mocha`

<Warning>
Choose a distinct `"name"` for custom themes. `system` is reserved and a custom theme named `system` is silently ignored. Reusing another built-in name (`dark`, `light`, `catppuccin-*`) overrides interactive rendering, while `/export` still uses the built-in theme and live hot reload disables itself.
</Warning>

## Select a theme

<Note>
Atomic does not have a `/theme` slash command. Choose a theme in `/settings`, pass `--use-theme`, or edit `settings.json` ([Interface and display settings](/settings#interface-and-display)).
</Note>

Set a single theme in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "theme": "catppuccin-mocha"
}
```

To follow your terminal's light or dark appearance automatically, set `"theme": "light-theme/dark-theme"` with exactly one `/` and non-empty names on both sides (surrounding spaces are trimmed):

```json
{
  "theme": "catppuccin-latte/catppuccin-mocha"
}
```

Atomic chooses the light or dark side in this order:

1. Terminal-reported background color (waits up to 100 ms at startup and applies late replies asynchronously)
2. Terminal appearance change notifications (subscribed when using a `light/dark` pair or `system`, not when `theme` is unset)
3. `COLORFGBG` environment variable (see [Terminal compatibility](/themes/reference#terminal-compatibility) for index mapping)
4. Dark theme fallback

Edge cases to know:

- A malformed auto value with extra `/` characters or an empty side (such as `"light/"`) silently falls back to the detected terminal default (`dark` or `light`).
- Setting `"theme": ""` fails with `Theme not found: ` and falls back to `dark`.
- The main chat keeps your terminal's default background (including transparency), while headers, footers, and tool cards keep their theme colors.
- `NO_COLOR` (any value) or `FORCE_COLOR=0` disables all theme colors and text styles, `FORCE_COLOR=1` or `2` caps output at 256 colors, and `NO_COLOR` always wins over `FORCE_COLOR` ([Terminal compatibility](/themes/reference#terminal-compatibility), [Environment variables](/environment-variables#terminal-and-display-variables)).

### Initial theme

Override the theme for one interactive run without changing `settings.json`:

```bash
atomic --use-theme light
atomic --use-theme light/dark
```

`--use-theme` applies in interactive mode only (ignored in print, JSON, and RPC modes). Selecting a different theme later in `/settings` applies immediately and saves normally. If the requested theme name is unknown or invalid, Atomic prints `Failed to load theme "<name>": ...` and falls back to `dark`.

## Create a custom theme

<Steps>
  <Step title="Create the theme file">
    Create a JSON file under `~/.atomic/agent/themes/` (global) or `.atomic/themes/` (project):

    ```bash
    mkdir -p ~/.atomic/agent/themes
    vim ~/.atomic/agent/themes/my-theme.json
    ```
  </Step>
  <Step title="Define variables and all 51 required color tokens">
    Include `$schema` for editor completion and define every required token (plus optional `scrollbarThumb` shown below; see [Color tokens](/themes/reference#color-tokens)):

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
  </Step>
  <Step title="Activate and iterate live">
    Run `/reload` if Atomic is already open, then pick `my-theme` in `/settings`. Edit and save the file to watch changes apply live.
  </Step>
</Steps>

### Live hot reload

Atomic watches the active custom theme's file on disk and reloads it automatically on save (100 ms debounce), falling back to 1-second polling if native file watching is unavailable on that path.

- Works for global themes, project themes, package themes, `--theme <path>` files, and custom themes whose filename differs from their JSON `"name"`.
- Saving invalid JSON mid-edit keeps the last valid theme active until the next valid save.
- Hot reload is not active for `system`, built-in theme names, or in-memory `Theme` instances passed via extension `setTheme()`.

Theme validation is strict: Atomic rejects unknown top-level keys or unknown properties under `colors`, `workingIndicator`, or `export`, and reports invalid files on startup and `/reload`. Put reusable custom colors in `vars`.

## Where themes load from

Atomic discovers custom themes from these sources:

- **Global:** `~/.atomic/agent/themes/*.json`
- **Project** (requires [project trust](/security#project-trust)): `.atomic/themes/*.json`
- **Packages:** `themes/` directories or `atomic.themes` entries in `package.json` ([Create packages](/packages/authoring))
- **Settings:** `themes` array in global or project `settings.json`, accepting files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--theme <path>` (repeatable; accepts a `.json` file or a directory) loads themes; `--use-theme <name>` activates one for that run

Discovery and precedence behavior:

- Auto-discovery in `~/.atomic/agent/themes/` and `.atomic/themes/` is non-recursive and skips dotfiles, `node_modules`, and files matched by `.gitignore`, `.ignore`, or `.fdignore`.
- Explicit `--theme <dir>` paths read all `*.json` files in that directory without applying dotfile or `.gitignore` filters.
- Passing `--no-themes` disables auto-discovered and configured-package themes; built-in themes, themes shipped in `-e` / `--extension` packages, and explicit `--theme <path>` files or directories still load.
- When multiple custom themes declare the same `"name"`, Atomic reports a collision diagnostic and keeps the first match: `-e` packages win first, then project overrides global, both override configured packages, and explicit `--theme` paths apply last—see [Resource precedence order](/packages/reference#resource-precedence-order).

<Note>
Legacy `.pi` theme locations (`~/.pi/agent/themes/*.json`, `.pi/themes/*.json`, and `pi.themes` in `package.json`) remain supported alongside `.atomic` paths.
</Note>

## Tips

- **Dark terminals:** Use bright, saturated accents with clear contrast against dark backgrounds.
- **Light terminals:** Use darker, muted tones to keep text comfortable to scan.
- **Color harmony:** Define a small base palette (such as Nord, Gruvbox, or Tokyo Night) in `vars` and reference it across tokens.
- **Testing:** Check your theme across user messages, tool pending/success/error states, diffs, Markdown code blocks, and long wrapped lines.
- **VS Code terminal:** Set `terminal.integrated.minimumContrastRatio` to `1` so VS Code does not shift your palette colors.
