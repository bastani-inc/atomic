#!/usr/bin/env bash
# Seed the shipped permission-gate extension from crash-course Extra A.2.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/extensions"
cat >"$ws/.atomic/extensions/permission-gate.ts" <<'TS'
import type { ExtensionAPI } from "@bastani/atomic";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command as string;
		if (!dangerousPatterns.some((pattern) => pattern.test(command))) return undefined;
		if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
		return choice === "Yes" ? undefined : { block: true, reason: "Blocked by user" };
	});
}
TS
