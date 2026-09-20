// Codex 的实时流。
//
// Codex 把 app-server 的每个流式事件都记到 ~/.codex/logs_2.sqlite 里，
// item/reasoning/textDelta 和 item/agentMessage/delta 就是"模型正在吐字"。
// 实测一条一条冒出来，秒级就能看出快慢，比用量库快一个数量级。
//
// 坑：这张表只留最近约一千行（生成快的时候也就十来秒），
// 所以必须高频增量读取，读完自己记账，别指望回头查历史。
use super::{Live, SourceStatus};
use rusqlite::{params, Connection, OpenFlags};
use std::path::PathBuf;
use std::time::Duration;

const TARGET: &str = "codex_app_server::outgoing_message";
/// 刚启动时用最近这么多秒的数据把火先点起来
const SEED_SECONDS: i64 = 30;
/// 一次最多读这么多行，防止日志库异常时把内存撑爆
const MAX_ROWS: usize = 20000;

const SEED_SQL: &str = "
    SELECT id, ts, feedback_log_body, thread_id
    FROM logs
    WHERE ts >= ?1 AND target = ?2
    ORDER BY id
    LIMIT 20000
";

const TAIL_SQL: &str = "
    SELECT id, ts, feedback_log_body, thread_id
    FROM logs
    WHERE id > ?1 AND target = ?2
    ORDER BY id
    LIMIT 20000
";

const MAX_ID_SQL: &str = "SELECT COALESCE(MAX(id), 0) FROM logs WHERE target = ?1";

pub fn default_db() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("logs_2.sqlite")
}

pub struct CodexStream {
    pub db: PathBuf,
    pub live: Live,
    pub available: bool,
    cursor: i64,
    /// 见过流式事件没有 —— 用来区分"装了 Codex 但还没聊过"和"正在烧"
    seen_events: bool,
}

impl CodexStream {
    pub fn new(db: PathBuf) -> Self {
        Self {
            db,
            live: Live::new(),
            available: false,
            cursor: 0,
            seen_events: false,
        }
    }

    pub fn mark_unavailable(&mut self) {
        self.available = false;
    }

    pub fn poll(&mut self, now: i64) -> Result<(), String> {
        if !self.db.is_file() {
            self.available = false;
            return Err(format!(
                "没找到 Codex 的日志库 {}。装了 Codex 并且至少聊过一次才会有。",
                self.db.display()
            ));
        }

        let conn = Connection::open_with_flags(&self.db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|err| format!("打不开 Codex 日志库：{err}（{}）", self.db.display()))?;
        // Codex 正在写，短暂拿不到读锁就等一下
        let _ = conn.busy_timeout(Duration::from_millis(300));

        if self.cursor == 0 {
            // 第一趟：先记住当前最大 id，再补最近 30 秒的量，
            // 不然刚启动那几秒火是死的
            self.cursor = conn
                .query_row(MAX_ID_SQL, [TARGET], |row| row.get::<_, i64>(0))
                .map_err(|err| format!("读 Codex 日志库失败：{err}"))?;
            let rows = query(&conn, SEED_SQL, now - SEED_SECONDS)?;
            self.absorb(rows);
        } else {
            let rows = query(&conn, TAIL_SQL, self.cursor)?;
            self.absorb(rows);
        }

        self.available = true;
        Ok(())
    }

    fn absorb(&mut self, rows: Vec<Row>) {
        for row in rows {
            if row.id > self.cursor {
                self.cursor = row.id;
            }
            let Some(name) = event_name(&row.body) else {
                continue;
            };
            // 只认模型吐出来的字。item/commandExecution/outputDelta 是命令输出，
            // 不是模型生成，算进来会变成"跑个命令火就旺"。
            if name != "item/reasoning/textDelta" && name != "item/agentMessage/delta" {
                continue;
            }
            self.seen_events = true;
            self.live.events.add(row.ts, 1.0);
            if let Some(thread) = row.thread.as_deref() {
                self.live.note_thread(thread, row.ts);
            }
        }
    }

    pub fn status(&self, error: Option<&str>) -> SourceStatus {
        let path = self.db.display().to_string();
        let mut status = SourceStatus {
            id: "codex".to_string(),
            name: "Codex 实时流".to_string(),
            short: String::new(),
            detail: String::new(),
            path: path.clone(),
            live: true,
            experimental: false,
            available: self.available,
            level: "ok".to_string(),
        };
        if let Some(err) = error {
            status.level = "bad".to_string();
            status.short = "Codex 没接上".to_string();
            status.detail = err.to_string();
        } else if !self.available {
            // 后台线程还没来得及采第一次样，属于启动那一瞬间的正常过渡，
            // 别报成红的把人吓一跳
            status.level = "warn".to_string();
            status.short = "正在接上".to_string();
            status.detail = format!("正在读 {path}");
        } else if !self.seen_events {
            // 连上了但还没看到流式事件，属于"空闲"不是"故障"，
            // 面板里提一句就够了，别在摆件上一直挂个黄牌子
            status.detail =
                format!("Codex 实时流 · {path} · 已连上，但还没看到流式事件，跟 Codex 说句话火就烧起来了");
        } else {
            status.detail = format!("Codex 实时流 · {path} · 毫秒级跟手");
        }
        status
    }
}

struct Row {
    id: i64,
    ts: i64,
    body: String,
    thread: Option<String>,
}

fn query(conn: &Connection, sql: &str, arg: i64) -> Result<Vec<Row>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("准备查询失败：{err}"))?;
    let rows = stmt
        .query_map(params![arg, TARGET], |row| {
            Ok(Row {
                id: row.get(0)?,
                ts: row.get(1)?,
                body: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                thread: row.get(3)?,
            })
        })
        .map_err(|err| format!("查询失败：{err}"))?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        if out.len() >= MAX_ROWS {
            break;
        }
        out.push(row);
    }
    Ok(out)
}

/// 日志体长这样：app-server event: item/reasoning/textDelta targeted_connections=1
fn event_name(body: &str) -> Option<&str> {
    let rest = body.strip_prefix("app-server event:")?;
    rest.trim_start().split(' ').next()
}