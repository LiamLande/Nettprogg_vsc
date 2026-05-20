use serde::{Deserialize, Serialize};

use crate::id::{ElementId, ParentId};
use crate::operation::{DeleteOp, InsertOp};

/// Persistent representation of a single character element. Used inside CRDT
/// snapshots that travel over the wire to bootstrap newly joining peers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharSnapshot {
    pub id: ElementId,
    pub value: String,
    pub parent_id: ParentId,
    pub deleted: bool,
}

/// Complete snapshot of a [`crate::TextCrdt`] including buffered operations.
///
/// Sent over P2P snapshots so a late joiner can rebuild the document without
/// replaying every individual operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCrdtSnapshot {
    pub replica_id: String,
    pub counter: u64,
    pub elements: Vec<CharSnapshot>,
    pub seen_op_ids: Vec<String>,
    pub pending_inserts: Vec<InsertOp>,
    pub pending_deletes: Vec<DeleteOp>,
}
