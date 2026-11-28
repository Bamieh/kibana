use chrono::Local;
use serde_json::json;
use std::process;
use std::time::Instant;

pub struct EcsLogger {
    started_at: Instant,
    pid: u32,
}

impl EcsLogger {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            pid: process::id(),
        }
    }

    pub fn info(&self, logger: &str, message: &str, extra: serde_json::Value) {
        self.emit("INFO", logger, message, extra);
    }

    pub fn warn(&self, logger: &str, message: &str, extra: serde_json::Value) {
        self.emit("WARN", logger, message, extra);
    }

    fn emit(&self, level: &str, logger: &str, message: &str, extra: serde_json::Value) {
        let timestamp = Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string();
        let uptime_s = self.started_at.elapsed().as_secs_f64();
        let mut doc = json!({
            "ecs": { "version": "8.11.0" },
            "@timestamp": timestamp,
            "message": message,
            "log": {
                "level": level,
                "logger": logger
            },
            "process": {
                "pid": self.pid,
                "uptime": uptime_s
            },
            "service": {
                "node": {
                    "roles": ["migrator"]
                }
            }
        });
        if let (Some(base), Some(extra_map)) = (doc.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_map {
                base.insert(k.clone(), v.clone());
            }
        }
        println!("{doc}");
    }
}
