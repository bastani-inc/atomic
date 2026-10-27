use super::*;
use sha2::{Digest, Sha256};

const INPUT_BYTE_CREDITS: usize = 65_536;

#[napi]
#[derive(Clone)]
pub struct StdinLease {
	pub(super) cap: Cap,
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
pub enum InputData {
	Bytes { bytes: napi::bindgen_prelude::Buffer },
	Eof {},
}
#[napi(object)]
#[derive(Clone)]
pub struct InputReceipt {
	#[napi(ts_type = "string")]
	pub operation_id: JsString,
	pub accepted_bytes: u32,
	pub kind: String,
}
#[napi(object)]
pub struct OutputRange {
	pub start: String,
	pub maximum_bytes: u32,
}
struct InputOperation {
	hash: [u8; 32],
	bytes: Vec<u8>,
	offset: usize,
	eof: bool,
	result: Option<Door<InputReceipt>>,
}
#[derive(Default)]
pub(super) struct InputQueue {
	operations: BTreeMap<JsString, InputOperation>,
	pending: VecDeque<JsString>,
	credits: usize,
	closed: bool,
	/// Set only by supervisor cleanup; caller EOF leaves it false.
	terminal: bool,
}
impl InputQueue {
	fn admit(&mut self, operation: &JsString, data: InputData) -> Door<()> {
		let (bytes, eof) = match data {
			InputData::Bytes { bytes } => (bytes.to_vec(), false),
			InputData::Eof {} => (vec![], true),
		};
		let mut hash = Sha256::new();
		hash.update([u8::from(eof)]);
		hash.update(&bytes);
		let hash: [u8; 32] = hash.finalize().into();
		if let Some(existing) = self.operations.get(operation) {
			return if existing.hash == hash { Ok(()) } else { Err(fail("OperationConflict")) };
		}
		if self.terminal {
			return Err(fail("TaskTerminal"));
		}
		if self.closed {
			return Err(fail("StdinClosed"));
		}
		if bytes.len() > INPUT_BYTE_CREDITS.saturating_sub(self.credits) {
			return Err(fail("InputBackpressure"));
		}
		self.credits += bytes.len();
		self
			.operations
			.insert(operation.clone(), InputOperation { hash, bytes, offset: 0, eof, result: None });
		self.pending.push_back(operation.clone());
		if eof {
			self.closed = true;
		}
		Ok(())
	}
	pub(super) fn drain(&mut self, writer: &mut Option<impl Write>) {
		let Some(id) = self.pending.front().cloned() else {
			return;
		};
		let op = self.operations.get_mut(&id).unwrap();
		let result = if op.eof {
			writer.take();
			Some(Ok(InputReceipt { operation_id: id.clone(), accepted_bytes: 0, kind: "eof".into() }))
		} else if op.bytes.is_empty() {
			Some(Ok(InputReceipt {
				operation_id: id.clone(),
				accepted_bytes: 0,
				kind: "bytes".into(),
			}))
		} else if let Some(writer) = writer.as_mut() {
			match writer.write(&op.bytes[op.offset..]) {
				Ok(0) => Some(Err(fail("InputDeliveryUnknown"))),
				Ok(count) => {
					op.offset += count;
					(op.offset == op.bytes.len()).then(|| {
						Ok(InputReceipt {
							operation_id: id.clone(),
							accepted_bytes: op.offset as u32,
							kind: "bytes".into(),
						})
					})
				},
				Err(error)
					if matches!(
						error.kind(),
						io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
					) =>
				{
					None
				},
				Err(_) => Some(Err(fail("InputDeliveryUnknown"))),
			}
		} else {
			Some(Err(fail("InputDeliveryUnknown")))
		};
		if let Some(mut result) = result {
			if let Err(error) = &mut result {
				error.message =
					format!("operationId={}; acceptedBytes={}", id.process_text(), op.offset);
			}
			self.credits -= op.bytes.len();
			op.bytes.clear();
			op.result = Some(result);
			self.pending.pop_front();
		}
	}
	pub(super) fn close(&mut self) {
		self.closed = true;
		self.terminal = true;
		for id in self.pending.drain(..) {
			let op = self.operations.get_mut(&id).unwrap();
			op.result = Some(Err(TaskFailure {
				code: "InputDeliveryUnknown".into(),
				message: format!("operationId={}; acceptedBytes={}", id.process_text(), op.offset),
			}));
			op.bytes.clear();
		}
		self.credits = 0;
	}
}
impl Actor {
	pub(in crate::task_supervisor) fn resize_command(
		&self,
		task: &TaskLease,
		columns: u16,
		rows: u16,
	) -> Door<()> {
		let command = self.command_resource(task)?;
		if command.finished.load(Ordering::Acquire) {
			return Err(fail("TaskTerminal"));
		}
		if !matches!(command.intent.terminal, CommandTerminal::Pty { .. }) {
			return Err(fail("OutputUnavailable"));
		}
		#[cfg(windows)]
		super::windows_pty::dimensions(columns, rows).map_err(|error| TaskFailure {
			code: "OutputUnavailable".into(),
			message: error.to_string(),
		})?;
		*command.resize.lock().unwrap() = Some((columns, rows));
		Ok(())
	}
	pub(in crate::task_supervisor) fn process_group(&self, task: &TaskLease) -> Door<Option<i32>> {
		let command = self.command_resource(task)?;
		#[cfg(unix)]
		{
			let group = command.process_group.load(Ordering::Acquire);
			Ok((group > 0).then_some(group))
		}
		#[cfg(not(unix))]
		{
			let _ = command;
			Ok(None)
		}
	}
	pub(super) fn command_resource(&self, task: &TaskLease) -> Door<Arc<CommandTask>> {
		let state = self.state.lock().unwrap();
		let (oi, ti) = state.task(self.id, &task.cap, "UnknownTask")?;
		state.owners[oi].tasks[ti].command.clone().ok_or_else(|| fail("OutputUnavailable"))
	}
	pub(in crate::task_supervisor) fn stdin_lease(&self, task: &TaskLease) -> Door<StdinLease> {
		let command = self.command_resource(task)?;
		if command.finished.load(Ordering::Acquire) || command.input.lock().unwrap().terminal {
			return Err(fail("TaskTerminal"));
		}
		if command.input.lock().unwrap().closed {
			return Err(fail("StdinClosed"));
		}
		Ok(StdinLease { cap: task.cap.clone() })
	}
	pub(in crate::task_supervisor) fn input(
		&self,
		input: &StdinLease,
		operation: JsString,
		data: InputData,
	) -> Door<InputReceipt> {
		let command = self.command_resource(&TaskLease { cap: input.cap.clone() })?;
		{
			let mut queue = command.input.lock().unwrap();
			if command.finished.load(Ordering::Acquire) && !queue.operations.contains_key(&operation) {
				return Err(fail("TaskTerminal"));
			}
			queue.admit(&operation, data)?;
		}
		loop {
			if let Some(result) = command.input.lock().unwrap().operations[&operation].result.clone() {
				return result;
			}
			std::thread::sleep(PROCESS_POLL);
		}
	}
	pub(in crate::task_supervisor) fn output_page(
		&self,
		task: &TaskLease,
		range: OutputRange,
	) -> Door<OutputPage> {
		let resource = self.command_resource(task)?;
		let start = range.start.parse::<u64>().map_err(|_| fail("OutputUnavailable"))?;
		let mut store = resource.output.lock().unwrap();
		let mut page = store.page(start, range.maximum_bytes.into());
		page.requested.start = range.start;
		Ok(page)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	struct PartialWriter {
		writes: usize,
	}
	impl Write for PartialWriter {
		fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
			self.writes += 1;
			if self.writes == 1 {
				Ok(bytes.len().min(2))
			} else {
				Err(io::ErrorKind::BrokenPipe.into())
			}
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	// RFC #2884: ambiguous partial writes are never blindly replayed.
	#[test]
	fn partial_delivery_keeps_unknown_receipt_and_never_resends() {
		let mut queue = InputQueue::default();
		let data = || InputData::Bytes { bytes: b"hello".to_vec().into() };
		queue.admit(&"operation".into(), data()).unwrap();
		let mut writer = Some(PartialWriter { writes: 0 });
		queue.drain(&mut writer);
		queue.drain(&mut writer);
		let error = queue.operations[&JsString::from("operation")]
			.result
			.as_ref()
			.unwrap()
			.as_ref()
			.err()
			.unwrap();
		assert_eq!(error.code, "InputDeliveryUnknown");
		assert_eq!(error.message, "operationId=operation; acceptedBytes=2");
		queue.admit(&"operation".into(), data()).unwrap();
		queue.drain(&mut writer);
		assert_eq!(writer.unwrap().writes, 2);
		assert_eq!(queue.credits, 0);
	}
	#[test]
	fn byte_credits_refuse_before_queue_admission() {
		let mut queue = InputQueue::default();
		queue
			.admit(&"full".into(), InputData::Bytes { bytes: vec![0; INPUT_BYTE_CREDITS].into() })
			.unwrap();
		assert_eq!(
			queue.admit(&"extra".into(), InputData::Bytes { bytes: vec![1].into() }).unwrap_err().code,
			"InputBackpressure"
		);
		assert!(!queue.operations.contains_key(&JsString::from("extra")));
		queue.close();
		assert_eq!(queue.credits, 0);
	}
	// A write admitted after supervisor cleanup closed stdin, but before the runner
	// publishes `finished`, races task termination; it must not look like caller EOF.
	#[test]
	fn supervisor_close_refuses_late_writes_as_task_terminal() {
		let mut queue = InputQueue::default();
		queue.close();
		let late = InputData::Bytes { bytes: vec![1].into() };
		assert_eq!(queue.admit(&"late".into(), late).unwrap_err().code, "TaskTerminal");
		let mut eof = InputQueue::default();
		eof.admit(&"eof".into(), InputData::Eof {}).unwrap();
		let after = InputData::Bytes { bytes: vec![1].into() };
		assert_eq!(eof.admit(&"after".into(), after).unwrap_err().code, "StdinClosed");
	}
}
