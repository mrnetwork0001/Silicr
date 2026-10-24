//! SOCKS5 (RFC 1928) client connector for tonic, so that every lightwalletd connection can go
//! through Tor or another SOCKS proxy.
//!
//! Privacy properties:
//! - the destination is handed to the proxy as a *hostname* (ATYP 0x03), so DNS is resolved by
//!   the proxy and no lookup leaves this machine (`socks5h` semantics, whatever the scheme says);
//! - TLS is layered on top by tonic, so the proxy sees only the TLS handshake and ciphertext;
//! - there is no fallback: if the proxy is unreachable or refuses the connection, the connection
//!   fails. Nothing ever dials lightwalletd directly while a proxy is configured.

use std::{
    future::Future,
    net::IpAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use anyhow::{Context as _, anyhow, bail};
use hyper_util::rt::TokioIo;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tonic::transport::Uri;
use tower_service::Service;

/// A SOCKS5 proxy: `socks5h://host:port` or `socks5://host:port`, optionally `user:pass@`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proxy {
    pub host: String,
    pub port: u16,
    /// RFC 1929 username/password. Tor uses them for stream isolation. Never logged.
    pub auth: Option<(String, String)>,
}

impl Proxy {
    /// Parses `socks5h://[user:pass@]host[:port]` (`socks5://` is accepted and means the same:
    /// names are always resolved by the proxy). The port defaults to 1080.
    pub fn parse(url: &str) -> anyhow::Result<Self> {
        const HELP: &str = "expected socks5h://host:port (e.g. socks5h://127.0.0.1:9050 for Tor)";
        let url = url.trim();
        let (scheme, rest) = url
            .split_once("://")
            .ok_or_else(|| anyhow!("bad proxy url {url:?}: {HELP}"))?;
        if !matches!(scheme.to_ascii_lowercase().as_str(), "socks5" | "socks5h") {
            bail!("unsupported proxy scheme {scheme:?} in {url:?}: only SOCKS5 is supported ({HELP})");
        }
        let rest = rest.trim_end_matches('/');
        if rest.contains('/') || rest.contains('?') || rest.contains('#') {
            bail!("bad proxy url {url:?}: no path or query allowed ({HELP})");
        }
        let (auth, hostport) = match rest.rsplit_once('@') {
            Some((userinfo, hp)) => {
                let (u, p) = userinfo
                    .split_once(':')
                    .ok_or_else(|| anyhow!("bad proxy url: credentials must be user:pass@"))?;
                if u.is_empty() || u.len() > 255 || p.len() > 255 {
                    bail!("bad proxy url: username must be 1-255 bytes and password at most 255");
                }
                (Some((u.to_string(), p.to_string())), hp)
            }
            None => (None, rest),
        };
        let (host, port) = if let Some(h) = hostport.strip_prefix('[') {
            // [v6]:port
            let (v6, after) = h.split_once(']').ok_or_else(|| anyhow!("bad proxy url {url:?}: unclosed [ipv6]"))?;
            let port = match after {
                "" => 1080,
                p => p.strip_prefix(':').ok_or_else(|| anyhow!("bad proxy url {url:?}: {HELP}"))?.parse()?,
            };
            (v6.to_string(), port)
        } else {
            match hostport.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse::<u16>().with_context(|| format!("bad proxy port in {url:?}"))?),
                None => (hostport.to_string(), 1080),
            }
        };
        if host.is_empty() {
            bail!("bad proxy url {url:?}: missing host ({HELP})");
        }
        if port == 0 {
            bail!("bad proxy url {url:?}: port must be 1-65535");
        }
        Ok(Proxy { host, port, auth })
    }

    /// For logs and status: scheme://host:port, never credentials.
    pub fn redacted(&self) -> String {
        if self.host.contains(':') {
            format!("socks5h://[{}]:{}", self.host, self.port)
        } else {
            format!("socks5h://{}:{}", self.host, self.port)
        }
    }
}

/// Opens a TCP connection to the proxy and asks it to CONNECT to `host:port`. Hostnames are
/// sent as-is (ATYP 0x03); IP literals use ATYP 0x01/0x04. Returns the tunnelled stream.
pub async fn socks5_connect(proxy: &Proxy, host: &str, port: u16, timeout: Duration) -> anyhow::Result<TcpStream> {
    tokio::time::timeout(timeout, handshake(proxy, host, port))
        .await
        .map_err(|_| anyhow!("SOCKS5 proxy {} did not answer within {} s", proxy.redacted(), timeout.as_secs()))?
}

async fn handshake(proxy: &Proxy, host: &str, port: u16) -> anyhow::Result<TcpStream> {
    // The proxy's own address is resolved locally if it is a name; it is the proxy, not the destination.
    let mut s = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .with_context(|| format!("SOCKS5 proxy {} is unreachable", proxy.redacted()))?;
    let _ = s.set_nodelay(true);

    // Greeting: version 5, the methods we support.
    let greeting: &[u8] = if proxy.auth.is_some() { &[0x05, 0x02, 0x00, 0x02] } else { &[0x05, 0x01, 0x00] };
    s.write_all(greeting).await?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).await.context("SOCKS5 proxy closed the connection during the greeting")?;
    if reply[0] != 0x05 {
        bail!("{} is not a SOCKS5 proxy (version byte {})", proxy.redacted(), reply[0]);
    }
    match (reply[1], &proxy.auth) {
        (0x00, _) => {}
        (0x02, Some((user, pass))) => {
            let mut req = vec![0x01, user.len() as u8];
            req.extend_from_slice(user.as_bytes());
            req.push(pass.len() as u8);
            req.extend_from_slice(pass.as_bytes());
            s.write_all(&req).await?;
            let mut st = [0u8; 2];
            s.read_exact(&mut st).await.context("SOCKS5 proxy closed the connection during authentication")?;
            if st[1] != 0x00 {
                bail!("SOCKS5 proxy {} rejected the username/password", proxy.redacted());
            }
        }
        (0xFF, _) => bail!("SOCKS5 proxy {} accepts none of our authentication methods", proxy.redacted()),
        (m, _) => bail!("SOCKS5 proxy {} chose an unsupported authentication method {m}", proxy.redacted()),
    }

    // CONNECT request. Names go to the proxy unresolved.
    let mut req = vec![0x05, 0x01, 0x00];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => {
            req.push(0x01);
            req.extend_from_slice(&a.octets());
        }
        Ok(IpAddr::V6(a)) => {
            req.push(0x04);
            req.extend_from_slice(&a.octets());
        }
        Err(_) => {
            if host.is_empty() || host.len() > 255 {
                bail!("SOCKS5: hostname must be 1-255 bytes");
            }
            req.push(0x03);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.context("SOCKS5 proxy closed the connection during CONNECT")?;
    if head[0] != 0x05 {
        bail!("SOCKS5 proxy {} sent a malformed CONNECT reply", proxy.redacted());
    }
    if head[1] != 0x00 {
        bail!("SOCKS5 proxy {} refused to connect to {host}:{port}: {}", proxy.redacted(), reply_text(head[1]));
    }
    // Skip BND.ADDR / BND.PORT.
    let bound = match head[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            usize::from(len[0]) + 2
        }
        t => bail!("SOCKS5 proxy {} sent an unknown address type {t} in its reply", proxy.redacted()),
    };
    let mut skip = vec![0u8; bound];
    s.read_exact(&mut skip).await?;
    Ok(s)
}

fn reply_text(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown reply code",
    }
}

/// A `tower` connector for tonic: every connection for the endpoint URI goes through the proxy.
#[derive(Clone, Debug)]
pub struct SocksConnector {
    proxy: Proxy,
    timeout: Duration,
}

impl SocksConnector {
    pub fn new(proxy: Proxy, timeout: Duration) -> Self {
        Self { proxy, timeout }
    }
}

impl Service<Uri> for SocksConnector {
    type Response = TokioIo<TcpStream>;
    type Error = anyhow::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let proxy = self.proxy.clone();
        let timeout = self.timeout;
        Box::pin(async move {
            let host = uri
                .host()
                .ok_or_else(|| anyhow!("endpoint {uri} has no host"))?
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            let port = uri
                .port_u16()
                .unwrap_or(if uri.scheme_str() == Some("https") { 443 } else { 80 });
            let stream = socks5_connect(&proxy, &host, port, timeout).await?;
            Ok(TokioIo::new(stream))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[test]
    fn parses_proxy_urls() {
        let p = Proxy::parse("socks5h://127.0.0.1:9050").unwrap();
        assert_eq!(p, Proxy { host: "127.0.0.1".into(), port: 9050, auth: None });
        assert_eq!(p.redacted(), "socks5h://127.0.0.1:9050");
        assert_eq!(Proxy::parse("SOCKS5://tor.local").unwrap().port, 1080);
        assert_eq!(Proxy::parse("socks5h://[::1]:9050/").unwrap(), Proxy { host: "::1".into(), port: 9050, auth: None });
        let a = Proxy::parse("socks5h://silicr:isolation@127.0.0.1:9050").unwrap();
        assert_eq!(a.auth, Some(("silicr".into(), "isolation".into())));
        assert_eq!(a.redacted(), "socks5h://127.0.0.1:9050");
        for bad in ["http://127.0.0.1:8080", "socks4://127.0.0.1:1080", "127.0.0.1:9050", "socks5h://:9050", "socks5h://127.0.0.1:0", "socks5h://127.0.0.1:9050/path"] {
            assert!(Proxy::parse(bad).is_err(), "{bad} should be refused");
        }
    }

    /// What the test proxy was asked to CONNECT to: (atyp, host, port).
    type Seen = Arc<Mutex<Vec<(u8, String, u16)>>>;

    /// A tiny in-process SOCKS5 server: records every CONNECT, then either tunnels to `target`
    /// or answers with `refuse` as the reply code.
    async fn test_proxy(target: Option<std::net::SocketAddr>, refuse: u8) -> (Proxy, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let seen2 = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                let seen = seen2.clone();
                tokio::spawn(async move {
                    let mut g = [0u8; 2];
                    c.read_exact(&mut g).await.unwrap();
                    let mut methods = vec![0u8; g[1] as usize];
                    c.read_exact(&mut methods).await.unwrap();
                    c.write_all(&[0x05, 0x00]).await.unwrap();
                    let mut h = [0u8; 4];
                    c.read_exact(&mut h).await.unwrap();
                    let host = match h[3] {
                        0x01 => {
                            let mut a = [0u8; 4];
                            c.read_exact(&mut a).await.unwrap();
                            std::net::Ipv4Addr::from(a).to_string()
                        }
                        0x03 => {
                            let mut l = [0u8; 1];
                            c.read_exact(&mut l).await.unwrap();
                            let mut n = vec![0u8; l[0] as usize];
                            c.read_exact(&mut n).await.unwrap();
                            String::from_utf8(n).unwrap()
                        }
                        _ => panic!("unexpected atyp"),
                    };
                    let mut p = [0u8; 2];
                    c.read_exact(&mut p).await.unwrap();
                    seen.lock().unwrap().push((h[3], host, u16::from_be_bytes(p)));
                    if refuse != 0 {
                        c.write_all(&[0x05, refuse, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.unwrap();
                        return;
                    }
                    let mut t = TcpStream::connect(target.unwrap()).await.unwrap();
                    // A domain-typed bound address, to exercise the variable-length reply parsing.
                    c.write_all(&[0x05, 0x00, 0x00, 0x03, 4, b'b', b'i', b'n', b'd', 0, 0]).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut t).await;
                });
            }
        });
        (Proxy { host: "127.0.0.1".into(), port, auth: None }, seen)
    }

    async fn echo_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = c.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn tunnels_through_the_proxy_sending_the_hostname() {
        let echo = echo_server().await;
        let (proxy, seen) = test_proxy(Some(echo), 0).await;
        let mut s = socks5_connect(&proxy, "lightwalletd.example", 443, Duration::from_secs(5)).await.unwrap();
        s.write_all(b"hello through socks").await.unwrap();
        let mut buf = [0u8; 19];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello through socks");
        assert_eq!(seen.lock().unwrap().as_slice(), &[(0x03, "lightwalletd.example".to_string(), 443)]);
    }

    #[tokio::test]
    async fn connector_uses_the_uri_host_and_default_https_port() {
        let echo = echo_server().await;
        let (proxy, seen) = test_proxy(Some(echo), 0).await;
        let mut c = SocksConnector::new(proxy, Duration::from_secs(5));
        let io = c.call("https://testnet.zec.rocks".parse().unwrap()).await.unwrap();
        drop(io);
        assert_eq!(seen.lock().unwrap().as_slice(), &[(0x03, "testnet.zec.rocks".to_string(), 443)]);
    }

    #[tokio::test]
    async fn ip_literals_are_sent_as_addresses() {
        let echo = echo_server().await;
        let (proxy, seen) = test_proxy(Some(echo), 0).await;
        socks5_connect(&proxy, "10.1.2.3", 9067, Duration::from_secs(5)).await.unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), &[(0x01, "10.1.2.3".to_string(), 9067)]);
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_not_a_direct_connection() {
        let (proxy, seen) = test_proxy(None, 0x02).await;
        let err = socks5_connect(&proxy, "lightwalletd.example", 443, Duration::from_secs(5)).await.unwrap_err();
        assert!(err.to_string().contains("not allowed by ruleset"), "{err}");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_unreachable_proxy_is_an_error() {
        // A port nobody listens on.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let proxy = Proxy { host: "127.0.0.1".into(), port, auth: None };
        let err = socks5_connect(&proxy, "lightwalletd.example", 443, Duration::from_secs(5)).await.unwrap_err();
        assert!(format!("{err:#}").contains("unreachable"), "{err:#}");
    }
}
