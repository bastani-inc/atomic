# Cursor v2 sanitized protocol fixtures

These whitespace-separated hex fixtures are **synthetic**. None came from a live Cursor request or response. They contain no credentials, account/subject/issuer values, request or conversation IDs, prompts, customer content, machine paths, headers, UUIDs, or retained private bodies.

## Provenance and evidence

- Checked-in source baseline: `e5e1c2fd9d6887ca62ab81fbc3143298f948f955`.
- Schema evidence class: independently verified source-baseline fields retained verbatim in the purpose-minimal `packages/cursor/src/proto/schema/cursor-{catalog,conversation,stream}.proto` schemas, their checked-in generated `cursor-*_pb.ts` descriptors, and `packages/cursor/src/transport-frame.ts` Connect framing.
- Inference evidence class: RequestedModel's non-optional proto3 bool maps authoritative Max absence to `false`; canonical identity still distinguishes absent from false. Clean Connect end-stream/EOF is the single Atomic terminal. Historical thinking uses checked-in `ConversationStep.thinking_message = 3` / `ThinkingMessage.text = 1`.
- Generation method: deterministic Bun script using literal protobuf tags/lengths and Connect's flags byte plus four-byte big-endian payload length. Values are deliberately synthetic (`A`, `B`, `M`, ` R/1 `, `one`, `two`, `think-1`, `think-2`).
- Corpus enforcement: `cursor-v2-fixtures.test.ts` enumerates exactly these 15 `.hex` files, bounds every fixture to 64 bytes, allowlists every printable synthetic value, and rejects credential/header/cookie/JWT, UUID, account, URL/email, and machine-path patterns. Each fixture is also decoded or driven through its named production behavior below; none is a broad capture.

## Fixture ledger

| Fixture | Purpose / matrix IDs | Fields represented |
|---|---|---|
| `get-usable-models-duplicates.hex` | Literal A/B/A order and duplicates (D-05) | response models=1; ModelDetails model_id=1, max_mode=7 |
| `get-usable-models-max-states.hex` | Max absent/false/true (D-06) | same fields, with optional field 7 omitted/0/1 |
| `get-usable-models-empty.hex` | Authoritative valid empty (D-07) | zero-byte protobuf body |
| `get-usable-models-malformed-row.hex` | Whole-response malformed row failure (D-08) | valid row followed by empty ModelDetails |
| `run-route-{nonmax,max,absent-max}.hex` | Exact dual-route encoding and empty parameters (D-28..D-30) | AgentClient run=1; AgentRun modelDetails=3, requestedModel=9; IDs=1; Max=7/2; zero parameter elements |
| `stream-text-chunks.connect.hex` | Ordered incremental text (D-31) | server interaction=1; interaction text_delta=1; text=1 |
| `stream-thinking-chunks.connect.hex` | Ordered canonical thinking (T-03) | server interaction=1; thinking_delta=4; text=1 |
| `stream-clean-terminal.connect.hex` | One clean terminal (T-05) | Connect end-stream flag `0x02` with safe synthetic `{}` envelope |
| `cancel-action.hex` | Conversation cancellation (T-06..T-10) | client conversation_action=4; cancel_action=3 |
| `stream-error-auth.connect.hex` | Authentication taxonomy/redaction (T-13) | synthetic Connect error envelope |
| `stream-error-server.connect.hex` | Server taxonomy/redaction (T-19) | synthetic Connect error envelope |
| `stream-malformed-header.hex` | Malformed framing (D-33) | incomplete Connect header |
| `stream-truncated-body.hex` | Truncated framing (D-34) | declared length 5 with only 2 bytes |

An empty repeated protobuf collection has no field tag. Therefore RequestedModel `parameters: []` is asserted semantically in codec tests and represented on wire by zero field-3 elements; no empty parameter message is invented.
