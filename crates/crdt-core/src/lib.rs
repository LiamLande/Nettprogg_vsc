//! RGA-inspired operation-based text CRDT used by LiveShare Lite.
//!
//! The crate is pure — no I/O, no networking, no async. Servers and the
//! WebAssembly bridge each depend on it and supply their own transports.
//!
//! ## Data model
//!
//! Every inserted character gets a globally unique [`ElementId`] composed of
//! a stable replica id and a per-replica monotonic counter. Characters form a
//! tree rooted at [`ParentId::Root`]; siblings under the same parent are sorted
//! by descending `(counter, replica_id)`, giving every replica the same
//! deterministic order.
//!
//! Deletions set a tombstone flag rather than removing the element, so other
//! replicas can still use the element as an insertion anchor. Duplicate
//! operations are detected by id and ignored. Operations that reference a
//! parent or target not yet received are buffered and applied automatically
//! once the dependency arrives.

pub mod error;
pub mod id;
pub mod operation;
pub mod operation_log;
pub mod snapshot;
pub mod text_crdt;
pub mod version_vector;

pub use error::{ApplyError, CrdtError};
pub use id::{ElementId, ParentId};
pub use operation::{ApplyResult, ApplyStatus, DeleteOp, InsertOp, Operation};
pub use operation_log::OperationLog;
pub use snapshot::{CharSnapshot, TextCrdtSnapshot};
pub use text_crdt::TextCrdt;
pub use version_vector::VersionVector;
