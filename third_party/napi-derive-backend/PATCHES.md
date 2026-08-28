# Atomic patch to napi-derive-backend 6.1.2

This directory starts from the published `napi-derive-backend` 6.1.2 crate. Its source tag is
[`napi-derive-backend-v6.1.2`](https://github.com/napi-rs/napi-rs/releases/tag/napi-derive-backend-v6.1.2) at commit
`956e4525fea6a676ea3680b711382f167b899af9`.

Atomic carries one ownership patch because that release and napi-rs main as of
`b494acc732767bda7f0957a8cc0dead4d87deb3a` keep class values as nullable raw pointers until generated
reference creation. The napi runtime rejects null inside its borrow helper, but that proof is neither encoded in
the pointer type nor visible to CodeQL at the macro expansion site.

The patch converts class pointers to `NonNull<T>` before borrow registration in:

- `FromNapiRef` and `FromNapiMutRef` generation;
- shared and mutable method-receiver generation;
- generated class field getters and setters.

Generated code preserves the existing `Status::InvalidArg` status and `Cannot borrow a null native value` reason.
The patch does not change JavaScript declarations, exports, class layout, or lifecycle behavior.
