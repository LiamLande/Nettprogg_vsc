use std::collections::BTreeSet;

use crate::operation::Operation;

/// Append-only log of every operation observed by a replica.
///
/// Backed by a [`Vec`] so the relay server can replay operations in arrival
/// order to late joiners. A separate [`BTreeSet`] of operation ids enforces
/// idempotency: duplicate operations are silently ignored.
#[derive(Debug, Clone, Default)]
pub struct OperationLog {
    operations: Vec<Operation>,
    seen: BTreeSet<String>,
}

impl OperationLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an operation to the log. Returns `true` if the operation was new
    /// and was appended, `false` if it was already in the log.
    pub fn append(&mut self, operation: Operation) -> bool {
        let key = operation.op_id().key();
        if !self.seen.insert(key) {
            return false;
        }
        self.operations.push(operation);
        true
    }

    pub fn contains(&self, operation: &Operation) -> bool {
        self.seen.contains(&operation.op_id().key())
    }

    pub fn all(&self) -> &[Operation] {
        &self.operations
    }

    pub fn cloned(&self) -> Vec<Operation> {
        self.operations.clone()
    }

    pub fn len(&self) -> usize {
        self.operations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ElementId, InsertOp, ParentId};

    fn insert(counter: u64, replica: &str, value: &str) -> Operation {
        Operation::Insert(InsertOp {
            op_id: ElementId::new(counter, replica),
            parent_id: ParentId::Root,
            value: value.to_string(),
        })
    }

    #[test]
    fn append_ignores_duplicates() {
        let mut log = OperationLog::new();
        assert!(log.append(insert(1, "A", "x")));
        assert!(!log.append(insert(1, "A", "x")));
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn append_preserves_arrival_order() {
        let mut log = OperationLog::new();
        log.append(insert(1, "A", "x"));
        log.append(insert(1, "B", "y"));
        log.append(insert(2, "A", "z"));
        let collected: Vec<_> = log.all().iter().map(|op| op.op_id().clone()).collect();
        assert_eq!(
            collected,
            vec![
                ElementId::new(1, "A"),
                ElementId::new(1, "B"),
                ElementId::new(2, "A"),
            ]
        );
    }
}
