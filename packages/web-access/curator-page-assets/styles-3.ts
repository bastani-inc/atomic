export const CURATOR_PAGE_STYLES_3 = `.summary-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.summary-subtitle {
  font-size: 12px;
  color: var(--fg-dim);
}
.summary-generating {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: var(--radius-sm);
  background: linear-gradient(130deg, color-mix(in srgb, var(--accent-subtle) 78%, transparent) 0%, var(--bg-elevated) 70%);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary-generating::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 0%, color-mix(in srgb, var(--accent) 16%, transparent) 50%, transparent 100%);
  transform: translateX(-115%);
  animation: summary-panel-sweep 2.4s ease-in-out infinite;
  pointer-events: none;
}
.summary-generating > * {
  position: relative;
  z-index: 1;
}
.summary-generating.hidden { display: none; }
.summary-generating-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-hover);
}
.summary-generating-orb {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent);
  animation: summary-pulse 1.1s ease-in-out infinite;
}
.summary-generating-bars {
  display: grid;
  gap: 6px;
}
.summary-generating-bar {
  position: relative;
  display: block;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 65%, var(--bg-elevated));
  overflow: hidden;
  transition: width 220ms ease;
}
.summary-generating-bar::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent) 45%, transparent) 50%, transparent 100%);
  animation: summary-sweep 1.6s ease-in-out infinite;
}
.summary-generating-bar.b1 { width: 86%; }
.summary-generating-bar.b2 { width: 68%; }
.summary-generating-bar.b3 { width: 74%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b1 { width: 72%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b2 { width: 82%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b3 { width: 60%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b1 { width: 64%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b2 { width: 71%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b3 { width: 90%; }
.summary-generating-bar.b2::after { animation-delay: 0.15s; }
.summary-generating-bar.b3::after { animation-delay: 0.3s; }
.summary-input {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg-elevated);
  outline: none;
}
.summary-input.hidden { display: none; }
.summary-input:focus {
  border-color: var(--accent);
}
.summary-feedback-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.summary-feedback {
  flex: 1;
  height: 32px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-family: var(--font);
  font-size: 12px;
  color: var(--fg);
  background: var(--bg-elevated);
  outline: none;
}
.summary-feedback:focus {
  border-color: var(--accent);
}
.summary-feedback::placeholder {
  color: var(--fg-muted);
}
.summary-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: color-mix(in srgb, var(--bg) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--border);
}
.action-shortcuts { display: flex; align-items: center; gap: 16px; }
.shortcut { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-dim); }
.shortcut kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  color: var(--fg-muted);
}
.action-buttons { display: flex; gap: 8px; }

.btn {
  font-family: var(--font);
  font-size: 13px;
  font-weight: 500;
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}
.btn:disabled { opacity: 0.35; cursor: default; }
.btn-submit { background: var(--btn-primary); color: var(--btn-primary-fg); }
.btn-submit:hover:not(:disabled) { background: var(--btn-primary-hover); }
.btn-secondary { background: var(--btn-secondary); color: var(--fg-muted); border: 1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background: var(--btn-secondary-hover); color: var(--fg); }

.success-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: var(--overlay-bg);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  transition: opacity 200ms;
}
.success-overlay.hidden { display: flex !important; opacity: 0; pointer-events: none; }
.success-icon {
  width: 56px; height: 56px; border-radius: 50%;
  border: 2px solid var(--success);
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 700; color: var(--success);
}
.success-overlay p { margin: 0; font-size: 13px; font-weight: 600; color: var(--success); letter-spacing: 0.06em; text-transform: uppercase; }

.expired-overlay {
  position: fixed; inset: 0;
  background: var(--overlay-bg);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 400ms; pointer-events: none; z-index: 200;
}
.expired-overlay.visible { opacity: 1; pointer-events: auto; }
.expired-overlay.hidden { display: flex !important; opacity: 0; pointer-events: none; }
.expired-content {
  text-align: center; max-width: 480px; padding: 48px 56px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
}
.expired-overlay.visible .expired-content { animation: slide-up 400ms ease-out; }
@keyframes slide-up { from { transform: translateY(20px); } to { transform: translateY(0); } }
.expired-icon {
  width: 72px; height: 72px; border-radius: 50%; border: 2px solid var(--warning);
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; font-weight: bold; color: var(--warning); margin: 0 auto 24px;
}
.expired-content h2 { color: var(--fg); margin: 0 0 16px; font-size: 22px; font-weight: 600; }
.expired-content p { color: var(--fg-muted); margin: 0 0 24px; font-size: 14px; line-height: 1.6; }
.expired-countdown { font-size: 13px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.expired-countdown span { color: var(--warning); font-weight: 600; }

.preview-modal {
  position: fixed; inset: 0; z-index: 250;
  background: var(--overlay-bg);
  display: flex; align-items: center; justify-content: center;
  animation: fade-in 150ms ease-out;
}
.preview-modal.hidden { display: none; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.preview-modal-inner {
  width: min(720px, calc(100% - 48px));
  max-height: calc(100vh - 80px);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex; flex-direction: column;
  animation: slide-up 200ms ease-out;
}
.preview-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.preview-modal-title { font-size: 14px; font-weight: 600; color: var(--fg); margin: 0; }
.preview-modal-close {
  background: none; border: none; cursor: pointer;
  font-size: 22px; line-height: 1; color: var(--fg-muted); padding: 0 4px;
  transition: color 0.12s;
}
.preview-modal-close:hover { color: var(--fg); }
.preview-modal-body {
  position: relative;
  padding: 24px 28px;
  overflow-y: auto;
  font-size: 14px; line-height: 1.7; color: var(--fg);
}
.preview-modal-body h1 { font-size: 20px; font-weight: 600; margin: 1.2em 0 0.5em; color: var(--fg); }
.preview-modal-body h2 { font-size: 16px; font-weight: 600; margin: 1.2em 0 0.4em; color: var(--fg); }
.preview-modal-body h3 { font-size: 14px; font-weight: 600; margin: 1em 0 0.3em; color: var(--fg); }
.preview-modal-body p { margin: 0.6em 0; }
.preview-modal-body a { color: var(--accent); }
.preview-modal-body pre { background: var(--bg-elevated); padding: 14px; border-radius: var(--radius-sm); overflow-x: auto; }
.preview-modal-body code { font-size: 0.9em; }
.preview-modal-body blockquote { border-left: 3px solid var(--border); padding-left: 14px; color: var(--fg-muted); margin: 0.6em 0; }
.preview-modal-body hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.preview-modal-body ul, .preview-modal-body ol { padding-left: 1.4em; }
.preview-modal-body li + li { margin-top: 0.25em; }
.preview-modal-body strong { color: var(--fg); }
.preview-modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px;
  flex-shrink: 0;
}
.preview-modal-model {
  margin-right: auto;
  font-family: var(--font);
  font-size: 11px;
  color: var(--fg-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  max-width: 220px;
  outline: none;
}
.preview-modal-model:focus { border-color: var(--accent); }

.preview-popover {
  position: absolute;
  z-index: 260;
  width: min(340px, calc(100% - 40px));
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  animation: fade-in 100ms ease-out;
}
.preview-popover.hidden { display: none; }
.preview-popover-quote {
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  max-height: 48px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.preview-popover-input {
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.4;
  color: var(--fg);
  background: var(--bg-card);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  outline: none;
  width: 100%;
  resize: vertical;
}
.preview-popover-input:focus { border-color: var(--accent); }
.preview-popover-btn { align-self: flex-end; font-size: 12px; padding: 5px 14px; }

.error-banner {
  position: fixed; bottom: 64px; left: 50%; transform: translateX(-50%); z-index: 50;
  padding: 10px 20px; background: var(--timer-urgent-bg); color: var(--timer-urgent-fg);
  border-radius: var(--radius); font-size: 13px; font-weight: 500;
}

.summary-panel.updating {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  position: relative;
  overflow: hidden;
}
.summary-panel.updating::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 30%;
  height: 2px;
  border-radius: var(--radius) var(--radius) 0 0;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: updating-bar 1.8s ease-in-out infinite;
  pointer-events: none;
}
.summary-panel.updating .summary-input,
.summary-panel.updating .summary-feedback-row {
  opacity: 0.45;
  pointer-events: none;
}
.summary-panel.updating .summary-actions {
  opacity: 0.72;
}
@keyframes updating-bar {
  0% { transform: translateX(-50%); }
  100% { transform: translateX(430%); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-card::after,
  .result-card.searching::after,
  .provider-btn.loading::after,
  .searching-dots::after,
  .summary-generating::before,
  .summary-generating-orb,
  .summary-generating-bar::after,
  .summary-panel.updating::after {
    animation: none !important;
  }
}

@media (max-width: 500px) {
  main { padding: 32px 16px 16px; }
  .hero-title { font-size: 28px; }
  .hero-desc { font-size: 13px; }
  .summary-header-top { flex-direction: column; }
  .summary-model-controls { flex-wrap: wrap; }
  .summary-model-dropdown { max-width: 100%; }
  .action-bar { padding: 10px 14px; }
  .action-shortcuts { display: none; }
  .result-card-header { padding: 12px 14px; }
  .expired-content { padding: 32px 24px; }
  .timer-badge { top: 12px; right: 16px; }
}
`;
