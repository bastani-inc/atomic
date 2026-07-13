import { SessionManager } from "./session-manager.js";
import type { SessionInfo } from "./session-manager-types.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	collectDescendantUsageReports,
	sumAssistantUsage,
	TransitiveUsageAggregator,
	USAGE_DESCENDANT_ROLLUP_CHANNEL,
} from "./transitive-usage.ts";
import type { DescendantUsageReport, TransitiveUsage } from "./transitive-usage.ts";
export async function walkDescendantUsage(this: AgentSession, root?: SessionInfo): Promise<TransitiveUsage> {
	const sessionFile = this.sessionManager.getSessionFile();
	const rootInfo = root ?? (sessionFile
		? {
			path: sessionFile,
			id: this.sessionManager.getSessionId(),
			cwd: this.sessionManager.getCwd(),
			created: new Date(),
			modified: new Date(),
			messageCount: this.sessionManager.getEntries().filter((entry) => entry.type === "message").length,
			firstMessage: "",
			allMessagesText: "",
		}
		: undefined);
	if (!rootInfo) return this.getTransitiveUsage();
	const listSessions = async () => {
		const local = await SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), undefined, { includeInternal: true });
		const all = this.sessionManager.usesDefaultSessionDir()
			? await SessionManager.listAll(undefined, undefined, { includeInternal: true })
			: await SessionManager.listAll(this.sessionManager.getSessionDir(), undefined, { includeInternal: true });
		return [...new Map([...local, ...all].map((session) => [session.path, session])).values()];
	};
	const startedAtRevision = this._transitiveUsageAggregator.getRevision();
	const reconciliationId = this._transitiveUsageAggregator.beginReconciliation();
	const result = await collectDescendantUsageReports({
		root: rootInfo,
		rootSessionId: this.sessionManager.getSessionId(),
		listSessions,
	});
	this._transitiveUsageAggregator.reconcile(result.reports, result.complete, { startedAtRevision, reconciliationId });
	return this.getTransitiveUsage();
}

export function getTransitiveUsage(this: AgentSession): TransitiveUsage {
	return this._transitiveUsageAggregator.getTransitiveUsage();
}

export function attributeDescendantUsage(this: AgentSession, report: DescendantUsageReport): void {
	this._transitiveUsageAggregator.attributeDescendantUsage(report);
}

export function _initializeTransitiveUsage(this: AgentSession): void {
	this._transitiveUsageAggregator = new TransitiveUsageAggregator(
		this.sessionManager.getSessionId(),
		() => sumAssistantUsage(this.sessionManager.getEntries()),
		() => this._emit({ type: "descendant_usage_changed" }),
		{ initialComplete: this.sessionManager.getSessionFile() === undefined },
	);
	const eventBus = this._resourceLoader.getEventBus?.();
	if (eventBus) {
		this._unsubscribeDescendantUsage = eventBus.on(USAGE_DESCENDANT_ROLLUP_CHANNEL, (payload) => {
			this.attributeDescendantUsage(payload as DescendantUsageReport);
		});
	}
	void this.walkDescendantUsage().catch(() => {
		this._emit({ type: "descendant_usage_changed" });
	});
}

export function _disposeTransitiveUsage(this: AgentSession): void {
	this._unsubscribeDescendantUsage?.();
	this._unsubscribeDescendantUsage = undefined;
}

export const agentSessionTransitiveUsageMethods = {
	walkDescendantUsage,
	getTransitiveUsage,
	attributeDescendantUsage,
	_initializeTransitiveUsage,
	_disposeTransitiveUsage,
};
