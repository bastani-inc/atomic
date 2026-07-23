/** High-level MCP OAuth flow management using the SDK auth helpers. */
import { auth as runSdkAuth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import open from "open"
import { McpOAuthProvider, type McpOAuthConfig } from "./mcp-oauth-provider.js"
import {
  cancelAllPendingCallbacks,
  cancelPendingCallback,
  ensureCallbackServer,
  stopCallbackServer,
  waitForCallback,
} from "./mcp-callback-server.js"
import {
  clearAllCredentials,
  clearClientInfo,
  clearCodeVerifier,
  clearOAuthState,
  getAuthForUrl,
  getOAuthState,
  hasStoredTokens,
  isTokenExpired,
  updateOAuthState,
  type StoredTokens,
} from "./mcp-auth.js"
import { McpSessionCleanupBarrier } from "./session-cleanup-barrier.js"
import type { ServerEntry } from "./types.js"

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

interface PendingTransport {
  readonly serverName: string
  readonly transport: StreamableHTTPClientTransport
  readonly oauthState?: string
}

interface PendingAuthentication {
  readonly serverName: string
  readonly controller: AbortController
  readonly result: Promise<AuthStatus>
  readonly producer: Promise<AuthStatus>
  readonly resolve: (status: AuthStatus) => void
  readonly reject: (error: Error) => void
  oauthState?: string
  transport?: PendingTransport
}

const pendingTransports = new Map<string, PendingTransport>()
const pendingAuthentications = new Map<string, PendingAuthentication>()
const closingTransports = new WeakMap<StreamableHTTPClientTransport, Promise<void>>()
const oauthCleanupBarrier = new McpSessionCleanupBarrier()

/** Actionable cancellation surfaced to callers whose session no longer owns OAuth. */
export class OAuthSessionResetError extends Error {
  readonly code = "MCP_OAUTH_SESSION_RESET"

  constructor(serverName: string | undefined, reason: string) {
    const target = serverName ? ` for "${serverName}"` : ""
    const readableReason = reason.replaceAll("_", " ")
    super(
      `MCP OAuth authentication${target} was cancelled because the MCP session was reset (${readableReason}). Retry authentication in the active session.`,
    )
    this.name = "OAuthSessionResetError"
  }
}

function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
  if (definition.oauth === false) return {}
  return {
    grantType: definition.oauth?.grantType,
    clientId: definition.oauth?.clientId,
    clientSecret: definition.oauth?.clientSecret,
    scope: definition.oauth?.scope,
  }
}

function assertActive(owner?: PendingAuthentication): void {
  owner?.controller.signal.throwIfAborted()
}

function clearOwnedOAuthState(serverName: string, oauthState?: string): void {
  if (oauthState && getOAuthState(serverName) === oauthState) clearOAuthState(serverName)
}

function closeTransport(transport: StreamableHTTPClientTransport): Promise<void> {
  const existing = closingTransports.get(transport)
  if (existing) return existing
  const closing = transport.close().catch(() => undefined)
  closingTransports.set(transport, closing)
  return closing
}

async function retireTransport(serverName: string, pending: PendingTransport): Promise<void> {
  if (pendingTransports.get(serverName) === pending) pendingTransports.delete(serverName)
  await closeTransport(pending.transport)
}

interface StartedAuth {
  readonly authorizationUrl: string
  readonly oauthState?: string
  readonly pendingTransport?: PendingTransport
}

async function startAuthAttempt(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
  owner?: PendingAuthentication,
): Promise<StartedAuth> {
  assertActive(owner)
  const config = definition ? extractOAuthConfig(definition) : {}
  const storedAuth = getAuthForUrl(serverName, serverUrl)
  if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
    clearClientInfo(serverName)
    clearCodeVerifier(serverName)
    clearOAuthState(serverName)
  }

  const providerCallbacks = {
    onRedirect: async (_url: URL): Promise<void> => {
      throw new Error("Browser redirect is not used for client_credentials flow")
    },
    assertActive: (): void => assertActive(owner),
  }
  if (config.grantType === "client_credentials") {
    const authProvider = new McpOAuthProvider(serverName, serverUrl, config, providerCallbacks)
    const result = await runSdkAuth(authProvider, { serverUrl })
    assertActive(owner)
    if (result !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize")
    return { authorizationUrl: "" }
  }

  await ensureCallbackServer({ strictPort: Boolean(config.clientId) })
  assertActive(owner)
  const oauthState = generateState()
  if (owner) owner.oauthState = oauthState
  updateOAuthState(serverName, oauthState, serverUrl)

  let capturedUrl: URL | undefined
  const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
    onRedirect: async (url) => { capturedUrl = url },
    assertActive: (): void => assertActive(owner),
  })

  try {
    const result = await runSdkAuth(authProvider, { serverUrl })
    assertActive(owner)
    if (result === "AUTHORIZED") {
      clearOwnedOAuthState(serverName, oauthState)
      return { authorizationUrl: "", oauthState }
    }
    if (!capturedUrl) throw new UnauthorizedError("OAuth authorization URL was not provided")
    const pendingTransport = {
      serverName,
      transport: new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider }),
      oauthState,
    }
    pendingTransports.set(serverName, pendingTransport)
    if (owner) owner.transport = pendingTransport
    return { authorizationUrl: capturedUrl.toString(), oauthState, pendingTransport }
  } catch (error) {
    clearOwnedOAuthState(serverName, oauthState)
    if (owner?.transport) await retireTransport(serverName, owner.transport)
    throw error
  }
}

/** Start OAuth and return the browser authorization URL when interaction is needed. */
export async function startAuth(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
): Promise<{ authorizationUrl: string }> {
  const { authorizationUrl } = await startAuthAttempt(serverName, serverUrl, definition)
  return { authorizationUrl }
}

async function completePendingTransport(
  serverName: string,
  authorizationCode: string,
  pending: PendingTransport,
): Promise<AuthStatus> {
  try {
    await pending.transport.finishAuth(authorizationCode)
    return "authenticated"
  } finally {
    await retireTransport(serverName, pending)
  }
}

/** Complete a separately started OAuth flow with its authorization code. */
export async function completeAuth(serverName: string, authorizationCode: string): Promise<AuthStatus> {
  const pending = pendingTransports.get(serverName)
  if (!pending) throw new Error(`No pending OAuth flow for server: ${serverName}`)
  return completePendingTransport(serverName, authorizationCode, pending)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function performAuthentication(
  owner: PendingAuthentication,
  serverUrl: string,
  definition?: ServerEntry,
): Promise<AuthStatus> {
  const serverName = owner.serverName
  const started = await startAuthAttempt(serverName, serverUrl, definition, owner)
  assertActive(owner)
  if (!started.authorizationUrl) return "authenticated"
  if (!started.oauthState || !started.pendingTransport) {
    throw new Error("OAuth state or transport not found - this should not happen")
  }

  const callbackPromise = waitForCallback(started.oauthState)
  try {
    console.log(`MCP Auth: Opening browser for ${serverName}`)
    try {
      await open(started.authorizationUrl)
      assertActive(owner)
    } catch (error) {
      assertActive(owner)
      throw new Error(
        `Could not open browser. Please open this URL manually: ${started.authorizationUrl}`,
        { cause: error },
      )
    }

    const code = await callbackPromise
    assertActive(owner)
    const storedState = getOAuthState(serverName)
    if (storedState !== started.oauthState) {
      clearOwnedOAuthState(serverName, started.oauthState)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }
    clearOwnedOAuthState(serverName, started.oauthState)
    assertActive(owner)
    return await completePendingTransport(serverName, code, started.pendingTransport)
  } catch (error) {
    const failure = owner.controller.signal.aborted
      ? asError(owner.controller.signal.reason)
      : asError(error)
    cancelPendingCallback(started.oauthState, failure)
    clearOwnedOAuthState(serverName, started.oauthState)
    await retireTransport(serverName, started.pendingTransport)
    throw failure
  }
}

/** Authenticate once per server while allowing every caller to await the same producer. */
export function authenticate(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
): Promise<AuthStatus> {
  const inFlight = pendingAuthentications.get(serverName)
  if (inFlight) return inFlight.result

  let resolve!: (status: AuthStatus) => void
  let reject!: (error: Error) => void
  const result = new Promise<AuthStatus>((resolveResult, rejectResult) => {
    resolve = resolveResult
    reject = rejectResult
  })
  const controller = new AbortController()
  const inheritedCleanup = oauthCleanupBarrier.wait()
  let owner!: PendingAuthentication
  const producer = inheritedCleanup.then(() => performAuthentication(owner, serverUrl, definition))
  owner = { serverName, controller, result, producer, resolve, reject }
  pendingAuthentications.set(serverName, owner)
  const removeOwner = (): void => {
    if (pendingAuthentications.get(serverName) === owner) pendingAuthentications.delete(serverName)
  }
  void result.then(removeOwner, removeOwner)
  void producer.then(resolve, (error: unknown) => reject(asError(error)))
  return result
}

/**
 * Retire every OAuth single-flight owner before a replacement session can start.
 * Caller-visible promises reject immediately; non-abortable SDK work remains observed
 * and is fenced from later credential/transport ownership by its aborted provider.
 */
export function resetOAuthLifecycle(reason = "session_reset"): Promise<void> {
  const owners = Array.from(pendingAuthentications.values())
  pendingAuthentications.clear()
  const lifecycleError = new OAuthSessionResetError(undefined, reason)
  for (const owner of owners) {
    const ownerError = new OAuthSessionResetError(owner.serverName, reason)
    owner.controller.abort(ownerError)
    owner.reject(ownerError)
    clearOwnedOAuthState(owner.serverName, owner.oauthState)
  }
  cancelAllPendingCallbacks(lifecycleError)

  const transports = Array.from(new Set(pendingTransports.values()))
  pendingTransports.clear()
  for (const pending of transports) clearOwnedOAuthState(pending.serverName, pending.oauthState)

  const callbackCleanup = stopCallbackServer(lifecycleError)
  return oauthCleanupBarrier.retain([
    callbackCleanup,
    ...owners.map((owner) => owner.producer),
    ...transports.map((pending) => closeTransport(pending.transport)),
  ])
}

/** Get a valid access token, refreshing it when the stored token is expired. */
export async function getValidToken(
  serverName: string,
  serverUrl: string,
): Promise<StoredTokens | null> {
  const entry = getAuthForUrl(serverName, serverUrl)
  if (!entry?.tokens) return null
  const expired = isTokenExpired(serverName)
  if (expired === false) return entry.tokens

  if (expired === true && entry.tokens.refreshToken) {
    console.log(`MCP Auth: Token expired for ${serverName}, attempting refresh`)
    try {
      const authProvider = new McpOAuthProvider(serverName, serverUrl, {}, {
        onRedirect: async () => {},
      })
      const clientInfo = await authProvider.clientInformation()
      if (!clientInfo) {
        console.log(`MCP Auth: No client info for refresh for ${serverName}`)
        return null
      }
      const result = await runSdkAuth(authProvider, { serverUrl })
      if (result !== "AUTHORIZED") return null
      return getAuthForUrl(serverName, serverUrl)?.tokens ?? null
    } catch (error) {
      console.error(`MCP Auth: Token refresh failed for ${serverName}`, { error })
      return null
    }
  }
  return entry.tokens
}

export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  if (!hasStoredTokens(serverName)) return "not_authenticated"
  return isTokenExpired(serverName) ? "expired" : "authenticated"
}

export async function removeAuth(serverName: string): Promise<void> {
  const oauthState = getOAuthState(serverName)
  if (oauthState) cancelPendingCallback(oauthState)
  const pending = pendingTransports.get(serverName)
  if (pending) await retireTransport(serverName, pending)
  clearAllCredentials(serverName)
  clearOAuthState(serverName)
  console.log(`MCP Auth: Removed credentials for ${serverName}`)
}

export function supportsOAuth(definition: ServerEntry): boolean {
  if (!definition.url || definition.auth === false || definition.oauth === false) return false
  return definition.auth === "oauth" || definition.auth === undefined
}

export async function initializeOAuth(): Promise<void> {
  await ensureCallbackServer()
}

/** Reset all OAuth ownership and stop callback acceptance for session teardown. */
export function shutdownOAuth(reason = "session_shutdown"): Promise<void> {
  return resetOAuthLifecycle(reason)
}
