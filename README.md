# dsh-facts — 时间感知记忆

复刻 [Graphiti](https://github.com/getzep/Graphiti) 的两点核心价值，但砍掉全部重型依赖，做成**纯本地、零外部服务、DSHA 即装即用**的记忆插件：

1. **每条事实带时间戳**（`since` 生效 / `until` 失效）；
2. **新事实自动使旧事实失效**（不删除，保留历史可回溯）。

## 设计

- 存储：**SQLite 单文件**（`node:sqlite` 内置，零 npm 依赖），默认落在 `data/facts.db`，可用环境变量 `DSH_FACTS_DB` 覆盖。
- 事实模型：`subject`（主体）+ `predicate`（关系/属性）+ `object`（值）+ `since` + `until`。
- 时间语义：`until = NULL` 表示「当前仍有效」；`set` 同「主体+关系」时，把旧事实填上 `until=now`，再插入新事实。
- 历史回溯：`fact_get_at(at)` 命中 `since <= at < until`，可查「某天当时的状态」。

## 能力

### 工具（agent 会话内可直接调用）

| 工具 | 作用 |
|---|---|
| `fact_set` | 记录/更新事实；同「主体+关系」自动失效旧值 |
| `fact_get` | 查当前有效事实 |
| `fact_get_at` | 查某历史时刻（ISO 8601）有效事实 |
| `fact_list` | 列当前（或含历史）事实 |
| `fact_forget` | 按 id 物理删除 |
| `fact_undo` | 撤销最近一次写入 |

### 记忆注入

插件注册一个系统提示词段落，**每轮自动把当前有效事实渲染进提示词**，让未来的会话直接「记得」这些事实；当用户陈述的新事实与记忆冲突时，agent 会调用 `fact_set` 更新（旧值自动失效）。

## 安装

```sh
# 1. 把插件加进 profile 依赖与 bundles（link 模式）
dsh plugin --profile web add /path/to/dsh-facts
# 手动编辑 package.json：dependencies 加 "dsh-facts": "link:/path/to/dsh-facts"，
# dsh.profile.bundles 列表追加 "dsh-facts"

# 2. 重启 web profile 生效
```

## 为什么不是 Graphiti 本体

Graphiti 需要图数据库（Neo4j / FalkorDB / Kuzu）服务端 + 反复调用 LLM 做实体抽取，在手机容器里跑不起来，也塞不进 JS 插件体系。本插件只保留「时间戳 + 自动失效」这一精髓，用 SQLite + 静态 schema 实现同等语义，成本趋近于零。

## License

MIT
