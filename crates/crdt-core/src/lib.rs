//! Operation-based RGA-inspired text CRDT used by LiveShare Lite.
//!
//! The crate is pure: it has no I/O, no networking, and no async runtime.
//! Servers and the WebAssembly bridge depend on it and provide their own
//! transports.
//!
//! ## Model
//!
//! Each replica owns a strictly increasing counter and a stable replica id.
//! An [`ElementId`] is the pair `(counter, replica_id)` and uniquely identifies
//! every character ever inserted, even after deletion. Characters are stored
//! in a tree rooted at [`ParentId::Root`]. Siblings under the same parent are
//! ordered deterministically by descending `(counter, replica_id)` so all
//! replicas converge to the same visible text.
//!
//! Inserts reference the previous element (or [`ParentId::Root`] for the
//! beginning of the document). Deletes simply mark the target element as a
//! tombstone. Duplicate operations are detected by their unique [`ElementId`]
//! and are no-ops, which means the CRDT is idempotent under arbitrary
//! redelivery.
//!
//! Operations with missing dependencies are buffered until the dependency
//! arrives. This makes the CRDT robust against out-of-order delivery without
//! requiring causal broadcast.

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
