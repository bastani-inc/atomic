export const CURATOR_PAGE_STYLES_2 = `}
.result-card-header:hover { background: var(--bg-hover); }

.result-card-header input[type="checkbox"] {
  appearance: none;
  width: 16px;
  height: 16px;
  min-width: 16px;
  border: 1.5px solid var(--border-muted);
  border-radius: 4px;
  margin-top: 2px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  display: grid;
  place-content: center;
}
.result-card-header input[type="checkbox"]:checked {
  background: var(--check-bg);
  border-color: var(--check-bg);
}
.result-card-header input[type="checkbox"]:checked::after {
  content: "";
  width: 9px;
  height: 6px;
  border-left: 2px solid var(--btn-primary-fg);
  border-bottom: 2px solid var(--btn-primary-fg);
  transform: rotate(-45deg);
  margin-top: -1px;
}

.result-card-info { flex: 1; min-width: 0; }

.result-card-query-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.result-card-query {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.provider-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border: 1px solid transparent;
}
.provider-tag.provider-exa {
  color: #8dd3ff;
  background: rgba(141, 211, 255, 0.14);
  border-color: rgba(141, 211, 255, 0.3);
}
.provider-tag.provider-perplexity {
  color: #cba6f7;
  background: rgba(203, 166, 247, 0.14);
  border-color: rgba(203, 166, 247, 0.3);
}
.provider-tag.provider-gemini {
  color: #f5c27b;
  background: rgba(245, 194, 123, 0.14);
  border-color: rgba(245, 194, 123, 0.3);
}
.provider-tag.provider-unknown {
  color: var(--fg-muted);
  background: var(--bg-elevated);
  border-color: var(--border-muted);
}
.result-card-meta {
  font-size: 12px;
  color: var(--fg-dim);
}
.result-card-preview {
  font-size: 12.5px;
  color: var(--fg-muted);
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}

.result-card-expand {
  color: var(--fg-dim);
  font-size: 11px;
  margin-top: 2px;
  flex-shrink: 0;
  padding-top: 3px;
  transition: color 0.12s;
}
.result-card-header:hover .result-card-expand { color: var(--fg-muted); }

.result-card-body {
  display: none;
  border-top: 1px solid var(--border);
}
.result-card-body.open { display: block; }

.result-card-answer {
  padding: 14px 16px;
  font-size: 13.5px;
  color: var(--fg-muted);
  line-height: 1.6;
  max-height: 400px;
  overflow-y: auto;
}
.result-card-answer h1,
.result-card-answer h2,
.result-card-answer h3,
.result-card-answer h4 {
  color: var(--fg);
  font-family: var(--font);
  font-weight: 600;
  margin: 16px 0 6px;
  line-height: 1.3;
}
.result-card-answer h1 { font-size: 16px; }
.result-card-answer h2 { font-size: 14.5px; }
.result-card-answer h3 { font-size: 13.5px; }
.result-card-answer h4 { font-size: 13px; color: var(--fg-muted); }
.result-card-answer p { margin: 0 0 10px; }
.result-card-answer p:last-child { margin-bottom: 0; }
.result-card-answer strong { color: var(--fg); font-weight: 600; }
.result-card-answer a { color: var(--accent); text-decoration: none; }
.result-card-answer a:hover { text-decoration: underline; }
.result-card-answer ul, .result-card-answer ol {
  margin: 6px 0 10px;
  padding-left: 20px;
}
.result-card-answer li { margin-bottom: 4px; }
.result-card-answer li::marker { color: var(--fg-dim); }
.result-card-answer code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--fg);
}
.result-card-answer pre {
  margin: 8px 0 12px;
  padding: 12px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  line-height: 1.45;
}
.result-card-answer pre code {
  padding: 0;
  background: none;
  border: none;
  font-size: 12px;
  color: var(--fg-muted);
}
.result-card-answer blockquote {
  margin: 8px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--accent);
  color: var(--fg-dim);
  background: var(--accent-subtle);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.result-card-answer table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 12px;
  font-size: 12.5px;
}
.result-card-answer th, .result-card-answer td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  text-align: left;
}
.result-card-answer th {
  background: var(--bg-elevated);
  color: var(--fg);
  font-weight: 600;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.result-card-answer hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}

.result-card-sources {
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
}
.result-card-sources-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  margin-bottom: 6px;
}
.source-link {
  display: block;
  padding: 4px 0;
  font-size: 12.5px;
  color: var(--fg-muted);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.12s;
}
.source-link:hover { color: var(--accent); }
.source-domain {
  color: var(--fg-dim);
  margin-left: 6px;
}

.result-card-error-msg {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--timer-urgent-fg);
}

.card-alt-providers {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 16px 8px 42px;
  font-size: 11px;
  color: var(--fg-dim);
}
.card-alt-chip {
  font-family: var(--font);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.card-alt-chip:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.card-alt-chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.card-alt-chip.loading {
  opacity: 0.6;
  pointer-events: none;
}
.card-alt-chip.loading::after {
  content: " …";
}

.searching-dots::after {
  content: "";
  animation: dots 1.5s steps(4, end) infinite;
}
@keyframes dots {
  0% { content: ""; }
  25% { content: "."; }
  50% { content: ".."; }
  75% { content: "..."; }
}

@keyframes loading-sweep {
  0% { transform: translateX(-130%); }
  100% { transform: translateX(130%); }
}

@keyframes summary-pulse {
  0%, 100% {
    transform: scale(0.9);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent);
  }
  50% {
    transform: scale(1.15);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent);
  }
}

@keyframes summary-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(120%); }
}

@keyframes summary-panel-sweep {
  0% { transform: translateX(-115%); }
  100% { transform: translateX(115%); }
}

.add-search {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 11px 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  cursor: text;
  transition: border-color 0.15s, background 0.15s;
}
.add-search:hover {
  border-color: var(--border-muted);
  background: var(--accent-subtle);
}
.add-search:focus-within {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent-subtle);
}
.add-search-icon {
  color: var(--fg-dim);
  font-size: 16px;
  font-weight: 300;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.15s;
}
.add-search:focus-within .add-search-icon { color: var(--accent); }
.add-search input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 13.5px;
  font-weight: 500;
}
.add-search input::placeholder {
  color: var(--fg-dim);
  font-weight: 400;
}
.add-search-wand {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 14px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.add-search-wand:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.add-search-wand:disabled {
  opacity: 0.3;
  cursor: default;
}
.add-search-wand.rewriting {
  pointer-events: none;
  animation: wand-spin 0.8s linear infinite;
}
@keyframes wand-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.summary-panel {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary-panel.hidden { display: none; }
.summary-header { display: flex; flex-direction: column; gap: 2px; }
.summary-header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }`;
