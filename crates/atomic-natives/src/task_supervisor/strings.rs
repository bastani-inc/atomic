//! S1-owned JavaScript code units. No JS handles or UTF-8 round trips enter actor state.
use napi::{
	bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, Utf16String, ValidateNapiValue},
	sys,
};

// napi-rs Utf16String supplies the supported lossless boundary, but not owned-record
// Clone/Eq/Ord/Hash. Keep those operations on code units, never its lossy Display impl.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsString(Vec<u16>);
impl From<&str> for JsString {
	fn from(value: &str) -> Self {
		Self(value.encode_utf16().collect())
	}
}
impl From<String> for JsString {
	fn from(value: String) -> Self {
		Self::from(value.as_str())
	}
}
impl JsString {
	/// OS execution converts only at the process boundary; replay keeps original code units.
	pub(crate) fn process_text(&self) -> String {
		String::from_utf16_lossy(&self.0)
	}
	#[cfg(windows)]
	pub(crate) fn process_wide(&self) -> &[u16] {
		&self.0
	}
	pub(super) fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
	pub(super) fn equals_str(&self, value: &str) -> bool {
		self.0.iter().copied().eq(value.encode_utf16())
	}
	pub(super) fn parse_u64(&self) -> Option<u64> {
		String::from_utf16(&self.0).ok()?.parse().ok()
	}
	/// The ordinal of a canonical `{prefix}{ordinal}` id: decimal digits without a sign or leading zero.
	pub(super) fn canonical_ordinal(&self, prefix: &str) -> Option<usize> {
		let text = String::from_utf16(&self.0).ok()?;
		let digits = text.strip_prefix(prefix)?;
		let ordinal = digits.parse::<usize>().ok()?;
		(ordinal.to_string() == digits).then_some(ordinal)
	}
	// Match str::lines and Unicode trim's blank-line predicate, but copy the original
	// line's units. Lone surrogates are non-whitespace; CR is removed only before LF.
	pub(super) fn first_nonblank_line(&self) -> Option<Self> {
		self.0.split_inclusive(|unit| *unit == 10).find_map(|line| {
			let line = if let Some(line) = line.strip_suffix(&[10]) {
				line.strip_suffix(&[13]).unwrap_or(line)
			} else {
				line
			};
			line
				.iter()
				.any(|unit| !char::from_u32(u32::from(*unit)).is_some_and(char::is_whitespace))
				.then(|| Self(line.to_vec()))
		})
	}
}
impl std::fmt::Debug for JsString {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "\"")?;
		for character in char::decode_utf16(self.0.iter().copied()) {
			match character {
				Ok(character) => write!(f, "{}", character.escape_debug())?,
				Err(error) => write!(f, "\\u{{{:04x}}}", error.unpaired_surrogate())?,
			}
		}
		write!(f, "\"")
	}
}
impl TypeName for JsString {
	fn type_name() -> &'static str {
		Utf16String::type_name()
	}
	fn value_type() -> napi::ValueType {
		napi::ValueType::String
	}
}
impl ValidateNapiValue for JsString {}
impl FromNapiValue for JsString {
	unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
		// SAFETY: forward the current environment/value to napi-rs, then retain only units.
		let value = unsafe { Utf16String::from_napi_value(env, value)? };
		Ok(Self(value.to_vec()))
	}
}
impl ToNapiValue for JsString {
	unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> napi::Result<sys::napi_value> {
		// SAFETY: napi-rs copies the owned units into an ordinary string in this environment.
		unsafe { Utf16String::to_napi_value(env, value.0.into()) }
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::task_supervisor::*;
	use std::collections::{BTreeSet, HashSet};

	// RFC #2884: equality, ordering and hashing must distinguish every original code unit.
	#[test]
	fn all_code_units_have_distinct_owned_identity() {
		let strings: Vec<_> = (0..=u16::MAX).map(|unit| JsString(vec![unit])).collect();
		assert_eq!(strings.iter().cloned().collect::<HashSet<_>>().len(), 65_536);
		assert_eq!(
			strings.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>(),
			strings
		);
		assert_ne!(JsString(vec![0xd800]), JsString::from("\u{fffd}"));
		assert_ne!(JsString(vec![0xdfff]), JsString::from("\u{fffd}"));
		assert_eq!(JsString(vec![0xd83d, 0xde00]), JsString::from("😀"));
		assert_ne!(JsString(vec![0]), JsString::from(""));
	}

	#[test]
	fn title_selection_preserves_raw_units_and_existing_unicode_line_rules() {
		for input in [
			"",
			"\r",
			" \n",
			"\u{2003}\r\n raw 😀 \r\nignored",
			"x\r",
			"\n\n",
			"\u{85}\nnext",
			"\u{feff}\nnext",
			"a\0b",
		] {
			assert_eq!(
				JsString::from(input).first_nonblank_line(),
				input.lines().find(|line| !line.trim().is_empty()).map(JsString::from)
			);
		}
		let raw = JsString(vec![0x2003, 13, 10, 32, 0xd800, 0, 0xdfff, 32, 13, 10]);
		assert_eq!(raw.first_nonblank_line(), Some(JsString(vec![32, 0xd800, 0, 0xdfff, 32])));
		let before = raw.clone();
		assert!(format!("{raw:?}").contains("\\u{d800}"));
		assert_eq!(raw, before, "diagnostics never change owned code units");
	}

	#[test]
	fn raw_actor_scope_intent_report_and_terminal_replay_remain_distinct() {
		let actor = Actor::new();
		let raw = JsString(vec![0xd800, 0, 0xdfff]);
		let replacement = JsString::from("\u{fffd}\0\u{fffd}");
		let scope = OwnerScope::Session { session_id: raw.clone() };
		let host = actor.bind(scope.clone());
		assert_eq!(
			actor
				.open(&host, OwnerScope::Session { session_id: replacement.clone() })
				.unwrap_err()
				.code,
			"ScopeMismatch"
		);
		let owner = actor.open(&host, scope.clone()).unwrap();
		let intent = AgentIntent {
			kind: AgentTaskKind::Agent,
			agent: raw.clone(),
			task: raw.clone(),
			description: None,
			cwd: Some(raw.clone()),
			parent_task_id: None,
		};
		let task = actor.start(&owner, intent.clone(), raw.clone()).unwrap();
		assert_eq!(actor.start(&owner, intent.clone(), raw.clone()).unwrap().cap, task.cap);
		assert_ne!(actor.start(&owner, intent.clone(), replacement.clone()).unwrap().cap, task.cap);
		assert_eq!(
			actor
				.start(&owner, AgentIntent { task: replacement.clone(), ..intent }, raw.clone())
				.unwrap_err()
				.code,
			"OperationConflict"
		);
		let runner = actor.claim(&task).unwrap();
		let report = ActivityReport {
			report_id: raw.clone(),
			change: ActivityChange::Action { tool: raw.clone(), text: raw.clone() },
		};
		actor.activity(&runner, report.clone()).unwrap();
		assert_eq!(actor.activity(&runner, report.clone()).unwrap().disposition, "duplicate");
		assert_eq!(
			actor
				.activity(&runner, ActivityReport { report_id: replacement.clone(), ..report.clone() })
				.unwrap()
				.disposition,
			"accepted"
		);
		assert_eq!(
			actor
				.activity(
					&runner,
					ActivityReport {
						change: ActivityChange::Action { tool: raw.clone(), text: replacement },
						..report
					}
				)
				.unwrap_err()
				.code,
			"ReportConflict"
		);
		let terminal = OutcomeReport {
			report_id: "terminal".into(),
			result: TaskResult::Failed {
				code: raw.clone(),
				message: raw.clone(),
				output: None,
				exit_code: None,
			},
		};
		let receipt = actor.outcome(&runner, terminal.clone()).unwrap();
		assert_eq!(actor.outcome(&runner, terminal).unwrap(), receipt);
		let snapshot = actor.snapshot(&owner).unwrap();
		assert_eq!(snapshot.scope, scope);
		assert_eq!(snapshot.tasks[0].title, raw);
		assert_eq!(snapshot.tasks[0].execution, Execution::Settled { result: receipt.result });
	}
}
