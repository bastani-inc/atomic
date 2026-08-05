use std::{
	collections::{BTreeMap, BTreeSet, HashSet},
	sync::{Arc, Mutex},
};

use super::{
	AdmissionRefusal, AgentStatus, ChildIdentity, ChildPath, Depth, StatusUpdate, StatusWatch,
	validate_task_name,
};

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

impl ChildIdentitySeed {
	fn to_identity(&self, update: StatusUpdate, loaded: bool) -> ChildIdentity {
		ChildIdentity {
			path: self.path.to_string(),
			parent_path: self.parent_path.to_string(),
			task_name: self.task_name.clone(),
			depth: self.depth.value(),
			status: update.status,
			cause: update.cause,
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
					.map(|record| record.identity.to_identity(record.status.current_update(), false))
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

	pub fn set_status_with_cause(
		&self,
		path: &ChildPath,
		status: AgentStatus,
		cause: Option<super::TerminationCause>,
	) -> Result<(), String> {
		let record = self.get_record(path).ok_or_else(|| "unknown child path".to_owned())?;
		record.status.publish_with_cause(status, cause);
		Ok(())
	}

	fn get_record(&self, path: &ChildPath) -> Option<Arc<AgentRecord>> {
		self.inner.lock().ok().and_then(|inner| inner.children.get(path).cloned())
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReservationError {
	NotStarted,
	AlreadyStarted,
	ReservationMissing,
	IdentityAlreadyCommitted,
	RegistryUnavailable,
}

impl std::fmt::Display for ReservationError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(match self {
			Self::NotStarted => "spawn reservation has not started",
			Self::AlreadyStarted => "spawn reservation already started",
			Self::ReservationMissing => "spawn reservation is no longer available",
			Self::IdentityAlreadyCommitted => "child identity is already committed",
			Self::RegistryUnavailable => "child registry is unavailable",
		})
	}
}

/// A reservation that releases its identity slot unless it commits successfully.
pub struct SpawnReservation {
	registry: AgentRegistry,
	identity: ChildIdentitySeed,
	started: bool,
	committed: bool,
}

impl SpawnReservation {
	pub fn path(&self) -> &ChildPath {
		&self.identity.path
	}

	pub fn start(&mut self) -> Result<(), ReservationError> {
		if self.committed {
			return Err(ReservationError::ReservationMissing);
		}
		if self.started {
			return Err(ReservationError::AlreadyStarted);
		}
		self.started = true;
		Ok(())
	}

	pub fn commit(mut self) -> Result<AdmittedChild, ReservationError> {
		if !self.started {
			return Err(ReservationError::NotStarted);
		}
		let result = self.registry.commit(self.identity.clone());
		if result.is_ok() {
			self.committed = true;
		}
		result
	}
}

impl Drop for SpawnReservation {
	fn drop(&mut self) {
		if !self.committed {
			self.registry.release(&self.identity);
		}
	}
}

/// An identity minted by a committed spawn reservation.
#[derive(Clone)]
pub struct AdmittedChild {
	record: Arc<AgentRecord>,
}

impl AdmittedChild {
	pub fn path(&self) -> &ChildPath {
		&self.record.identity.path
	}

	pub fn parent_path(&self) -> &ChildPath {
		&self.record.identity.parent_path
	}

	pub fn task_name(&self) -> &str {
		&self.record.identity.task_name
	}

	pub fn depth(&self) -> Depth {
		self.record.identity.depth
	}

	pub fn status_watch(&self) -> StatusWatch {
		self.record.status.clone()
	}

	pub(crate) fn identity(&self, residency: super::Residency) -> ChildIdentity {
		let loaded = residency.is_loaded(self.path()).unwrap_or(false);
		self.record.identity.to_identity(self.status_watch().current_update(), loaded)
	}
}
