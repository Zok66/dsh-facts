// dsh-facts 存储层：基于 node:sqlite 的单文件事实库。
//
// 一张表存所有事实，核心字段：
//   subject    主体
//   predicate  关系/属性
//   object     值（统一存字符串；value_type 标记语义类型）
//   value_type text | number | bool | date
//   since      生效时间（ISO 8601 字符串）
//   until      失效时间（null = 当前仍有效）
//   source     来源备注
//   note       附注
//
// 时间语义（复刻 Graphiti 的“新事实使旧事实失效”，但不删历史）：
//   当前有效  = until IS NULL
//   某时刻 t  = since <= t < until（until 为 null 视为 +∞）
//   set 同“主体+关系”的当前有效事实会被填上 until=now，再插入新事实。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 事实库文件默认落在插件目录下的 data/facts.db；可用环境变量覆盖。 */
export function defaultDbPath() {
  return process.env.DSH_FACTS_DB || join(PLUGIN_ROOT, 'data', 'facts.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  object     TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'text',
  since      TEXT NOT NULL,
  until      TEXT,
  source     TEXT,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_effective
  ON facts(subject, predicate, until);
`

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class FactStore {
  constructor(dbPath = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA)
  }

  close() {
    this.db.close()
  }

  /** 写入一条事实；若 replace=true 且存在同“主体+关系”的当前有效事实，先将其失效。 */
  set({ subject, predicate, object, valueType = 'text', source, note, replace = true }) {
    if (replace) this.expireCurrent(subject, predicate)
    const id = newId()
    const since = nowIso()
    this.db.prepare(`
      INSERT INTO facts (id, subject, predicate, object, value_type, since, until, source, note)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, subject, predicate, object, valueType, since, source ?? null, note ?? null)
    return { id, subject, predicate, object, valueType, since, until: null }
  }

  /** 把某“主体+关系”的所有当前有效事实标记为 now 失效。 */
  expireCurrent(subject, predicate) {
    const until = nowIso()
    const r = this.db.prepare(`
      UPDATE facts SET until = ? WHERE subject = ? AND predicate = ? AND until IS NULL
    `).run(until, subject, predicate)
    return r.changes
  }

  /** 查询“现在”有效的事实；可按主体/关系过滤。 */
  getNow(subject, predicate) {
    const rows = this._query({
      subject,
      predicate,
      untilIsNull: true,
    })
    return rows
  }

  /** 查询某 ISO 时刻（默认 now）有效的事实。 */
  getAt(at, subject, predicate) {
    return this._query({
      subject,
      predicate,
      at: at ?? nowIso(),
    })
  }

  /** 列出全部（含历史），按 since 倒序。 */
  listAll(subject, predicate) {
    return this._query({ subject, predicate })
  }

  /** 删除一条（物理删除）。 */
  forget(id) {
    const r = this.db.prepare('DELETE FROM facts WHERE id = ?').run(id)
    return r.changes
  }

  /** 撤销最近一次写操作——通过记录在案的方式实现：删除 since 最大的那条。 */
  undo() {
    const row = this.db.prepare('SELECT id FROM facts ORDER BY since DESC LIMIT 1').get()
    if (!row) return 0
    return this.forget(row.id)
  }

  _query({ subject, predicate, untilIsNull = false, at }) {
    const conds = []
    const params = []
    if (subject != null) { conds.push('subject = ?'); params.push(subject) }
    if (predicate != null) { conds.push('predicate = ?'); params.push(predicate) }
    if (untilIsNull) conds.push('until IS NULL')
    if (at != null) conds.push('since <= ? AND (until IS NULL OR until > ?)')
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    if (at != null) { params.push(at); params.push(at) }
    const stmt = this.db.prepare(`SELECT * FROM facts ${where} ORDER BY since DESC, id DESC`)
    return stmt.all(...params)
  }
}
