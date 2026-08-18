//! Strict LF-only JSONL framing for Atomic RPC.
//!
//! Split records on `\n` only. Strip an optional trailing `\r`. Do not treat
//! Unicode separators as newlines: U+2028 and U+2029 are legal inside JSON
//! strings, and Node's `readline` is not protocol-compliant for that reason.

#[derive(Default)]
pub struct JsonlDecoder {
	buf: Vec<u8>,
}

impl JsonlDecoder {
	pub fn new() -> Self {
		Self::default()
	}

	/// Consume a byte chunk and return every complete frame.
	pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
		self.buf.extend_from_slice(chunk);
		let mut frames = Vec::new();
		while let Some(newline) = self.buf.iter().position(|&byte| byte == b'\n') {
			let mut frame: Vec<u8> = self.buf.drain(..=newline).collect();
			frame.pop();
			if frame.last() == Some(&b'\r') {
				frame.pop();
			}
			frames.push(String::from_utf8_lossy(&frame).into_owned());
		}
		frames
	}

	/// Return a trailing unterminated frame, if any.
	pub fn finish(&mut self) -> Option<String> {
		if self.buf.is_empty() {
			return None;
		}
		let mut frame = std::mem::take(&mut self.buf);
		if frame.last() == Some(&b'\r') {
			frame.pop();
		}
		Some(String::from_utf8_lossy(&frame).into_owned())
	}
}

pub fn serialize_json_line(value: &serde_json::Value) -> Result<Vec<u8>, serde_json::Error> {
	let mut bytes = serde_json::to_vec(value)?;
	bytes.push(b'\n');
	Ok(bytes)
}

#[cfg(test)]
mod tests {
	use super::JsonlDecoder;

	#[test]
	fn splits_on_lf_only() {
		let mut decoder = JsonlDecoder::new();
		let frames = decoder.push(b"{\"a\":1}\n{\"b\":2}\n");
		assert_eq!(frames, vec!["{\"a\":1}", "{\"b\":2}"]);
		assert!(decoder.finish().is_none());
	}

	#[test]
	fn strips_trailing_cr() {
		let mut decoder = JsonlDecoder::new();
		let frames = decoder.push(b"{\"a\":1}\r\n");
		assert_eq!(frames, vec!["{\"a\":1}"]);
	}

	#[test]
	fn does_not_split_on_unicode_line_separator() {
		let mut decoder = JsonlDecoder::new();
		// U+2028 encoded as UTF-8, then a real LF.
		let mut chunk = b"{\"text\":\"".to_vec();
		chunk.extend_from_slice("\u{2028}".as_bytes());
		chunk.extend_from_slice(b"inside\"}\n");
		let frames = decoder.push(&chunk);
		assert_eq!(frames.len(), 1);
		assert!(frames[0].contains('\u{2028}'));
	}

	#[test]
	fn holds_partial_frames_across_chunks() {
		let mut decoder = JsonlDecoder::new();
		assert!(decoder.push(b"{\"a\":").is_empty());
		assert_eq!(decoder.push(b"1}\n{\"b\":2"), vec!["{\"a\":1}"]);
		assert_eq!(decoder.finish().as_deref(), Some("{\"b\":2"));
	}

	#[test]
	fn finish_returns_none_when_empty() {
		let mut decoder = JsonlDecoder::new();
		assert!(decoder.finish().is_none());
	}
}
