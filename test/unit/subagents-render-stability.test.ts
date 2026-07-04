import { beforeAll } from "bun:test";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

import "./subagents-render-stability-fast-mode.js";
import "./subagents-render-stability-running-spinner.js";
import "./subagents-render-stability-running-widget.js";
import "./subagents-render-stability-widget-lifecycle.js";
import "./subagents-render-stability-invariants.js";
