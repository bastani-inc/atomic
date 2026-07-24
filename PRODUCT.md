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
- Ordinary working identity: the literal one-cell `∀` follows a theme-aware dark → accent → bright/bold → accent → dark luminance ramp at 88ms; reduced motion uses a static regular accent `∀`

### Layout Constants
- Sidebar width: 24 characters
- Sidebar collapse: < 80 character terminal width
- Standard padding: 1 unit
- Standard gap: 1 unit
- Border style: rounded
- Scroll behavior: sticky-bottom (follow latest output)