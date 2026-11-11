//! What this build is, and what the home screen tells players about it.
//!
//! All three settings are optional and read once at startup:
//!
//! * `BOXHEAD_BUILD`: a short label for the build, usually the git commit
//!   (`git rev-parse --short HEAD`). Shown next to the version so a bug report
//!   can name the exact build.
//! * `BOXHEAD_FEEDBACK_URL`: an `http(s)` link shown as "Report a bug".
//! * `BOXHEAD_NOTICE`: one line shown on the home screen, for example
//!   "Playtest: progress may be wiped".

use std::sync::OnceLock;

/// The server version, from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const BUILD_MAX: usize = 40;
const URL_MAX: usize = 300;
const NOTICE_MAX: usize = 200;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuildInfo {
    pub build: String,
    pub feedback_url: String,
    pub notice: String,
}

impl BuildInfo {
    fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        let raw_url = var("BOXHEAD_FEEDBACK_URL");
        let feedback_url = clean_feedback_url(&raw_url);
        if feedback_url.is_none() && !raw_url.trim().is_empty() {
            println!("WARNING: BOXHEAD_FEEDBACK_URL is not an http(s) link, so no feedback link is shown.");
        }
        BuildInfo {
            build: clean_build(&var("BOXHEAD_BUILD")),
            feedback_url: feedback_url.unwrap_or_default(),
            notice: clean_notice(&var("BOXHEAD_NOTICE")),
        }
    }

    /// "3.0.0 (abc1234)", or just the version when the build isn't labelled.
    pub fn label(&self) -> String {
        if self.build.is_empty() { VERSION.to_string() } else { format!("{VERSION} ({})", self.build) }
    }
}

/// This process's build settings.
pub fn get() -> &'static BuildInfo {
    static INFO: OnceLock<BuildInfo> = OnceLock::new();
    INFO.get_or_init(BuildInfo::from_env)
}

/// A build label: letters, digits and `. _ - +` only.
pub fn clean_build(raw: &str) -> String {
    raw.trim().chars().filter(|c| c.is_ascii_alphanumeric() || "._-+".contains(*c)).take(BUILD_MAX).collect()
}

/// A feedback link the client may show: an absolute `http(s)` address with
/// nothing that could break out of an attribute or a line.
pub fn clean_feedback_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let bad = |c: char| c.is_whitespace() || c.is_control() || "\"'<>`\\".contains(c);
    (!rest.is_empty() && !rest.starts_with('/') && url.len() <= URL_MAX && !url.chars().any(bad)).then(|| url.to_string())
}

/// One line of plain text.
pub fn clean_notice(raw: &str) -> String {
    let line: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NOTICE_MAX).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_labels_keep_only_safe_characters() {
        assert_eq!(clean_build("  abc1234\n"), "abc1234");
        assert_eq!(clean_build("v3.0.0-playtest.1+abc"), "v3.0.0-playtest.1+abc");
        assert_eq!(clean_build("<b>x</b> y"), "bxby");
        assert_eq!(clean_build(&"a".repeat(100)).len(), BUILD_MAX);
        assert_eq!(clean_build(""), "");
    }

    #[test]
    fn feedback_links_must_be_plain_http_addresses() {
        assert_eq!(clean_feedback_url(" https://example.com/feedback?x=1 ").as_deref(), Some("https://example.com/feedback?x=1"));
        assert_eq!(clean_feedback_url("http://10.0.0.5:8080/bugs").as_deref(), Some("http://10.0.0.5:8080/bugs"));
        for bad in ["", "example.com", "javascript:alert(1)", "data:text/html,x", "//example.com", "https://", "https:///x",
            "https://example.com/\"onclick=", "https://example.com/<script>", "https://example.com/a b", "ftp://example.com"] {
            assert_eq!(clean_feedback_url(bad), None, "{bad}");
        }
        assert_eq!(clean_feedback_url(&format!("https://example.com/{}", "a".repeat(URL_MAX))), None);
    }

    #[test]
    fn notices_are_one_short_line() {
        assert_eq!(clean_notice("  Playtest build.\r\n  Progress may be wiped. "), "Playtest build. Progress may be wiped.");
        assert_eq!(clean_notice("\u{7}"), "");
        assert_eq!(clean_notice(&"word ".repeat(100)).chars().count(), NOTICE_MAX);
    }

    #[test]
    fn the_label_names_the_build_when_there_is_one() {
        let plain = BuildInfo::default();
        assert_eq!(plain.label(), VERSION);
        let stamped = BuildInfo { build: "abc1234".into(), ..Default::default() };
        assert_eq!(stamped.label(), format!("{VERSION} (abc1234)"));
    }
}
