import type { SessionManager } from "../session-manager.ts";
import type { ExtensionError, ReplacedSessionContext } from "./types.ts";

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;
