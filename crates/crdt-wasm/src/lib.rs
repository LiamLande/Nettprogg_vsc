//! WebAssembly bindings for [`crdt_core::TextCrdt`].
//!
//! Operations cross the JS/WASM boundary as JSON-compatible objects, keeping
//! the wire format identical to what the Rust relay server expects.

use crdt_core::{ApplyStatus, Operation, TextCrdt, TextCrdtSnapshot};
use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn _start() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// JavaScript-facing wrapper around [`crdt_core::TextCrdt`].
#[wasm_bindgen(js_name = TextCrdt)]
pub struct WasmTextCrdt {
    inner: TextCrdt,
}

#[wasm_bindgen(js_class = TextCrdt)]
impl WasmTextCrdt {
    /// Create a new CRDT for the given replica id.
    #[wasm_bindgen(constructor)]
    pub fn new(replica_id: &str) -> WasmTextCrdt {
        WasmTextCrdt {
            inner: TextCrdt::new(replica_id),
        }
    }

    /// Reconstructs a CRDT from a snapshot, adopting `replica_id` for future operations.
    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(snapshot: JsValue, replica_id: &str) -> Result<WasmTextCrdt, JsError> {
        let snapshot: TextCrdtSnapshot = from_value(snapshot).map_err(into_js_error)?;
        Ok(WasmTextCrdt {
            inner: TextCrdt::from_snapshot(&snapshot, replica_id),
        })
    }

    /// Returns this replica's id string.
    #[wasm_bindgen(js_name = getReplicaId)]
    pub fn replica_id(&self) -> String {
        self.inner.replica_id().to_string()
    }

    /// Returns the current visible document text.
    #[wasm_bindgen(js_name = toString)]
    pub fn to_text(&self) -> String {
        self.inner.to_text()
    }

    /// Number of operations buffered pending their dependency.
    #[wasm_bindgen(js_name = pendingCount)]
    pub fn pending_count(&self) -> usize {
        self.inner.pending_count()
    }

    /// Visible document length in Unicode scalar values.
    #[wasm_bindgen(js_name = visibleLength)]
    pub fn visible_length(&self) -> usize {
        self.inner.visible_length()
    }

    /// Inserts `text` at visible position `index`. Returns an array of insert operations.
    pub fn insert(&mut self, index: usize, text: &str) -> Result<JsValue, JsError> {
        let ops = self.inner.insert(index, text).map_err(into_js_error)?;
        let wrapped: Vec<Operation> = ops.into_iter().map(Operation::Insert).collect();
        to_value(&wrapped).map_err(into_js_error)
    }

    /// Tombstones `count` consecutive visible characters starting at `index`. Returns delete operations.
    pub fn delete(&mut self, index: usize, count: usize) -> Result<JsValue, JsError> {
        let ops = self.inner.delete(index, count).map_err(into_js_error)?;
        let wrapped: Vec<Operation> = ops.into_iter().map(Operation::Delete).collect();
        to_value(&wrapped).map_err(into_js_error)
    }

    /// Applies a remote operation. Returns `{ status, opId, drained }`.
    #[wasm_bindgen(js_name = applyOperation)]
    pub fn apply_operation(&mut self, operation: JsValue) -> Result<JsValue, JsError> {
        let op: Operation = from_value(operation).map_err(into_js_error)?;
        let result = self.inner.apply_operation(&op);
        let payload = serde_json::json!({
            "status": match result.status {
                ApplyStatus::Applied => "applied",
                ApplyStatus::Duplicate => "duplicate",
                ApplyStatus::Queued => "queued",
            },
            "opId": result.op_id,
            "drained": result.drained,
        });
        to_value(&payload).map_err(into_js_error)
    }

    /// Returns `true` if `operation` has already been applied or buffered.
    #[wasm_bindgen(js_name = hasSeen)]
    pub fn has_seen(&self, operation: JsValue) -> Result<bool, JsError> {
        let op: Operation = from_value(operation).map_err(into_js_error)?;
        Ok(self.inner.has_seen(&op))
    }

    /// Serialises the full replica state into a JS-compatible snapshot object.
    pub fn snapshot(&self) -> Result<JsValue, JsError> {
        to_value(&self.inner.snapshot()).map_err(into_js_error)
    }

    /// Returns the full internal CRDT state for the extension's debug command.
    #[wasm_bindgen(js_name = debugState)]
    pub fn debug_state(&self) -> Result<JsValue, JsError> {
        to_value(&self.inner.debug_state()).map_err(into_js_error)
    }
}

fn into_js_error<E: std::fmt::Display>(error: E) -> JsError {
    JsError::new(&error.to_string())
}
