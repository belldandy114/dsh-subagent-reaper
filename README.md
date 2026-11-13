# dsh-subagent-reaper

DSH 会话页头的**子代理回收器**：一键列出当前会话的子代理，点行尾的 ✕ 回收它（连同其会话数据）。

![version](https://img.shields.io/badge/version-0.3.0-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 为什么需要

评审类子代理（`expert_*`）是一次性的，跑完就没人再用。但 DSH **没有删除子代理会话的公开 API**
（`subagents` 只有 interrupt/drain，`sessions` 无 delete），于是它们会一直留在父会话页头的谱系目录里，
侧栏还会显示「N 个子代理运行中」。这个插件补上这个缺口。

## 环境要求

- DSH Desktop **0.2.2-rc.2 及以上**（`webServer` / `sessionQuery` / `subagents` / `sessions` / `sessionPersistence` / `sessionProjectionCache` 服务齐备）
- Node.js ≥ 22

## 安装

```powershell
dsh plugin --profile desktop add github:belldandy114/dsh-subagent-reaper
```

本地开发用 `file:` 指向本仓库目录：

```powershell
dsh plugin --profile desktop add file:<本仓库绝对路径>
```

装完**重启 DSH**（新 bundle 在启动时进组合）。卸载：

```powershell
dsh plugin --profile desktop remove dsh-subagent-reaper
```

## 用法

会话页头右侧出现一个 **28×28 的纯图标按钮**（`IconUsersOutlineRegular`，无文字），
`title` / `aria-label` 都是「子代理回收：列出并删除子代理会话」，有子代理时右上角显示数量徽标：

- 点开 → 只列**当前会话**的直接子代理，每行显示 `会话名称`、`可续接|一次性|外部 · 空闲|运行中`
- 点行尾 **✕** → 弹二次确认「删除「xxx」？删除后无法恢复。」，确认后回收该子代理（含其全部后代）
- 底部一行：左边状态文字（如「数量已同步」），右边「清理全部空闲」→ 同样弹二次确认后批量回收（运行中的自动跳过）
- 删除**不可恢复**，所以两个入口都要显式确认；已删除的子代理不会再出现在列表里

## 回收机制

| 步 | 调用 | 作用 |
|:-:|:--|:--|
| 1 | `sessionQuery.observeSession(parentId).projections.values.subagentCatalog` | 列**当前会话的直接子代理**（官方口径；失败回退 `subagents.listDescendants` 取 `depth === 1`） |
| 2 | `sessionQuery.listSessions()` | 全量会话记录（live + persisted），用于「全部会话」页签与后代收集 |
| 3 | `sessions.get(id)` → `sessions.flush(live)` → `sessions.liveEntryFor(live)` + `sessions.detachEntered(entry)` | **让宿主忘掉这个会话**（否则 `sessionQuery` 仍把它当 live 返回） |
| 4 | `sessionPersistence.stat(id).location.path`（回退 `locate(header)`） | 取会话产物目录 `<DSH_HOME>/sessions/<slug>/<id>/` |
| 5 | `rm(dir, { recursive: true, force: true })` | 删产物目录；删完 `stat()` 复查，再等 150ms 二次确认没被写回来 |
| 6 | `ctx.emit('api-session/removed', id)` | 通知客户端该会话已离开 live 注册表 |

顺序不能颠倒：摘除会触发 persistence 的 `session/disposed` → `retire` → `flush`，**它会把缓冲事件写回文件**。
所以先 flush、再摘除、等落盘结束，最后才删文件，并在删完后再确认一次。

### 为什么需要「已回收」名单

父会话的 `subagentCatalog` 投影是**只追加**的（`appendChunkedList`），DSH 没有任何「移除子代理」事件
（`removeSubagent` / `forgetSubagent` / `subagent/removed` 在 0.2.2-rc.2 里都不存在）。
所以删掉子会话数据后，父会话目录里那一行**仍然会被读出来**（降级为 diagnostic）。

另外，**从未落盘的子代理**（continuable 模式、跑完但没被 flush 过）在磁盘上根本没有目录，
只有父会话日志里一条 `subagent/catalog` 事件 —— 这类目标没有产物可删。

插件因此维护一份本地名单 `<DSH_HOME>/subagent-reaper-reaped.json`（`{version:2, ids, dismissed}`）：

- 回收成功后把 id 记进 `ids`，列表时过滤掉，用户看到的结果与实际删除一致
- 对「无产物但已不在 live 注册表」的目标也算回收成功（面板会注明「该子代理从未落盘，仅摘除并标记」）
- 0.3.0 起面板**不再显示**这份名单（删了就不恢复，没有「已回收」栏）；`/dismiss`、`/clear-reaped`、`/unreap` 仍保留在 API 里，供脚本或排障使用
- 需要真正恢复可见性时用 `POST /unreap`（面板不暴露这个入口，避免误触）

## 安全

- 路由鉴权走官方 `connection.requestRejection({ headers })`：已认证的同源页面（含桌面版 `dsh-app://` 转发）直接放行，未认证的外部请求一律 403
- 兼容旧路径：`connection` 服务不可用时退回 index 注入的随机 token（`x-reaper-token`，每次启动新生成）
- 只允许回收**子代理会话**；id 必须是 UUID；运行中的一律拒绝
- 删除**不可逆**，且只删主会话库（`$DSH_HOME/sessions/…`）；导出到项目目录的会话副本不受影响

## 结构

```
package.json         dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml     把插件行插入组合
lib/index.js         Host 半：9 条同源 HTTP 路由（list / all / purge / purge-idle / reaped / dismiss / unreap / clear-reaped / diag）+ token 注入
lib/client.js        Client 半：window.__ModuleLoader__.load(...)，页头纯图标按钮 + 单页签面板（当前会话）
```


## License

[MIT](./LICENSE)
