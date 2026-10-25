//! lightwalletd / Zaino connection handling. Every connection is checked against the server's
//! reported chain name before it is used: it must be the network this sidecar was started for.
//!
//! With a SOCKS5 proxy configured (`--proxy`, e.g. Tor), every connection to the server is made
//! through it, with the hostname resolved by the proxy. There is no fallback to a direct
//! connection. Loopback servers (your own node on this machine) are the one exception: nothing
//! leaves the machine, so they connect directly.

use std::{net::IpAddr, time::Duration};

use anyhow::{Context, anyhow, bail};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient};
use zcash_protocol::consensus::Network;

use crate::socks::{Proxy, SocksConnector};

pub type Client = CompactTxStreamerClient<Channel>;

/// The public testnet lightwalletd run by zec.rocks (Ironwood-aware, lightwalletd v0.5.x on Zebra).
pub const DEFAULT_SERVER: &str = "testnet.zec.rocks:443";
/// The public mainnet lightwalletd run by zec.rocks (probed 2026-10-21; alternatives in docs/ZCASH_SETUP.md).
pub const DEFAULT_MAINNET_SERVER: &str = "zec.rocks:443";

/// lightwalletd's chain name for a network ("main" / "test"), as `GetLightdInfo` reports it.
pub fn chain_name(network: Network) -> &'static str {
    match network {
        Network::MainNetwork => "main",
        Network::TestNetwork => "test",
    }
}

pub fn default_server(network: Network) -> &'static str {
    match network {
        Network::MainNetwork => DEFAULT_MAINNET_SERVER,
        Network::TestNetwork => DEFAULT_SERVER,
    }
}

/// `--network`: "main" or "test" (the long forms are accepted too). Nothing defaults to mainnet.
pub fn parse_network(s: &str) -> anyhow::Result<Network> {
    match s.trim().to_ascii_lowercase().as_str() {
        "main" | "mainnet" => Ok(Network::MainNetwork),
        "test" | "testnet" => Ok(Network::TestNetwork),
        other => bail!("unknown network {other:?}: use --network main or --network test"),
    }
}

/// TCP connect (direct) or full SOCKS handshake (proxied; Tor circuits can take a while).
const CONNECT_TIMEOUT_DIRECT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT_PROXIED: Duration = Duration::from_secs(45);
/// Per-request bound for unary calls and the head of streaming calls. A server that stops
/// answering (connection reset, half-open TCP after a network change) fails a call within this
/// instead of hanging until the OS gives up; the wallet then reconnects with backoff.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug)]
pub struct Server {
    pub host: String,
    pub port: u16,
    /// The chain this server must serve; checked against `GetLightdInfo.chain_name` on every `connect_checked`.
    pub network: Network,
    /// SOCKS5 proxy for every connection to a non-loopback server.
    pub proxy: Option<Proxy>,
}

impl Server {
    /// Accepts `host:port`, `https://host:port` or `http://localhost:port`. Which chain the host
    /// really serves is not guessed from its name: it is checked when connecting.
    pub fn parse(s: &str, network: Network) -> anyhow::Result<Self> {
        let trimmed = s
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        let (host, port) = trimmed
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("server must be host:port, got {s:?}"))?;
        let port: u16 = port.parse().with_context(|| format!("bad port in {s:?}"))?;
        if host.is_empty() {
            bail!("server must be host:port, got {s:?}");
        }
        let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
        Ok(Server { host, port, network, proxy: None })
    }

    /// Parses `--proxy` (if given) and attaches it. Refuses anything that is not a SOCKS5 url.
    pub fn with_proxy(mut self, proxy: Option<&str>) -> anyhow::Result<Self> {
        self.proxy = match proxy {
            Some(p) if !p.trim().is_empty() => Some(Proxy::parse(p)?),
            _ => None,
        };
        Ok(self)
    }

    fn is_loopback(&self) -> bool {
        self.host.eq_ignore_ascii_case("localhost") || self.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
    }

    fn use_tls(&self) -> bool {
        !self.is_loopback()
    }

    /// The proxy this server is reached through: the configured one, unless the server is on
    /// this machine (loopback), where there is no network path to observe.
    pub fn route_proxy(&self) -> Option<&Proxy> {
        if self.is_loopback() { None } else { self.proxy.as_ref() }
    }

    pub fn uri(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        format!("{}://{}:{}", if self.use_tls() { "https" } else { "http" }, host, self.port)
    }

    /// For logs, `ready` and `info`: the proxy in use for this server, credentials stripped.
    pub fn proxy_label(&self) -> Option<String> {
        self.route_proxy().map(Proxy::redacted)
    }

    fn endpoint(&self, request_timeout: Option<Duration>) -> anyhow::Result<Endpoint> {
        let proxied = self.route_proxy().is_some();
        let mut ep = Channel::from_shared(self.uri())?
            .connect_timeout(if proxied { CONNECT_TIMEOUT_PROXIED } else { CONNECT_TIMEOUT_DIRECT })
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(true);
        if let Some(t) = request_timeout {
            ep = ep.timeout(t);
        }
        if self.use_tls() {
            ep = ep.tls_config(
                ClientTlsConfig::new()
                    .domain_name(self.host.clone())
                    .assume_http2(true)
                    .with_webpki_roots(),
            )?;
        }
        Ok(ep)
    }

    /// Opens the channel: directly, or through the SOCKS5 proxy (TLS still terminates at the
    /// server; the proxy only sees the handshake and ciphertext).
    async fn channel(&self, request_timeout: Option<Duration>) -> anyhow::Result<Channel> {
        let ep = self.endpoint(request_timeout)?;
        match self.route_proxy() {
            Some(proxy) => ep
                .connect_with_connector(SocksConnector::new(proxy.clone(), CONNECT_TIMEOUT_PROXIED))
                .await
                .map_err(|e| anyhow!("connecting to lightwalletd at {} via SOCKS5 proxy {}: {}", self.uri(), proxy.redacted(), describe(&e))),
            None => ep
                .connect()
                .await
                .with_context(|| format!("connecting to lightwalletd at {}", self.uri())),
        }
    }

    /// Connects with a per-request timeout (unary calls and the head of streaming calls).
    pub async fn connect(&self) -> anyhow::Result<Client> {
        let channel = self.channel(Some(REQUEST_TIMEOUT)).await?;
        Ok(CompactTxStreamerClient::new(channel)
            .max_decoding_message_size(64 * 1024 * 1024)
            .accept_compressed(tonic::codec::CompressionEncoding::Gzip))
    }

    /// Connects without a request timeout, for long-lived streams (mempool).
    pub async fn connect_streaming(&self) -> anyhow::Result<Client> {
        let channel = self.channel(None).await?;
        Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(64 * 1024 * 1024))
    }

    /// Connects and verifies the server serves this sidecar's network. Returns the server info as well.
    pub async fn connect_checked(&self) -> anyhow::Result<(Client, service::LightdInfo)> {
        let mut client = self.connect().await?;
        let info = client
            .get_lightd_info(service::Empty {})
            .await
            .context("GetLightdInfo")?
            .into_inner();
        let expected = chain_name(self.network);
        if info.chain_name != expected {
            bail!(
                "lightwalletd at {} reports chain {:?} but this sidecar was started with --network {expected}; refusing (a wallet never crosses networks)",
                self.uri(),
                info.chain_name
            );
        }
        Ok((client, info))
    }
}

/// tonic's transport errors wrap the connector's error so that its text appears twice in the
/// source chain. Collect the distinct messages along the chain instead.
fn describe(e: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        let msg = err.to_string();
        if msg != "transport error" && !parts.iter().any(|p| p == &msg || p.ends_with(&msg)) {
            parts.push(msg);
        }
        cur = err.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST: Network = Network::TestNetwork;

    #[test]
    fn parses_servers_and_networks() {
        let s = Server::parse("testnet.zec.rocks:443", TEST).unwrap();
        assert_eq!(s.uri(), "https://testnet.zec.rocks:443");
        assert_eq!(Server::parse("http://localhost:9067", TEST).unwrap().uri(), "http://localhost:9067");
        assert_eq!(Server::parse("127.0.0.1:9067", TEST).unwrap().uri(), "http://127.0.0.1:9067");
        let m = Server::parse("zec.rocks:443", Network::MainNetwork).unwrap();
        assert_eq!((m.uri().as_str(), chain_name(m.network)), ("https://zec.rocks:443", "main"));
        assert!(Server::parse("nonsense", TEST).is_err());
        assert_eq!(parse_network("main").unwrap(), Network::MainNetwork);
        assert_eq!(parse_network("TestNet").unwrap(), Network::TestNetwork);
        assert!(parse_network("regtest").is_err());
        assert_eq!(default_server(Network::MainNetwork), DEFAULT_MAINNET_SERVER);
        assert_eq!(default_server(Network::TestNetwork), DEFAULT_SERVER);
    }

    #[test]
    fn proxy_applies_to_remote_servers_only() {
        let remote = Server::parse("testnet.zec.rocks:443", TEST).unwrap().with_proxy(Some("socks5h://127.0.0.1:9050")).unwrap();
        assert_eq!(remote.proxy_label().as_deref(), Some("socks5h://127.0.0.1:9050"));
        // Loopback: your own node on this machine; nothing to hide from the network.
        let local = Server::parse("127.0.0.1:9067", TEST).unwrap().with_proxy(Some("socks5h://127.0.0.1:9050")).unwrap();
        assert!(local.proxy.is_some());
        assert_eq!(local.route_proxy(), None);
        // Empty / absent means direct; anything that is not SOCKS5 is refused, not ignored.
        assert!(Server::parse("testnet.zec.rocks:443", TEST).unwrap().with_proxy(Some("")).unwrap().proxy.is_none());
        assert!(Server::parse("testnet.zec.rocks:443", TEST).unwrap().with_proxy(Some("http://127.0.0.1:8118")).is_err());
    }
}
