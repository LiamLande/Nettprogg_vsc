use serde::{Deserialize, Serialize};

use crate::id::{ElementId, ParentId};

/// Wire-compatible CRDT operation tagged with the `type` discriminator used by
/// the TypeScript reference implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Operation {
    #[serde(rename = "insert")]
    Insert(InsertOp),

    #[serde(rename = "delete")]
    Delete(DeleteOp),
}

impl Operation {
    pub fn op_id(&self) -> &ElementId {
        match self {
            Operation::Insert(op) => &op.op_id,
            Operation::Delete(op) => &op.op_id,
        }
    }

    pub fn as_insert(&self) -> Option<&InsertOp> {
        match self {
            Operation::Insert(op) => Some(op),
            _ => None,
        }
    }

    pub fn as_delete(&self) -> Option<&DeleteOp> {
        match self {
            Operation::Delete(op) => Some(op),
            _ => None,
        }
    }
}

/// An insertion of a single character anchored to a parent element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertOp {
    pub op_id: ElementId,
    pub parent_id: ParentId,
    pub value: String,
}

/// A logical deletion of a previously inserted element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOp {
    pub op_id: ElementId,
    pub target_id: ElementId,
}

/// Status reported by [`crate::TextCrdt::apply_operation`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplyStatus {
    /// The operation was applied and any dependent pending operations drained.
    Applied,
    /// The operation was already seen; no state changed.
    Duplicate,
    /// The operation depends on something we have not received yet and was
    /// buffered until that dependency arrives.
    Queued,
}

/// Detailed report on how an [`Operation`] interacted with the CRDT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub status: ApplyStatus,
    pub op_id: String,
    /// Number of previously-buffered operations that became applicable after
    /// this operation was applied.
    pub drained: usize,
}

impl ApplyResult {
    pub fn new(status: ApplyStatus, op_id: String, drained: usize) -> Self {
        Self {
            status,
            op_id,
            drained,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_round_trips_through_json() {
        let op = Operation::Insert(InsertOp {
            op_id: ElementId::new(1, "A"),
            parent_id: ParentId::Root,
            value: "x".into(),
        });

        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"type\":\"insert\""));
        let back: Operation = serde_json::from_str(&json).unwrap();
        assert_eq!(back, op);
    }

    #[test]
    fn delete_round_trips_through_json() {
        let op = Operation::Delete(DeleteOp {
            op_id: ElementId::new(2, "B"),
            target_id: ElementId::new(1, "A"),
        });

        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"type\":\"delete\""));
        let back: Operation = serde_json::from_str(&json).unwrap();
        assert_eq!(back, op);
    }
}
