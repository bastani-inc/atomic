---
name: Atomic CLI
description: Terminal control plane for orchestrating multi-agent coding workflows.
colors:
  crust: "#11111b"
  mantle: "#181825"
  base: "#1e1e2e"
  surface0: "#313244"
  surface1: "#45475a"
  surface2: "#585b70"
  overlay0: "#6c7086"
  overlay1: "#7f849c"
  text: "#cdd6f4"
  subtext0: "#a6adc8"
  blue: "#89b4fa"
  green: "#a6e3a1"
  yellow: "#f9e2af"
  red: "#f38ba8"
  mauve: "#cba6f7"
  sky: "#89dceb"
typography:
  bold:
    fontWeight: 700
  regular:
    fontWeight: 400
rounded:
  box: "rounded"
spacing:
  unit-1: "1ch"
  unit-2: "2ch"
  unit-3: "3ch"
components:
  pill-mode:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.surface0}"
    typography: "{typography.bold}"
    padding: "0 1ch"
  pill-status-success:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface0}"
    typography: "{typography.bold}"
    padding: "0 1ch"
  pill-status-error:
    backgroundColor: "{colors.red}"
    textColor: "{colors.surface0}"
    typography: "{typography.bold}"
    padding: "0 1ch"
  picker-row-default:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.subtext0}"
    padding: "0 2ch 0 1ch"
  picker-row-selected:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.surface0}"
    typography: "{typography.bold}"
    padding: "0 2ch 0 1ch"
  picker-row-broken:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.overlay1}" # dim alias
    glyphColor: "{colors.red}"
    captionColor: "{colors.red}"
    padding: "0 2ch 0 1ch"
  picker-row-broken-focused:
    backgroundColor: "{colors.surface1}" # the previously-reserved disabled-hover stratum
    textColor: "{colors.text}" # alias lifted to text, NOT bold
    glyphColor: "{colors.red}"
    captionColor: "{colors.red}"
    padding: "0 2ch 0 1ch"
  panel:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.box}"
    padding: "1ch 2ch"
  field-default:
    backgroundColor: "{colors.crust}"
    textColor: "{colors.text}"
    rounded: "{rounded.box}"
    padding: "0 2ch"
  field-focused:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.box}"
    padding: "0 2ch"
  node-card-pending:
    backgroundColor: "{colors.base}"
    textColor: "{colors.overlay1}"
    rounded: "{rounded.box}"
  node-card-running:
    backgroundColor: "{colors.base}"
    textColor: "{colors.yellow}"
    rounded: "{rounded.box}"
  node-card-complete:
    backgroundColor: "{colors.base}"
    textColor: "{colors.green}"
    rounded: "{rounded.box}"
  node-card-error:
    backgroundColor: "{colors.base}"
    textColor: "{colors.red}"
    rounded: "{rounded.box}"
  node-card-awaiting:
    backgroundColor: "{colors.base}"
    textColor: "{colors.sky}"
    rounded: "{rounded.box}"
  statusline:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    padding: "0 2ch 0 0"
  section-label:
    textColor: "{colors.subtext0}"
    typography: "{typography.bold}"
---

# Design System: Atomic CLI

## 1. Overview

**Creative North Star: "The Quiet Operator"**

Atomic is a terminal-native control plane for AI coding agents. Engineers run hour-long autonomous sessions through it, then come back to review. The interface has to disappear into that work: glanceable at 2am, dense without being cluttered, and willing to surface a saturated color the moment something needs attention. Catppuccin Mocha is the canonical palette; Tokyo Night is the secondary fallback. Light terminals fall back to Catppuccin Latte through the same token roles, so every component below has a parallel light reading.

The visual register is Restrained. Most of the surface is tinted neutral, with one accent (Catppuccin Blue) reserved for primary actions, current selection, and the mode pill. Status colors are not decoration; they correspond to the orchestrator's own state vocabulary (running, complete, awaiting input, error, pending). Bold weight does the heavy lifting where size cannot — terminals control font and size, but they reliably honor weight.

What Atomic is not: a cluttered enterprise dashboard, a generic CLI dump, or a flashy demo. There is no gratuitous animation. There is no decoration without a state behind it.

**Key Characteristics:**
- Catppuccin Mocha tokens, role-mapped (`bg`, `backgroundPanel`, `backgroundElement`, `surface`, `selection`, `border`, `borderDim`, `accent`, `text`, `textMuted`, `dim`, semantic colors)
- Restrained color strategy: one accent at a time, status colors carry meaning
- Tactile and confident component voice — pills, rounded boxes, decisive selection states
- Depth via tonal layering only; no shadows are possible in a terminal
- Bold + dim contrast carries hierarchy where size cannot
- Unicode iconography only (no emoji): `✓ ✗ → ↵ ↑↓←→ ○ ● ◆ ▸ ▎ ❯ │`
- Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms for loading

## 2. Colors

A Catppuccin Mocha palette, addressed by role. The Mantle/Base/Crust trio carries chrome, panel, and recess; surface0–surface2 carry chrome lift, selection, and subtle structure; the saturated colors carry meaning, never decoration.

### Primary
- **Catppuccin Blue** (`#89b4fa`): The sole accent. Powers the mode pill (`GRAPH`, `PICK`), the workflow-picker selection background, the focused-field border, the leading chevron `❯`, and inline references to API symbols in empty states. Treat as scarce.

### Secondary
- **Catppuccin Mauve** (`#cba6f7`): Section-label glyph (`▎`), `CONFIRM` mode pill, `opencode` agent identifier. Reads as a quieter emphasis next to Blue.

### Tertiary (semantic statuses)
- **Catppuccin Green** (`#a6e3a1`): `complete` status, `copilot` agent identifier, the "ready to run" confirm modal border, `y` submit indicator.
- **Catppuccin Yellow** (`#f9e2af`): `running` status (border pulses with this hue), `claude` agent identifier, `required` form field tag.
- **Catppuccin Red** (`#f38ba8`): `error` status, `n` cancel indicator, fatal render fallback.
- **Catppuccin Sky** (`#89dceb`): `awaiting_input` status, "waiting for response" caption inside a node card.

### Neutral
- **Crust** (`#11111b`): Recessed elements — input field default backgrounds in the workflow picker form. The "deepest" stratum.
- **Mantle** (`#181825`): Panel and card backgrounds — workflow list, filter bar, focused-field interior, modal interior.
- **Base** (`#1e1e2e`): Main canvas — orchestrator graph background, picker root, modal scrim.
- **Surface0** (`#313244`): Chrome bars — statusline, header, the foreground of saturated pills (text *on* an accent pill is `surface0`).
- **Surface1** (`#45475a`): Reserved for hover/selection states on neutral surfaces. Currently used by token consumers; not reused as a row-selection background (Blue handles that for visibility).
- **Surface2** (`#585b70`): `borderDim` — quiet rule-lines and panel separators.
- **Overlay0** (`#6c7086`): `border` — emphasized borders (active panels, the divider between picker list and preview).
- **Overlay1** (`#7f849c`): `dim` — separator dots (`·`), inactive metadata, pending-state foregrounds.
- **Text** (`#cdd6f4`): Primary content text, focused field values, hint key letters.
- **Subtext0** (`#a6adc8`): `textMuted` — descriptions, hint labels, section captions.

### Named Rules

**The One Accent Rule.** Catppuccin Blue is used on ≤10% of the surface at any time — the mode pill, the selected picker row, the focused field's border. Saturating two regions simultaneously breaks the rule: pick which moment carries the accent and let the other go quiet.

**The Status-Is-Truth Rule.** Yellow, Green, Red, Sky, and dim-Overlay1 map one-to-one to the orchestrator's session statuses. Never use a status color decoratively. If a node-card border is yellow, an agent is running. Full stop.

**The Pulse Rule.** Running and awaiting-input borders pulse via `lerpColor(border, hue, t)` where `t` follows a sine. Steady-state colors don't pulse — pulse means "this is live, watch it."

## 3. Typography

**Display Font:** terminal default (user-controlled monospace). Atomic does not pick a font; it picks weight and color.
**Body Font:** identical — every glyph is a single-cell monospace character.
**Label/Mono Font:** identical.

**Character:** A monospace TUI has only weight and color to distinguish hierarchy. Atomic leans on three text colors (`text` / `textMuted` / `dim`) and one weight (`bold` via `<strong>`) to carry the entire scale.

### Hierarchy
- **Title** (bold, `text`): Workflow names in the preview pane, header session name, modal title strings, the workflow name in the prompt-phase header.
- **Body** (regular, `text`): Field values, focused row content, primary readable copy.
- **Caption** (regular, `textMuted`): Workflow descriptions, hint labels, secondary metadata.
- **Meta** (regular, `dim`): Type/required tags, separator `·`, pending statuses, "no matches" empty-state text.
- **Pill text** (bold, `surface0` *on* an accent background): `GRAPH`, `PICK`, `PROMPT`, `CONFIRM`, agent header (`CLAUDE` / `COPILOT` / `OPENCODE`), header session badge.
- **Label** (bold, `subtext0`): Section labels rendered as `▎ LABEL` — the leading mauve glyph carries the visual weight, the label itself is muted.

### Named Rules

**The Weight-and-Tone Rule.** Hierarchy is bold/regular × `text`/`textMuted`/`dim`. Six combinations cover the entire system. Inventing a seventh (italics, underline, blinking) is a smell — find the existing slot.

**The No-Decorative-Bold Rule.** Bold marks emphasis (titles, pills, hint key letters, focused selection). Never bold an entire line of body copy or a description.

## 4. Elevation

A terminal cannot render shadows or blur, so depth in Atomic is conveyed exclusively by **stacked tonal strata**. Each component declares which stratum it lives on; the renderer paints that stratum's solid background. There is no hover lift, no focus glow, no drop shadow.

### Strata (deepest to highest)
- **Crust** (`#11111b`): Recess. Where you reach into the surface — input fields you type into.
- **Mantle** (`#181825`): Panel. The body of cards, lists, and modal interiors.
- **Base** (`#1e1e2e`): Canvas. The main work area.
- **Surface0** (`#313244`): Chrome. Persistent bars (statusline, header) that sit on top of the canvas.
- **Saturated pill**: Stratum-of-emphasis. A solid accent or status hue, with `surface0` text on top, used for mode badges and the selected picker row.

### Named Rules

**The Strata Rule.** Every new component must declare which stratum it lives on (`crust`, `mantle`, `base`, `surface0`, or `accent-pill`). Mixing two strata inside one component is the smell — split it into stacked components instead.

**The No-Glow Rule.** Focus states do not glow, blur, or grow. They shift one stratum (field interior `crust → mantle`) and recolor the border (`border → primary`). That is the entire focus vocabulary.

## 5. Components

The component voice is **tactile and confident**: rounded boxes, decisive selection, status surge only when warranted. Buttons are not a concept here (no mouse-first button affordance) — pills, rows, and bordered boxes are.

### Mode Pills
- **Shape:** Solid rectangle, 1 row tall, padded `1ch` on each side. No corner radius (terminal cells are square).
- **Default (mode badge):** `accent` background, `surface0` foreground, **bold** label. `GRAPH`, `PICK`, `PROMPT`.
- **Status variants:** `success` (green) for the orchestrator header on completion; `error` (red) for the failed header; `info` (sky) for the running header pre-completion. Same shape, same bold-on-color treatment.
- **Confirm pill:** `mauve` background, used only when the picker is in confirm phase.

### Picker Rows
- **Shape:** 1 row tall, `paddingLeft: 1`, `paddingRight: 2`, no border.
- **Default:** `mantle` background, `subtext0` (textMuted) name, leading two-space indent.
- **Selected:** `accent` background, `surface0` foreground, **bold** name, leading `▸ ` chevron also `surface0` and bold. The accent-pill vocabulary applied to a row.
- **Broken (default):** `mantle` background, `overlay1` (dim) alias text, `✗ ` glyph in `red`, trailing caption in `red`. No bold — bold is reserved for actionable selection. Status-Is-Truth: red genuinely means broken.
- **Broken (focused/cursor-on):** `surface1` background — the slot reserved for hover/selection states on neutral surfaces — `text` foreground (lifted from dim), glyph and caption remain `red`. The bold-and-Blue (accent) vocabulary stays sacred for actionable rows; broken-focused uses `surface1` instead. No bold on broken rows in either state.
- **Section header:** 2 rows tall, `mantle` bg, agent name colored per agent (`yellow`/`green`/`mauve`).

### Panels (rounded boxes)
- **Corner Style:** `borderStyle="rounded"`. Always.
- **Background:** `mantle` for content panels, `base` for the picker root, `crust` for default field interiors.
- **Border:** `border` (overlay0) by default, `borderActive` for emphasis, `primary` (blue) for the focused field, `success` (green) for the confirm modal.
- **Internal Padding:** `paddingLeft={2}` / `paddingRight={2}` is the standard. Vertical padding `paddingTop={1}` / `paddingBottom={1}` only when the panel contains a multi-line composition.
- **Title:** Use the `title` prop with surrounding spaces (` workflow name `), `titleAlignment="left"` for fields and `"center"` for modals.

### Fields (inputs, textareas, enums)
- **Shape:** Rounded border, label rendered via the box `title` prop.
- **Default:** Border `border` (overlay0), interior `crust`.
- **Focused:** Border `primary` (blue), interior `mantle`. The interior lifts one stratum to telegraph "this is where input goes."
- **Caption row:** `paddingLeft={2}`, type and required/optional tags rendered as `dim · warning`.
- **Enum option (selected, focused):** filled marker `●` in `primary`, label in `text`. Unfocused selected: marker `success`, label `textMuted`. Unselected: marker and label both `dim`.

### Statusline & Header
- **Shape:** Single row, `surface0` background, full width.
- **Mode badge** sits flush left as a saturated pill; metadata (agent name, count) follow with `paddingLeft={1}`; hints are right-aligned with `paddingRight={2}`.
- **Hint pattern:** `<key> <label>` separated by ` · ` in `dim`, repeated. Active keys in `text`, labels in `textMuted`. Disabled hints in `dim`.

### Node Cards (orchestrator graph)
- **Shape:** Rounded box, fixed `NODE_W`, dynamic height.
- **Background:** Always `base` so cards sit on the canvas without lifting visually.
- **Border:** Status-colored. `pending` uses `borderActive`; `running` and `awaiting_input` pulse via sine-eased lerp; `complete`/`error` are solid.
- **Title:** Centered via the `title` prop with surrounding spaces.
- **Duration:** Centered, `dim` while pending and status-colored otherwise.
- **Awaiting-input** adds a `info`-colored "waiting for response" line and a `dim` `↵ enter to respond` hint.

### Section Labels
- **Pattern:** `▎ LABEL` — `mauve` glyph, `subtext0` bold caps. Used to demarcate ARGUMENTS, INPUTS, and similar groupings.

### Spinner
- **Pattern:** Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms. Always `text` or status-colored, never animated decoratively.

### Named Rules

**The Pill-Means-Mode Rule.** A saturated pill always means "you are in this mode." Don't use the pill shape for a static label or a count.

**The Rounded-Or-Nothing Rule.** Bordered boxes use `borderStyle="rounded"`. Square borders, ASCII `+---+` art, and double-line borders are out of vocabulary.

## 6. Do's and Don'ts

### Do:
- **Do** use Catppuccin Mocha tokens addressed by role (`accent`, `success`, `warning`, `info`, `error`, `text`, `textMuted`, `dim`). Never inline a hex code in a component.
- **Do** mirror the accent-pill vocabulary (`primary` bg + `surface0` fg + **bold**) across every "you are here" state — mode badges, selected rows, header session pills.
- **Do** use Unicode icons from the established set: `✓ ✗ → ↵ ↑↓←→ ○ ● ◆ ▸ ▎ ❯ │`.
- **Do** respect `NO_COLOR`. Color carries semantics; the layout must still parse without it.
- **Do** keep all interactions reachable via keyboard. Every selection state has a key binding.
- **Do** lean on **bold** + `text`/`textMuted`/`dim` to carry hierarchy. Six combinations cover the system.
- **Do** pulse running and awaiting-input borders. Steady-state colors don't pulse.
- **Do** write hints as `<key> <label>` separated by ` · `. Active keys `text`, labels `textMuted`.

### Don't:
- **Don't** ship cluttered enterprise dashboards or information overload. Density without clarity is the failure mode.
- **Don't** ship generic or boilerplate CLI output. Atomic should feel crafted.
- **Don't** add gratuitous animation, ASCII art overload, or flashy/gimmicky UI. Function over novelty.
- **Don't** introduce loading states for instantly-renderable content. No spinners on prompt; no flash.
- **Don't** use emoji. Unicode glyphs only — they render reliably across terminals.
- **Don't** saturate two regions with the accent simultaneously. The mode pill *or* the selection — not both.
- **Don't** use a status color decoratively. Yellow means running, sky means awaiting input. Don't paint a divider yellow because it looks nice.
- **Don't** invent a side-stripe `border-left` accent on rows or cards. Background tints, full borders, leading icons, or nothing.
- **Don't** use square borders or ASCII `+---+` art. Rounded only.
- **Don't** introduce italics, underline, blinking, or any text decoration outside bold/regular.
- **Don't** mix two strata inside one component. Split into stacked components.
- **Don't** wrap focus states in glow, blur, or growth. Shift one stratum and recolor the border, that's it.
