import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthInteraction } from "@bastani/pi-ai";
import { type Api, type Model, modelsAreEqual } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";
import { type AtomicOAuthLoginCallbacks, loginRuntimeOAuthProvider } from "./agent-session-runtime-auth.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { ModelFallbackReason } from "./model-resolver-types.ts";
import type { AuthStatus } from "./provider-composer.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { sessionLifecycleCreation, sessionLifecycleScopes } from "./session-lifecycle-scope.ts";
import {
	drainSessionWork,
	hasCallingSessionWork,
	ownedSessionManagerStores,
	ownedSessionStores,
	registerSessionRetirement,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { SessionEntryError, SessionManager } from "./session-manager.ts";
import { type StorageFailureCause, StorageRollbackError } from "./storage/errors.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import type { SessionStore } from "./storage/session/types.js";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export interface LogoutProviderResult {
	provider: string;
	authStatus: AuthStatus;
	models: Model<Api>[];
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export interface CreateAgentSessionRuntimeOptions {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}

export type CreateAgentSessionRuntimeFactory = {
	(options: CreateAgentSessionRuntimeOptions): Promise<CreateAgentSessionRuntimeResult>;
	prepareResume?: (
		options: CreateAgentSessionRuntimeOptions,
	) => Promise<() => Promise<CreateAgentSessionRuntimeResult>>;
};

const SESSION_REPLACEMENT_UI_PROMPT_SETTLEMENT_TIMEOUT_MS = 1_000;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	private closed = false;
	private endedBySignal = false;
	private closing?: Promise<void>;
	private readonly ownedStores = new Set<SessionStore>();
	private cleanupFailures: unknown[] = [];
	private candidates = new Set<AgentSession>();
	private replacements = 0;
	private publication: Promise<void> = Promise.resolve();
	private publicationContext = new AsyncLocalStorage<{ active: boolean }>();
	private retained = new Set<AgentSession>();
	private retirementCleanup = new Set<Promise<void>>();

	private retainRetirementCleanup(cleanup: Promise<void>): void {
		const receipt = cleanup.catch((error) => {
			this.cleanupFailures.push(error);
		});
		this.retirementCleanup.add(receipt);
		void receipt.then(() => this.retirementCleanup.delete(receipt));
	}

	private async finalizeRetained(): Promise<void> {
		const session = this.session;
		if (!this.retained.delete(session)) return;
		const finalize = async () => {
			await emitSessionShutdownEvent(session.extensionRunner, this.quitEvent());
		};
		if (hasCallingSessionWork(session)) {
			this.retainRetirementCleanup(
				session.dispose().then(finalize, async (error) => {
					try {
						await finalize();
					} catch (failure) {
						throw new AggregateError([error, failure], "Retained cleanup failed");
					}
					throw error;
				}),
			);
			return;
		}
		await finalize();
	}

	private replace<T>(operation: () => Promise<T>): Promise<T> {
		registerSessionRetirement(this.session);
		return this.admit(async () => {
			this.replacements++;
			let outcome: { value: T } | { error: unknown };
			try {
				outcome = { value: await operation() };
			} catch (error) {
				outcome = { error };
				this.retainCleanupFailures(error);
			}
			this.replacements--;
			if (this.replacements === 0 && (this.session as unknown as AgentSessionInternalSurface)._disposed) {
				try {
					await this.finalizeRetained();
				} catch (error) {
					this.cleanupFailures.push(error);
					throw Object.assign(
						new AggregateError(
							"error" in outcome ? [outcome.error, error] : [error],
							"Retained session cleanup failed",
						),
						{ code: "ShutdownFailed" },
					);
				}
			}
			if ("error" in outcome) throw outcome.error;
			return outcome.value;
		});
	}

	private assertOpen(): void {
		if (this.closed) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	}

	private admit<T>(operation: () => Promise<T>): Promise<T> {
		try {
			this.assertOpen();
		} catch (error) {
			return Promise.reject(error);
		}
		return trackSessionWork(this, operation);
	}

	/** Bind a process-local trust UI; closures never cross the engine RPC boundary. */
	setProjectTrustContextFactory(factory: (cwd: string) => ProjectTrustContext): void {
		this.projectTrustContextFactory = factory;
	}

	/** Return false for ordinary startup; otherwise finish the safe session in place. */
	async completeStartup(): Promise<boolean> {
		return this.admit(async () => {
			const complete = this.services.completeStartup;
			if (!complete) return false;
			if (!this.projectTrustContextFactory) throw new Error("Startup trust requires a bound session UI");
			await complete(this.projectTrustContextFactory(this.services.cwd));
			return true;
		});
	}

	private declare _session: AgentSession;
	private declare _services: AgentSessionServices;
	private declare readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private declare _diagnostics: AgentSessionRuntimeDiagnostic[];
	private declare _modelFallbackMessage?: string;
	private declare _modelFallbackReason?: ModelFallbackReason;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		_modelFallbackReason?: ModelFallbackReason,
	) {
		this._session = _session;
		this.retainSessionStore(_session);
		this._services = _services;
		const scope = sessionLifecycleScopes.get(_session) ?? {};
		const context = () => {
			const current = this._session as unknown as AgentSessionInternalSurface;
			return {
				scope,
				replacement: true,
				bindings: {
					...this._session.extensionRunner.getChildHostBindings(),
					uiContext: current._extensionUIContext,
					mode: current._extensionMode,
					commandContextActions: current._extensionCommandContextActions,
					shutdownHandler: current._extensionShutdownHandler,
					onError: current._extensionErrorListener,
				},
			};
		};
		this.createRuntime = (options) =>
			this.createReplacement(() => sessionLifecycleCreation.run(context(), () => createRuntime(options)));
		this.createRuntime.prepareResume = (options) =>
			sessionLifecycleCreation.run(context(), async () => {
				const complete = createRuntime.prepareResume
					? await createRuntime.prepareResume(options)
					: () => createRuntime(options);
				return () => this.createReplacement(() => sessionLifecycleCreation.run(context(), complete));
			});
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._modelFallbackReason = _modelFallbackReason;
	}

	/** A wrapping runtime replaces, rather than borrows, the local lifetime owner. */
	protected adoptSessionStores(owner: AgentSessionRuntime): void {
		for (const store of owner.ownedStores) this.ownedStores.add(store);
		owner.ownedStores.clear();
	}

	private retainSessionStore(session: AgentSession): void {
		const store = ownedSessionStores.get(session);
		if (store) {
			ownedSessionStores.delete(session);
			this.ownedStores.add(store);
		}
	}

	private retainCleanupFailures(error: unknown): void {
		if (error instanceof Error && "code" in error && error.code === "ShutdownFailed") {
			this.cleanupFailures.push(error);
		} else if (error instanceof AggregateError) {
			for (const nested of error.errors) this.retainCleanupFailures(nested);
		}
	}

	private async createReplacement(
		create: () => Promise<CreateAgentSessionRuntimeResult>,
	): Promise<CreateAgentSessionRuntimeResult> {
		try {
			this.assertOpen();
			const candidate = await create();
			this.retainSessionStore(candidate.session);
			this.candidates.add(candidate.session);
			if (this.closed) {
				try {
					await (candidate.session as unknown as AgentSessionInternalSurface)._close(this.quitEvent());
				} catch (error) {
					this.cleanupFailures.push(error);
				}
				this.candidates.delete(candidate.session);
				this.assertOpen();
			}
			return candidate;
		} catch (cause) {
			this.retainCleanupFailures(cause);
			// The last admitted replacement finalizes retained scope only if no
			// live successor exists. A failed peer must not shut down a winner.
			throw cause;
		}
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get modelFallbackReason(): ModelFallbackReason | undefined {
		return this._modelFallbackReason;
	}

	replaceModelFallback(message?: string, reason?: ModelFallbackReason): void {
		this._modelFallbackMessage = message;
		this._modelFallbackReason = reason;
	}

	resolveModelFallback(): void {
		this.replaceModelFallback();
	}

	resolveModelFallbackAfterExplicitModelSelection(
		previousModel: Model<Api> | undefined,
		selectedModel: Model<Api> | null | undefined,
	): void {
		if (selectedModel && !modelsAreEqual(previousModel, selectedModel)) this.resolveModelFallback();
	}

	async loginOAuthProvider(
		provider: string,
		callbacks: AtomicOAuthLoginCallbacks,
	): Promise<{ modelsRefreshed: boolean }> {
		return this.admit(async () => {
			await loginRuntimeOAuthProvider(this.session, provider, callbacks);
			return { modelsRefreshed: true };
		});
	}

	async loginApiKeyProvider(provider: string, interaction: AuthInteraction): Promise<{ modelsRefreshed: boolean }> {
		return this.admit(async () => {
			await this.session.modelRuntime.login(provider, "api_key", interaction);
			return { modelsRefreshed: true };
		});
	}

	async logoutProvider(provider: string): Promise<LogoutProviderResult> {
		return this.admit(async () => {
			const registry = this.session.modelRuntime;
			await registry.logout(provider);
			const availableIds = new Set(registry.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`));
			const scopedModels = this.session.scopedModels.filter(({ model }) =>
				availableIds.has(`${model.provider}\0${model.id}`),
			);
			this.session.setScopedModels([...scopedModels]);
			await this.session.refreshCurrentModelFromRegistry();
			return {
				provider,
				authStatus: registry.getProviderAuthStatus(provider),
				models: [...registry.getAvailableSnapshot()],
				scopedModels: [...scopedModels],
			};
		});
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * When a replacement is requested from inside the outgoing session's own tracked
	 * work (for example an extension command calling `ctx.switchSession()`), the
	 * outgoing session finishes closing only after that work ends, which is after the
	 * replacement is published. In that case the callback runs once when the outgoing
	 * session's extension authority is retired, before the replacement binds and
	 * before the outgoing `session_shutdown` handlers run, so it never resets UI that
	 * the replacement session has already set.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(reason: "new" | "resume", targetSessionId?: string): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionId,
		});
		this.assertOpen();
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		this.assertOpen();
		return { cancelled: result?.cancel === true };
	}

	private quitEvent(): SessionShutdownEvent {
		return this.endedBySignal
			? { type: "session_shutdown", reason: "quit", fromSignal: true }
			: { type: "session_shutdown", reason: "quit" };
	}

	private disposeCurrentSession(event: SessionShutdownEvent): Promise<void> {
		const session = this.session;
		this.retainSessionStore(session);
		if (event.reason !== "quit") this.retained.add(session);
		const receipt = (session as unknown as AgentSessionInternalSurface)._close(event, this.beforeSessionInvalidate);
		if (event.reason !== "quit" && hasCallingSessionWork(session)) this.retainRetirementCleanup(session.dispose());
		return receipt;
	}

	/**
	 * Settle an active response before the session it belongs to is replaced, so the
	 * aborted turn (including its tool results) is persisted to the outgoing session
	 * rather than stranded.
	 *
	 * Overridable because the isolated engine must not re-enter its cooperative
	 * abort wait here: the child engine settles its own turn before it reports the
	 * replacement, and the host facade's `abort()` is an unbounded round trip that
	 * would hang teardown on an unresponsive or dead engine.
	 */
	protected async settleActiveResponseBeforeTeardown(): Promise<void> {
		if (!this.session.isStreaming) return;
		await this.session.abort();
	}

	private async serializePublication(operation: () => Promise<void>): Promise<void> {
		// Host callbacks may themselves await another supported replacement.
		if (this.publicationContext.getStore()?.active) return operation();
		const previous = this.publication;
		let release!: () => void;
		this.publication = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = { active: true };
		try {
			await previous;
			await this.publicationContext.run(context, operation);
		} finally {
			context.active = false;
			release();
		}
	}
	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionId?: string): Promise<void> {
		return this.serializePublication(async () => {
			this.assertOpen();
			await this.settleActiveResponseBeforeTeardown();
			this.assertOpen();
			const { timedOut } = await this.session.extensionRunner.flushUIPromptNotifications(
				SESSION_REPLACEMENT_UI_PROMPT_SETTLEMENT_TIMEOUT_MS,
			);
			this.assertOpen();
			if (timedOut) {
				console.error(
					"Warning: UI prompt observers did not settle within 1,000 ms; continuing session replacement.",
				);
			}
			await this.disposeCurrentSession({ type: "session_shutdown", reason, targetSessionId });
		});
	}

	private async apply(
		result: CreateAgentSessionRuntimeResult,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
		setup?: (sessionManager: SessionManager) => Promise<void>,
	): Promise<void> {
		return this.serializePublication(async () => {
			try {
				this.assertOpen();
				// A concurrently admitted factory may have published since preflight.
				// Retire that successor before displacing it, retaining workflow lineage.
				await this.disposeCurrentSession({ type: "session_shutdown", reason: "new" });
				this.assertOpen();
				this.candidates.delete(result.session);
				this.retained.delete(this.session);
				this._session = result.session;
				this._services = result.services;
				this._diagnostics = result.diagnostics;
				this._modelFallbackMessage = result.modelFallbackMessage;
				this._modelFallbackReason = result.modelFallbackReason;
				if (setup) {
					await setup(result.session.sessionManager);
					this.assertOpen();
					if (this.session !== result.session) return;
					result.session.refreshContext();
				}
				if (this.rebindSession) {
					await this.rebindSession(result.session);
					this.assertOpen();
					if (this.session !== result.session) return;
				}
				if (withSession) await withSession(result.session.createReplacedSessionContext());
			} catch (cause) {
				if (this.candidates.delete(result.session)) {
					try {
						await (result.session as unknown as AgentSessionInternalSurface)._close(
							this.closed ? this.quitEvent() : { type: "session_shutdown", reason: "new" },
						);
					} catch (error) {
						this.cleanupFailures.push(error);
						throw Object.assign(
							new AggregateError([cause, error], "Replacement publication and candidate cleanup failed"),
							{ code: "ShutdownFailed" },
						);
					}
				}
				throw cause;
			}
		});
	}

	async switchSession(
		sessionId: string,
		options?: {
			cwdOverride?: string;
			sessionDirectory?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.replace(async () => {
			const beforeResult = await this.emitBeforeSwitch("resume", sessionId);
			this.assertOpen();
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionId = this.session.sessionId;
			const sessionManager = await this.session.sessionManager.openSessionById(
				sessionId,
				options?.cwdOverride,
				options?.sessionDirectory,
			);
			assertSessionCwdExists(sessionManager, this.cwd);
			const runtimeOptions: CreateAgentSessionRuntimeOptions = {
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionId },
				projectTrustContext: (options?.projectTrustContextFactory ?? this.projectTrustContextFactory)?.(
					sessionManager.getCwd(),
				),
			};
			await this.settleActiveResponseBeforeTeardown();
			this.assertOpen();
			const complete = await this.createRuntime.prepareResume?.(runtimeOptions);
			this.assertOpen();
			await this.teardownCurrent("resume", sessionManager.getSessionId());
			await this.apply(await (complete ? complete() : this.createRuntime(runtimeOptions)), options?.withSession);
			return { cancelled: false };
		});
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.replace(async () => {
			const beforeResult = await this.emitBeforeSwitch("new");
			this.assertOpen();
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionId = this.session.sessionId;
			const sessionManager = await SessionManager.create(this.session.sessionManager.getSessionStore(), this.cwd, {
				parentSession: options?.parentSession,
			});

			await this.teardownCurrent("new", sessionManager.getSessionId());
			await this.apply(
				await this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "new", previousSessionId },
				}),
				options?.withSession,
				options?.setup,
			);
			return { cancelled: false };
		});
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.replace(async () => {
			const position = options?.position ?? "before";
			const beforeResult = await this.emitBeforeFork(entryId, { position });
			this.assertOpen();
			if (beforeResult.cancelled) {
				return { cancelled: true };
			}
			let targetLeafId: string | null;
			let selectedText: string | undefined;

			const selectedEntry = this.session.sessionManager.getEntry(entryId);
			if (!selectedEntry) {
				throw new SessionEntryError(entryId, "missing");
			}

			if (position === "at") {
				targetLeafId = selectedEntry.id;
			} else {
				if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
					throw new SessionEntryError(entryId, "not-forkable");
				}
				targetLeafId = selectedEntry.parentId;
				selectedText = extractUserMessageText(selectedEntry.message.content);
			}

			const previousSessionId = this.session.sessionId;
			const sessionManager = await this.session.sessionManager.openSessionById(previousSessionId);
			if (!targetLeafId) {
				await sessionManager.newSession({ parentSession: previousSessionId });
			} else {
				await sessionManager.createBranchedSession(targetLeafId);
			}
			await this.teardownCurrent("fork", sessionManager.getSessionId());
			await this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionId },
				}),
				options?.withSession,
			);
			return { cancelled: false, selectedText };
		});
	}

	/** Import a format-4 JSONL export into the active session store. */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.replace(async () => {
			const resolvedPath = resolvePath(inputPath);
			if (!existsSync(resolvedPath)) throw new SessionImportFileNotFoundError(resolvedPath);
			const source = await JsonlSessionStore.open(dirname(resolvedPath), { scanExisting: false });
			let targetSessionId: string;
			try {
				targetSessionId = (await source.loadFile(resolvedPath)).header.id;
			} finally {
				await source.close();
			}
			const beforeResult = await this.emitBeforeSwitch("resume", targetSessionId);
			this.assertOpen();
			if (beforeResult.cancelled) return beforeResult;
			const previousSessionId = this.session.sessionId;
			const sessionManager = await this.session.sessionManager.importFromJsonl(resolvedPath, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.teardownCurrent("resume", sessionManager.getSessionId());
			await this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionId },
				}),
			);
			return { cancelled: false };
		});
	}

	dispose(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.endedBySignal = options?.fromSignal === true;
		const current = this.disposeCurrentSession(this.quitEvent());
		void current.catch(() => {});
		this.closing = (async () => {
			await drainSessionWork(this);
			for (const candidate of this.candidates) {
				try {
					await (candidate as unknown as AgentSessionInternalSurface)._close(this.quitEvent());
				} catch (error) {
					this.cleanupFailures.push(error);
				}
			}
			this.candidates.clear();
			try {
				await current;
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			while (this.retirementCleanup.size) await Promise.all(this.retirementCleanup);
			try {
				await this.finalizeRetained();
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			for (const store of this.ownedStores) {
				try {
					await store.close();
				} catch (error) {
					this.cleanupFailures.push(error);
				}
			}
			this.ownedStores.clear();
			if (this.cleanupFailures.length)
				throw Object.assign(new AggregateError(this.cleanupFailures, "Runtime shutdown failed"), {
					code: "ShutdownFailed",
				});
		})();
		return this.closing;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	try {
		assertSessionCwdExists(options.sessionManager, options.cwd);
		const result = await sessionLifecycleCreation.run({ scope: {} }, () => createRuntime(options));
		return new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
			result.modelFallbackReason,
		);
	} catch (error) {
		const store = ownedSessionManagerStores.get(options.sessionManager);
		ownedSessionManagerStores.delete(options.sessionManager);
		try {
			await store?.close();
		} catch (cause) {
			throw new StorageRollbackError(error as StorageFailureCause, cause as StorageFailureCause);
		}
		throw error;
	}
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
