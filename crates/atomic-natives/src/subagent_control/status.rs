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

impl From<LifecycleEvent> for super::AgentStatus {
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

/// A reduced lifecycle update. Termination causes are carried alongside the
/// six-state status rather than being represented as additional statuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatusUpdate {
	pub status: super::AgentStatus,
	pub cause: Option<super::TerminationCause>,
}

/// A watch channel carrying the reduced status and optional termination cause
/// for one child.
#[derive(Clone)]
pub struct StatusWatch {
	sender: tokio::sync::watch::Sender<StatusUpdate>,
}

impl Default for StatusWatch {
	fn default() -> Self {
		Self::new()
	}
}

impl StatusWatch {
	pub fn new() -> Self {
		let (sender, _receiver) = tokio::sync::watch::channel(StatusUpdate {
			status: super::AgentStatus::Pending,
			cause: None,
		});
		Self { sender }
	}

	pub fn current(&self) -> super::AgentStatus {
		self.sender.borrow().status
	}

	pub fn current_cause(&self) -> Option<super::TerminationCause> {
		self.sender.borrow().cause
	}

	pub fn current_update(&self) -> StatusUpdate {
		*self.sender.borrow()
	}

	pub fn subscribe(&self) -> tokio::sync::watch::Receiver<StatusUpdate> {
		self.sender.subscribe()
	}

	/// Publish a status without changing an already-recorded terminal cause.
	/// Non-terminal transitions clear a previous cause when a child is reused.
	pub fn publish(&self, status: super::AgentStatus) {
		let cause = if status.is_terminal() { self.current_cause() } else { None };
		self.publish_with_cause(status, cause);
	}

	pub fn publish_with_cause(
		&self,
		status: super::AgentStatus,
		cause: Option<super::TerminationCause>,
	) {
		self.sender.send_replace(StatusUpdate { status, cause });
	}

	pub fn reduce(&self, event: LifecycleEvent) -> super::AgentStatus {
		let status = super::AgentStatus::from(event);
		self.publish(status);
		status
	}
}
