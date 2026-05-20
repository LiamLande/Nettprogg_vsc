//! WebSocket relay server library.
//!
//! Splitting the binary into a library lets us unit-test the server end to
//! end with real WebSocket clients while keeping `main.rs` minimal.

pub mod room;
pub mod server;

pub use server::{RelayServer, RelayServerHandle, RelayServerOptions};
