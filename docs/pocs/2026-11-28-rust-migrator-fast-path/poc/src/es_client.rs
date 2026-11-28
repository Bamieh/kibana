use crate::config::MigratorConfig;
use crate::zdt::EsIndexEntry;
use reqwest::{Certificate, Client, StatusCode};
use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, Instant};

const RETRYABLE_STATUSES: &[u16] = &[401, 403, 408, 429, 502, 503, 504];

pub struct EsClient {
    http: Client,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    bearer_token: Option<String>,
    max_wait: Duration,
}

impl EsClient {
    pub fn from_config(cfg: &MigratorConfig) -> Result<Self, String> {
        let base_url = cfg
            .es_hosts
            .first()
            .ok_or_else(|| "no elasticsearch.hosts configured".to_string())?
            .trim_end_matches('/')
            .to_string();

        let mut builder = Client::builder()
            .timeout(Duration::from_millis(cfg.request_timeout_ms))
            .pool_max_idle_per_host(8)
            .danger_accept_invalid_certs(!cfg.es_verify_certs);

        for cert_path in &cfg.es_ca_certs {
            let pem = fs::read(cert_path)
                .map_err(|e| format!("failed to read CA {}: {e}", cert_path.display()))?;
            let cert = Certificate::from_pem(&pem)
                .map_err(|e| format!("invalid CA PEM {}: {e}", cert_path.display()))?;
            builder = builder.add_root_certificate(cert);
        }

        let http = builder
            .build()
            .map_err(|e| format!("failed to construct ES HTTP client: {e}"))?;

        Ok(Self {
            http,
            base_url,
            username: cfg.es_username.clone(),
            password: cfg.es_password.clone(),
            bearer_token: cfg.es_service_account_token.clone(),
            max_wait: Duration::from_millis(cfg.max_wait_ms),
        })
    }

    pub async fn fetch_indices(&self, prefix: &str) -> Result<BTreeMap<String, EsIndexEntry>, String> {
        let url = format!("{}/{}_*?ignore_unavailable=true", self.base_url, prefix);
        let started = Instant::now();
        let mut backoff_ms = 100u64;

        loop {
            let mut req = self.http.get(&url);
            if let Some(token) = &self.bearer_token {
                req = req.bearer_auth(token);
            } else if let Some(user) = &self.username {
                req = req.basic_auth(user, self.password.as_deref());
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return resp
                            .json::<BTreeMap<String, EsIndexEntry>>()
                            .await
                            .map_err(|e| format!("failed to decode ES response for {prefix}: {e}"));
                    }
                    if status == StatusCode::NOT_FOUND {
                        return Ok(BTreeMap::new());
                    }
                    let code = status.as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    if RETRYABLE_STATUSES.contains(&code) && started.elapsed() < self.max_wait {
                        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(2_000);
                        continue;
                    }
                    return Err(format!("ES HTTP {code} for {prefix}: {body}"));
                }
                Err(err) => {
                    if started.elapsed() < self.max_wait {
                        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(2_000);
                        continue;
                    }
                    return Err(format!("ES request failed for {prefix}: {err}"));
                }
            }
        }
    }
}
