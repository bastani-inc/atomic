# Intercom Multi-Node Brokers — Technical Design Document / RFC

| Document Metadata      | Details |
| ---------------------- | ------- |
| Author(s)              | Norin Lavaee (with Atomic) |
| Status                 | S0 accepted for review: spec, seams and contract suite; S1–S7 not started |
| Team / Owner           | `packages/intercom` — broker; `packages/coding-agent` — shared `storage` adapter |
| Created / Last Updated | 2026-10-19 |
| Builds on              | [#3761](https://github.com/bastani-inc/atomic/issues/3761) — recipients save messages on arrival and `delivered` waits for the recipient's `received` ack (commit `75427a850`) |
| Seams (S0)             | `packages/intercom/broker/multinode-state-store.ts`, `packages/intercom/broker/wake-up-bus.ts` |
| Contract suite (S0)    | `test/helpers/intercom-multinode-contract.ts`, run by `test/unit/intercom-multinode-state-contract.test.ts` against the test-only `test/helpers/intercom-multinode-memory-reference.ts` |
| Compatibility posture  | S0 is additive: no broker behaviour changes. Single-host Intercom keeps working unchanged until S5 wires the seams in. |

---

## 1. Problem

Intercom brokers are local. Each host runs one broker on a Unix socket or Windows named pipe, trusted by
filesystem permissions, and all routing state lives in that broker's memory:

- connected sessions;
- pending and live workflow-stage routes, and workflow rosters;
- pending questions (ask routes);
- held sends for restoring recipients (#3760);
- session-id reclaim (#3760);
- #3761's receipts awaiting the recipient's `received` ack.

The only durable broker state is the local `delivered-messages.sqlite`. It is duplicate-send protection only: HMAC
digests and a key file with a 12-minute TTL, and it holds no message text.

Sessions and workflow runs can already be shared across hosts by selecting the same remote SQLite-compatible database
through the `storage` adapter (`packages/coding-agent/docs/storage.md`, "Sharing storage across hosts"). Intercom
cannot follow them there. A session on host A cannot message a session on host B, ask it a question, or act as its
supervisor. The user asked to "prepare for the remote db scenario and multi-node", and expects that "the intercom
message will just get received right from the other node".

This document chooses the design, freezes the seams that later slices implement independently, and plans those
slices so they can run in parallel.

## 2. Decisions (user, immutable)

1. **Scope this round.** Spec plus seams with local implementations. No network transport.
2. **Routing.** The database is the source of truth. A pluggable wake-up signal tells a broker to look, and a slow
   backup poll covers lost signals.
3. **Only link between brokers.** Brokers coordinate *only* through the shared storage adapter and the wake-up bus.
   There is no broker-to-broker protocol and no remote-client endpoint; both are documented as future options (§11).
4. **Storage.** Intercom state uses the existing shared `storage` adapter selection, not a separate Intercom-owned
   database.
5. **Wake-ups are hints only.** A wake-up says "broker X: check the store" and carries a version number, never a
   message. The DB outbox is the truth.
6. **Cross-node parity.** A cross-node message reaches the recipient exactly like a local one. That means the same
   `intercom_message` card, sender identity, reply and ask routing, group isolation and supervisor routes, delivered
   over the recipient's local broker socket.
7. **"Delivered" keeps #3761's meaning.** The recipient durably saved the message (`intercom_inbox` entry) and
   acknowledged with `received`.

## 3. Prior art

| Project | Who is connected where | Routing | Guarantees |
|---|---|---|---|
| Socket.IO adapters: Redis, Redis Streams, Postgres, Mongo ([adapter](https://socket.io/docs/v4/adapter/), [postgres-adapter](https://socket.io/docs/v4/postgres-adapter/)) | Each node knows its own sockets; `fetchSockets()` asks every node and merges | Replaces the in-memory adapter. Postgres NOTIFYs small packets; larger ones go into a side table and only the row id is NOTIFYed | Pub/sub is fire-and-forget; Streams and Mongo add replay after reconnect |
| Centrifugo ([engines](https://centrifugal.dev/docs/server/engines), [design](https://centrifugal.dev/docs/getting-started/design)) | A "presence manager" kept separate from the broker; Redis entries with a TTL, so a crashed node's clients disappear within about a minute | Pluggable engine (memory, Redis, NATS) | Presence is explicitly eventually consistent |
| Phoenix Tracker / Presence ([Phoenix.Tracker](https://hexdocs.pm/phoenix_pubsub/Phoenix.Tracker.html)) | Heartbeats plus CRDT replication, no central DB | Phoenix.PubSub | Eventually consistent |
| Orleans grain directory / Dapr placement | A directory maps id to owning node; callers cache locations | Direct forward to the owner, refreshing the location on a miss | One live copy per id |
| Transactional outbox ([microservices.io](https://microservices.io/patterns/data/transactional-outbox.html); NestJS outbox docs) with Postgres LISTEN/NOTIFY | n/a | Message rows live in the DB; NOTIFY is only a wake-up nudge; a slow backup poll; claims are leases with random tokens and fencing; `SKIP LOCKED` | At least once; idempotent consumers deduplicate by id |

These share one shape:

- durable state lives in the DB;
- a lightweight signal only says "something changed, go check";
- presence is a lease or TTL that may be briefly stale;
- delivery is at least once, with id deduplication.

Projects that run their own server cluster (NATS, Temporal, Orleans, Dapr) build membership and mTLS links. Projects
that sit on a shared DB or bus (Socket.IO adapters, Centrifugo engines) leave node-to-node traffic and its security to
that infrastructure. Intercom is the second kind (§11).

## 4. Chosen design

```text
 host A                                   shared storage adapter                    host B
 ┌──────────────┐  local socket  ┌──────────┐   ┌──────────────────────┐   ┌──────────┐  local socket  ┌──────────────┐
 │ sender S     │◄──────────────►│ broker A │──►│ leases (presence,    │◄──│ broker B │◄──────────────►│ recipient R  │
 └──────────────┘                └──────────┘   │  membership)         │   └──────────┘                └──────────────┘
                                      │  ▲      │ outbox + claims      │        │  ▲
                                      │  │      │ held sends           │        │  │
                                      │  │      │ pending asks         │        │  │
                                      │  │      │ sent-message record  │        │  │
                                      │  │      └──────────────────────┘        │  │
                                      ▼  │           wake-up bus (hints only)    ▼  │
                                      └──┴──────────────────────────────────────────┘
```

- **Local stays local.** A sender's broker delivers to a recipient connected to that same broker exactly as today.
  Only a recipient hosted by another broker goes through the outbox.
- **Presence decides where a recipient lives.** Each broker holds a presence lease per connected recipient. The lease
  is keyed by the recipient's stable `deliveryTargetIdentity` and carries its `SessionInfo`. The origin broker reads
  that lease to resolve names and groups, and to find the hosting broker.
- **The outbox carries the exact frame.** An outbox row stores the `IntercomDeliveryFrame`
  (`{ type: "message", from, message, channel? }`) that the origin broker would have written to a local recipient.
  The hosting broker writes that frame verbatim to the recipient's local socket, so the recipient cannot tell a
  cross-node message from a local one, and builds the same `intercom_message` card. Parity holds by construction:
  there is no second message format.
- **Decisions are made at the origin.** The origin broker runs today's group isolation, supervisor authorization,
  pending-reply checks and duplicate-send checks before enqueuing, using the shared presence, ask and sent-message
  state. The hosting broker re-checks only what can change in transit (§8, "Split ownership").
- **Wake-ups are hints.** After enqueuing, the origin publishes `{ brokerId, reason: "outbox", version }`. After
  settling a row, the hosting broker publishes `{ brokerId: originBrokerId, reason: "outcome", version }`. A broker
  never depends on a hint. It scans on every `resync` event (subscribe and reconnect), on presence acquisition, and
  every `OUTBOX_BACKUP_POLL_INTERVAL_MS`. Coalesced or duplicate hints collapse into one read.
- **Claims make delivery exclusive.** The hosting broker claims a recipient's rows, writes their frames, and marks
  each row delivered only when the recipient sends #3761's `received`. Claim leases have random tokens and expire, so
  a crashed claimant's rows are redelivered. The recipient deduplicates by message id (#3761 `intercom_inbox`).
- **Storage selection.** Intercom state follows the top-level shared `storage` setting only, with its usual rule
  that a project selection replaces the global one as a whole. Domain-only selections do not move Intercom state:
  `sessions.storage`, `--session-dir`, `--session-store`, `ATOMIC_CODING_AGENT_SESSION_DIR`, `workflows.journal` and
  `ATOMIC_WORKFLOW_JOURNAL_PATH` leave it where the shared `storage` setting puts it. The stores are opened on the
  `SqliteDatabase` of that selection (an adapter's `openDatabase`, or a `path` selection's file), with tables named
  `<validated prefix>intercom_<name>`, and use the database clock for every age. A local file serves one host, so
  every broker that opens it sits on that host and the outbox is never used for local recipients. Multi-node is
  unavailable, and Intercom behaves exactly as today with its state in broker memory, when no top-level `storage` is
  set, when it selects `memory`, or when it selects a domain-only adapter that implements `openSessionStore` or
  `openRunJournal` but not `openDatabase`, because there is no `SqliteDatabase` to open. This is not an error and does
  not change single-node behaviour. The choice is recorded for confirmation as open decision 7 (§10).

## 5. Data model

The TypeScript seams in `packages/intercom/broker/multinode-state-store.ts` are the contract. Tables below are the
shape S1–S3 implement on the shared database. All ages come from the database clock, so clock skew between hosts does
not affect ownership. These rules apply to every store:

- Every operation returns a discriminated result.
- An empty identifier returns `{ status: "invalid", reason }`, never a silent success.
- Text, frames and requests are stored verbatim. There is no trimming or normalization; NUL is carried inside JSON.
- Returned values are detached copies.
- Lists come back in insertion order.

### 5.1 Broker membership and presence leases (`BrokerLeaseStore`, S1)

`<prefix>intercom_leases` has these columns:

- `kind` (`broker` | `presence`);
- `key` (the `brokerId` or `targetIdentity`);
- `holder_id`;
- `fencing_token`;
- `last_token`;
- `subject_json`;
- `renewed_at`;
- `first_acquired_order`.

The rules:

- **Membership.** There is one `broker` lease per running broker process, keyed by a random `brokerId`. Its subject
  carries `nodeId` (host label) and `startedAt`. It lists live brokers for diagnostics and for the future membership
  table (§11). Routing does not need it.
- **Presence.** There is one `presence` lease per connected recipient, keyed by its `deliveryTargetIdentity` and held
  by the hosting broker. Its subject carries the recipient's `SessionInfo`: name, groups, status and reply
  capability. Session ids are broker-assigned UUIDs, so they are unique across hosts.
- **Liveness.** A lease is live while `ageMs <= staleAfterMs`. Brokers renew every
  `BROKER_LEASE_RENEW_INTERVAL_MS` (10 s), and others may take a lease over after `BROKER_LEASE_STALE_AFTER_MS`
  (30 s). Centrifugo drops a crashed node's presence in about a minute; the workflow journal uses about two minutes.
- **Fencing.** Tokens are positive safe integers that strictly increase per key, including after a release. Taking
  over an expired lease issues a greater token. The old holder's `renew` and `release` then return
  `{ status: "stale", currentFencingToken }`. Expiry alone does not fence: until another broker takes the lease over,
  its holder may renew it. This is the standard fencing-token rule — the token, not wall time, decides.
- **Re-acquiring.** When the current holder re-acquires, it keeps its token, resets the age and replaces the subject.
  A non-holder's release is `stale`.

### 5.2 Outbox rows and claim leases (`OutboxStore`, S2)

`<prefix>intercom_outbox` has these columns:

- `sequence` (autoincrement);
- `message_id` (unique);
- `target_identity`;
- `origin_broker_id`;
- `digest`;
- `frame_json`;
- `state` (`queued` | `claimed` | `delivered` | `failed`);
- `claim_attempts`;
- `claimant_id`;
- `claim_token`;
- `claim_renewed_at`;
- `failure_reason`;
- `settled_at`.

| From | Operation | To | Notes |
|---|---|---|---|
| — | `enqueue` | `queued` | Same id and digest returns `duplicate` with the current row. Same id with another digest returns `conflict`. |
| `queued`, or `claimed` older than `staleAfterMs` | `claim` | `claimed` | Issues a new random token and increments `claimAttempts` |
| `claimed` (current token) | `renewClaim` | `claimed` | Resets the claim age |
| `claimed` (current token) | `releaseClaim` | `queued` | For example, the recipient disconnected before acking |
| `claimed` (current token) | `markDelivered` | `delivered` | Only on the recipient's `received` ack |
| `claimed` (current token) | `markFailed(reason)` | `failed` | The reason is reported to the sender verbatim |
| `delivered` / `failed` | any claim write | unchanged | Returns `settled` with the row, whatever the token |
| `delivered` / `failed` | `prune` after retention | deleted | The dedupe window equals the retention, `DELIVERED_MESSAGE_TTL_MS` |
| any | write with a superseded token | unchanged | Returns `stale` |
| none | write for an unknown id | — | Returns `unknown` |

Invariants:

- **One claimant per recipient.** `claim` returns `held` with the other claimant while another broker holds any live
  claim on that recipient. This keeps per-recipient order across claimant changes.
- **No resend of in-flight rows.** A claimant's own live claims are not returned again.
- **Ordering.** Rows for one recipient are claimed in insertion order. SQL implementations use `BEGIN IMMEDIATE`
  (SQLite) or `FOR UPDATE SKIP LOCKED` (Postgres) for exclusivity.

### 5.3 Held sends (`HeldSendStore`, S3)

`<prefix>intercom_held_sends` has the columns `order` (autoincrement), `message_id` (unique), `reservation_key` (the
supervisor capability the hold is for), `origin_broker_id`, `sender_session_id`, `request_json` and `held_at`.

`hold` refuses a message id already held under any reservation with `duplicate`. `take` atomically removes and returns
a reservation's sends in insertion order, so each is dispatched once, by whichever broker the restored child
registers with. The hold timeout stays with the origin broker, which owns the sender's wait. #3760's reservations
themselves (owner, child name, aliases, dormant) stay in the supervisor's broker; sharing them is S5 work if a child
can be restored on another host (§10, open decision 5).

### 5.4 Pending asks (`PendingAskStore`, S3)

`<prefix>intercom_pending_asks` has the columns `order`, `sender_session_id`, `target_session_id` and `message_id`,
unique on all three. It mirrors `PendingQuestionIndex`:

- the recipient's broker calls `record` when the ask's recipient acks it, so a reply route never opens for an
  unsaved ask;
- `matchesReply` and `clearReply` accept only the exact reverse route;
- `pruneSender` runs when a sender leaves;
- `takeForTarget` hands a departed target's asks over in insertion order.

### 5.5 Duplicate-send authority (`SentMessageAuthority`, S3)

`<prefix>intercom_sent_messages` has the columns `message_id` (primary key), `digest`, `target_identity`,
`question_route_json`, `state` (`reserved` | `accepted`) and `recorded_at`. It replaces the host-local
`delivered-messages.sqlite` once S5 lands, so a same-id retry through any broker is recognized:

- `reserve` returns `match` for the same digest and `conflict` for another digest;
- `forget` drops a reservation whose forwarding failed;
- `prune` enforces the retention.

The outbox's own unique `message_id` is the authority for rows already enqueued.

### 5.6 Wake-up bus (`WakeUpBus`, S4)

`packages/intercom/broker/wake-up-bus.ts`:

- `publish({ brokerId, reason, version })` is best effort. It never throws for a transport failure and returns
  `unavailable` when the bus is down or closed.
- `subscribe(brokerId, listener)` first emits `{ kind: "resync", cause: "subscribed" }`, and emits a `reconnected`
  resync after every transport reconnect.
- `close()` closes the connection and every subscription on it; it is idempotent. After `close`, `publish` and
  `subscribe` both return `unavailable`, and no subscription on that connection receives another event.
- Hints may be delayed, coalesced, duplicated or lost. A hint carries no message data.

## 6. Round trip

Sender S is on host A (broker A). Recipient R is on host B (broker B). Both brokers use the same storage adapter and
bus.

| # | Step | Store / bus effect |
|---|---|---|
| 1 | S sends `send` with message id `m` over its local socket. | — |
| 2 | Broker A resolves `to`: no local session; the live `presence` lease for R names broker B and R's `SessionInfo`. It runs group isolation, supervisor authorization and `sentMessages.reserve` exactly as for a local target. | reads `leases`, writes `sent_messages` |
| 3 | Broker A builds the frame it would write locally and enqueues it. | `outbox.enqueue` → `queued` |
| 4 | Broker A publishes a hint. S keeps waiting. | `publish({ brokerId: B, reason: "outbox", version: sequence })` |
| 5 | Broker B wakes (or polls) and claims R's rows in order. | `outbox.claim` → `claimed` |
| 6 | Broker B writes each row's frame verbatim to R's local socket and tracks it in `RecipientReceipts` as today. | — |
| 7 | R appends `intercom_inbox` (#3761), then sends `received`. | — |
| 8 | Broker B marks the row delivered. For an ask, it then records the pending ask. | `outbox.markDelivered` → `delivered`; `pendingAsks.record` |
| 9 | Broker B publishes the outcome hint. | `publish({ brokerId: A, reason: "outcome", version })` |
| 10 | Broker A wakes (or polls), reads the outcome for each `m` it is waiting on, accepts the sent-message record, and sends S `delivered` (or `delivery_failed` with the row's `failureReason`). | `outbox.read`, `sentMessages.accept` |

**Replies and asks travel the same path in reverse.**

- R replies with `replyTo: m`. Broker B checks `pendingAsks.matchesReply` on the shared store, resolves S's presence
  (held by broker A), and enqueues the reply frame for S's identity. Steps 3–10 then run with the roles swapped.
- Broker A clears the ask route with `clearReply` when S acks the reply.
- Supervisor sends use `channel: "supervisor"` in the stored frame, so R sees the supervisor card and route.
- `question_target` and `send_held` frames to the sender stay local to broker A.

**Expected added latency** compared with a local send:

- **Wake-up hops.** Two hops: A→B in step 4 and B→A in step 9.
- **Database round trips.** About five: enqueue, claim, markDelivered, the ask record when present, and the outcome
  read. The sent-message reserve and accept add two more.
- **Push bus** (Postgres NOTIFY, Redis or NATS): one notify latency per hop, typically 1–10 ms. With a remote
  database at 5–20 ms per round trip, expect tens of milliseconds.
- **S4's database-polled bus:** up to one poll interval per hop (default 500 ms, so ≤ 1 s for both hops), plus the
  database round trips.
- **Worst case, a lost hint:** one `OUTBOX_BACKUP_POLL_INTERVAL_MS` (30 s) per lost hop, so 60 s if both are lost.
  This is longer than #3761's 8 s receipt wait. The sender then gets the uncertain-outcome `delivery_failed`, and a
  same-id retry is answered from the outbox row's current state (`duplicate` with `delivered` reports `delivered`).
  No message is duplicated, because the recipient deduplicates by id.

## 7. Cross-node parity rules

1. **Same frame.** The outbox stores the `IntercomDeliveryFrame` broker A builds for a local delivery, and broker B
   writes that frame verbatim. The contract suite asserts the claimed frame deep-equals the local frame, for every
   field: verbatim text with whitespace, NUL and non-ASCII, attachments, `replyTo`, `expectsReply`, `source`,
   `channel: "supervisor"`, and the full `from` identity including groups.
2. **Same delivered meaning.** Broker A tells S `delivered` only after broker B's `markDelivered`, which runs only on
   R's `received` ack. The contract suite asserts the row stays `claimed` after the frame is written and before the
   ack.
3. **Same routing decisions.** Group isolation, supervisor authorization and pending-reply checks run at the origin
   on the same inputs as locally. `SessionInfo` comes from the presence lease, and ask routes come from the shared
   ask store.
4. **Same socket.** The recipient only ever talks to its local broker over its local socket. Nothing new is exposed.

## 8. Failure cases

- **Broker crash (hosting broker B).** B's presence and claim leases stop renewing. Once its presence leases expire,
  senders see no live presence, and the offline rule applies (open decision 1). B's claimed rows become claimable
  after `OUTBOX_CLAIM_STALE_AFTER_MS`. When R reconnects to a broker (B restarted or another), that broker acquires
  R's presence lease with a greater token, scans, and claims the rows with new tokens. R deduplicates any message it
  saved but whose ack was lost.
- **Broker crash (origin broker A).** S's socket is gone, so S's client reconnects and retries with the same message
  id (#3761). The new origin broker's `enqueue` returns `duplicate` with the row's current state. A settled row is
  reported at once. A pending row is checked by the new origin's backup poll, because outcome hints still name the
  dead broker A (open decision 4).
- **Lost wake-up.** Nothing is lost: rows stay in the outbox. Catch-up runs on `resync` (subscribe and reconnect), on
  presence acquisition, and every 30 s. The contract suite proves the outbox alone yields every undelivered row, in
  order, with no hint published.
- **Coalesced or duplicate wake-ups.** One claim returns every row; later claims return `[]`; an outbox hint with no
  rows is a harmless no-op (all asserted).
- **Lease expiry while still alive** (a GC pause or network partition):
  - **Presence:** another broker can take the lease over only when R has connected to it, which means R left
    broker B. Broker B's next presence write is `stale`, so it drops its local copy of R.
  - **Claims:** an expired claim can be re-claimed by another broker. The stale claimant's `markDelivered` is
    `stale`, so its outcome is not reported. The new claimant redelivers, R deduplicates by id and acks again, and the
    row is delivered exactly once from the sender's view.
- **Split ownership** (two brokers both believe they host R). Fencing tokens give one presence holder. Recipient-level
  claim exclusivity (`held`) gives one claimant per recipient. If both still write a frame, R's #3761 inbox
  deduplicates by message id, so the message is shown once. The hosting broker re-checks R's current group membership
  before writing; if R left the sender's group in transit, it calls `markFailed` with the isolation reason.
- **Recipient offline** (no live presence anywhere). Today a send to an unknown session fails with
  `Session not found`. Multi-node keeps that for names that resolve to no presence at all. When a presence or
  reservation exists but its broker is gone or R is mid-reconnect, the row waits in the outbox until a broker acquires
  R's presence and catches up. What the sender sees meanwhile is open decision 1.
- **Database unavailable.** The stores surface `StorageUnavailableError`. The broker keeps serving local delivery and
  refuses cross-node sends with an explicit `delivery_failed`. It never falls back to memory, matching the storage
  adapter's rule.

## 9. Security

The outbox stores message bodies in the shared database. Whoever can read that database can read cross-node Intercom
traffic, just as they can read the shared session transcripts there. The storage adapter's credentials and transport
security protect it. The local `delivered-messages.sqlite` design (HMAC digests, no content) cannot be kept for
cross-node rows by construction, and the user guide (S7) must say so. Wake-up hints carry only broker ids and
versions. No new listening endpoint is added.

## 10. Open decisions

1. **What the sender sees while the recipient is offline (OPEN).**
   - (a) Keep #3761's bounded wait: after `RECIPIENT_RECEIPT_TIMEOUT_MS` (8 s) the sender gets the uncertain-outcome
     `delivery_failed`. The row stays queued, and a same-id retry later learns the real outcome. Pro: no new
     protocol. Con: "uncertain" is vague for a recipient known to be offline.
   - (b) An explicit `queued` status, for example reusing the existing `queued` broker frame with
     `target: "offline session"`. The sender is told the message is queued for an offline session, and `delivered`
     arrives later only if the sender is still connected. Pro: honest. Con: a new client-visible state, and docs and
     tool feedback must change.
   - S5 must not ship until the user picks (a) or (b). S0's seams support both, through `listUndelivered` and the row
     state.
2. **Digest keying for the shared sent-message record (OPEN).** Today's digests are HMACs keyed by a host-local key
   file. Across hosts, either every broker shares a key (where is it distributed?) or the digest is unkeyed SHA-256
   over the canonical send. The outbox already stores bodies, so unkeyed digests leak nothing new for cross-node rows.
   They do weaken local-only sends' at-rest secrecy. S3 implements whatever digest S5 computes; the interface takes an
   opaque string.
3. **Pending-question "answered" flag (OPEN).** `DeliveredMessageCache` remembers whether an accepted ask was
   answered, so a same-id retry does not reopen its route. `SentMessageAuthority` has no such flag. S5 decides
   whether `PendingAskStore`'s absence of a route suffices, or proposes an additive interface field reviewed with
   S3.
4. **Outcome hints after an origin broker changes (OPEN).** Rows name their original `originBrokerId`. A sender that
   retries through another broker learns pending outcomes only by its backup poll. Re-pointing `originBrokerId` on a
   `duplicate` enqueue would need a new store operation.
5. **Restoring-recipient reservations across hosts (OPEN).** S0 shares held sends, not #3760's reservation records.
   That is enough when a child is restored on its supervisor's host, which is today's only case.
6. **Permissive choices made where the brief was silent** (recorded, reversible by review):
   - an expired but unsuperseded lease or claim stays renewable by its holder;
   - re-acquiring by the current holder keeps its token;
   - lease lists come in first-acquisition order;
   - a duplicate enqueue from another origin broker is still a `duplicate`;
   - `prune` takes a caller-supplied age;
   - a same-id enqueue addressed to another target is a `duplicate` (same digest) or `conflict` (other digest), never
     a second row, because the message id is unique across the outbox;
   - the wake-up bus does not promise detached event objects; listeners must not mutate events.
7. **Which storage selection Intercom follows (DECIDED for S0, open for user confirmation).** §4 picks the
   top-level shared `storage` setting alone, the narrowest reading of "Intercom state uses the existing shared
   `storage` adapter selection". Alternatives:
   - (a) follow the session selection's precedence, because #3761's inbox entries live in the session store;
   - (b) add an Intercom-specific selection.
   Either changes only S5's `open-broker-state.ts` and its configuration reading; no seam changes.

## 11. Future options (documented, not built)

- **Direct forwarding (Temporal and Orleans shape).** Brokers discover peers from the membership leases (cf. Orleans
  `IMembershipTable`, Temporal `cluster_membership`) and forward a frame straight to the hosting broker over gRPC or
  framed JSON with mTLS. They keep the outbox as the durable fallback. Client and cluster traffic use separate ports
  with independent TLS settings per link type, following NATS (client port 4222, cluster port 6222, separate TLS
  blocks). This removes the wake-up hops but adds a cluster protocol, peer authentication and certificate rotation.
- **Remote clients via gateway brokers (Orleans gateway shape).** A broker accepts sessions from other hosts over TLS
  with token authentication, so a session can attach to a remote broker without a local one.
- **Security precedent for either option:**
  - Dapr Sentry: an automatic mTLS certificate authority for sidecars;
  - NATS: per-link-type TLS;
  - Temporal: mTLS on gRPC and on its membership gossip.

  Intercom currently relies on the storage adapter's and bus's own security. It would need the same machinery before
  opening a port.
- **Push wake-up buses.** Postgres LISTEN/NOTIFY, Redis pub/sub or NATS behind the same `WakeUpBus` interface. A
  durable queue (JetStream, Azure Service Bus) is optional, because the outbox already provides durability.

## 12. Slice plan

Every slice depends only on the S0 seams and contract suite. File sets are disjoint, so S1, S2, S3, S4 and S6 can
run in parallel. S5 integrates them and needs the user's answer to open decision 1. S7 follows S5. No slice edits the
S0 files. An interface change goes through review as an S0 amendment.

| Slice | Files (new unless marked) | Interface implemented | Acceptance tests |
|---|---|---|---|
| **S1 presence leases** | `packages/intercom/broker/sql-lease-store.ts`; `test/unit/intercom-multinode-sql-lease-store.test.ts` | `BrokerLeaseStore` on `SqliteDatabase` + prefix; table `<prefix>intercom_leases`; database-clock ages | `registerBrokerLeaseStoreConformance` passes for: `openNodeSqliteDatabase` on a temp file with two connections as two brokers; and the module-selected adapter `test/fixtures/storage-adapter.ts` |
| **S2 outbox + claims** | `packages/intercom/broker/sql-outbox-store.ts`; `test/unit/intercom-multinode-sql-outbox-store.test.ts` | `OutboxStore`; table `<prefix>intercom_outbox`; exclusive claims in one transaction | `registerOutboxStoreConformance` passes on the same two fixtures, plus `registerCrossNodeRoundTripConformance` with S2's outbox, the memory pending-ask store and the memory bus |
| **S3 held sends, pending asks, duplicate-send record** | `packages/intercom/broker/sql-held-send-store.ts`; `packages/intercom/broker/sql-pending-ask-store.ts`; `packages/intercom/broker/sql-sent-message-authority.ts`; `test/unit/intercom-multinode-sql-s3-stores.test.ts` | `HeldSendStore`, `PendingAskStore`, `SentMessageAuthority`; tables `<prefix>intercom_held_sends`, `_pending_asks`, `_sent_messages` | `registerHeldSendStoreConformance`, `registerPendingAskStoreConformance` and `registerSentMessageAuthorityConformance` pass on both fixtures |
| **S4 wake-up bus** | `packages/intercom/broker/database-wake-up-bus.ts`; `test/unit/intercom-multinode-database-wake-up-bus.test.ts` | `WakeUpBus` as a database-polled hint log (`<prefix>intercom_wakeups`, default poll 500 ms, hints pruned after delivery), needing only the storage adapter | `registerWakeUpBusConformance` passes on two connections to one temp SQLite file; `interrupt` closes and reopens the poller's connection |
| **S5 broker integration (cross-node parity in the send/ack path)** | modified: `packages/intercom/broker/broker.ts`, `packages/intercom/broker/send-handler.ts`, `packages/intercom/broker/spawn.ts`, `packages/intercom/config.ts`; new: `packages/intercom/broker/multinode-router.ts`, `packages/intercom/broker/open-broker-state.ts` (composes S1–S4 into `IntercomBrokerStateStore` from the top-level shared `storage` selection, §4), `test/unit/intercom-multinode-broker-routing.test.ts` | Uses `IntercomBrokerStateStore` + `WakeUpBus`: presence acquire/renew/release on register/presence/leave; remote resolution; enqueue + hint; claim on hint, resync, presence acquire and backup poll; `markDelivered` on `received`; outcome reporting; shared ask and duplicate records | Unit: local-only behaviour unchanged (existing intercom suites green); a remote send writes the identical frame and reports `delivered` only after `received`; ask/reply reverse route; supervisor channel; group-isolation refusal; offline behaviour per decision 1; no top-level `storage`, `memory`, or a domain-only adapter leaves single-node behaviour unchanged; S6's cross-node scenarios green |
| **S6 two-broker E2E harness** | `test/helpers/intercom-two-broker-harness.ts`; `test/integration/intercom-multinode-two-broker.test.ts` | Starts two real broker processes with separate socket directories and one shared SQLite storage file (one adapter selection), and attaches real Intercom clients to each | Harness self-test now: both brokers start, each serves only its own clients, both open the shared file. Cross-node scenarios (send, ask/reply, supervisor send, broker kill and redelivery, lost-wake-up recovery via backup poll) are written in S6 and must pass as S5's acceptance |
| **S7 user docs + changelog** | modified: `packages/coding-agent/docs/intercom.md`, `packages/coding-agent/docs/storage.md` ("Sharing storage across hosts"), `packages/intercom/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md` | — | Docs describe enabling multi-node through the shared storage adapter, latency, offline behaviour, and that message bodies are stored in the shared database; docs tests (`npm run test:unit`) green |

The S0 files are frozen: `specs/2026-10-19-intercom-multi-node.md`,
`packages/intercom/broker/multinode-state-store.ts`, `packages/intercom/broker/wake-up-bus.ts`,
`test/helpers/intercom-multinode-contract.ts`, `test/helpers/intercom-multinode-memory-reference.ts` and
`test/unit/intercom-multinode-state-contract.test.ts`.

## 13. S0 verification

The contract suite registers 39 cases:

- leases: 8;
- outbox: 13;
- held sends: 2;
- pending asks: 3;
- sent messages: 3;
- wake-up bus: 6;
- cross-node round trip: 4.

The command `npx vitest --run --project unit test/unit/intercom-multinode-state-contract.test.ts` passes 39/39
against the memory reference.

Every ordering case inserts message ids whose lexical order differs from their insertion order (for example `z-9`,
`a-1`, `m-5`), so a store that sorts by message id instead of insertion order fails. Production message ids are
random UUIDs.

The two renewal cases measure ages without tight absolute windows, so machine load cannot fail a correct store:

- **Lease.** The age read after a renew or a holder re-acquire must not exceed the time the caller measured since it
  started that reset, plus `CLOCK_TOLERANCE_MS` (25 ms). Before each reset, the age must have grown by at least
  `RENEWAL_GAP_MS` (1 s).
- **Claim.** After `RENEWAL_GAP_MS`, the claimant renews. Another broker then claims with a window of the time since
  the renewal plus `RENEWAL_GAP_MS / 2`, and must get `held`. An unrenewed claim is older than that window by at least
  `RENEWAL_GAP_MS / 2`. A correct store fails only if more than 500 ms pass between computing the window and the
  store reading its clock.

**Mutation sweep.** Each mutant is one text substitution in a scratch copy of the memory reference outside the
checkout. It breaks one rule taken from a seam doc comment, a result variant, or a §5 transition table. The suite
runs against each mutant under `bun test` with the same registrations, once with the suite at the parent commit
(36 cases) and once with the current suite (39 cases). The sweep includes every mutant from earlier rounds under the
names below. For example, round 1's `outbox-by-message-id` is `O-order-by-message-id`, and `ask-forward-route-matches`
is `P-forward-route-matches`. No scratch files are committed.

Result: 129 of 132 mutants are killed. 15 of them survived the 36-case suite and are killed only
by the current one. The three survivors break no observable documented rule; the table gives each reason.
`L-negative-window-as-zero` is killed because the takeovers run in the same millisecond as the acquisition.

| Mutant | Rule it breaks | 36-case suite | Current suite |
|---|---|---|---|
| `L-acquire-empty-holder` | lease acquire: empty holder is invalid | 1 failed | killed (1 failed) |
| `L-acquire-empty-key` | lease acquire: empty broker id / target identity is invalid | 1 failed | killed (1 failed) |
| `L-reacquire-no-age-reset` | lease acquire by holder resets the age | 36/36 pass | killed (1 failed) |
| `L-reacquire-keeps-subject` | lease acquire by holder replaces the subject | 1 failed | killed (1 failed) |
| `L-reacquire-new-token` | lease acquire by holder keeps its token (even when expired) | 1 failed | killed (1 failed) |
| `L-takeover-while-live` | lease: live holder reported as held | 2 failed | killed (2 failed) |
| `L-held-wrong-token` | lease held result carries the holder's token | 2 failed | killed (2 failed) |
| `L-takeover-reuses-token` | takeover issues a greater token | 2 failed | killed (2 failed) |
| `L-token-not-positive` | fencing token is a positive safe integer | 1 failed | killed (1 failed) |
| `L-renew-no-age-reset` | lease renew resets the age (B2) | 36/36 pass | killed (1 failed) |
| `L-renew-ignores-subject` | lease renew replaces the subject when given | 1 failed | killed (1 failed) |
| `L-renew-subject-mismatch-allowed` | renew with a subject for another key is invalid | 1 failed | killed (1 failed) |
| `L-owns-ignores-token` | a superseded token is stale (holder id alone is not enough) | 1 failed | killed (1 failed) |
| `L-owns-ignores-holder` | a non-holder's renew/release is stale | 1 failed | killed (1 failed) |
| `L-stale-without-current-token` | stale carries currentFencingToken while the key has a holder | 2 failed | killed (2 failed) |
| `L-release-resets-token` | release keeps later tokens greater | 1 failed | killed (1 failed) |
| `L-release-noop` | release gives the lease up | 2 failed | killed (2 failed) |
| `L-renew-empty-holder` | renew/release: empty holder is invalid | 1 failed | killed (1 failed) |
| `L-renew-empty-key` | renew/release: empty key is invalid | 1 failed | killed (1 failed) |
| `L-read-empty-key` | lease read: empty key is invalid | 1 failed | killed (1 failed) |
| `L-read-not-detached` | lease read returns a detached copy | 1 failed | killed (1 failed) |
| `L-acquire-not-cloned` | lease acquire stores the subject verbatim (detached from the caller) | 1 failed | killed (1 failed) |
| `L-list-ignores-kind` | listLive returns one kind | 1 failed | killed (1 failed) |
| `L-list-ignores-liveness` | listLive returns only live leases | 1 failed | killed (1 failed) |
| `L-list-reverse-order` | listLive in first-acquisition order | 1 failed | killed (1 failed) |
| `L-live-strict-boundary` | live while ageMs <= staleAfterMs (boundary) | 36/36 pass | survived: Changes only the boundary age == `staleAfterMs`. Hitting that exact millisecond is not repeatable under load, so no load-robust case can observe it. |
| `L-negative-window-as-zero` | a negative staleAfterMs treats a lease or claim as expired | 5 failed | killed (5 failed) |
| `O-enqueue-empty-target` | enqueue: empty target is invalid | 1 failed | killed (1 failed) |
| `O-enqueue-empty-origin` | enqueue: empty origin broker is invalid | 1 failed | killed (1 failed) |
| `O-enqueue-empty-id` | enqueue: empty message id is invalid | 1 failed | killed (1 failed) |
| `O-no-dedupe` | one row per message id | 2 failed | killed (2 failed) |
| `O-dedupe-per-target` | dedupe by message id is global, not per target (B3) | 36/36 pass | killed (1 failed) |
| `O-conflict-as-duplicate` | same id with another digest is a conflict | 1 failed | killed (1 failed) |
| `O-duplicate-reports-original-state` | duplicate reports the existing row's current state | 1 failed | killed (1 failed) |
| `O-sequence-max-plus-one` | sequence strictly increasing, never reused after prune | 1 failed | killed (1 failed) |
| `O-sequence-per-recipient` | sequence strictly increasing across the outbox | 1 failed | killed (1 failed) |
| `O-enqueue-frame-not-cloned` | frame stored verbatim, detached from the caller | 1 failed | killed (1 failed) |
| `O-row-frame-not-cloned` | returned rows are detached copies | 1 failed | killed (1 failed) |
| `O-trim-text` | text stored verbatim | 3 failed | killed (3 failed) |
| `O-failure-reason-on-every-row` | failureReason present only on failed rows | 1 failed | killed (1 failed) |
| `O-failure-reason-trimmed` | failure reason stored verbatim | 1 failed | killed (1 failed) |
| `O-list-claims-rows` | listUndelivered does not claim | 36/36 pass | killed (1 failed) |
| `O-list-queued-only` | listUndelivered returns queued and claimed rows | 1 failed | killed (1 failed) |
| `O-order-by-message-id` | claim/listUndelivered in insertion order | 5 failed | killed (5 failed) |
| `O-claim-reverse-order` | claim in insertion order | 6 failed | killed (6 failed) |
| `O-global-claim-lock` | held only for a live claim on THIS recipient (B1) | 36/36 pass | killed (2 failed) |
| `O-no-recipient-exclusivity` | one claimant per recipient | 2 failed | killed (4 failed) |
| `O-held-ignores-expiry` | an expired claim of another claimant is reclaimable | 2 failed | killed (2 failed) |
| `O-held-by-own-claims` | own live claims do not make a recipient held | 4 failed | killed (4 failed) |
| `O-own-inflight-resent` | own live claims are not returned again | 3 failed | killed (3 failed) |
| `O-own-expired-not-reclaimed` | own expired claims are re-claimed with a new token | 1 failed | killed (1 failed) |
| `O-no-attempt-increment` | claim increments claimAttempts | 4 failed | killed (4 failed) |
| `O-token-deterministic` | claim token differs for every claim | 1 failed | killed (1 failed) |
| `O-attempt-mismatch` | claim attempt equals claimAttempts | 3 failed | killed (3 failed) |
| `O-delivered-on-claim` | delivered only on markDelivered | 10 failed | killed (12 failed) |
| `O-renew-claim-noop` | renewClaim resets the claim age (B2) | 36/36 pass | killed (1 failed) |
| `O-no-claim-fencing` | a superseded claim token is stale | 2 failed | killed (2 failed) |
| `O-claimant-only-fencing` | a superseded token is stale | 1 failed | killed (1 failed) |
| `O-token-only-fencing` | claim write with another claimant id is stale | 1 failed | killed (1 failed) |
| `O-settled-as-stale` | writes on a settled row return settled | 2 failed | killed (2 failed) |
| `O-unknown-as-stale` | writes for an unknown id return unknown | 1 failed | killed (1 failed) |
| `O-claim-write-empty-id` | claim write: empty message id is invalid | 1 failed | killed (1 failed) |
| `O-claim-write-empty-claimant` | claim write: empty claimant is invalid | 1 failed | killed (1 failed) |
| `O-claim-empty-claimant` | claim: empty claimant is invalid | 1 failed | killed (1 failed) |
| `O-claim-empty-target` | claim: empty target is invalid | 1 failed | killed (1 failed) |
| `O-release-keeps-claimed` | releaseClaim returns the row to queued | 1 failed | killed (1 failed) |
| `O-release-keeps-claim` | releaseClaim drops the claim | 1 failed | killed (1 failed) |
| `O-settle-keeps-state` | markDelivered/markFailed settle the row | 6 failed | killed (6 failed) |
| `O-read-empty-id` | read: empty id is invalid | 1 failed | killed (1 failed) |
| `O-list-empty-target` | listUndelivered: empty target is invalid | 1 failed | killed (1 failed) |
| `O-prune-claimed` | prune keeps in-flight claimed rows (N1) | 36/36 pass | killed (1 failed) |
| `O-prune-ignores-age` | prune only rows settled longer ago than the window | 1 failed | killed (1 failed) |
| `O-prune-queued` | prune deletes only settled rows | 1 failed | killed (1 failed) |
| `H-hold-empty-reservation` | hold: empty reservation is invalid | 1 failed | killed (1 failed) |
| `H-hold-empty-origin` | hold: empty origin is invalid | 1 failed | killed (1 failed) |
| `H-hold-empty-sender` | hold: empty sender session is invalid | 1 failed | killed (1 failed) |
| `H-hold-empty-id` | hold: empty message id is invalid | 1 failed | killed (1 failed) |
| `H-duplicate-per-reservation` | a message id held under any reservation is a duplicate | 1 failed | killed (1 failed) |
| `H-hold-not-cloned` | held request stored detached from the caller | 1 failed | killed (1 failed) |
| `H-list-not-detached` | list/take return detached copies | 36/36 pass | killed (1 failed) |
| `H-list-every-reservation` | list/take are per reservation | 1 failed | killed (1 failed) |
| `H-order-by-message-id` | held sends in insertion order | 1 failed | killed (1 failed) |
| `H-take-not-removing` | take hands each send over once | 1 failed | killed (1 failed) |
| `H-list-empty` | list: empty reservation is invalid | 1 failed | killed (1 failed) |
| `H-take-empty` | take: empty reservation is invalid | 1 failed | killed (1 failed) |
| `H-drop-always-dropped` | drop reports missing for an unknown id | 1 failed | killed (1 failed) |
| `H-drop-empty` | drop: empty id is invalid | 1 failed | killed (1 failed) |
| `P-record-empty-session` | record: empty session ids are invalid | 1 failed | killed (1 failed) |
| `P-record-empty-id` | record: empty message id is invalid | 1 failed | killed (1 failed) |
| `P-duplicate-by-pair` | duplicate only for the same sender, target and message | 1 failed | killed (2 failed) |
| `P-record-not-copied` | recorded ask is detached from the caller | 36/36 pass | killed (1 failed) |
| `P-forward-route-matches` | only the exact reverse route matches | 1 failed | killed (1 failed) |
| `P-ignores-reply-to` | the reply must answer the recorded message id | 1 failed | killed (1 failed) |
| `P-ignores-reply-target` | the reply must go back to the ask's sender | 36/36 pass | killed (1 failed) |
| `P-ignores-reply-sender` | the reply must come from the ask's target | 1 failed | killed (1 failed) |
| `P-clear-by-pair` | clearReply clears only the exact ask (N2) | 36/36 pass | killed (1 failed) |
| `P-clear-noop` | clearReply removes the route | 2 failed | killed (2 failed) |
| `P-route-empty-session` | reply route: empty session ids are invalid | 1 failed | killed (1 failed) |
| `P-route-empty-reply-to` | reply route: empty replyTo is invalid | 1 failed | killed (1 failed) |
| `P-prune-by-target` | pruneSender removes the sender's asks | 1 failed | killed (1 failed) |
| `P-prune-count` | pruneSender reports the removed count | 1 failed | killed (1 failed) |
| `P-prune-empty` | pruneSender: empty session is invalid | 1 failed | killed (1 failed) |
| `P-take-not-removing` | takeForTarget removes the asks | 1 failed | killed (1 failed) |
| `P-take-order-by-message-id` | takeForTarget in insertion order | 1 failed | killed (1 failed) |
| `P-take-empty` | takeForTarget: empty session is invalid | 1 failed | killed (1 failed) |
| `P-take-not-copied` | takeForTarget returns detached copies | 36/36 pass | survived: Equivalent: `takeForTarget` removes the asks it returns, so the store never reads the returned objects again. |
| `S-reserve-empty-id` | reserve: empty id is invalid | 1 failed | killed (1 failed) |
| `S-reserve-empty-target` | reserve: empty target is invalid | 1 failed | killed (1 failed) |
| `S-reserve-conflict-as-match` | reserve: another digest is a conflict | 1 failed | killed (1 failed) |
| `S-reserve-match-state-fixed` | reserve match reports the current state | 1 failed | killed (1 failed) |
| `S-route-not-copied-in` | question route stored detached from the caller | 36/36 pass | killed (1 failed) |
| `S-route-not-copied-out` | lookup returns a detached question route | 36/36 pass | killed (1 failed) |
| `S-route-key-always-present` | questionRoute absent unless given | 1 failed | killed (1 failed) |
| `S-accept-ignores-digest` | accept with another digest is a conflict | 1 failed | killed (1 failed) |
| `S-accept-noop` | accept moves the record to accepted | 1 failed | killed (1 failed) |
| `S-accept-empty` | accept: empty id is invalid | 1 failed | killed (1 failed) |
| `S-lookup-empty` | lookup: empty id is invalid | 1 failed | killed (1 failed) |
| `S-lookup-ignores-digest` | lookup with another digest is a conflict | 1 failed | killed (1 failed) |
| `S-forget-empty` | forget: empty id is invalid | 1 failed | killed (1 failed) |
| `S-forget-ignores-digest` | forget with another digest is a conflict | 1 failed | killed (1 failed) |
| `S-forget-noop` | forget drops the reservation | 1 failed | killed (1 failed) |
| `S-prune-ignores-age` | prune only records older than the window | 1 failed | killed (1 failed) |
| `W-publish-empty` | publish: empty broker id is invalid | 1 failed | killed (1 failed) |
| `W-closed-publishes` | publish after close is unavailable | 1 failed | killed (1 failed) |
| `W-hints-to-every-broker` | a hint reaches only the addressed broker | 1 failed | killed (1 failed) |
| `W-subscribe-empty` | subscribe: empty broker id is invalid | 1 failed | killed (1 failed) |
| `W-closed-subscribes` | subscribe after close is unavailable (N4) | 36/36 pass | killed (1 failed) |
| `W-no-subscribe-resync` | subscribe starts with a subscribed resync | 7 failed | killed (7 failed) |
| `W-no-reconnect-resync` | a reconnect emits a reconnected resync | 2 failed | killed (2 failed) |
| `W-subscription-close-noop` | closing a subscription stops its events | 1 failed | killed (1 failed) |
| `W-connection-close-keeps-subscriptions` | closing a connection closes its subscriptions | 36/36 pass | killed (1 failed) |
| `W-event-not-cloned` | (not documented for the bus) events are detached | 36/36 pass | survived: Not a documented bus rule: the detached-copy convention covers the state stores, and §10 item 6 records that bus events are not promised detached. |
