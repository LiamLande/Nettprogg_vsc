use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crdt_core::{Operation, OperationLog};
use protocol::relay::{PeerInfo, ServerMessage};
use tokio::sync::mpsc::UnboundedSender;

/// Single connected peer in a relay room.
struct Peer {
    client_id: String,
    connected_at: u64,
    sender: UnboundedSender<ServerMessage>,
}

/// State for one collaboration room.
///
/// The relay never inspects CRDT internals: it just appends each operation to
/// an [`OperationLog`] so newly joining peers can be replayed in order, and
/// it broadcasts each operation to every connected peer in the room.
pub struct Room {
    pub room_id: String,
    peers: HashMap<String, Peer>,
    op_log: OperationLog,
}

impl Room {
    pub fn new(room_id: impl Into<String>) -> Self {
        Self {
            room_id: room_id.into(),
            peers: HashMap::new(),
            op_log: OperationLog::new(),
        }
    }

    /// Add a peer to the room. If a peer with the same `client_id` was
    /// already present, its previous sender is dropped (the old connection
    /// will close on the other side).
    pub fn add_peer(&mut self, client_id: String, sender: UnboundedSender<ServerMessage>) {
        let connected_at = now_millis();
        self.peers.insert(
            client_id.clone(),
            Peer {
                client_id,
                connected_at,
                sender,
            },
        );
    }

    /// Remove the peer iff the stored sender still refers to the connection
    /// represented by `sender`. Returns whether anything was removed.
    ///
    /// Comparing senders prevents a re-joining peer from being kicked off by
    /// the close handler of the previous (already-replaced) connection.
    pub fn remove_peer(
        &mut self,
        client_id: &str,
        sender: &UnboundedSender<ServerMessage>,
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

    pub fn append_operation(&mut self, operation: Operation) -> bool {
        self.op_log.append(operation)
    }

    pub fn operations(&self) -> Vec<Operation> {
        self.op_log.cloned()
    }

    pub fn peer_list(&self) -> Vec<PeerInfo> {
        let mut peers: Vec<PeerInfo> = self
            .peers
            .values()
            .map(|peer| PeerInfo {
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

    /// Send a message to every connected peer.
    pub fn broadcast(&self, message: &ServerMessage) {
        for peer in self.peers.values() {
            let _ = peer.sender.send(message.clone());
        }
    }

    pub fn send_to(&self, client_id: &str, message: &ServerMessage) -> bool {
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
        sender: &UnboundedSender<ServerMessage>,
    ) -> bool {
        self.peers
            .get(client_id)
            .map(|peer| peer.sender.same_channel(sender))
            .unwrap_or(false)
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
