use std::env;

use anyhow::Context;
use relay_server::{RelayServer, RelayServerOptions};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .or_else(|| env::args().nth(1).and_then(|value| value.parse().ok()))
        .unwrap_or(7071);

    let options = RelayServerOptions { host, port };
    let handle = RelayServer::new()
        .start(options)
        .await
        .context("starting relay server")?;
    println!(
        "LiveShare Lite relay server listening on ws://{}",
        handle.addr
    );

    // Wait for ctrl-c or the server to stop on its own.
    tokio::select! {
        _ = handle.join => {},
        _ = tokio::signal::ctrl_c() => {
            println!("\nrelay server shutting down");
        }
    }

    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
