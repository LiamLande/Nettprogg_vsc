use crdt_core::{ApplyStatus, Operation, TextCrdt};

#[test]
fn applying_the_same_insert_twice_is_idempotent() {
    let mut a = TextCrdt::new("A");
    let op = Operation::Insert(a.insert(0, "x").unwrap().into_iter().next().unwrap());

    let mut b = TextCrdt::new("B");
    assert_eq!(b.apply_operation(&op).status, ApplyStatus::Applied);
    assert_eq!(b.apply_operation(&op).status, ApplyStatus::Duplicate);
    assert_eq!(b.to_text(), "x");
}

#[test]
fn applying_the_same_delete_twice_is_idempotent() {
    let mut a = TextCrdt::new("A");
    let inserts = a.insert(0, "xy").unwrap();
    let delete = a.delete(0, 1).unwrap().into_iter().next().unwrap();

    let mut b = TextCrdt::new("B");
    for ins in &inserts {
        b.apply_operation(&Operation::Insert(ins.clone()));
    }

    let delete_op = Operation::Delete(delete);
    assert_eq!(b.apply_operation(&delete_op).status, ApplyStatus::Applied);
    assert_eq!(b.apply_operation(&delete_op).status, ApplyStatus::Duplicate);
    assert_eq!(b.to_text(), "y");
}
