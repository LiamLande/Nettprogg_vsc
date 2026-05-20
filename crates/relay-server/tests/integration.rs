use std::time::Duration;

use crdt_core::{ElementId, InsertOp, Operation, ParentId};
use futures_util::{SinkExt, StreamExt};
use protocol::relay::{ClientMessage, ServerMessage};
use relay_server::{RelayServer, RelayServerOptions};
use tokio_tungstenite::tungstenite::Message;

async fn start_server() -> (relay_server::RelayServerHandle, String) {
    let server = RelayServer::new();
    let handle = server
        .start(RelayServerOptions {
            host: "127.0.0.1".into(),
            port: 0,
        })
        .await
        .expect("server start");
    let url = format!("ws://{}", handle.addr);
    (handle, url)
}

async fn recv_json(
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerMessage {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("recv timed out")
            .expect("server closed")
            .expect("recv error");
        if let Message::Text(text) = msg {
            return serde_json::from_str(&text).expect("decode");
        }
    }
}

#[tokio::test]
async fn join_then_operation_is_broadcast_to_peers() {
    let (_handle, url) = start_server().await;

    let (mut alice, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("alice connect");
    let (mut bob, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("bob connect");

    alice
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Join {
                room_id: "room".into(),
                client_id: "alice".into(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut alice).await; // joined
    let _ = recv_json(&mut alice).await; // presence

    bob.send(Message::Text(
        serde_json::to_string(&ClientMessage::Join {
            room_id: "room".into(),
            client_id: "bob".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let _ = recv_json(&mut bob).await; // joined
    let _ = recv_json(&mut bob).await; // presence (bob)
    let _ = recv_json(&mut alice).await; // presence (alice sees bob)

    let op = Operation::Insert(InsertOp {
        op_id: ElementId::new(1, "alice"),
        parent_id: ParentId::Root,
        value: "x".into(),
    });
    alice
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Operation {
                room_id: "room".into(),
                client_id: "alice".into(),
                op: op.clone(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();

    // Both alice and bob should receive the operation echo.
    let bob_message = recv_json(&mut bob).await;
    let alice_message = recv_json(&mut alice).await;

    match bob_message {
        ServerMessage::Operation { op: received, .. } => assert_eq!(received, op),
        other => panic!("unexpected on bob: {other:?}"),
    }
    match alice_message {
        ServerMessage::Operation { op: received, .. } => assert_eq!(received, op),
        other => panic!("unexpected on alice: {other:?}"),
    }
}

#[tokio::test]
async fn replay_log_is_delivered_to_late_joiners() {
    let (_handle, url) = start_server().await;

    let (mut alice, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("alice connect");
    alice
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Join {
                room_id: "replay".into(),
                client_id: "alice".into(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut alice).await; // joined
    let _ = recv_json(&mut alice).await; // presence

    let op = Operation::Insert(InsertOp {
        op_id: ElementId::new(1, "alice"),
        parent_id: ParentId::Root,
        value: "x".into(),
    });
    alice
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Operation {
                room_id: "replay".into(),
                client_id: "alice".into(),
                op: op.clone(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut alice).await; // own operation echo

    let (mut bob, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("bob connect");
    bob.send(Message::Text(
        serde_json::to_string(&ClientMessage::Join {
            room_id: "replay".into(),
            client_id: "bob".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    let joined = recv_json(&mut bob).await;
    match joined {
        ServerMessage::Joined { op_log, .. } => {
            assert_eq!(op_log, vec![op]);
        }
        other => panic!("expected joined, got {other:?}"),
    }
}
