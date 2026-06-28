use std::net::{IpAddr, ToSocketAddrs};

#[derive(Clone, Debug)]
pub struct Target {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

/// Parse and validate a proxy target. Accepts only http(s), rejects userinfo,
/// and requires the host to resolve entirely to loopback addresses.
pub fn parse_target(t: &str) -> Result<Target, String> {
    let (scheme, rest) = t.split_once("://").ok_or("missing scheme")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("only http(s) scheme allowed".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.contains('@') {
        return Err("credentials not allowed in target".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| "invalid port".to_string())?,
        ),
        None => (
            authority.to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    if host.is_empty() {
        return Err("missing host".into());
    }
    if !host_is_loopback(&host, port) {
        return Err(format!("target {host} is not loopback"));
    }
    Ok(Target { scheme, host, port })
}

/// Resolve `host` and require EVERY resolved address to be loopback. Re-resolving
/// on each call defeats DNS-rebinding; checking the resolved IP (not the string)
/// defeats alternate encodings and /etc/hosts tricks.
pub fn host_is_loopback(host: &str, port: u16) -> bool {
    let mut any = false;
    let resolved = match (host, port).to_socket_addrs() {
        Ok(it) => it,
        Err(_) => return false,
    };
    for addr in resolved {
        any = true;
        let ok = match addr.ip() {
            IpAddr::V4(v4) => v4.is_loopback(),
            IpAddr::V6(v6) => v6.is_loopback(),
        };
        if !ok {
            return false;
        }
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_loopback_http() {
        let t = parse_target("http://127.0.0.1:5173/x").unwrap();
        assert_eq!(t.scheme, "http");
        assert_eq!(t.host, "127.0.0.1");
        assert_eq!(t.port, 5173);
    }

    #[test]
    fn parse_defaults_port_80() {
        assert_eq!(parse_target("http://localhost").unwrap().port, 80);
    }

    #[test]
    fn parse_rejects_non_http_scheme() {
        assert!(parse_target("file:///etc/passwd").is_err());
        assert!(parse_target("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn parse_rejects_credentials() {
        assert!(parse_target("http://user:pass@127.0.0.1:5173").is_err());
    }

    #[test]
    fn parse_rejects_non_loopback() {
        // 93.184.216.34 (example.com) must fail loopback validation
        assert!(parse_target("http://93.184.216.34").is_err());
    }

    #[test]
    fn parse_rejects_missing_host() {
        assert!(parse_target("http://").is_err());
    }
}
