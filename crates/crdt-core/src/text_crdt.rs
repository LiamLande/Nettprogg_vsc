use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::error::ApplyError;
use crate::id::{compare_element_id_descending, ElementId, ParentId};
use crate::operation::{ApplyResult, ApplyStatus, DeleteOp, InsertOp, Operation};
use crate::snapshot::{CharSnapshot, TextCrdtSnapshot};

/// Internal tree node. Mirrors the TypeScript `CharElement` shape.
#[derive(Debug, Clone)]
struct CharElement {
    id: ElementId,
    value: String,
    parent_id: ParentId,
    deleted: bool,
}

/// RGA-inspired text CRDT.
///
/// Each inserted character becomes a tree node with a unique [`ElementId`].
/// Nodes reference their left neighbour as a parent; siblings under the same
/// parent are sorted by descending `(counter, replica_id)` so concurrent
/// inserts at the same position always resolve to the same order on every
/// replica. Deletions tombstone a node rather than removing it.
///
/// Duplicate operations are silently dropped. Operations whose parent or
/// target has not yet arrived are buffered and applied automatically once
/// the dependency is received.
///
/// ## Index units
///
/// [`insert`](TextCrdt::insert) and [`delete`](TextCrdt::delete) count
/// positions in Unicode scalar values (`char`). For ASCII and Basic
/// Multilingual Plane text this matches the UTF-16 offsets VS Code reports.
/// Non-BMP characters (emoji, etc.) occupy two UTF-16 code units but one
/// `char`, which is a known limitation.
#[derive(Debug, Clone)]
pub struct TextCrdt {
    replica_id: String,
    counter: u64,
    elements: HashMap<String, CharElement>,
    children: HashMap<String, Vec<ElementId>>,
    seen_op_ids: HashSet<String>,
    pending_inserts: HashMap<String, InsertOp>,
    pending_deletes: HashMap<String, DeleteOp>,
}

impl TextCrdt {
    /// Create a new, empty CRDT for the given replica id.
    pub fn new(replica_id: impl Into<String>) -> Self {
        let mut children = HashMap::new();
        children.insert(ROOT_KEY.into(), Vec::new());

        Self {
            replica_id: replica_id.into(),
            counter: 0,
            elements: HashMap::new(),
            children,
            seen_op_ids: HashSet::new(),
            pending_inserts: HashMap::new(),
            pending_deletes: HashMap::new(),
        }
    }

    pub fn replica_id(&self) -> &str {
        &self.replica_id
    }

    pub fn counter(&self) -> u64 {
        self.counter
    }

    /// Allocates and returns the next [`ElementId`] for this replica.
    pub fn next_operation_id(&mut self) -> ElementId {
        self.counter += 1;
        ElementId::new(self.counter, self.replica_id.clone())
    }

    // -------------------------------------------------------------------------
    // Local edits
    // -------------------------------------------------------------------------

    /// Inserts `text` at visible position `index`.
    ///
    /// Returns one [`InsertOp`] per character, each anchored to its left
    /// neighbour. All operations are applied to the local replica immediately.
    pub fn insert(&mut self, index: usize, text: &str) -> Result<Vec<InsertOp>, ApplyError> {
        let visible = self.visible_elements();
        if index > visible.len() {
            return Err(ApplyError::OutOfRange {
                index,
                length: visible.len(),
            });
        }

        let mut parent_id = if index == 0 {
            ParentId::Root
        } else {
            ParentId::Element(visible[index - 1].id.clone())
        };

        let mut ops = Vec::with_capacity(text.chars().count());
        for ch in text.chars() {
            let op_id = self.next_operation_id();
            let op = InsertOp {
                op_id: op_id.clone(),
                parent_id: parent_id.clone(),
                value: ch.to_string(),
            };
            self.record_seen(&op_id);
            self.apply_insert_inner(&op);
            parent_id = ParentId::Element(op_id);
            ops.push(op);
        }
        Ok(ops)
    }

    /// Tombstones `count` consecutive visible characters starting at `index`.
    ///
    /// Returns one [`DeleteOp`] per character.
    pub fn delete(&mut self, index: usize, count: usize) -> Result<Vec<DeleteOp>, ApplyError> {
        let visible = self.visible_elements();
        let length = visible.len();

        if index.saturating_add(count) > length {
            return Err(ApplyError::OutOfRange { index, length });
        }

        let mut ops = Vec::with_capacity(count);
        for element in visible.into_iter().skip(index).take(count) {
            let op_id = self.next_operation_id();
            let op = DeleteOp {
                op_id: op_id.clone(),
                target_id: element.id.clone(),
            };
            self.record_seen(&op_id);
            self.apply_delete_inner(&op);
            ops.push(op);
        }
        Ok(ops)
    }

    // -------------------------------------------------------------------------
    // Remote operations
    // -------------------------------------------------------------------------

    /// Applies a remote operation to this replica.
    ///
    /// Idempotent — duplicate operations are detected by id and skipped.
    /// Operations whose dependency is not yet present are buffered and applied
    /// automatically when that dependency arrives.
    pub fn apply_operation(&mut self, operation: &Operation) -> ApplyResult {
        let op_key = operation.op_id().key();
        if self.seen_op_ids.contains(&op_key) {
            return ApplyResult::new(ApplyStatus::Duplicate, op_key, 0);
        }

        // Mark seen before queuing so a redelivery of the same op is dropped.
        self.seen_op_ids.insert(op_key.clone());

        match operation {
            Operation::Insert(insert) => {
                if !self.has_parent(&insert.parent_id) {
                    self.pending_inserts.insert(op_key.clone(), insert.clone());
                    return ApplyResult::new(ApplyStatus::Queued, op_key, 0);
                }
                self.apply_insert_inner(insert);
                let drained = self.drain_pending();
                ApplyResult::new(ApplyStatus::Applied, op_key, drained)
            }
            Operation::Delete(delete) => {
                if !self.elements.contains_key(&delete.target_id.key()) {
                    self.pending_deletes.insert(op_key.clone(), delete.clone());
                    return ApplyResult::new(ApplyStatus::Queued, op_key, 0);
                }
                self.apply_delete_inner(delete);
                let drained = self.drain_pending();
                ApplyResult::new(ApplyStatus::Applied, op_key, drained)
            }
        }
    }

    /// Returns `true` if `operation` has already been applied or buffered.
    pub fn has_seen(&self, operation: &Operation) -> bool {
        self.seen_op_ids.contains(&operation.op_id().key())
    }

    pub fn pending_count(&self) -> usize {
        self.pending_inserts.len() + self.pending_deletes.len()
    }

    // -------------------------------------------------------------------------
    // Read-only views
    // -------------------------------------------------------------------------

    /// Returns the current visible document as a `String`.
    pub fn to_text(&self) -> String {
        self.visible_elements()
            .into_iter()
            .map(|element| element.value)
            .collect()
    }

    pub fn visible_length(&self) -> usize {
        self.visible_elements().len()
    }

    pub fn id_at_visible_index(&self, index: usize) -> Option<ElementId> {
        self.visible_elements().into_iter().nth(index).map(|c| c.id)
    }

    /// Full internal state for diagnostics (used by the extension's debug command).
    pub fn debug_state(&self) -> DebugState {
        let snapshot = self.snapshot();
        DebugState {
            replica_id: self.replica_id.clone(),
            counter: self.counter,
            text: self.to_text(),
            elements: snapshot.elements,
            seen_op_ids: snapshot.seen_op_ids,
            pending_inserts: snapshot.pending_inserts,
            pending_deletes: snapshot.pending_deletes,
        }
    }

    // -------------------------------------------------------------------------
    // Snapshot support
    // -------------------------------------------------------------------------

    /// Serialises the full replica state into a [`TextCrdtSnapshot`].
    pub fn snapshot(&self) -> TextCrdtSnapshot {
        let mut elements: Vec<CharSnapshot> = self
            .elements
            .values()
            .map(|element| CharSnapshot {
                id: element.id.clone(),
                value: element.value.clone(),
                parent_id: element.parent_id.clone(),
                deleted: element.deleted,
            })
            .collect();
        elements.sort_by(|a, b| a.id.cmp(&b.id));

        let mut seen: Vec<String> = self.seen_op_ids.iter().cloned().collect();
        seen.sort();

        let mut pending_inserts: Vec<InsertOp> = self.pending_inserts.values().cloned().collect();
        pending_inserts.sort_by(|a, b| a.op_id.cmp(&b.op_id));

        let mut pending_deletes: Vec<DeleteOp> = self.pending_deletes.values().cloned().collect();
        pending_deletes.sort_by(|a, b| a.op_id.cmp(&b.op_id));

        TextCrdtSnapshot {
            replica_id: self.replica_id.clone(),
            counter: self.counter,
            elements,
            seen_op_ids: seen,
            pending_inserts,
            pending_deletes,
        }
    }

    /// Reconstructs a CRDT from a snapshot.
    ///
    /// The resulting replica uses `replica_id` for future operations and
    /// inherits all elements and operation history from `snapshot`.
    pub fn from_snapshot(snapshot: &TextCrdtSnapshot, replica_id: impl Into<String>) -> Self {
        let replica_id = replica_id.into();
        let mut crdt = TextCrdt::new(replica_id.clone());
        crdt.counter = max_counter_for_replica(snapshot, &replica_id);

        for element in &snapshot.elements {
            let key = element.id.key();
            crdt.elements.insert(
                key,
                CharElement {
                    id: element.id.clone(),
                    value: element.value.clone(),
                    parent_id: element.parent_id.clone(),
                    deleted: element.deleted,
                },
            );
        }

        crdt.rebuild_children();

        for op_id in &snapshot.seen_op_ids {
            crdt.seen_op_ids.insert(op_id.clone());
        }
        for op in &snapshot.pending_inserts {
            crdt.pending_inserts.insert(op.op_id.key(), op.clone());
        }
        for op in &snapshot.pending_deletes {
            crdt.pending_deletes.insert(op.op_id.key(), op.clone());
        }

        crdt
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    fn record_seen(&mut self, op_id: &ElementId) {
        self.seen_op_ids.insert(op_id.key());
    }

    fn apply_insert_inner(&mut self, op: &InsertOp) {
        let op_key = op.op_id.key();
        if self.elements.contains_key(&op_key) {
            return;
        }

        self.elements.insert(
            op_key.clone(),
            CharElement {
                id: op.op_id.clone(),
                value: op.value.clone(),
                parent_id: op.parent_id.clone(),
                deleted: false,
            },
        );

        let parent_key = op.parent_id.key();
        let siblings = self.children.entry(parent_key).or_default();
        siblings.push(op.op_id.clone());
        siblings.sort_by(compare_element_id_descending);
        self.children.entry(op_key).or_default();

        if op.op_id.replica_id == self.replica_id && op.op_id.counter > self.counter {
            self.counter = op.op_id.counter;
        }
    }

    fn apply_delete_inner(&mut self, op: &DeleteOp) {
        if let Some(element) = self.elements.get_mut(&op.target_id.key()) {
            element.deleted = true;
        }
        if op.op_id.replica_id == self.replica_id && op.op_id.counter > self.counter {
            self.counter = op.op_id.counter;
        }
    }

    fn drain_pending(&mut self) -> usize {
        let mut drained = 0;
        let mut progressed = true;
        while progressed {
            progressed = false;

            let ready_inserts: Vec<String> = self
                .pending_inserts
                .iter()
                .filter(|(_, op)| self.has_parent(&op.parent_id))
                .map(|(key, _)| key.clone())
                .collect();
            for key in ready_inserts {
                if let Some(op) = self.pending_inserts.remove(&key) {
                    self.apply_insert_inner(&op);
                    drained += 1;
                    progressed = true;
                }
            }

            let ready_deletes: Vec<String> = self
                .pending_deletes
                .iter()
                .filter(|(_, op)| self.elements.contains_key(&op.target_id.key()))
                .map(|(key, _)| key.clone())
                .collect();
            for key in ready_deletes {
                if let Some(op) = self.pending_deletes.remove(&key) {
                    self.apply_delete_inner(&op);
                    drained += 1;
                    progressed = true;
                }
            }
        }
        drained
    }

    fn has_parent(&self, parent_id: &ParentId) -> bool {
        match parent_id {
            ParentId::Root => true,
            ParentId::Element(id) => self.elements.contains_key(&id.key()),
        }
    }

    fn rebuild_children(&mut self) {
        self.children.clear();
        self.children.insert(ROOT_KEY.into(), Vec::new());

        let entries: Vec<(String, ElementId, ParentId)> = self
            .elements
            .values()
            .map(|element| (element.id.key(), element.id.clone(), element.parent_id.clone()))
            .collect();

        for (own_key, id, parent_id) in entries {
            self.children
                .entry(parent_id.key())
                .or_default()
                .push(id.clone());
            self.children.entry(own_key).or_default();
        }

        for siblings in self.children.values_mut() {
            siblings.sort_by(compare_element_id_descending);
        }
    }

    fn visible_elements(&self) -> Vec<CharElement> {
        let mut output = Vec::new();
        let root = self.children.get(ROOT_KEY).cloned().unwrap_or_default();
        let mut stack: Vec<ElementId> = root.into_iter().rev().collect();

        while let Some(id) = stack.pop() {
            if let Some(element) = self.elements.get(&id.key()) {
                if !element.deleted {
                    output.push(element.clone());
                }
                if let Some(grandchildren) = self.children.get(&id.key()) {
                    for child in grandchildren.iter().rev() {
                        stack.push(child.clone());
                    }
                }
            }
        }
        output
    }
}

const ROOT_KEY: &str = "ROOT";

/// Diagnostic snapshot returned by [`TextCrdt::debug_state`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugState {
    pub replica_id: String,
    pub counter: u64,
    pub text: String,
    pub elements: Vec<CharSnapshot>,
    pub seen_op_ids: Vec<String>,
    pub pending_inserts: Vec<InsertOp>,
    pub pending_deletes: Vec<DeleteOp>,
}

fn max_counter_for_replica(snapshot: &TextCrdtSnapshot, replica_id: &str) -> u64 {
    let mut max = if snapshot.replica_id == replica_id {
        snapshot.counter
    } else {
        0
    };

    for element in &snapshot.elements {
        if element.id.replica_id == replica_id && element.id.counter > max {
            max = element.id.counter;
        }
    }

    for op in snapshot
        .pending_inserts
        .iter()
        .map(|op| &op.op_id)
        .chain(snapshot.pending_deletes.iter().map(|op| &op.op_id))
    {
        if op.replica_id == replica_id && op.counter > max {
            max = op.counter;
        }
    }

    for opid in &snapshot.seen_op_ids {
        if let Some((replica, counter_str)) = split_op_key(opid) {
            if replica == replica_id {
                if let Ok(counter) = counter_str.parse::<u64>() {
                    if counter > max {
                        max = counter;
                    }
                }
            }
        }
    }

    max
}

fn split_op_key(value: &str) -> Option<(&str, &str)> {
    let separator = value.rfind(':')?;
    Some((&value[..separator], &value[separator + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::ElementId;

    #[test]
    fn inserts_build_a_chain() {
        let mut crdt = TextCrdt::new("A");
        crdt.insert(0, "hello").unwrap();
        assert_eq!(crdt.to_text(), "hello");
    }

    #[test]
    fn deletes_become_tombstones() {
        let mut crdt = TextCrdt::new("A");
        crdt.insert(0, "abc").unwrap();
        crdt.delete(1, 1).unwrap();
        assert_eq!(crdt.to_text(), "ac");
    }

    #[test]
    fn duplicate_operations_are_noops() {
        let mut a = TextCrdt::new("A");
        let ops = a.insert(0, "x").unwrap();
        let op = Operation::Insert(ops.into_iter().next().unwrap());

        let mut b = TextCrdt::new("B");
        assert_eq!(b.apply_operation(&op).status, ApplyStatus::Applied);
        assert_eq!(b.apply_operation(&op).status, ApplyStatus::Duplicate);
        assert_eq!(b.to_text(), "x");
    }

    #[test]
    fn has_seen_reflects_log_membership() {
        let mut a = TextCrdt::new("A");
        let insert = a.insert(0, "x").unwrap().into_iter().next().unwrap();
        let op = Operation::Insert(insert);
        assert!(a.has_seen(&op));
        let mut b = TextCrdt::new("B");
        assert!(!b.has_seen(&op));
        b.apply_operation(&op);
        assert!(b.has_seen(&op));
    }

    #[test]
    fn out_of_order_insert_queues_then_drains() {
        let parent = InsertOp {
            op_id: ElementId::new(1, "A"),
            parent_id: ParentId::Root,
            value: "a".into(),
        };
        let child = InsertOp {
            op_id: ElementId::new(2, "A"),
            parent_id: ParentId::Element(parent.op_id.clone()),
            value: "b".into(),
        };

        let mut crdt = TextCrdt::new("C");
        let child_status = crdt.apply_operation(&Operation::Insert(child.clone()));
        assert_eq!(child_status.status, ApplyStatus::Queued);
        assert_eq!(crdt.pending_count(), 1);

        let parent_status = crdt.apply_operation(&Operation::Insert(parent));
        assert_eq!(parent_status.status, ApplyStatus::Applied);
        assert_eq!(parent_status.drained, 1);
        assert_eq!(crdt.pending_count(), 0);
        assert_eq!(crdt.to_text(), "ab");
    }

    #[test]
    fn concurrent_inserts_use_deterministic_order() {
        let insert_a = Operation::Insert(InsertOp {
            op_id: ElementId::new(1, "A"),
            parent_id: ParentId::Root,
            value: "x".into(),
        });
        let insert_b = Operation::Insert(InsertOp {
            op_id: ElementId::new(1, "B"),
            parent_id: ParentId::Root,
            value: "y".into(),
        });

        let mut left = TextCrdt::new("left");
        left.apply_operation(&insert_a);
        left.apply_operation(&insert_b);

        let mut right = TextCrdt::new("right");
        right.apply_operation(&insert_b);
        right.apply_operation(&insert_a);

        assert_eq!(left.to_text(), right.to_text());
        assert_eq!(left.to_text(), "yx");
    }

    #[test]
    fn snapshots_round_trip_with_a_different_replica() {
        let mut source = TextCrdt::new("A");
        source.insert(0, "abc").unwrap();

        let snapshot = source.snapshot();
        let mut joined = TextCrdt::from_snapshot(&snapshot, "B");
        let ops = joined.insert(joined.visible_length(), "!").unwrap();

        assert_eq!(joined.to_text(), "abc!");
        assert_eq!(ops[0].op_id, ElementId::new(1, "B"));
    }

    #[test]
    fn snapshot_skips_over_observed_remote_counters_for_local_replica() {
        let mut source = TextCrdt::new("A");
        let mut other = TextCrdt::new("B");
        let ops = other.insert(0, "b").unwrap();
        source.apply_operation(&Operation::Insert(ops.into_iter().next().unwrap()));

        let mut joined = TextCrdt::from_snapshot(&source.snapshot(), "B");
        let nxt = joined.insert(joined.visible_length(), "!").unwrap();
        assert_eq!(nxt[0].op_id, ElementId::new(2, "B"));
    }
}
