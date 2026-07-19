## Register

product

## Platform

web

Atomic is a terminal (TUI) application. It has no native iOS/Android target, so it takes the `web`/default rulebook; there is no HIG or Material rulebook to apply. All "screens" are terminal frames rendered in a monospace grid.

## Design Context

### Users
Developers and engineering teams who orchestrate AI coding agents (Claude Code, OpenCode, GitHub Copilot CLI) through a unified terminal interface. They are technical, keyboard-first users who value efficiency and clarity. They use Atomic to run autonomous multi-hour coding sessions — researching codebases, generating specs, and shipping code. Their primary job: trust the system to do complex multi-agent work correctly, then review results.

### Brand Personality
**Reliable, Minimal, Powerful**

- **Voice:** Direct, precise, confident. No filler, no hype. Speak like a trusted tool, not a chatbot.
- **Tone:** Professional but not cold. Calm authority with moments of delight when things go well (a clean checkmark, a satisfying completion status).
- **Emotional goals:** Users should feel *excitement and delight* about what multi-agent orchestration can accomplish, paired with deep *confidence and trust* that agents are executing correctly and safely.

### Aesthetic Direction

**Visual tone:** Clean, information-dense, purposeful. Every pixel of terminal space earns its place.

**Primary theme:** Catppuccin Mocha as the canonical dark palette, with Tokyo Night as secondary fallback. Terminal-adaptive color derivation remains for edge cases where OSC queries succeed.

**Catppuccin Mocha reference palette:**
| Role       | Color    | Hex       |
| ---------- | -------- | --------- |
| Base (bg)  | Base     | `#1e1e2e` |
| Surface    | Surface0 | `#313244` |
| Selection  | Surface1 | `#45475a` |
| Border     | Overlay0 | `#6c7086` |
| Border dim | Surface2 | `#585b70` |
| Accent     | Blue     | `#89b4fa` |
| Text       | Text     | `#cdd6f4` |
| Dim text   | Subtext0 | `#a6adc8` |
| Success    | Green    | `#a6e3a1` |
| Error      | Red      | `#f38ba8` |
| Warning    | Yellow   | `#f9e2af` |
| Info       | Mauve    | `#cba6f7` |

**References:**
- **Neovim + Tokyo Night** — dark, clean, syntax-highlighted, keyboard-first programmer aesthetic
- **Arc Browser** (arc.net) — modern, polished, thoughtful use of space with personality baked into subtle details

**Anti-references (what to avoid):**
- Cluttered dashboards — no information overload or enterprise-style complexity
- Generic/bland CLI output — Atomic should feel crafted, not boilerplate
- Flashy/gimmicky UI — no gratuitous animations or ASCII art overload; function over novelty
- Slow/heavy interfaces — rendering must be instant; no unnecessary loading states

### Design Principles

1. **Density with clarity.** Show useful information compactly, but never sacrifice readability. Whitespace is a tool, not waste.
2. **Keyboard-first, always.** Every interaction must be reachable via keyboard. Mouse support is optional, not primary.
3. **Earn every element.** If a UI element doesn't help the user understand agent state or take action, remove it. No decoration for decoration's sake.
4. **Trust through transparency.** Show what agents are doing, what state they're in, and what happened. Confidence comes from visibility, not hiding complexity.
5. **Delight in the details.** A smooth spinner, a clean status transition, a well-timed checkmark — small moments of craft signal quality throughout.

### Accessibility
- Respect `NO_COLOR` environment variable standard
- Ensure good contrast ratios in all theme-derived colors
- Full keyboard navigation for all interactive elements
- Unicode icons (no emoji) for cross-platform terminal compatibility

### Iconography
Stick to the established Unicode icon set for consistency:
- `✓` success, `✗` error, `→` navigation, `…` truncation
- `○` pending, `●` active, `│` structure
- Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80ms for loading states

### Layout Constants
- Sidebar width: 24 characters
- Sidebar collapse: < 80 character terminal width
- Standard padding: 1 unit
- Standard gap: 1 unit
- Border style: rounded
- Scroll behavior: sticky-bottom (follow latest output)

## Gaps / Assumptions

Captured during the `shape` interview for the Atomic terminal-branding exploration (design exploration only; no production code changed).

Confirmed by the user:
- Restraint dial = **one earned gesture**. The default everyday UI stays as quiet as today. Exactly one signature startup moment plus one whisper-quiet recurring micro-symbol; the milestone easter egg is the only rare surprise.
- Emotional target = early-Apple **"Crazy Ones" / "Think Different"** energy: outliers, misfits, the round peg in the square hole, pirate-hearted defiance — conveyed for principled reasons, never performatively.

Assumed (pending explicit override; user moved to open chat mid-interview):
- Banned imagery is honored despite the user naming it as a vibe: **no Guy Fawkes mask, no Anonymous imagery, no skull/Jolly-Roger, no cyberpunk/glitch/Matrix.** The spirit is carried instead by authentic, insider signals — the real 1983 Apple Macintosh-team **pirate flag** ("better to be a pirate than join the navy") rendered as a *raised pennant with no skull*, the **round peg / square hole** outlier, and the existing **∀** ("for all" + a subverted A) as the anchor gesture.
- Prototype form = one self-contained HTML file with **navigable simulated-TUI scenes** (startup -> working -> workflow spinner -> earned 5th-workflow egg) plus a small **A/B/C contact sheet** comparing three directions.
- Existing identity to preserve verbatim: Catppuccin Mocha palette, Restrained one-accent strategy, status-is-truth color semantics, the ∀ block banner with its `░` offset shadow, and the Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` @ 80ms). Augment minimally; never destabilize the quiet default.

Reconciled during the recurring-brand revision interview (2026-07-18; artifact `specs/design/2026-07-17T18-22-03-452Z-pznh1f/`):
- **Startup decision is locked.** The `A · Settle` startup proposal (banner character-swap reveal, any-key settle, reduced-motion instant settle, narrow-stack meta) is approved and immutable; revisions must preserve it exactly.
- **Recurring voice = "assured rebel."** The prior artifact thesis "whimsy is not Atomic's voice" is rejected. Atomic's recurring brand may carry a sharp, fun, developer-native, quietly insurgent voice — confident, never corporate or generic — anchored in README positioning: developers who want assurance; build in the open; question the defaults; keep control; inspect/adapt/own the process; plausible output is not enough.
- **Scope of recurrence = copy + cheap behavioral changes only.** Small compact product moments (working/loading label + spinner glyph, status text, tool/activity transitions, workflow dispatch/progress, waiting/approval, empty states, cancellation, retry/recovery, completion/receipts, help/hints). No large new system, no decorative status semantics, no expensive animation.
- **Working state uses a phase-derived label set** (confirmed): a small coherent family of labels mapped deterministically to what the agent is actually doing (lane examples: "Building assurance", "Questioning the defaults", "Checking the machinery", "Demanding receipts") — not random rotation. Every state stays truthful and useful; personality never obscures errors, destructive actions, blockers, or required user action.
- The earlier "one earned gesture" restraint entry above is superseded on the recurrence axis only: recurring microcopy voice is now approved; the startup gesture remains singular and everything else about the quiet default holds.