use crdt_core::{Operation, TextCrdt};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

fn apply_action(replica: &mut TextCrdt, action: &Action) -> Vec<Operation> {
    let len = replica.visible_length();
    match action.kind {
        ActionKind::Insert => {
            let index = if len == 0 {
                0
            } else {
                action.index % (len + 1)
            };
            replica
                .insert(index, &action.value)
                .unwrap_or_default()
                .into_iter()
                .map(Operation::Insert)
                .collect()
        }
        ActionKind::Delete => {
            if len == 0 {
                return Vec::new();
            }
            let index = action.index % len;
            replica
                .delete(index, 1)
                .unwrap_or_default()
                .into_iter()
                .map(Operation::Delete)
                .collect()
        }
    }
}

#[derive(Clone)]
enum ActionKind {
    Insert,
    Delete,
}

#[derive(Clone)]
struct Action {
    replica: usize,
    kind: ActionKind,
    index: usize,
    value: String,
}

#[test]
fn three_replicas_converge_under_random_delivery_and_duplicates() {
    for seed in 0u64..30 {
        let mut rng = StdRng::seed_from_u64(seed);
        let mut replicas = [TextCrdt::new("A"), TextCrdt::new("B"), TextCrdt::new("C")];
        let mut operations: Vec<Operation> = Vec::new();

        let actions_count = rng.gen_range(8..40);
        let alphabet = ['a', 'b', 'c', 'x', 'y', 'z', '\n'];
        for _ in 0..actions_count {
            let action = Action {
                replica: rng.gen_range(0..replicas.len()),
                kind: if rng.gen_bool(0.7) {
                    ActionKind::Insert
                } else {
                    ActionKind::Delete
                },
                index: rng.gen_range(0..50),
                value: alphabet[rng.gen_range(0..alphabet.len())].to_string(),
            };
            let mut new_ops = apply_action(&mut replicas[action.replica], &action);
            operations.append(&mut new_ops);
        }

        // Shuffle and add duplicates.
        let mut delivery = operations.clone();
        for index in (0..delivery.len()).step_by(3) {
            delivery.push(operations[index].clone());
        }
        for index in (1..delivery.len()).rev() {
            let swap = rng.gen_range(0..=index);
            delivery.swap(index, swap);
        }

        for replica in replicas.iter_mut() {
            for op in &delivery {
                replica.apply_operation(op);
            }
        }

        let canonical = replicas[0].to_text();
        assert_eq!(replicas[1].to_text(), canonical, "seed={seed}");
        assert_eq!(replicas[2].to_text(), canonical, "seed={seed}");
        assert_eq!(replicas[0].pending_count(), 0);
        assert_eq!(replicas[1].pending_count(), 0);
        assert_eq!(replicas[2].pending_count(), 0);
    }
}
