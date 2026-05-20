//! Wire-compatible message types for the LiveShare Lite servers.
//!
//! The serialised form of every message in this module matches the JSON
//! produced by the TypeScript reference implementation, so a Rust server can
//! interoperate with the TypeScript VS Code extension and vice versa.

use crdt_core::{Operation, TextCrdtSnapshot};
use serde::{Deserialize, Serialize};

pub mod relay {
    //! Messages exchanged with the WebSocket operation-relay server.

    use super::*;

    /// Information about a single peer connected to a relay room.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PeerInfo {
        pub client_id: String,
        /// Unix epoch milliseconds when the peer connected.
        pub connected_at: u64,
    }

    /// Messages a client sends to the relay server.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum ClientMessage {
        #[serde(rename = "join")]
        Join {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
        },
        #[serde(rename = "operation")]
        Operation {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            op: Operation,
        },
    }

    /// Messages the relay server sends back to clients.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum ServerMessage {
        #[serde(rename = "joined")]
        Joined {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            peers: Vec<PeerInfo>,
            #[serde(rename = "opLog")]
            op_log: Vec<Operation>,
        },
        #[serde(rename = "presence")]
        Presence {
            #[serde(rename = "roomId")]
            room_id: String,
            peers: Vec<PeerInfo>,
        },
        #[serde(rename = "operation")]
        Operation {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            op: Operation,
        },
        #[serde(rename = "error")]
        Error { message: String },
    }
}

pub mod signaling {
    //! Messages exchanged with the WebRTC signaling server.

    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SignalingPeerInfo {
        pub client_id: String,
        pub connected_at: u64,
    }

    /// SDP description type. Matches the values accepted by `node-datachannel`.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum DescriptionType {
        Offer,
        Answer,
        Pranswer,
        Rollback,
        Unspec,
    }

    /// Payload nested inside [`SignalingClientMessage::Signal`] /
    /// [`SignalingServerMessage::Signal`]. Either an SDP description or an
    /// ICE candidate.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum SignalingSignalPayload {
        #[serde(rename = "description")]
        Description {
            #[serde(rename = "descriptionType")]
            description_type: DescriptionType,
            sdp: String,
        },
        #[serde(rename = "candidate")]
        Candidate { candidate: String, mid: String },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum SignalingClientMessage {
        #[serde(rename = "join")]
        Join {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
        },
        #[serde(rename = "signal")]
        Signal {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            #[serde(rename = "targetClientId")]
            target_client_id: String,
            signal: SignalingSignalPayload,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum SignalingServerMessage {
        #[serde(rename = "joined")]
        Joined {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            peers: Vec<SignalingPeerInfo>,
        },
        #[serde(rename = "peerJoined")]
        PeerJoined {
            #[serde(rename = "roomId")]
            room_id: String,
            peer: SignalingPeerInfo,
            peers: Vec<SignalingPeerInfo>,
        },
        #[serde(rename = "peerLeft")]
        PeerLeft {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            peers: Vec<SignalingPeerInfo>,
        },
        #[serde(rename = "signal")]
        Signal {
            #[serde(rename = "roomId")]
            room_id: String,
            #[serde(rename = "clientId")]
            client_id: String,
            #[serde(rename = "targetClientId")]
            target_client_id: String,
            signal: SignalingSignalPayload,
        },
        #[serde(rename = "error")]
        Error { message: String },
    }
}

/// Optional helper alias for snapshot payloads carried over the data channel.
pub type Snapshot = TextCrdtSnapshot;

#[cfg(test)]
mod tests {
    use super::relay::*;
    use crdt_core::{ElementId, InsertOp, Operation, ParentId};

    #[test]
    fn client_join_serialises_in_camel_case() {
        let msg = ClientMessage::Join {
            room_id: "abc".into(),
            client_id: "alice".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"join\""));
        assert!(json.contains("\"roomId\":\"abc\""));
        assert!(json.contains("\"clientId\":\"alice\""));
    }

    #[test]
    fn server_joined_round_trips_with_op_log() {
        let op = Operation::Insert(InsertOp {
            op_id: ElementId::new(1, "A"),
            parent_id: ParentId::Root,
            value: "x".into(),
        });
        let msg = ServerMessage::Joined {
            room_id: "abc".into(),
            client_id: "alice".into(),
            peers: vec![PeerInfo {
                client_id: "alice".into(),
                connected_at: 1,
            }],
            op_log: vec![op],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"joined\""));
        let back: ServerMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, msg);
    }
}
