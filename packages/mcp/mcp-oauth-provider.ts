/**
 * MCP OAuth Provider
 * 
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  acquireTokenRefreshLock,
  getAuthForUrl,
  getOwnedOAuthTransients,
  updateTokens,
  updateClientInfo,
  updateCodeVerifier,
  updateOAuthState,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  type StoredTokens,
  type StoredClientInfo,
} from "./mcp-auth.js"

// Callback server configuration
const DEFAULT_OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/callback"

const REFRESH_REQUEST_TIMEOUT_MS = 15_000;

async function fetchRefreshResponse(url: Parameters<FetchLike>[0], init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("MCP token refresh timed out", "TimeoutError")), REFRESH_REQUEST_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void reader?.cancel(signal.reason).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const request = (async () => {
    signal.throwIfAborted();
    const response = await fetch(url, { ...init, signal });
    if (signal.aborted) {
      void response.body?.cancel(signal.reason).catch(() => {});
      signal.throwIfAborted();
    }
    reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    return new Response(response.body ? text : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  })();
  try {
    return await Promise.race([request, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT

if (process.env.MCP_OAUTH_CALLBACK_PORT) {
  const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10)
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    configuredOAuthCallbackPort = parsedPort
  }
}

let oauthCallbackPort = configuredOAuthCallbackPort

export function getConfiguredOAuthCallbackPort(): number {
  return configuredOAuthCallbackPort
}

export function getOAuthCallbackPort(): number {
  return oauthCallbackPort
}

export function setOAuthCallbackPort(port: number): void {
  oauthCallbackPort = port
}

/** Configuration options for OAuth */
export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials"
  clientId?: string
  clientSecret?: string
  scope?: string
}

/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
  assertActive?: () => void
}

/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly transients = getOwnedOAuthTransients()
  private refreshRelease: (() => Promise<void>) | undefined;
  private readonly refreshes = new Set<Promise<void>>();

  /** SDK-supported fetch hook keeps rotating-token exchanges serialized across processes. */
  readonly fetch: FetchLike = async (url, init) => {
    if (!(init?.body instanceof URLSearchParams) || init.body.get("grant_type") !== "refresh_token") {
      return fetch(url, init);
    }
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    this.refreshes.add(pending);
    const release = await acquireTokenRefreshLock(this.serverName).catch((error) => {
      this.refreshes.delete(pending);
      finish();
      throw error;
    });
    this.refreshRelease = async () => {
      this.refreshRelease = undefined;
      try { await release(); } finally { this.refreshes.delete(pending); finish(); }
    };
    try {
      init.signal?.throwIfAborted();
      const current = getAuthForUrl(this.serverName, this.serverUrl)?.tokens;
      if (!current?.refreshToken) throw new UnauthorizedError("MCP refresh credentials are no longer available");
      if (current.refreshToken !== init.body.get("refresh_token") && (!current.expiresAt || current.expiresAt > Date.now() / 1000)) {
        return Response.json({
          access_token: current.accessToken, refresh_token: current.refreshToken, token_type: "Bearer",
          ...(current.expiresAt ? { expires_in: Math.max(0, current.expiresAt - Date.now() / 1000) } : {}),
          ...(current.scope ? { scope: current.scope } : {}),
        });
      }
      const body = new URLSearchParams(init.body);
      body.set("refresh_token", current.refreshToken);
      const response = await fetchRefreshResponse(url, { ...init, body });
      // The SDK only calls saveTokens after a successful schema parse. Release on every other path.
      if (!response.ok) {
        await this.refreshRelease();
        return response;
      }
      const parsed = OAuthTokensSchema.safeParse(await response.clone().json());
      if (!parsed.success) {
        await this.refreshRelease();
        return response;
      }
      // The SDK's fallback captured the old token before locking. Keep the token actually exchanged.
      return Response.json({ refresh_token: current.refreshToken, ...parsed.data });
    } catch (error) {
      await this.refreshRelease?.();
      throw error;
    }
  };

  async waitForRefresh(): Promise<void> {
    await Promise.all(this.refreshes);
  }

  private transientEntry() {
    if (!this.transients) return getAuthForUrl(this.serverName, this.serverUrl)
    const entry = this.transients.get(this.serverName)
    return entry?.serverUrl === this.serverUrl ? entry : undefined
  }
  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
  ) {}

  private ensureActive(): void {
    this.callbacks.assertActive?.()
  }

  private get usesClientCredentials(): boolean {
    return this.config.grantType === "client_credentials"
  }

  /**
   * The redirect URL for OAuth callbacks.
   * This must match the redirect_uri in client metadata.
   */
  get redirectUrl(): string | undefined {
    if (this.usesClientCredentials) return undefined
    return `http://localhost:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}`
  }

  /**
   * Client metadata for dynamic registration.
   * Describes this client to the OAuth authorization server.
   */
  get clientMetadata(): OAuthClientMetadata {
    if (this.usesClientCredentials) {
      return {
        client_name: "Pi Coding Agent",
        redirect_uris: [],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      }
    }

    const redirectUrl = this.redirectUrl
    if (!redirectUrl) {
      throw new Error("redirectUrl is required for authorization_code flow")
    }

    return {
      redirect_uris: [redirectUrl],
      client_name: "Pi Coding Agent",
      client_uri: "https://github.com/nicobailon/pi-mcp-adapter",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    }
  }

  /**
   * Get client information (for pre-registered or dynamically registered clients).
   * Returns undefined if no client info exists or if the server URL has changed.
   */
  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    this.ensureActive()
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getAuthForUrl to validate credentials are for the current server URL
    const entry = await getAuthForUrl(this.serverName, this.serverUrl)
    this.ensureActive()
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  /**
   * Save client information from dynamic registration.
   */
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.ensureActive()
    const clientInfo: StoredClientInfo = {
      clientId: info.client_id,
      clientSecret: info.client_secret,
      clientIdIssuedAt: info.client_id_issued_at,
      clientSecretExpiresAt: info.client_secret_expires_at,
    }
    updateClientInfo(this.serverName, clientInfo, this.serverUrl)
  }

  /**
   * Get stored OAuth tokens.
   * Returns undefined if no tokens exist or if the server URL has changed.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    this.ensureActive()
    // Use getAuthForUrl to validate tokens are for the current server URL
    const entry = await getAuthForUrl(this.serverName, this.serverUrl)
    this.ensureActive()
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  /**
   * Save OAuth tokens.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    try {
      if (!this.refreshRelease) this.ensureActive();
      const storedTokens: StoredTokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
        scope: tokens.scope,
      };
      updateTokens(this.serverName, storedTokens, this.serverUrl);
    } finally {
      await this.refreshRelease?.();
    }
  }

  /**
   * Redirect the user to the authorization URL.
   * This opens the browser for the user to authenticate.
   *
   * Throws UnauthorizedError when called outside of a user-initiated flow
   * (no oauthState saved by startAuth). That path is reached when the SDK
   * falls through from a failed refresh into a fresh authorization_code
   * flow, which library hosts cannot complete in-process.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.ensureActive()
    if (this.usesClientCredentials) {
      throw new Error("redirectToAuthorization is not used for client_credentials flow")
    }
    // No saved oauthState means we're on the post-refresh authorize fallback.
    const entry = this.transientEntry()
    this.ensureActive()
    if (!entry?.oauthState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    // URL is passed to callback, not logged (may contain sensitive params)
    await this.callbacks.onRedirect(authorizationUrl)
    this.ensureActive()
  }

  /**
   * Save the PKCE code verifier.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.ensureActive()
    if (this.transients) {
      this.transients.set(this.serverName, { ...this.transientEntry(), codeVerifier, serverUrl: this.serverUrl })
      return
    }
    updateCodeVerifier(this.serverName, codeVerifier, this.serverUrl)
  }

  /**
   * Get the stored PKCE code verifier.
   * @throws Error if no code verifier is stored
   */
  async codeVerifier(): Promise<string> {
    this.ensureActive()
    if (this.usesClientCredentials) {
      throw new Error("codeVerifier is not used for client_credentials flow")
    }
    const entry = this.transientEntry()
    this.ensureActive()
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`)
    }
    return entry.codeVerifier
  }

  /**
   * Save the OAuth state parameter for CSRF protection.
   */
  async saveState(state: string): Promise<void> {
    this.ensureActive()
    if (this.transients) {
      this.transients.set(this.serverName, { ...this.transientEntry(), oauthState: state, serverUrl: this.serverUrl })
      return
    }
    updateOAuthState(this.serverName, state, this.serverUrl)
  }

  /**
   * Get the stored OAuth state parameter.
   * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
   */
  async state(): Promise<string> {
    this.ensureActive()
    if (this.usesClientCredentials) {
      throw new Error("state is not used for client_credentials flow")
    }
    const entry = this.transientEntry()
    this.ensureActive()
    if (!entry?.oauthState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    return entry.oauthState
  }

  /**
   * Invalidate credentials when authentication fails.
   * Clears tokens, client info, or all credentials based on the type.
   */
  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    this.ensureActive()
    switch (type) {
      case "all":
        this.transients?.delete(this.serverName)
        clearAllCredentials(this.serverName)
        break
      case "client":
        clearClientInfo(this.serverName)
        break
      case "tokens":
        clearTokens(this.serverName)
        break
    }
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    this.ensureActive()
    if (!this.usesClientCredentials) {
      return undefined
    }

    const params = new URLSearchParams({ grant_type: "client_credentials" })
    const requestedScope = scope ?? this.config.scope
    if (requestedScope) {
      params.set("scope", requestedScope)
    }
    return params
  }
}

export { DEFAULT_OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
