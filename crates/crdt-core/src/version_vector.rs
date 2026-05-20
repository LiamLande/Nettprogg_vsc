use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::id::ElementId;

/// Per-replica highest seen counter. Used to detect missing operations and to
/// avoid sending redundant data when peers reconnect.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionVector {
    counters: BTreeMap<String, u64>,
}

impl VersionVector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the replica has observed the given element id.
    pub fn observe(&mut self, id: &ElementId) {
        let entry = self.counters.entry(id.replica_id.clone()).or_insert(0);
        if id.counter > *entry {
            *entry = id.counter;
        }
    }

    pub fn get(&self, replica_id: &str) -> u64 {
        self.counters.get(replica_id).copied().unwrap_or(0)
    }

    /// Returns true when this vector already covers the given id.
    pub fn includes(&self, id: &ElementId) -> bool {
        self.get(&id.replica_id) >= id.counter
    }

    pub fn entries(&self) -> impl Iterator<Item = (&String, &u64)> {
        self.counters.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_keeps_max_per_replica() {
        let mut vv = VersionVector::new();
        vv.observe(&ElementId::new(3, "A"));
        vv.observe(&ElementId::new(1, "A"));
        vv.observe(&ElementId::new(2, "B"));
        assert_eq!(vv.get("A"), 3);
        assert_eq!(vv.get("B"), 2);
        assert_eq!(vv.get("C"), 0);
    }

    #[test]
    fn includes_checks_replica_aware_counter() {
        let mut vv = VersionVector::new();
        vv.observe(&ElementId::new(5, "A"));
        assert!(vv.includes(&ElementId::new(5, "A")));
        assert!(!vv.includes(&ElementId::new(6, "A")));
        assert!(!vv.includes(&ElementId::new(1, "B")));
    }
}
