# dsh-subagent-reaper

DSH 会话页头的**子代理回收器**：一键列出当前会话的子代理，点行尾的 ✕ 回收它（连同其会话数据）。

![version](https://img.shields.io/badge/version-0.2.3-blue) ![license](https://img.shields.io/badge/license-MIT-green)

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

- 点开 → 两个页签：
  - **当前会话**：本会话的直接子代理，显示 `标签`、`可续接|一次性|外部 · 空闲|运行中`
  - **全部会话**：所有会话遗留的子代理，按父会话分组
- 点行尾 **✕** → 回收该子代理（含其全部后代）
- 底部「清理全部空闲」→ 批量回收（运行中的自动跳过）
- 底部「已回收 N 个（可撤销）」→ 点 id 芯片可撤销回收标记，让该行重新出现

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

插件因此维护一份本地名单 `<DSH_HOME>/subagent-reaper-reaped.json`：

- 回收成功后把 id 记进去，列表时过滤掉，用户看到的结果与实际删除一致
- 对「无产物但已不在 live 注册表」的目标也算回收成功（面板会注明「该子代理从未落盘，仅摘除并标记」）
- 名单可撤销（`POST /unreap`），撤销后该行重新出现
- 名单可整块清空（`POST /clear-reaped`），面板「已回收」标题行右侧的「清空」按钮就是它；清空只影响隐藏名单，已删除的数据不会回来

## 安全

- 路由鉴权走官方 `connection.requestRejection({ headers })`：已认证的同源页面（含桌面版 `dsh-app://` 转发）直接放行，未认证的外部请求一律 403
- 兼容旧路径：`connection` 服务不可用时退回 index 注入的随机 token（`x-reaper-token`，每次启动新生成）
- 只允许回收**子代理会话**；id 必须是 UUID；运行中的一律拒绝
- 删除**不可逆**，且只删主会话库（`$DSH_HOME/sessions/…`）；导出到项目目录的会话副本不受影响

## 结构

```
package.json         dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml     把插件行插入组合
lib/index.js         Host 半：8 条同源 HTTP 路由（list / all / purge / purge-idle / reaped / unreap / clear-reaped / diag）+ token 注入
lib/client.js        Client 半：window.__ModuleLoader__.load(...)，页头纯图标按钮 + 面板
```

## 修复记录

- **0.1.1**：修掉「删除失败：请求被拒绝或连接中断」。根因在 client 半：带 body 的请求没有设 `method`，`fetch` 默认 GET，而 **Fetch 规范禁止 GET 带 body**，浏览器直接抛 `TypeError`，被 `.catch` 吞成一句笼统提示。现在带 body 一律 POST，并把 HTTP 状态/网络原因原样显示在面板里。
- **0.1.1**：新增「全部会话」页签（`/all`），可清理**其他会话**遗留的子代理；空闲标绿、运行中标琥珀；底部提示与按钮分行，避免长提示把按钮挤换行。
- **0.1.2**：加删除 loading（行内旋转指示 + 「删除中…」/「清理中…」，期间按钮禁用）。
- **0.1.2**：修侧栏「项目名称 / N 个子代理」删完不消失（要重启才消）。
- **0.1.3**：client 半补 `sessions` 注入、刷新各刷两轮、Host 半删除前先 `flush` + `detachEntered` 摘除 live 会话。
- **0.1.3**：面板底部新增诊断行「侧栏计数 目录/快照 = 目录状态 子代理数/后代数」。
- **0.2.0（适配 DSH 0.2.2-rc.2）**：**修掉「读取不到子代理」**。0.1.3 依赖的 5 个 API 里有 4 个在 0.2.2-rc.2 不存在，全部换成现行契约：
  1. `subagents.listChildren(parentId)` → **不存在**。改用 `sessionQuery.observeSession(parentId).projections.values.subagentCatalog`（官方列直接子代理的口径），回退 `subagents.listDescendants(parentId)` 过滤 `depth === 1`。
  2. `sessionController.inspect(childId)` → **不存在**。改用 `sessionPersistence.stat(childId)` 取 `.header` / `.location`，回退 `locate(header)`。
  3. `shell.run(shell.resolve(...))` → **不存在**。改用 `shell.execute(spec)` + `await execution.result()`。
  4. `sessions.store`（Map）→ **不存在**。改用 `sessions.get(id)` + `sessions.liveEntryFor(live)` + `sessions.detachEntered(entry)`。
  5. client 的 `sessions.refresh()` / `refreshSubagents()` → **都不存在**。改用 `sessions.refreshProjections(sessionId)`（两轮）。
  6. client 的 `state.subagentsByParent[parentId]` → **该字段不存在**（asar 里搜不到）。改为由 Host 路由返回计数。
- **0.2.0**：页头按钮从「🧹 子代理 + 徽标」芯片改为**纯图标按钮**（官方 `IconUsersOutlineRegular`，28×28，无文字），靠 `title` / `aria-label` 说明用途；拿不到 primitives 时退回 emoji。
- **0.2.0**：面板从 `position: absolute` 改为 `position: fixed` + 由按钮矩形算坐标。页头祖先（`*_root` / `*_centerCol` / `*_frame`）都是 `overflow: hidden`，absolute 面板会被裁掉左半边（实测 440px 只剩 339px 可见）。
- **0.2.0**：页签切换时立即重新拉取（此前只切 `scope` 不刷新，切到「全部会话」仍显示旧数据）。
- **0.2.0**：新增「已回收」名单（见上），解决「删了还在列表里」与「从未落盘的子代理删不掉」两个问题；新增 `/reaped`、`/unreap` 两条路由与面板撤销入口。
- **0.2.1**：**修掉桌面版「读取失败：HTTP 403」**。桌面版窗口走 `dsh-app://app/` 协议转发，转发时会剥掉 `cookie` / `origin` / `host` / `sec-fetch-site` 再注入 Host 自己的 cookie，页面里那份 `<meta name="subagent-reaper-token">` 与 Host 进程当前 token 可能不同步，于是只认 token 的守卫把合法请求也拒了。现在守卫首选官方 `connection.requestRejection({ headers })`（Host/Origin fence + 签名 cookie 校验），未认证的外部请求仍返回 403，token 只作为 `connection` 不可用时的回退。
- **0.2.2**：**面板里的 UUID 换成会话名称**。Host 半新增 `readTitles(ids)`：优先 `sessionQuery.readTitleSnapshots(ids)`（一次批量、保留输入顺序、单条失败隔离），回退逐条 `sessionQuery.readTitle(id)`；`/list` 与 `/all` 的每一行都带 `title`，`/all` 的分组还带 `parentTitle`。Client 半显示优先级：**会话标题 → catalog `label` → UUID 前 20 位**，`title` 属性仍保留完整 UUID 便于核对。
- **0.2.2**：**删除后侧栏计数真正减一**。此前只调 `sessions.refreshProjections(parentId)`，而它在 `projectionLoads.get(id).state === 'ready'` 时**直接 resolve 不重拉**（asar 偏移 22650914），所以侧栏（按 `byId` 里 `origin === 'subagent' && parentId` 计数）不会变。现在 `syncClientState` 同时调 `sessions.refresh()`（= `manager.refreshList()`，走 `mergeOrderedBaseline`，宿主不再列出的会话会从 `byId` 消失）与 `refreshProjections(parentId)`，各两轮。
- **0.2.2**：**页头谱系仍会保留一行，这是 DSH 的设计**。`conversation.session.header.lineage` 的计数来自父会话日志里的 `subagent/catalog` 事件，该投影是 `appendChunkedList` 只追加，官方没有移除事件（`catalog-removed` / `subagent/retire` 在 asar 里命中数为 0），`sessionProjections` / `sessionProjectionCache` 也没有删除行的接口。插件无权改写父会话日志，因此面板底部如实说明：「删除后侧栏计数会同步刷新；页头谱系来自父会话日志（只追加），仍会保留一行」。
- **0.2.2**：`forgetProjection` 修正。0.2.2-rc.2 的 `sessionProjectionCache` 只有 `cachedSnapshot` / `cachedPredecessorTitle` / `hydratePrepared` / `write` / `coldSnapshot`，**没有 `requireTable`**；原实现调 `cache.requireTable().delete(id)` 会静默失败。现在只做能力探测（有 `forget` 才调），拿不到就跳过。
- **0.2.3**：**「已回收」那一栏可以整块删掉**。新增 `POST /subagent-reaper/clear-reaped`（Host 半 `clearReaped()` 把名单文件写成空数组），面板标题行右侧加「清空」按钮；每个 id 芯片也从「点一下撤销」改成「芯片 + ✕」，避免误触。清空只影响隐藏名单，已删除的会话数据不会回来。

## License

[MIT](./LICENSE)
