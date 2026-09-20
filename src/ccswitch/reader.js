import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_TAU_SECONDS } from "./rates.js";

export * from "./rates.js";

// ccswitch 把每次代理请求的用量写在这个库里
export const DEFAULT_DB_PATH = join(homedir(), ".cc-switch", "cc-switch.db");

// created_at 是 Unix 秒，不是毫秒
const ROWS_SQL = `
  SELECT created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
  FROM proxy_request_logs
  WHERE created_at >= ?
  ORDER BY created_at DESC
`;

// 实测 cache_read_tokens 永远不大于 input_tokens，
// 说明这里的 input_tokens 是"总 prompt"，已经把缓存命中算进去了。
// 所以算总量绝不能再加一次 cacheRead，否则翻倍。
export function totalTokens(row) {
  return row.input_tokens + row.output_tokens + row.cache_creation_tokens;
}

// 真正新算的 token（不含缓存命中）
export function freshTokens(row) {
  return (
    Math.max(0, row.input_tokens - row.cache_read_tokens) +
    row.output_tokens +
    row.cache_creation_tokens
  );
}

function emptyCounts() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
}

export class UsageReader {
  constructor({ dbPath = DEFAULT_DB_PATH, tauSeconds = DEFAULT_TAU_SECONDS } = {}) {
    this.dbPath = dbPath;
    this.tauSeconds = tauSeconds;
    this.db = null;
  }

  open() {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) return null;
    // 只读打开，绝不干扰 ccswitch 自己在写
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // 瞬时速率：每条请求的 token 按"距今多久"衰减后再除以时间常数。
  // 这样刚跑完一大轮火会很旺，然后自然慢慢熄灭，而不是到点突然归零。
  sample(nowSeconds = Math.floor(Date.now() / 1000)) {
    const tau = this.tauSeconds;
    const db = this.open();
    if (!db) return this.buildSample(emptyCounts(), null, `找不到 ${this.dbPath}`);

    let rows;
    try {
      // 取 5 个时间常数以内的记录，更早的权重已经衰减到 1% 以下
      rows = db.prepare(ROWS_SQL).all(nowSeconds - Math.ceil(tau * 5));
    } catch (err) {
      // 库可能正被 ccswitch 写入导致短暂拿不到读锁，这一拍先跳过
      return this.buildSample(emptyCounts(), null, String(err.message || err));
    }

    const counts = emptyCounts();
    let totalWeight = 0;
    let freshWeight = 0;
    let outputWeight = 0;
    let lastActivityAt = null;

    for (const row of rows) {
      const age = Math.max(0, nowSeconds - row.created_at);
      if (lastActivityAt === null || row.created_at > lastActivityAt) {
        lastActivityAt = row.created_at;
      }
      const w = Math.exp(-age / tau);

      counts.input += row.input_tokens;
      counts.output += row.output_tokens;
      counts.cacheRead += row.cache_read_tokens;
      counts.cacheCreation += row.cache_creation_tokens;
      counts.requests += 1;

      totalWeight += totalTokens(row) * w;
      freshWeight += freshTokens(row) * w;
      outputWeight += row.output_tokens * w;
    }

    return this.buildSample(counts, lastActivityAt, null, {
      total: totalWeight / tau,
      fresh: freshWeight / tau,
      output: outputWeight / tau,
    });
  }

  buildSample(counts, lastActivityAt, error, rates) {
    return {
      tauSeconds: this.tauSeconds,
      ...counts,
      error,
      lastActivityAt,
      idleSeconds: lastActivityAt === null ? null : Date.now() / 1000 - lastActivityAt,
      rates: rates || { total: 0, fresh: 0, output: 0 },
    };
  }
}
