//! WebSocket signaling server library used by the P2P transport.

pub mod room;
pub mod server;

pub use server::{SignalingServer, SignalingServerHandle, SignalingServerOptions};
