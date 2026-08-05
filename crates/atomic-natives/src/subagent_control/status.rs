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

/// A watch channel carrying the reduced status for one child.
#[derive(Clone)]
pub struct StatusWatch {
	sender: tokio::sync::watch::Sender<super::AgentStatus>,
}

impl Default for StatusWatch {
	fn default() -> Self {
		Self::new()
	}
}

impl StatusWatch {
	pub fn new() -> Self {
		let (sender, _receiver) = tokio::sync::watch::channel(super::AgentStatus::Pending);
		Self { sender }
	}

	pub fn current(&self) -> super::AgentStatus {
		*self.sender.borrow()
	}

	pub fn subscribe(&self) -> tokio::sync::watch::Receiver<super::AgentStatus> {
		self.sender.subscribe()
	}

	pub fn publish(&self, status: super::AgentStatus) {
		self.sender.send_replace(status);
	}

	pub fn reduce(&self, event: LifecycleEvent) -> super::AgentStatus {
		let status = super::AgentStatus::from(event);
		self.publish(status);
		status
	}
}
