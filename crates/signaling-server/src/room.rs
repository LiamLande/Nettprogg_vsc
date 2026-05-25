use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use protocol::signaling::{SignalingPeerInfo, SignalingServerMessage};
use tokio::sync::mpsc::UnboundedSender;

struct SignalingPeer {
    client_id: String,
    connected_at: u64,
    sender: UnboundedSender<SignalingServerMessage>,
}

/// State for a single signaling room. Stores per-peer outbound senders so
/// targeted signals can be forwarded without locking the entire server.
pub struct SignalingRoom {
    pub room_id: String,
    peers: HashMap<String, SignalingPeer>,
}

impl SignalingRoom {
    pub fn new(room_id: impl Into<String>) -> Self {
        Self {
            room_id: room_id.into(),
            peers: HashMap::new(),
        }
    }

    pub fn add_peer(
        &mut self,
        client_id: String,
        sender: UnboundedSender<SignalingServerMessage>,
    ) -> SignalingPeerInfo {
        let connected_at = now_millis();
        self.peers.insert(
            client_id.clone(),
            SignalingPeer {
                client_id: client_id.clone(),
                connected_at,
                sender,
            },
        );
        SignalingPeerInfo {
            client_id,
            connected_at,
        }
    }

    pub fn remove_peer(
        &mut self,
        client_id: &str,
        sender: &UnboundedSender<SignalingServerMessage>,
    ) -> bool {
        let same = self
            .peers
            .get(client_id)
            .map(|peer| peer.sender.same_channel(sender))
            .unwrap_or(false);
        if same {
            self.peers.remove(client_id);
            true
        } else {
            false
        }
    }

    pub fn peer_list(&self) -> Vec<SignalingPeerInfo> {
        let mut peers: Vec<SignalingPeerInfo> = self
            .peers
            .values()
            .map(|peer| SignalingPeerInfo {
                client_id: peer.client_id.clone(),
                connected_at: peer.connected_at,
            })
            .collect();
        peers.sort_by(|a, b| a.client_id.cmp(&b.client_id));
        peers
    }

    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    pub fn send_to(&self, client_id: &str, message: &SignalingServerMessage) -> bool {
        match self.peers.get(client_id) {
            Some(peer) => peer.sender.send(message.clone()).is_ok(),
            None => false,
        }
    }

    /// Check whether `sender` refers to the currently registered connection
    /// for `client_id`.
    pub fn is_active_sender(
        &self,
        client_id: &str,
        sender: &UnboundedSender<SignalingServerMessage>,
    ) -> bool {
        self.peers
            .get(client_id)
            .map(|peer| peer.sender.same_channel(sender))
            .unwrap_or(false)
    }

    pub fn broadcast_except(&self, except: &str, message: &SignalingServerMessage) {
        for (client_id, peer) in &self.peers {
            if client_id == except {
                continue;
            }
            let _ = peer.sender.send(message.clone());
        }
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
