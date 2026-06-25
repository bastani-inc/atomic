import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";

export type SessionScope = "current" | "all";

export type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;
