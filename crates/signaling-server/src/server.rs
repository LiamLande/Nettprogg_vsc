use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use protocol::signaling::{SignalingClientMessage, SignalingServerMessage};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, WebSocketStream};
use tracing::{debug, info, warn};

use crate::room::SignalingRoom;

#[derive(Debug, Clone)]
pub struct SignalingServerOptions {
    pub host: String,
    pub port: u16,
}

impl Default for SignalingServerOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 7072,
        }
    }
}

type SharedRooms = Arc<Mutex<HashMap<String, SignalingRoom>>>;

/// Stateless signaling server used by the P2P transport.
///
/// The server never stores CRDT operations. It only forwards `signal`
/// messages directed at a specific `targetClientId` and keeps a minimal
/// presence list per room.
pub struct SignalingServer {
    rooms: SharedRooms,
}

pub struct SignalingServerHandle {
    pub addr: SocketAddr,
    pub join: JoinHandle<()>,
    pub rooms: SharedRooms,
}

impl SignalingServer {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        self,
        options: SignalingServerOptions,
    ) -> std::io::Result<SignalingServerHandle> {
        let listener = TcpListener::bind((options.host.as_str(), options.port)).await?;
        let addr = listener.local_addr()?;
        info!(%addr, "signaling server listening");

        let rooms = self.rooms.clone();
        let rooms_for_task = rooms.clone();
        let join = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        debug!(%peer_addr, "incoming signaling connection");
                        let rooms = rooms_for_task.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, rooms).await {
                                warn!(%error, "signaling connection ended with error");
                            }
                        });
                    }
                    Err(error) => warn!(%error, "signaling accept failed"),
                }
            }
        });

        Ok(SignalingServerHandle { addr, join, rooms })
    }
}

impl Default for SignalingServer {
    fn default() -> Self {
        Self::new()
    }
}

async fn handle_connection(stream: TcpStream, rooms: SharedRooms) -> anyhow::Result<()> {
    let ws_stream: WebSocketStream<TcpStream> = accept_async(stream).await?;
    let (sink, mut rx_ws) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    let (tx_outbound, rx_outbound) = mpsc::unbounded_channel::<SignalingServerMessage>();
    let writer = tokio::spawn(forward_outbound(rx_outbound, sink.clone()));

    let mut joined_room: Option<(String, String)> = None;

    while let Some(message) = rx_ws.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                warn!(%error, "websocket error; closing signaling connection");
                break;
            }
        };

        let text = match message {
            Message::Text(text) => text,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: Result<SignalingClientMessage, _> = serde_json::from_str(&text);
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                let _ = tx_outbound.send(SignalingServerMessage::Error {
                    message: format!("invalid signaling message: {error}"),
                });
                continue;
            }
        };

        match parsed {
            SignalingClientMessage::Join { room_id, client_id } => {
                handle_join(
                    &rooms,
                    room_id.clone(),
                    client_id.clone(),
                    tx_outbound.clone(),
                )
                .await;
                joined_room = Some((room_id, client_id));
            }
            SignalingClientMessage::Signal {
                room_id,
                client_id,
                target_client_id,
                signal,
            } => {
                if joined_room.as_ref() != Some(&(room_id.clone(), client_id.clone())) {
                    let _ = tx_outbound.send(SignalingServerMessage::Error {
                        message: "client must join the room before signaling".into(),
                    });
                    continue;
                }

                let mut guard = rooms.lock().await;
                if let Some(room) = guard.get_mut(&room_id) {
                    // Reject signals from stale connections that were replaced by a newer session.
                    if !room.is_active_sender(&client_id, &tx_outbound) {
                        let _ = tx_outbound.send(SignalingServerMessage::Error {
                            message: "stale connection replaced by a newer session".into(),
                        });
                        continue;
                    }

                    let payload = SignalingServerMessage::Signal {
                        room_id: room_id.clone(),
                        client_id: client_id.clone(),
                        target_client_id: target_client_id.clone(),
                        signal,
                    };
                    if !room.send_to(&target_client_id, &payload) {
                        let _ = tx_outbound.send(SignalingServerMessage::Error {
                            message: format!("target peer {target_client_id} is not connected"),
                        });
                    }
                }
            }
        }
    }

    if let Some((room_id, client_id)) = joined_room {
        let mut guard = rooms.lock().await;
        let mut empty_room = false;
        if let Some(room) = guard.get_mut(&room_id) {
            if room.remove_peer(&client_id, &tx_outbound) {
                let message = SignalingServerMessage::PeerLeft {
                    room_id: room_id.clone(),
                    client_id: client_id.clone(),
                    peers: room.peer_list(),
                };
                room.broadcast_except(&client_id, &message);
            }
            empty_room = room.is_empty();
        }
        if empty_room {
            guard.remove(&room_id);
        }
    }

    drop(tx_outbound);
    let _ = writer.await;
    Ok(())
}

async fn handle_join(
    rooms: &SharedRooms,
    room_id: String,
    client_id: String,
    tx_outbound: UnboundedSender<SignalingServerMessage>,
) {
    let mut guard = rooms.lock().await;
    let room = guard
        .entry(room_id.clone())
        .or_insert_with(|| SignalingRoom::new(room_id.clone()));

    let peer = room.add_peer(client_id.clone(), tx_outbound.clone());
    let peers = room.peer_list();

    let joined = SignalingServerMessage::Joined {
        room_id: room_id.clone(),
        client_id: client_id.clone(),
        peers: peers.clone(),
    };
    let _ = tx_outbound.send(joined);

    let peer_joined = SignalingServerMessage::PeerJoined {
        room_id,
        peer,
        peers,
    };
    room.broadcast_except(&client_id, &peer_joined);
}

async fn forward_outbound(
    mut rx: UnboundedReceiver<SignalingServerMessage>,
    sink: Arc<Mutex<SplitSink<WebSocketStream<TcpStream>, Message>>>,
) {
    while let Some(message) = rx.recv().await {
        let payload = match serde_json::to_string(&message) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "failed to serialise signaling message");
                continue;
            }
        };
        let mut sink = sink.lock().await;
        if let Err(error) = sink.send(Message::Text(payload)).await {
            debug!(%error, "client write failed; closing signaling sink");
            break;
        }
    }
    let mut sink = sink.lock().await;
    let _ = sink.close().await;
}
