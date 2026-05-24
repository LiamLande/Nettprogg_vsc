use std::cmp::Ordering;
use std::fmt;

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};

/// Globally unique identifier for a CRDT element.
///
/// Composed of a stable [`replica_id`](ElementId::replica_id) and a
/// per-replica monotonic [`counter`](ElementId::counter). The pair is
/// never reused, even after deletion.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementId {
    pub counter: u64,
    pub replica_id: String,
}

impl ElementId {
    pub fn new(counter: u64, replica_id: impl Into<String>) -> Self {
        Self {
            counter,
            replica_id: replica_id.into(),
        }
    }

    /// String key used as a `HashMap` key: `"<replica_id>:<counter>"`.
    pub fn key(&self) -> String {
        format!("{}:{}", self.replica_id, self.counter)
    }
}

impl fmt::Display for ElementId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.replica_id, self.counter)
    }
}

impl Ord for ElementId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.counter
            .cmp(&other.counter)
            .then_with(|| self.replica_id.cmp(&other.replica_id))
    }
}

impl PartialOrd for ElementId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Insertion anchor: either the document root or a specific element.
///
/// Every [`InsertOp`](crate::InsertOp) names its left neighbour as a
/// `ParentId`. The first character of a document uses [`ParentId::Root`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ParentId {
    Root,
    Element(ElementId),
}

impl ParentId {
    pub fn key(&self) -> String {
        match self {
            ParentId::Root => "ROOT".to_string(),
            ParentId::Element(id) => id.key(),
        }
    }

    pub fn is_root(&self) -> bool {
        matches!(self, ParentId::Root)
    }
}

impl From<ElementId> for ParentId {
    fn from(value: ElementId) -> Self {
        ParentId::Element(value)
    }
}

impl Serialize for ParentId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ParentId::Root => serializer.serialize_str("ROOT"),
            ParentId::Element(id) => {
                let mut state = serializer.serialize_struct("ElementId", 2)?;
                state.serialize_field("counter", &id.counter)?;
                state.serialize_field("replicaId", &id.replica_id)?;
                state.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ParentId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ParentIdVisitor)
    }
}

struct ParentIdVisitor;

impl<'de> Visitor<'de> for ParentIdVisitor {
    type Value = ParentId;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the string \"ROOT\" or an object {counter, replicaId}")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        if value == "ROOT" {
            Ok(ParentId::Root)
        } else {
            Err(E::custom(format!("unexpected parent id string `{value}`")))
        }
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut counter: Option<u64> = None;
        let mut replica_id: Option<String> = None;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "counter" => counter = Some(map.next_value()?),
                "replicaId" => replica_id = Some(map.next_value()?),
                other => {
                    return Err(de::Error::unknown_field(other, &["counter", "replicaId"]));
                }
            }
        }

        let counter = counter.ok_or_else(|| de::Error::missing_field("counter"))?;
        let replica_id = replica_id.ok_or_else(|| de::Error::missing_field("replicaId"))?;
        Ok(ParentId::Element(ElementId::new(counter, replica_id)))
    }
}

/// Comparator that places the highest `(counter, replica_id)` first.
///
/// Used to sort siblings under a shared parent so every replica produces the
/// same deterministic order for concurrent inserts at the same position.
pub fn compare_element_id_descending(left: &ElementId, right: &ElementId) -> Ordering {
    right.cmp(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_id_serialises_with_camel_case() {
        let id = ElementId::new(7, "A");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, r#"{"counter":7,"replicaId":"A"}"#);
    }

    #[test]
    fn parent_id_root_round_trips_as_string() {
        let value = ParentId::Root;
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, "\"ROOT\"");
        let back: ParentId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ParentId::Root);
    }

    #[test]
    fn parent_id_element_round_trips_as_object() {
        let value = ParentId::Element(ElementId::new(3, "B"));
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, r#"{"counter":3,"replicaId":"B"}"#);
        let back: ParentId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, value);
    }

    #[test]
    fn descending_order_puts_high_counter_first() {
        let mut ids = vec![
            ElementId::new(1, "B"),
            ElementId::new(2, "A"),
            ElementId::new(1, "A"),
        ];
        ids.sort_by(compare_element_id_descending);
        assert_eq!(ids[0], ElementId::new(2, "A"));
        assert_eq!(ids[1], ElementId::new(1, "B"));
        assert_eq!(ids[2], ElementId::new(1, "A"));
    }
}
