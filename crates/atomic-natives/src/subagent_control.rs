// Rust control plane for in-process subagents. The implementation is split
// into bounded parts to keep the repository's tracked-file length gate green.
use std::{
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	fmt,
	path::{Component, Path},
	sync::{
		Arc, Mutex, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use napi::{
	Error as NapiError, Status,
	bindgen_prelude::Unknown,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use tokio::sync::watch;

type StatusCallback = ThreadsafeFunction<String, Unknown<'static>, String, Status, false, true>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AdmissionRefusalKind {
	#[napi(value = "depthExceeded")]
	DepthExceeded,
	#[napi(value = "capacityExhausted")]
	CapacityExhausted,
	#[napi(value = "dispatchGuardBusy")]
	DispatchGuardBusy,
	#[napi(value = "invalidCwd")]
	InvalidCwd,
	#[napi(value = "unknownAgent")]
	UnknownAgent,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeChildSpec {
	pub task_name: String,
	pub agent_name: Option<String>,
	pub cwd: Option<String>,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeParentContext {
	pub path: String,
	pub depth: u8,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeAdmissionRefusal {
	pub kind: AdmissionRefusalKind,
	pub reason: String,
	pub max_depth: Option<u8>,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeAdmissionResult {
	pub child: Option<ChildIdentity>,
	pub refusal: Option<NativeAdmissionRefusal>,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeExecutionGuardResult {
	pub token: Option<u32>,
	pub refusal: Option<NativeAdmissionRefusal>,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeTerminationResult {
	pub cause: TerminationCause,
	pub forced: bool,
	pub grace_ms: u32,
}

fn native_refusal(refusal: AdmissionRefusal) -> NativeAdmissionRefusal {
	NativeAdmissionRefusal {
		kind: refusal_kind(&refusal),
		reason: refusal.to_string(),
		max_depth: match refusal {
			AdmissionRefusal::DepthExceeded(max) => Some(max),
			_ => None,
		},
	}
}
/// N-API wrapper around the root-scoped Rust control plane. The host marker is
/// intentionally held by the wrapper while the cloneable core stores only a
/// weak reference to it.
#[napi(js_name = "SubagentControl")]
pub struct NapiSubagentControl {
	inner: SubagentControl,
	_host: Arc<HostMarker>,
}

#[napi]
impl NapiSubagentControl {
	#[napi(constructor)]
	pub fn new(parent_path: String) -> Self {
		let parent_path = ChildPath::new(&parent_path)
			.unwrap_or_else(|reason| panic!("invalid parent path: {reason}"));
		let host = Arc::new(HostMarker);
		let inner = SubagentControl::with_host(parent_path, &host);
		Self { inner, _host: host }
	}

	#[napi(getter)]
	pub fn parent_path(&self) -> String {
		self.inner.parent_path().to_string()
	}

	#[napi]
	pub fn register_agent(&self, name: String) {
		self.inner.register_agent(name);
	}

	#[napi]
	pub fn admit_child_session(
		&self,
		spec: NativeChildSpec,
		parent: NativeParentContext,
	) -> NativeAdmissionResult {
		let result = (|| {
			let parent =
				ParentContext::new(parent.path, parent.depth).map_err(AdmissionRefusal::InvalidCwd)?;
			let mut spec_value = ChildSpec::new(spec.task_name);
			if let Some(agent_name) = spec.agent_name {
				spec_value = spec_value.with_agent_name(agent_name);
			}
			if let Some(cwd) = spec.cwd {
				spec_value = spec_value.with_cwd(cwd);
			}
			self.inner.admit_child_session(spec_value, parent)
		})();
		match result {
			Ok(child) => NativeAdmissionResult {
				child: Some(child.identity(self.inner.residency())),
				refusal: None,
			},
			Err(refusal) => {
				NativeAdmissionResult { child: None, refusal: Some(native_refusal(refusal)) }
			},
		}
	}

	#[napi]
	pub fn list_children(&self) -> Vec<ChildIdentity> {
		self.inner.list_children()
	}

	#[napi]
	pub fn publish_child_status(&self, path: String, status: AgentStatus) -> napi::Result<()> {
		self.inner.publish_status(path, status).map_err(NapiError::from_reason)
	}

	#[napi]
	pub fn subscribe_child_status(
		&self,
		path: String,
		#[napi(ts_arg_type = "(status: AgentStatus) => void")] callback: StatusCallback,
	) -> napi::Result<()> {
		let path = ChildPath::new(path).map_err(NapiError::from_reason)?;
		self.inner.subscribe_status(path, callback).map_err(NapiError::from_reason)
	}

	#[napi]
	pub fn try_acquire_execution_guard(&self) -> NativeExecutionGuardResult {
		match self.inner.acquire_napi_guard() {
			Ok(token) => NativeExecutionGuardResult {
				token: Some(u32::try_from(token).unwrap_or(u32::MAX)),
				refusal: None,
			},
			Err(refusal) => {
				NativeExecutionGuardResult { token: None, refusal: Some(native_refusal(refusal)) }
			},
		}
	}

	#[napi]
	pub fn release_execution_guard(&self, token: u32) -> bool {
		self.inner.release_napi_guard(u64::from(token))
	}

	#[napi]
	pub fn begin_child_attempt(&self, path: String) -> NativeExecutionGuardResult {
		let path = match ChildPath::new(path) {
			Ok(path) => path,
			Err(reason) => {
				return NativeExecutionGuardResult {
					token: None,
					refusal: Some(native_refusal(AdmissionRefusal::InvalidCwd(reason))),
				};
			},
		};
		let Some(child) = self.inner.registry().get(&path) else {
			return NativeExecutionGuardResult {
				token: None,
				refusal: Some(native_refusal(AdmissionRefusal::UnknownAgent)),
			};
		};
		match self.inner.begin_child_attempt(&child) {
			Ok(token) => NativeExecutionGuardResult {
				token: Some(u32::try_from(token).unwrap_or(u32::MAX)),
				refusal: None,
			},
			Err(refusal) => {
				NativeExecutionGuardResult { token: None, refusal: Some(native_refusal(refusal)) }
			},
		}
	}

	#[napi]
	pub fn finish_child_attempt(&self, token: u32, status: AgentStatus) -> napi::Result<()> {
		self.inner.finish_child_attempt(u64::from(token), status).map_err(NapiError::from_reason)
	}

	#[napi]
	pub fn terminate_child_attempt(
		&self,
		token: u32,
		cause: TerminationCause,
	) -> napi::Result<NativeTerminationResult> {
		self
			.inner
			.terminate_child_attempt(u64::from(token), cause)
			.map(|receipt| NativeTerminationResult {
				cause: receipt.cause,
				forced: receipt.forced,
				grace_ms: u32::try_from(receipt.grace_ms).unwrap_or(u32::MAX),
			})
			.map_err(NapiError::from_reason)
	}

	#[napi]
	pub fn reload_cold_child(&self, path: String, message: String) -> NativeAdmissionResult {
		match self.inner.reload_cold_child(path, &message) {
			Ok(child) => NativeAdmissionResult {
				child: Some(child.identity(self.inner.residency())),
				refusal: None,
			},
			Err(refusal) => {
				NativeAdmissionResult { child: None, refusal: Some(native_refusal(refusal)) }
			},
		}
	}
}
include!("subagent_control/part_01.rs");
include!("subagent_control/part_02.rs");
include!("subagent_control/part_03.rs");
include!("subagent_control/part_05.rs");
