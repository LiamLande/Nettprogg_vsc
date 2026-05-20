use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use protocol::signaling::{
    DescriptionType, SignalingClientMessage, SignalingServerMessage, SignalingSignalPayload,
};
use signaling_server::{SignalingServer, SignalingServerOptions};
use tokio_tungstenite::tungstenite::Message;

async fn start_server() -> (signaling_server::SignalingServerHandle, String) {
    let handle = SignalingServer::new()
        .start(SignalingServerOptions {
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
) -> SignalingServerMessage {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("timeout")
            .expect("closed")
            .expect("recv error");
        if let Message::Text(text) = msg {
            return serde_json::from_str(&text).expect("decode");
        }
    }
}

#[tokio::test]
async fn signaling_forwards_offers_to_targeted_peer() {
    let (_handle, url) = start_server().await;

    let (mut alice, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let (mut bob, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    alice
        .send(Message::Text(
            serde_json::to_string(&SignalingClientMessage::Join {
                room_id: "room".into(),
                client_id: "alice".into(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut alice).await; // joined

    bob.send(Message::Text(
        serde_json::to_string(&SignalingClientMessage::Join {
            room_id: "room".into(),
            client_id: "bob".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let _ = recv_json(&mut bob).await; // joined
    let _ = recv_json(&mut alice).await; // peerJoined notification

    let signal = SignalingSignalPayload::Description {
        description_type: DescriptionType::Offer,
        sdp: "v=0\r\n".into(),
    };
    alice
        .send(Message::Text(
            serde_json::to_string(&SignalingClientMessage::Signal {
                room_id: "room".into(),
                client_id: "alice".into(),
                target_client_id: "bob".into(),
                signal: signal.clone(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();

    match recv_json(&mut bob).await {
        SignalingServerMessage::Signal {
            client_id,
            target_client_id,
            signal: forwarded,
            ..
        } => {
            assert_eq!(client_id, "alice");
            assert_eq!(target_client_id, "bob");
            assert_eq!(forwarded, signal);
        }
        other => panic!("unexpected message: {other:?}"),
    }
}

#[tokio::test]
async fn peer_left_message_is_broadcast_when_a_socket_closes() {
    let (_handle, url) = start_server().await;

    let (mut alice, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let (mut bob, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    alice
        .send(Message::Text(
            serde_json::to_string(&SignalingClientMessage::Join {
                room_id: "leave".into(),
                client_id: "alice".into(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut alice).await;
    bob.send(Message::Text(
        serde_json::to_string(&SignalingClientMessage::Join {
            room_id: "leave".into(),
            client_id: "bob".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let _ = recv_json(&mut bob).await;
    let _ = recv_json(&mut alice).await; // peerJoined

    bob.close(None).await.unwrap();

    match recv_json(&mut alice).await {
        SignalingServerMessage::PeerLeft { client_id, .. } => {
            assert_eq!(client_id, "bob");
        }
        other => panic!("unexpected message: {other:?}"),
    }
}
