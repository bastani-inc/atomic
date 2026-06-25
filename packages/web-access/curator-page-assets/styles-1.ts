export const CURATOR_PAGE_STYLES_1 = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: #18181e;
  --bg-card: #1e1e24;
  --bg-elevated: #252530;
  --bg-hover: #2b2b37;
  --fg: #e0e0e0;
  --fg-muted: #909098;
  --fg-dim: #606068;
  --accent: #8abeb7;
  --accent-hover: #9dcec7;
  --accent-muted: rgba(138, 190, 183, 0.15);
  --accent-subtle: rgba(138, 190, 183, 0.08);
  --border: #2a2a34;
  --border-muted: #353540;
  --border-checked: #8abeb7;
  --check-bg: #8abeb7;
  --btn-primary: #8abeb7;
  --btn-primary-hover: #9dcec7;
  --btn-primary-fg: #18181e;
  --btn-secondary: #252530;
  --btn-secondary-hover: #2b2b37;
  --timer-bg: #252530;
  --timer-fg: #909098;
  --timer-warn-bg: rgba(240, 198, 116, 0.15);
  --timer-warn-fg: #f0c674;
  --timer-urgent-bg: rgba(204, 102, 102, 0.15);
  --timer-urgent-fg: #cc6666;
  --overlay-bg: rgba(24, 24, 30, 0.92);
  --success: #b5bd68;
  --warning: #f0c674;
  --font: 'Outfit', system-ui, -apple-system, sans-serif;
  --font-display: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  --font-mono: 'SF Mono', Consolas, monospace;
  --radius: 10px;
  --radius-sm: 6px;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f5f7;
    --bg-card: #ffffff;
    --bg-elevated: #eeeef0;
    --bg-hover: #e4e4e8;
    --fg: #1a1a1e;
    --fg-muted: #6c6c74;
    --fg-dim: #9a9aa2;
    --accent: #5f8787;
    --accent-hover: #4a7272;
    --accent-muted: rgba(95, 135, 135, 0.12);
    --accent-subtle: rgba(95, 135, 135, 0.06);
    --border: #dcdce0;
    --border-muted: #c8c8d0;
    --border-checked: #5f8787;
    --check-bg: #5f8787;
    --btn-primary: #5f8787;
    --btn-primary-hover: #4a7272;
    --btn-primary-fg: #ffffff;
    --btn-secondary: #e4e4e8;
    --btn-secondary-hover: #d4d4d8;
    --timer-bg: #e4e4e8;
    --timer-fg: #6c6c74;
    --timer-warn-bg: rgba(217, 119, 6, 0.10);
    --timer-warn-fg: #92400e;
    --timer-urgent-bg: rgba(175, 95, 95, 0.10);
    --timer-urgent-fg: #991b1b;
    --overlay-bg: rgba(255, 255, 255, 0.92);
    --success: #4d7c0f;
    --warning: #b45309;
  }
}

body {
  font-family: var(--font);
  background: var(--bg);
  background-image: radial-gradient(ellipse at 50% 0%, var(--accent-muted) 0%, transparent 60%);
  color: var(--fg);
  line-height: 1.5;
  min-height: 100dvh;
  padding-bottom: 72px;
}

.timer-badge {
  position: fixed;
  top: 20px;
  right: 24px;
  z-index: 50;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--timer-fg);
  border: 1px solid var(--border);
  transition: background 0.3s, color 0.3s, border-color 0.3s, opacity 0.3s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  cursor: pointer;
  user-select: none;
  opacity: 0.5;
}
.timer-badge:hover { opacity: 1; }
.timer-badge.active { opacity: 1; }
.timer-badge.warn {
  opacity: 1;
  background: var(--timer-warn-bg);
  color: var(--timer-warn-fg);
  border-color: color-mix(in srgb, var(--timer-warn-fg) 30%, transparent);
}
.timer-badge.urgent {
  opacity: 1;
  background: var(--timer-urgent-bg);
  color: var(--timer-urgent-fg);
  border-color: color-mix(in srgb, var(--timer-urgent-fg) 30%, transparent);
}
.timer-adjust {
  position: fixed;
  top: 20px;
  right: 24px;
  z-index: 51;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  border-radius: 999px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
}
.timer-adjust.visible { display: flex; }
.timer-adjust input {
  width: 48px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.timer-adjust-label { font-size: 11px; color: var(--fg-dim); }
.timer-adjust-btn {
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  background: var(--accent);
  color: var(--btn-primary-fg);
  cursor: pointer;
}
.timer-adjust-btn:hover { background: var(--accent-hover); }

main {
  max-width: 640px;
  margin: 0 auto;
  padding: 56px 24px 16px;
}

.hero { margin-bottom: 28px; }
.hero-kicker {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
  margin-bottom: 8px;
}
.hero-title {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.01em;
  line-height: 1.1;
  color: var(--fg);
  margin-bottom: 10px;
  text-wrap: balance;
}
.hero-desc {
  font-size: 14px;
  color: var(--fg-muted);
  line-height: 1.5;
  margin-bottom: 12px;
  max-width: 480px;
}
.hero-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--fg-dim);
}
.hero-meta-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--fg-dim);
  flex-shrink: 0;
}
#hero-status:empty + .hero-meta-sep { display: none; }
.provider-buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.summary-model-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 0;
}
.summary-model-dropdown {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  max-width: 220px;
}
.summary-model-dropdown:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
}
.summary-model-dropdown:disabled {
  opacity: 0.65;
  cursor: default;
}
.provider-btn {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s, opacity 0.12s;
}
.provider-btn.idle:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.provider-btn.loading {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border-muted));
  cursor: default;
  pointer-events: none;
  opacity: 0.85;
}
.provider-btn.loading::after {
  content: " …";
  animation: provider-pulse 1.2s ease-in-out infinite;
}
.provider-btn.searched {
  background: var(--btn-secondary);
  color: var(--fg);
  border-color: var(--border-muted);
}
.provider-btn.searched::after {
  content: " ✓";
  color: var(--success);
}
.provider-btn.is-default {
  box-shadow: inset 0 -2px 0 0 var(--accent);
  border-color: var(--accent);
}
.provider-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

@keyframes provider-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

#result-cards { display: flex; flex-direction: column; gap: 8px; }

.send-raw-row {
  display: flex;
  justify-content: flex-end;
  padding: 4px 0;
}
.send-raw-row.hidden { display: none; }

.result-loading {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-card) 86%, var(--accent-subtle));
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.result-loading-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border);
}
.result-loading-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
}
.result-loading-sub {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.result-loading-grid {
  display: grid;
  gap: 10px;
  padding: 12px 14px 14px;
}
.loading-card {
  border: 1px solid color-mix(in srgb, var(--border-muted) 80%, var(--accent-subtle));
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  overflow: hidden;
  position: relative;
}
.loading-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 10%, color-mix(in srgb, var(--accent) 18%, transparent) 45%, transparent 75%);
  transform: translateX(-130%);
  animation: loading-sweep 2s ease-in-out infinite;
  pointer-events: none;
}
.loading-card-row {
  height: 10px;
  border-radius: 999px;
  margin: 10px 12px;
  background: color-mix(in srgb, var(--fg-dim) 35%, transparent);
}
.loading-card-row.short { width: 35%; }
.loading-card-row.mid { width: 58%; }
.loading-card-row.long { width: 78%; }

.result-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.12s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.result-card.checked { border-color: var(--border-checked); }
.result-card.searching {
  opacity: 1;
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent-subtle) 70%, var(--bg-card)) 0%, var(--bg-card) 100%);
  position: relative;
}
.result-card.searching::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 20%, color-mix(in srgb, var(--accent) 14%, transparent) 50%, transparent 80%);
  transform: translateX(-130%);
  animation: loading-sweep 2.2s ease-in-out infinite;
  pointer-events: none;
}
.result-card.searching .result-card-header { cursor: default; }
.result-card.searching .result-card-header:hover { background: transparent; }
.result-card.error { border-color: var(--timer-urgent-fg); }

.result-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;`;
