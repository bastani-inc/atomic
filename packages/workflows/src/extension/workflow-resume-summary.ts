import { getAvailableDurableBackend } from "../durable/factory.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { ExtensionAPI, PiCommandContext, PiExecuteContext } from "./public-types.js";

const delivered = new WeakMap<object, Map<string, string | number | undefined>>();

export async function injectWorkflowResumeSummary(
	pi: ExtensionAPI,
	ctx: PiCommandContext | PiExecuteContext,
	runId: string,
	run?: RunSnapshot,
): Promise<void> {
	if (ctx.isSessionSummaryEnabled?.() === false || pi.sendMessage === undefined) return;
	const owner =
		("sessionManager" in ctx && typeof ctx.sessionManager === "object" ? ctx.sessionManager : undefined) ?? ctx;
	const manager = "sessionManager" in ctx ? ctx.sessionManager : undefined;
	const sessionId = manager && typeof manager.getSessionId === "function" ? manager.getSessionId() : "";
	const key = `${sessionId}:${runId}`;
	const seen = delivered.get(owner) ?? new Map<string, string | number | undefined>();
	const handle = getAvailableDurableBackend()?.getLoadableWorkflow(runId);
	const boundary = run?.pausedAt ?? (handle?.status !== "running" ? handle?.transitionClaimId : undefined);
	if (seen.has(key) && (boundary === undefined || seen.get(key) === boundary)) return;
	const summary = handle?.summary ?? run?.summary;
	if (!summary) return;
	const through = handle?.summarizedThrough ?? run?.summarizedThrough;
	const content = [
		`Workflow resume context: ${runId}`,
		`Workflow: ${handle?.name ?? run?.name ?? runId}`,
		`Status: ${handle?.status ?? run?.status ?? "unknown"}`,
		`Summarized through: ${through === undefined ? "unknown" : new Date(through).toISOString()}`,
		summary,
	].join("\n");
	seen.set(key, boundary);
	delivered.set(owner, seen);
	try {
		await pi.sendMessage(
			{ customType: "workflow-resume-summary", content, display: true },
			{ triggerTurn: false, deliverAs: "steer", persistWhenStreaming: true },
		);
	} catch {
		seen.delete(key);
	}
}
