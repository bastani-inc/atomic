//! The Atomic release a native module belongs to.
use napi_derive::napi;

/// The Atomic release this native module was built for (`0.0.0` from a source checkout). Atomic refuses to run a
/// release with the native module of another one, which a broken installation, or an update while it runs, leaves.
#[napi(js_name = "nativeVersion")]
pub fn native_version() -> String {
	env!("CARGO_PKG_VERSION").to_string()
}
