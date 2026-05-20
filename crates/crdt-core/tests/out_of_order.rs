use crdt_core::{ApplyStatus, DeleteOp, ElementId, InsertOp, Operation, ParentId, TextCrdt};

#[test]
fn delete_before_target_is_queued_and_drains_when_insert_arrives() {
    let insert = InsertOp {
        op_id: ElementId::new(1, "A"),
        parent_id: ParentId::Root,
        value: "x".into(),
    };
    let delete = DeleteOp {
        op_id: ElementId::new(1, "B"),
        target_id: insert.op_id.clone(),
    };

    let mut crdt = TextCrdt::new("C");
    assert_eq!(
        crdt.apply_operation(&Operation::Delete(delete)).status,
        ApplyStatus::Queued
    );
    let result = crdt.apply_operation(&Operation::Insert(insert));
    assert_eq!(result.status, ApplyStatus::Applied);
    assert_eq!(result.drained, 1);
    assert_eq!(crdt.to_text(), "");
    assert_eq!(crdt.pending_count(), 0);
}

#[test]
fn insert_before_parent_is_queued_and_drains_when_parent_arrives() {
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
    assert_eq!(
        crdt.apply_operation(&Operation::Insert(child)).status,
        ApplyStatus::Queued
    );
    let result = crdt.apply_operation(&Operation::Insert(parent));
    assert_eq!(result.status, ApplyStatus::Applied);
    assert_eq!(result.drained, 1);
    assert_eq!(crdt.to_text(), "ab");
}
