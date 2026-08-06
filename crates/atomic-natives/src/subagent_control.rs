use std::{
	fmt,
	path::{Component, Path},
	sync::Arc,
};

use napi::{
	Error as NapiError, Status, bindgen_prelude::Unknown, threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;

type StatusCallback = ThreadsafeFunction<String, Unknown<'static>, String, Status, false, true>;
type StatusUpdateCallback = ThreadsafeFunction<
	NativeStatusUpdate,
	Unknown<'static>,
	NativeStatusUpdate,
	Status,
	false,
	true,
>;

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

#[derive(Clone, Debug)]
#[napi(object)]
pub struct NativeStatusUpdate {
	pub status: AgentStatus,
	pub cause: Option<TerminationCause>,
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
	pub fn subscribe_child_status_with_cause(
		&self,
		path: String,
		#[napi(ts_arg_type = "(update: NativeStatusUpdate) => void")] callback: StatusUpdateCallback,
	) -> napi::Result<()> {
		let path = ChildPath::new(path).map_err(NapiError::from_reason)?;
		self.inner.subscribe_status_with_cause(path, callback).map_err(NapiError::from_reason)
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
	pub async fn terminate_child_attempt(
		&self,
		token: u32,
		cause: TerminationCause,
	) -> napi::Result<NativeTerminationResult> {
		let inner = self.inner.clone();
		// Keep the N-API door awaitable: the 100 ms cooperative grace must not
		// monopolize the JavaScript thread while a child flushes and completes.
		let receipt = inner
			.terminate_child_attempt(u64::from(token), cause)
			.await
			.map_err(NapiError::from_reason)?;
		Ok(NativeTerminationResult {
			cause: receipt.cause,
			forced: receipt.forced,
			grace_ms: u32::try_from(receipt.grace_ms).unwrap_or(u32::MAX),
		})
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

/// Maximum nesting depth for an admitted child.
pub const MAX_DEPTH: u8 = 5;
/// Maximum number of active child turns for one root control plane.
pub const EXECUTION_CAPACITY: usize = 4;
/// Codex's literal cooperative-interruption grace period.
pub const GRACEFUL_INTERRUPTION_TIMEOUT_MS: u64 = 100;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChildPath(String);

impl ChildPath {
	pub fn new(value: impl AsRef<str>) -> Result<Self, String> {
		let value = value.as_ref();
		validate_path(value)?;
		Ok(Self(value.to_owned()))
	}

	fn child(parent: &Self, task_name: &str, number: u64) -> Result<Self, String> {
		validate_task_name(task_name)?;
		let value = format!("{}/{task_name}_{number}", parent.0);
		Self::new(value)
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl AsRef<str> for ChildPath {
	fn as_ref(&self) -> &str {
		self.as_str()
	}
}

impl fmt::Display for ChildPath {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

fn validate_path(value: &str) -> Result<(), String> {
	if value.is_empty() {
		return Err("child path must not be empty".to_owned());
	}
	if value.contains('\0') || value.contains('\\') {
		return Err("child path contains an invalid character".to_owned());
	}
	for (index, component) in value.split('/').enumerate() {
		if component.is_empty() {
			if index == 0 && value.starts_with('/') {
				continue;
			}
			return Err("child path contains an empty component".to_owned());
		}
		if component == "." || component == ".." {
			return Err("child path contains a traversal component".to_owned());
		}
	}
	Ok(())
}

pub(crate) fn validate_task_name(value: &str) -> Result<(), String> {
	if value.is_empty() {
		return Err("task name must not be empty".to_owned());
	}
	if value.contains('/') || value.contains('\\') || value.contains('\0') {
		return Err("task name must be a single path component".to_owned());
	}
	if value == "." || value == ".." {
		return Err("task name contains a traversal component".to_owned());
	}
	Ok(())
}

pub(crate) fn validate_cwd(value: &str) -> Result<(), String> {
	if value.is_empty() {
		return Err("cwd must not be empty".to_owned());
	}
	if value.contains('\0') {
		return Err("cwd contains an invalid character".to_owned());
	}
	if Path::new(value).components().any(|component| matches!(component, Component::ParentDir)) {
		return Err("cwd must not contain a parent traversal component".to_owned());
	}
	Ok(())
}

/// A depth value whose constructor rejects values beyond the contract's limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Depth(u8);

impl Depth {
	pub fn new(value: u8) -> Result<Self, AdmissionRefusal> {
		if value > MAX_DEPTH {
			return Err(AdmissionRefusal::DepthExceeded(MAX_DEPTH));
		}
		Ok(Self(value))
	}

	pub fn value(self) -> u8 {
		self.0
	}

	pub fn child(self) -> Result<Self, AdmissionRefusal> {
		Self::new(self.0.saturating_add(1))
	}
}

/// Refusals returned by the admission and execution doors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmissionRefusal {
	DepthExceeded(u8),
	CapacityExhausted,
	DispatchGuardBusy,
	InvalidCwd(String),
	UnknownAgent,
}

impl fmt::Display for AdmissionRefusal {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::DepthExceeded(max) => write!(formatter, "child depth exceeds maximum {max}"),
			Self::CapacityExhausted => formatter.write_str("child execution capacity is exhausted"),
			Self::DispatchGuardBusy => formatter.write_str("child dispatch guard is busy"),
			Self::InvalidCwd(reason) => write!(formatter, "invalid cwd: {reason}"),
			Self::UnknownAgent => formatter.write_str("unknown agent"),
		}
	}
}

/// The only statuses emitted by a child status watch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AgentStatus {
	#[napi(value = "pending")]
	Pending,
	#[napi(value = "running")]
	Running,
	#[napi(value = "ok")]
	Ok,
	#[napi(value = "error")]
	Error,
	#[napi(value = "interrupted")]
	Interrupted,
	#[napi(value = "continued")]
	Continued,
}

impl AgentStatus {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Pending => "pending",
			Self::Running => "running",
			Self::Ok => "ok",
			Self::Error => "error",
			Self::Interrupted => "interrupted",
			Self::Continued => "continued",
		}
	}

	pub fn is_terminal(self) -> bool {
		matches!(self, Self::Ok | Self::Error | Self::Interrupted)
	}
}

#[derive(Clone, Debug)]
pub struct ParentContext {
	path: ChildPath,
	depth: Depth,
}

impl ParentContext {
	pub fn new(path: impl AsRef<str>, depth: u8) -> Result<Self, String> {
		let path = ChildPath::new(path)?;
		let depth = Depth::new(depth).map_err(|error| error.to_string())?;
		Ok(Self { path, depth })
	}

	pub fn path(&self) -> &ChildPath {
		&self.path
	}

	pub fn depth(&self) -> Depth {
		self.depth
	}
}

#[derive(Clone, Debug)]
pub struct ChildSpec {
	task_name: String,
	agent_name: Option<String>,
	cwd: Option<String>,
}

impl ChildSpec {
	pub fn new(task_name: impl Into<String>) -> Self {
		Self { task_name: task_name.into(), agent_name: None, cwd: None }
	}

	pub fn with_agent_name(mut self, agent_name: impl Into<String>) -> Self {
		self.agent_name = Some(agent_name.into());
		self
	}

	pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
		self.cwd = Some(cwd.into());
		self
	}

	pub fn task_name(&self) -> &str {
		&self.task_name
	}
}

/// Persistent identity information returned by the registry.
#[derive(Clone, Debug)]
#[napi(object)]
pub struct ChildIdentity {
	pub path: String,
	pub parent_path: String,
	pub task_name: String,
	pub depth: u8,
	pub status: AgentStatus,
	pub cause: Option<TerminationCause>,
	pub loaded: bool,
}

/// Explicit termination causes. Timer/idle/wall-clock causes are intentionally
/// absent, making timer-driven termination unrepresentable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum TerminationCause {
	#[napi(value = "abort")]
	Abort,
	#[napi(value = "interrupt")]
	Interrupt,
	#[napi(value = "fail-fast-skip")]
	FailFastSkip,
	#[napi(value = "parent-shutdown")]
	ParentShutdown,
}

mod control;
mod execution;
mod registry;
mod residency;
mod status;

pub use control::{DispatchGuard, SubagentControl, TerminationReceipt};
pub(crate) use control::{HostMarker, refusal_kind};
pub use execution::{ExecutionGuard, ExecutionLimiter};
pub use registry::{AdmittedChild, AgentRegistry, ReservationError, SpawnReservation};
pub use residency::{Residency, ResidencyError};
pub use status::{LifecycleEvent, StatusUpdate, StatusWatch};
