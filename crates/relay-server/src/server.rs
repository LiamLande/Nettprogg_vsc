use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use protocol::relay::{ClientMessage, ServerMessage};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, WebSocketStream};
use tracing::{debug, info, warn};

use crate::room::Room;

/// Configuration for [`RelayServer::start`].
#[derive(Debug, Clone)]
pub struct RelayServerOptions {
    pub host: String,
    pub port: u16,
}

impl Default for RelayServerOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 7071,
        }
    }
}

type SharedRooms = Arc<Mutex<HashMap<String, Room>>>;

/// Operation-relay server that broadcasts CRDT operations between clients in
/// the same room.
///
/// The server keeps an [`OperationLog`](crdt_core::OperationLog) per room so
/// reconnecting clients receive every operation they missed without the
/// extension having to maintain a separate sync protocol.
pub struct RelayServer {
    rooms: SharedRooms,
}

/// Handle to a running [`RelayServer`].
pub struct RelayServerHandle {
    pub addr: SocketAddr,
    pub join: JoinHandle<()>,
    pub rooms: SharedRooms,
}

impl RelayServer {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(self, options: RelayServerOptions) -> std::io::Result<RelayServerHandle> {
        let listener = TcpListener::bind((options.host.as_str(), options.port)).await?;
        let addr = listener.local_addr()?;
        info!(%addr, "relay server listening");

        let rooms = self.rooms.clone();
        let rooms_for_task = rooms.clone();
        let join = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        debug!(%peer_addr, "incoming relay connection");
                        let rooms = rooms_for_task.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, rooms).await {
                                warn!(%error, "relay connection ended with error");
                            }
                        });
                    }
                    Err(error) => {
                        warn!(%error, "relay accept failed");
                    }
                }
            }
        });

        Ok(RelayServerHandle { addr, join, rooms })
    }
}

impl Default for RelayServer {
    fn default() -> Self {
        Self::new()
    }
}

async fn handle_connection(stream: TcpStream, rooms: SharedRooms) -> anyhow::Result<()> {
    let ws_stream: WebSocketStream<TcpStream> = accept_async(stream).await?;
    let (sink, mut rx_ws) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    let (tx_outbound, rx_outbound) = mpsc::unbounded_channel::<ServerMessage>();
    let writer = tokio::spawn(forward_outbound(rx_outbound, sink.clone()));

    let mut joined_room: Option<(String, String)> = None;

    while let Some(message) = rx_ws.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                warn!(%error, "websocket error; closing connection");
                break;
            }
        };

        let text = match message {
            Message::Text(text) => text,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                let _ = tx_outbound.send(ServerMessage::Error {
                    message: format!("invalid relay message: {error}"),
                });
                continue;
            }
        };

        match parsed {
            ClientMessage::Join { room_id, client_id } => {
                handle_join(
                    &rooms,
                    room_id.clone(),
                    client_id.clone(),
                    tx_outbound.clone(),
                )
                .await;
                joined_room = Some((room_id, client_id));
            }
            ClientMessage::Operation {
                room_id,
                client_id,
                op,
            } => {
                if joined_room.as_ref() != Some(&(room_id.clone(), client_id.clone())) {
                    let _ = tx_outbound.send(ServerMessage::Error {
                        message: "client must join the room before sending operations".into(),
                    });
                    continue;
                }

                let mut guard = rooms.lock().await;
                if let Some(room) = guard.get_mut(&room_id) {
                    // Ensure this connection is still the active one for client_id.
                    if !room.is_active_sender(&client_id, &tx_outbound) {
                        let _ = tx_outbound.send(ServerMessage::Error {
                            message: "stale connection replaced by a newer session".into(),
                        });
                        continue;
                    }

                    let is_new = room.append_operation(op.clone());
                    if is_new {
                        let broadcast = ServerMessage::Operation {
                            room_id: room_id.clone(),
                            client_id: client_id.clone(),
                            op: op.clone(),
                        };
                        room.broadcast(&broadcast);
                    }
                }
            }
        }
    }

    if let Some((room_id, client_id)) = joined_room {
        let mut guard = rooms.lock().await;
        if let Some(room) = guard.get_mut(&room_id) {
            if room.remove_peer(&client_id, &tx_outbound) {
                let presence = ServerMessage::Presence {
                    room_id: room_id.clone(),
                    peers: room.peer_list(),
                };
                room.broadcast(&presence);
            }
            if room.is_empty() {
                guard.remove(&room_id);
            }
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
    tx_outbound: UnboundedSender<ServerMessage>,
) {
    let mut guard = rooms.lock().await;
    let room = guard
        .entry(room_id.clone())
        .or_insert_with(|| Room::new(room_id.clone()));
    room.add_peer(client_id.clone(), tx_outbound.clone());

    let peers = room.peer_list();
    let op_log = room.operations();
    let joined = ServerMessage::Joined {
        room_id: room_id.clone(),
        client_id: client_id.clone(),
        peers: peers.clone(),
        op_log,
    };
    // Send the join response first so the client can hydrate its op log
    // before any presence updates arrive.
    let _ = tx_outbound.send(joined);
    // Then notify everyone (including the joiner) about the new presence.
    let presence = ServerMessage::Presence { room_id, peers };
    room.broadcast(&presence);
}

async fn forward_outbound(
    mut rx: UnboundedReceiver<ServerMessage>,
    sink: Arc<Mutex<SplitSink<WebSocketStream<TcpStream>, Message>>>,
) {
    while let Some(message) = rx.recv().await {
        let payload = match serde_json::to_string(&message) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "failed to serialise relay message");
                continue;
            }
        };
        let mut sink = sink.lock().await;
        if let Err(error) = sink.send(Message::Text(payload)).await {
            debug!(%error, "client write failed; closing relay sink");
            break;
        }
    }
    let mut sink = sink.lock().await;
    let _ = sink.close().await;
}
