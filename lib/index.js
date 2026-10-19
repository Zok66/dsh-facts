// dsh-facts — dsh 的「时间感知记忆」插件。
//
// 复刻 Graphiti 的两点核心价值，砍掉全部重型依赖，纯本地零外部服务：
//   1. 每条事实带时间戳（since / until）；
//   2. 新事实使旧事实自动失效（set 时把同「主体+关系」的当前有效事实填上 until）。
//
// 两个能力：
//   · 工具：fact_set / fact_get / fact_get_at / fact_list / fact_forget / fact_undo
//     —— 注册进 ctx.tools，schema 自动进提示词，agent 可主动读写事实。
//   · 注入：ctx.systemPrompt.section 注册一个同步渲染段落，每轮把「当前有效」
//     事实渲染进系统提示词，让未来会话直接“记得”。
//
// 实现要点：不 import 任何 @deepseek-ai 包，工具定义手写成 DSH 工具注册表
// 要求的「标准 JSON Schema + execute + output.render」形状，保证在任意位置
// （含 /sdcard）都能被 loader 正常加载，真正零依赖。

import { FactStore } from './store.js'

export const name = 'dsh-facts'
export const inject = ['tools', 'systemPrompt']

/** 模块级单例：同一 loader entry 多次 apply 时复用同一个数据库连接。 */
let _store = null
function store() {
  if (_store === null) _store = new FactStore()
  return _store
}

const VALUE_TYPES = ['text', 'number', 'bool', 'date']

/**
 * 手写工具定义的统一封装：补齐 output.schema 与 output.render。
 * @param {object} def - { name, description, parameters(标准JSONSchema), execute(args,exec) }
 */
function def({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return execute(args ?? {}, exec)
    },
  }
}

/** 对象型参数 schema 的便捷构造器。 */
function paramsSchema(fields, required = []) {
  return {
    type: 'object',
    properties: fields,
    required,
    additionalProperties: false,
  }
}

const STR = { type: 'string' }
const OPT_STR = { type: 'string' }
const BOOL = { type: 'boolean' }
const VALUE_TYPE_ENUM = { type: 'string', enum: VALUE_TYPES, description: '值的语义类型（text/number/bool/date），默认 text' }

function rowsToResult(rows) {
  return {
    count: rows.length,
    facts: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      valueType: r.value_type,
      since: r.since,
      until: r.until,
      source: r.source,
      note: r.note,
    })),
  }
}

/** 把当前有效事实渲染成一段给模型看的文本；为空返回 ''（会被过滤掉）。 */
function renderMemorySection() {
  const rows = store().getNow()
  if (rows.length === 0) return ''
  const lines = rows.map((r) => {
    const line = `- ${r.subject} ｜ ${r.predicate} = ${r.object}`
    return r.note ? `${line}（${r.note}）` : line
  })
  return [
    '以下是本机「时间感知记忆」中当前有效的事实，可在回答时直接引用；当用户陈述的新事实与其中某项冲突时，请调用 fact_set 更新它（旧值会自动失效）。',
    ...lines,
  ].join('\n')
}

function apply(ctx) {
  const s = store()

  ctx.effect(() => {
    return ctx.systemPrompt.section({
      name: 'dsh-facts:memory',
      order: 450,
      text: () => renderMemorySection(),
    })
  }, 'dsh-facts.memory-section')

  ctx.tools.register(def({
    name: 'fact_set',
    description:
      '记录或更新一条带时间戳的事实。subject/predicate 定位，object 是值。' +
      '若已存在同「主体+关系」的当前有效事实，会先把它标记失效（保留历史），再写入新事实——用于修正会随时间变化的信息（如住址、状态、进度）。',
    parameters: paramsSchema({
      subject: { type: 'string', description: '主体，如 "主人"、"Zok66"、某个项目名' },
      predicate: { type: 'string', description: '关系或属性名，如 "居住地"、"GitHub用户名"、"当前状态"' },
      object: { type: 'string', description: '值（统一字符串）' },
      valueType: VALUE_TYPE_ENUM,
      source: { type: 'string', description: '来源备注（哪次会话/哪条指令）' },
      note: { type: 'string', description: '附注' },
    }, ['subject', 'predicate', 'object']),
    execute(args) {
      return s.set({
        subject: args.subject,
        predicate: args.predicate,
        object: args.object,
        valueType: VALUE_TYPES.includes(args.valueType) ? args.valueType : 'text',
        source: args.source,
        note: args.note,
        replace: true,
      })
    },
  }))

  ctx.tools.register(def({
    name: 'fact_get',
    description:
      '查询「当前有效」的事实。不传 subject/predicate 时返回全部有效事实；传 subject 可进一步按 predicate 过滤。这是 agent 回答前查记忆的主要入口。',
    parameters: paramsSchema({
      subject: { type: 'string', description: '主体过滤' },
      predicate: { type: 'string', description: '关系过滤' },
    }),
    execute(args) {
      return rowsToResult(s.getNow(args.subject, args.predicate))
    },
  }))

  ctx.tools.register(def({
    name: 'fact_get_at',
    description:
      '查询某个历史时刻有效的事实（时间旅行）。at 是 ISO 8601 时间字符串。命中条件：since <= at < until（until 为空视为无穷）。用于回溯「当时的状态」。',
    parameters: paramsSchema({
      subject: { type: 'string', description: '主体过滤' },
      at: { type: 'string', description: 'ISO 8601 时刻，如 "2026-06-01T00:00:00Z"' },
      predicate: { type: 'string', description: '关系过滤' },
    }, ['at']),
    execute(args) {
      return rowsToResult(s.getAt(args.at, args.subject, args.predicate))
    },
  }))

  ctx.tools.register(def({
    name: 'fact_list',
    description:
      '列出事实。默认只列当前有效（until IS NULL）；includeHistory=true 时列出全部含已失效的历史，按 since 倒序。',
    parameters: paramsSchema({
      includeHistory: { type: 'boolean', description: '是否包含已失效的历史事实' },
      subject: { type: 'string', description: '主体过滤' },
      predicate: { type: 'string', description: '关系过滤' },
    }),
    execute(args) {
      const rows = args.includeHistory === true
        ? s.listAll(args.subject, args.predicate)
        : s.getNow(args.subject, args.predicate)
      return rowsToResult(rows)
    },
  }))

  ctx.tools.register(def({
    name: 'fact_forget',
    description: '物理删除一条事实（按 id）。仅用于明确要求删除，不建议用于「修正」——修正请用 fact_set。',
    parameters: paramsSchema({
      id: { type: 'string', description: '事实 id（来自 fact_get / fact_list 结果）' },
    }, ['id']),
    execute(args) {
      return { deleted: s.forget(args.id) }
    },
  }))

  ctx.tools.register(def({
    name: 'fact_undo',
    description: '撤销最近一次写入（删除 since 最新的一条事实）。谨慎使用。',
    parameters: paramsSchema({}),
    execute() {
      return { deleted: s.undo() }
    },
  }))

  console.log(`[dsh-facts] 已启用：时间感知记忆（数据库 ${s.dbPath}）`)
}

function status() {
  return {
    name,
    version: '0.1.0',
    dbPath: store().dbPath,
    effectiveCount: store().getNow().length,
  }
}

export { apply, status }
