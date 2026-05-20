use crdt_core::{Operation, TextCrdt};

#[test]
fn three_replicas_converge_with_out_of_order_delivery() {
    let mut a = TextCrdt::new("A");
    let mut b = TextCrdt::new("B");
    let mut c = TextCrdt::new("C");

    let mut ops: Vec<Operation> = Vec::new();
    ops.extend(a.insert(0, "ab").unwrap().into_iter().map(Operation::Insert));
    ops.extend(b.insert(0, "xy").unwrap().into_iter().map(Operation::Insert));
    ops.extend(c.insert(0, "12").unwrap().into_iter().map(Operation::Insert));

    for op in ops.iter().rev() {
        a.apply_operation(op);
    }
    for index in [2, 0, 5, 1, 4, 3] {
        b.apply_operation(&ops[index]);
    }
    for op in &ops {
        c.apply_operation(op);
        c.apply_operation(op);
    }

    assert_eq!(a.to_text(), b.to_text(), "a vs b");
    assert_eq!(b.to_text(), c.to_text(), "b vs c");
}

#[test]
fn converges_after_offline_edits_and_reconnect_delivery() {
    let mut a = TextCrdt::new("A");
    let mut b = TextCrdt::new("B");
    let mut c = TextCrdt::new("C");

    let online_ops: Vec<Operation> = a
        .insert(0, "hello")
        .unwrap()
        .into_iter()
        .map(Operation::Insert)
        .collect();
    for op in &online_ops {
        b.apply_operation(op);
    }

    let mut offline_a: Vec<Operation> = Vec::new();
    offline_a.extend(a.delete(1, 2).unwrap().into_iter().map(Operation::Delete));
    offline_a.extend(a.insert(1, "A").unwrap().into_iter().map(Operation::Insert));
    let offline_b: Vec<Operation> = b
        .insert(5, "B")
        .unwrap()
        .into_iter()
        .map(Operation::Insert)
        .collect();
    let offline_c: Vec<Operation> = c
        .insert(0, "C")
        .unwrap()
        .into_iter()
        .map(Operation::Insert)
        .collect();

    let mut all = Vec::new();
    all.extend(online_ops);
    all.extend(offline_a);
    all.extend(offline_b);
    all.extend(offline_c);

    for replica in [&mut a, &mut b, &mut c] {
        for op in all.iter().rev() {
            replica.apply_operation(op);
        }
    }

    assert_eq!(a.to_text(), b.to_text());
    assert_eq!(b.to_text(), c.to_text());
    assert_eq!(a.pending_count(), 0);
    assert_eq!(b.pending_count(), 0);
    assert_eq!(c.pending_count(), 0);
}
