
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

fn validate_task_name(value: &str) -> Result<(), String> {
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

fn validate_cwd(value: &str) -> Result<(), String> {
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

/// Lifecycle values accepted by the status reducer. The reducer deliberately
/// has no timeout or timer event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleEvent {
	Pending,
	Running,
	Ok,
	Error,
	Interrupted,
	Continued,
}

impl From<LifecycleEvent> for AgentStatus {
	fn from(event: LifecycleEvent) -> Self {
		match event {
			LifecycleEvent::Pending => Self::Pending,
			LifecycleEvent::Running => Self::Running,
			LifecycleEvent::Ok => Self::Ok,
			LifecycleEvent::Error => Self::Error,
			LifecycleEvent::Interrupted => Self::Interrupted,
			LifecycleEvent::Continued => Self::Continued,
		}
	}
}

/// A watch channel carrying the reduced status for one child.
#[derive(Clone)]
pub struct StatusWatch {
	sender: watch::Sender<AgentStatus>,
}

impl Default for StatusWatch {
	fn default() -> Self {
		Self::new()
	}
}

impl StatusWatch {
	pub fn new() -> Self {
		let (sender, _receiver) = watch::channel(AgentStatus::Pending);
		Self { sender }
	}

	pub fn current(&self) -> AgentStatus {
		*self.sender.borrow()
	}

	pub fn subscribe(&self) -> watch::Receiver<AgentStatus> {
		self.sender.subscribe()
	}

	pub fn publish(&self, status: AgentStatus) {
		self.sender.send_replace(status);
	}

	pub fn reduce(&self, event: LifecycleEvent) -> AgentStatus {
		let status = AgentStatus::from(event);
		self.publish(status);
		status
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

#[derive(Clone, Debug)]
struct ChildIdentitySeed {
	path: ChildPath,
	parent_path: ChildPath,
	task_name: String,
	depth: Depth,
	number: u64,
}

#[derive(Clone)]
struct AgentRecord {
	identity: ChildIdentitySeed,
	status: StatusWatch,
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
	pub loaded: bool,
}

impl ChildIdentitySeed {
	fn to_identity(&self, status: AgentStatus, loaded: bool) -> ChildIdentity {
		ChildIdentity {
			path: self.path.to_string(),
			parent_path: self.parent_path.to_string(),
			task_name: self.task_name.clone(),
			depth: self.depth.value(),
			status,
			loaded,
		}
	}
}

#[derive(Default)]
struct RegistryInner {
	children: BTreeMap<ChildPath, Arc<AgentRecord>>,
	reservations: BTreeSet<ChildPath>,
	next_numbers: BTreeMap<(ChildPath, String), u64>,
	available_numbers: BTreeMap<(ChildPath, String), BTreeSet<u64>>,
	known_agents: HashSet<String>,
}

/// The identity registry for one root session.
#[derive(Clone, Default)]
pub struct AgentRegistry {
	inner: Arc<Mutex<RegistryInner>>,
}

impl AgentRegistry {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn register_agent(&self, name: impl Into<String>) {
		if let Ok(mut inner) = self.inner.lock() {
			inner.known_agents.insert(name.into());
		}
	}

	pub fn known_agent(&self, name: &str) -> bool {
		self.inner.lock().map(|inner| inner.known_agents.contains(name)).unwrap_or(false)
	}

	pub fn reserve_spawn(
		&self,
		parent_path: impl AsRef<str>,
		task_name: impl AsRef<str>,
		depth: u8,
	) -> Result<SpawnReservation, AdmissionRefusal> {
		let parent_path = ChildPath::new(parent_path).map_err(AdmissionRefusal::InvalidCwd)?;
		let depth = Depth::new(depth)?;
		self.reserve_spawn_typed(&parent_path, task_name.as_ref(), depth, None)
	}
	pub fn reserve_spawn_typed(
		&self,
		parent_path: &ChildPath,
		task_name: &str,
		depth: Depth,
		agent_name: Option<&str>,
	) -> Result<SpawnReservation, AdmissionRefusal> {
		validate_task_name(task_name).map_err(AdmissionRefusal::InvalidCwd)?;
		if let Some(agent_name) = agent_name
			&& !self.known_agent(agent_name)
		{
			return Err(AdmissionRefusal::UnknownAgent);
		}
		let mut inner = self.inner.lock().map_err(|_| AdmissionRefusal::DispatchGuardBusy)?;
		let key = (parent_path.clone(), task_name.to_owned());
		let number =
			inner.available_numbers.get_mut(&key).and_then(BTreeSet::pop_first).unwrap_or_else(|| {
				let next_number = inner.next_numbers.entry(key.clone()).or_insert(1);
				let number = *next_number;
				*next_number = next_number.saturating_add(1);
				number
			});
		let path =
			ChildPath::child(parent_path, task_name, number).map_err(AdmissionRefusal::InvalidCwd)?;
		inner.reservations.insert(path.clone());
		Ok(SpawnReservation {
			registry: self.clone(),
			identity: ChildIdentitySeed {
				path,
				parent_path: parent_path.clone(),
				task_name: task_name.to_owned(),
				depth,
				number,
			},
			started: false,
			committed: false,
		})
	}

	pub fn pending_reservations(&self) -> usize {
		self.inner.lock().map(|inner| inner.reservations.len()).unwrap_or(0)
	}

	pub fn get(&self, path: &ChildPath) -> Option<AdmittedChild> {
		self
			.inner
			.lock()
			.ok()
			.and_then(|inner| inner.children.get(path).cloned())
			.map(|record| AdmittedChild { record })
	}

	pub fn list(&self) -> Vec<ChildIdentity> {
		self
			.inner
			.lock()
			.map(|inner| {
				inner
					.children
					.values()
					.map(|record| record.identity.to_identity(record.status.current(), false))
					.collect()
			})
			.unwrap_or_default()
	}

	fn commit(&self, identity: ChildIdentitySeed) -> Result<AdmittedChild, ReservationError> {
		let mut inner = self.inner.lock().map_err(|_| ReservationError::RegistryUnavailable)?;
		if !inner.reservations.remove(&identity.path) {
			return Err(ReservationError::ReservationMissing);
		}
		if inner.children.contains_key(&identity.path) {
			inner
				.available_numbers
				.entry((identity.parent_path.clone(), identity.task_name.clone()))
				.or_default()
				.insert(identity.number);
			return Err(ReservationError::IdentityAlreadyCommitted);
		}
		let record = Arc::new(AgentRecord { identity, status: StatusWatch::new() });
		inner.children.insert(record.identity.path.clone(), Arc::clone(&record));
		Ok(AdmittedChild { record })
	}

	fn release(&self, identity: &ChildIdentitySeed) {
		if let Ok(mut inner) = self.inner.lock()
			&& inner.reservations.remove(&identity.path)
		{
			inner
				.available_numbers
				.entry((identity.parent_path.clone(), identity.task_name.clone()))
				.or_default()
				.insert(identity.number);
		}
	}

	pub fn set_status(&self, path: &ChildPath, status: AgentStatus) -> Result<(), String> {
		let record = self.get_record(path).ok_or_else(|| "unknown child path".to_owned())?;
		record.status.publish(status);
		Ok(())
	}

	fn get_record(&self, path: &ChildPath) -> Option<Arc<AgentRecord>> {
		self.inner.lock().ok().and_then(|inner| inner.children.get(path).cloned())
	}
}
