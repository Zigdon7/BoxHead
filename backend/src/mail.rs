//! Outgoing email (confirmation links, password resets).
//!
//! Configure SMTP with `SMTP_HOST`, `SMTP_PORT` (default 587, STARTTLS; 465 = TLS),
//! `SMTP_USERNAME`, `SMTP_PASSWORD` and `MAIL_FROM`. Any provider with SMTP works
//! (Postmark, Amazon SES, Resend, Mailgun...). Without SMTP, set
//! `BOXHEAD_MAIL_OUTBOX=<dir>` to write each message to a JSON file (tests and
//! local development); with neither, messages are printed to the log.

use std::path::PathBuf;

use lettre::message::{header::ContentType, Mailbox};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub enum Mailer {
    Smtp { transport: AsyncSmtpTransport<Tokio1Executor>, from: Mailbox },
    Outbox(PathBuf),
    Log,
}

impl Mailer {
    pub fn from_env() -> Mailer {
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(host) = var("SMTP_HOST") {
            let port: u16 = var("SMTP_PORT").and_then(|p| p.parse().ok()).unwrap_or(587);
            let from: Mailbox = match var("MAIL_FROM").unwrap_or_else(|| "BoxHead <no-reply@localhost>".into()).parse() {
                Ok(m) => m,
                Err(e) => panic!("MAIL_FROM is not a valid address: {e}"),
            };
            let builder = if port == 465 { AsyncSmtpTransport::<Tokio1Executor>::relay(&host) } else { AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host) };
            let mut builder = builder.unwrap_or_else(|e| panic!("Bad SMTP_HOST {host}: {e}")).port(port);
            if let (Some(user), Some(pass)) = (var("SMTP_USERNAME"), var("SMTP_PASSWORD")) {
                builder = builder.credentials(Credentials::new(user, pass));
            }
            println!("Email: SMTP via {host}:{port} from {from}");
            return Mailer::Smtp { transport: builder.build(), from };
        }
        if let Some(dir) = var("BOXHEAD_MAIL_OUTBOX") {
            let dir = PathBuf::from(dir);
            let _ = std::fs::create_dir_all(&dir);
            println!("Email: writing messages to {}", dir.display());
            return Mailer::Outbox(dir);
        }
        println!("Email: NOT CONFIGURED. Confirmation and reset links are printed here instead (set SMTP_HOST for real email).");
        Mailer::Log
    }

    pub async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), String> {
        match self {
            Mailer::Smtp { transport, from } => {
                let to: Mailbox = to.parse().map_err(|_| "That email address doesn't look valid.".to_string())?;
                let msg = Message::builder().from(from.clone()).to(to).subject(subject)
                    .header(ContentType::TEXT_PLAIN).body(body.to_string())
                    .map_err(|e| e.to_string())?;
                transport.send(msg).await.map(|_| ()).map_err(|e| {
                    eprintln!("Email send failed: {}", redact(&e.to_string()));
                    "We couldn't send the email. Try again in a few minutes.".to_string()
                })
            }
            Mailer::Outbox(dir) => {
                let file = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
                let json = serde_json::json!({ "to": to, "subject": subject, "body": body });
                std::fs::write(file, json.to_string()).map_err(|e| e.to_string())
            }
            Mailer::Log => {
                println!("--- email to {to}: {subject}\n{body}\n---");
                Ok(())
            }
        }
    }
}

/// Keep addresses out of error logs.
fn redact(s: &str) -> String {
    s.split_whitespace().map(|w| if w.contains('@') { "<address>" } else { w }).collect::<Vec<_>>().join(" ")
}
