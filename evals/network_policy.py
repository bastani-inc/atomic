"""Network-policy helpers for the Atomic eval adapters.

Deep SWE tasks declare ``network_mode = "no-network"`` for both the ``[agent]``
and ``[verifier]`` scopes. Pier resolves that onto the legacy ``allow_internet``
boolean and, for the agent, keeps filtered egress alive through a Squid overlay
built from the agent's :class:`NetworkAllowlist`.

The failure this module exists to prevent: when that allowlist is *empty*, Pier
skips the proxy overlay and applies the no-network overlay instead, so the agent
container has zero egress. The model call then fails as a generic SDK connection
error that is indistinguishable from a bad or missing credential. Raising a
named error at allowlist-construction time makes the sandbox itself the reported
cause.
"""

from __future__ import annotations

from pier.models.agent.network import NetworkAllowlist


class EmptyEgressAllowlistError(RuntimeError):
    """Raised when an agent's egress allowlist would be empty.

    An empty allowlist under restricted egress leaves the sandbox with no
    reachable provider host, which surfaces downstream as a provider connection
    failure. This error names the sandbox and the model that produced it.
    """

    def __init__(self, *, model_name: str | None, scope: str = "agent") -> None:
        self.model_name = model_name
        self.scope = scope
        shown = model_name if model_name else "<unset>"
        super().__init__(
            f"Egress allowlist for the {scope} sandbox is empty (model_name={shown!r}). "
            "Under restricted egress (network_mode='no-network') an empty allowlist "
            "removes the filtered-egress proxy overlay, so the sandbox has no route to "
            "any provider host and the run fails as a generic connection error that "
            "looks like a credential problem. Pass --model as 'provider/model' so the "
            "provider domains can be resolved, or run the task with "
            "network_mode='public'."
        )


def require_non_empty_allowlist(
    allowlist: NetworkAllowlist,
    *,
    model_name: str | None,
    scope: str = "agent",
) -> NetworkAllowlist:
    """Return ``allowlist`` unchanged, or raise :class:`EmptyEgressAllowlistError`."""

    if not allowlist.domains:
        raise EmptyEgressAllowlistError(model_name=model_name, scope=scope)
    return allowlist
