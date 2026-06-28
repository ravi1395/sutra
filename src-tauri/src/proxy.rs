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
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']').ok_or("invalid IPv6 address")?;
        let host = authority[1..close].to_string();
        let port = if authority.len() > close + 1 && authority.as_bytes()[close + 1] == b':' {
            authority[close + 2..].parse::<u16>().map_err(|_| "invalid port".to_string())?
        } else if scheme == "https" { 443 } else { 80 };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "invalid port".to_string())?),
            None => (authority.to_string(), if scheme == "https" { 443 } else { 80 }),
        }
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

pub fn is_html_content_type(ct: &str) -> bool {
    ct.to_ascii_lowercase().contains("text/html")
}

/// Remove every `<meta http-equiv="Content-Security-Policy" ...>` tag.
pub fn strip_csp_meta(html: &str) -> String {
    let needle = "content-security-policy";
    let mut result = html.to_string();
    loop {
        let lower = result.to_ascii_lowercase();
        let Some(cpos) = lower.find(needle) else { break };
        let Some(start) = lower[..cpos].rfind("<meta") else { break };
        let Some(end_rel) = lower[cpos..].find('>') else { break };
        let end = cpos + end_rel + 1;
        result.replace_range(start..end, "");
    }
    result
}

/// Strip CSP meta, then insert `agent` exactly once: after the first `<head ...>`
/// open tag, else before `</body>`, else prepended.
pub fn inject_agent(html: &[u8], agent: &str) -> Vec<u8> {
    let mut s = strip_csp_meta(&String::from_utf8_lossy(html));
    if let Some(idx) = head_insert_index(&s) {
        s.insert_str(idx, agent);
    } else if let Some(idx) = s.find("</body>") {
        s.insert_str(idx, agent);
    } else {
        s.insert_str(0, agent);
    }
    s.into_bytes()
}

fn head_insert_index(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let h = lower.find("<head")?;
    let gt = lower[h..].find('>')? + h;
    Some(gt + 1)
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

    #[test]
    fn parse_accepts_ipv6_loopback_with_port() {
        let t = parse_target("http://[::1]:5173").unwrap();
        assert_eq!(t.host, "::1");
        assert_eq!(t.port, 5173);
    }

    #[test]
    fn parse_ipv6_loopback_defaults_port_80() {
        assert_eq!(parse_target("http://[::1]").unwrap().port, 80);
    }

    #[test]
    fn injects_agent_after_head() {
        let html = b"<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
        let out = String::from_utf8(inject_agent(html, "<script>AGENT</script>")).unwrap();
        assert_eq!(out.matches("<script>AGENT</script>").count(), 1);
        let head = out.find("<head>").unwrap();
        let agent = out.find("<script>AGENT</script>").unwrap();
        let title = out.find("<title>").unwrap();
        assert!(head < agent && agent < title); // injected right after <head>
    }

    #[test]
    fn injects_before_body_when_no_head() {
        let html = b"<html><body>hi</body></html>";
        let out = String::from_utf8(inject_agent(html, "<script>A</script>")).unwrap();
        assert!(out.find("<script>A</script>").unwrap() < out.find("</body>").unwrap());
    }

    #[test]
    fn strips_csp_meta_tag() {
        let html = r#"<head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><title>t</title></head>"#;
        let out = strip_csp_meta(html);
        assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
        assert!(out.contains("<title>t</title>"));
    }

    #[test]
    fn html_content_type_detection() {
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(!is_html_content_type("application/json"));
        assert!(!is_html_content_type("text/event-stream"));
    }
}
