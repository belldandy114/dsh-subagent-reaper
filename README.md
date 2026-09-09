# dsh-subagent-reaper

DSH 会话页头的**子代理回收器**：一键列出当前会话的子代理，点行尾的 ✕ 删除它（连同其会话数据）。

![version](https://img.shields.io/badge/version-0.1.3-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 为什么需要

评审类子代理（`expert_*`）是一次性的，跑完就没人再用。但 DSH **没有删除子代理会话的公开 API**
（`subagents` 只有 interrupt/drain，`sessions` 无 delete），于是它们会一直留在父会话页头的谱系目录里，
侧栏还会显示「N 个子代理运行中」。这个插件补上这个缺口。

## 环境要求

- DSH Desktop（含 `dsh` CLI，`webServer` / `subagents` / `sessionController` / `sessionPersistence` / `shell` 服务齐备）
- Node.js ≥ 22

## 安装

```powershell
dsh plugin --profile desktop add github:belldandy114/dsh-subagent-reaper
```

本地开发用 `link:` 指向本仓库目录：

```powershell
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

装完**重启 DSH**（新 bundle 在启动时进组合）。卸载：

```powershell
dsh plugin --profile desktop remove dsh-subagent-reaper
```

## 用法

会话页头右侧出现「🧹 子代理」芯片（有子代理时显示数量徽标）：

- 点开 → 列表显示 `标签 / id`、`one-shot|continuable`、`空闲|运行中`
- 点行尾 **✕** → 删除该子代理
- 底部「清理全部空闲」→ 批量删除（运行中的自动跳过）

## 删除机制

| 步 | 调用 | 作用 |
|:-:|:--|:--|
| 1 | `subagents.listChildren(parentSessionId)` | 只枚举**当前会话的直接子代理**，运行中的拒绝删除 |
| 2 | `sessionController.inspect(childId)` | 取该子代理的 `SessionHeader` |
| 3 | `sessionPersistence.locate(header)` | 取会话产物绝对路径 `<DSH_HOME>/sessions/<slug>/<id>/session.jsonl.zstd` |
| 4 | `sessions.flush` + `sessions.detachEntered` | **让宿主忘掉这个会话**（见下） |
| 5 | `shell`（PowerShell `Remove-Item`） | 用**父会话自己的沙箱策略**删除产物；随后清空空目录，再确认文件没被写回来 |

第 4 步是 0.1.3 补上的关键一环：**只删磁盘产物不够**。`sessionQuery.listSessions()` = 磁盘记录 **+ 进程内的 live 会话**，所以已挂载的会话即使文件被删，`session.list` / `subagents.list` 仍会返回它，客户端计数自然不降，要重启 DSH 重建注册表才消失。`detachEntered` 正是 `enter()` 交给 fiber 的那个 disposer 本体（等于进程退出时做的那一步）。

顺序不能颠倒：摘除会触发 persistence 的 `session/disposed` → `retire` → `flush`，**它会把缓冲事件写回文件**（实测会新建出 262 字节的 header-only 产物）。所以先 flush、再摘除、等落盘结束，最后才删文件，并在删完后再确认一次。

删掉后子代理从 `listChildren` / 会话列表里消失；client 半再调 `sessions.refresh()` + `sessions.refreshSubagents(parentId)`（**各两轮**，因为这两个调用都是「单飞」复用 in-flight 请求，第一轮可能并入删除前发出的旧请求），页头谱系与侧栏计数同步刷新。

## 安全

- 路由需要 index 注入的随机 token（`x-reaper-token`，每次启动新生成），页面外的请求拿不到
- 只允许删**当前会话的直接子代理**；id 必须是 UUID；运行中的一律拒绝
- 删除用目标会话的沙箱策略：`read-only` 会话里会被沙箱拦下，不会绕过策略
- 删除**不可逆**，且只删主会话库（`$DSH_HOME/sessions/…`）；导出到项目目录的会话副本不受影响

## 结构

```
package.json         dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml     把插件行插入组合
lib/index.js         Host 半：5 条同源 HTTP 路由（list / all / purge / purge-idle / diag）+ token 注入
lib/client.js        Client 半：window.__ModuleLoader__.load(...)，页头芯片 UI
```

## 修复记录

- **0.1.1**：修掉「删除失败：请求被拒绝或连接中断」。根因在 client 半：带 body 的请求没有设 `method`，`fetch` 默认 GET，而 **Fetch 规范禁止 GET 带 body**，浏览器直接抛 `TypeError`，被 `.catch` 吞成一句笼统提示。现在带 body 一律 POST，并把 HTTP 状态/网络原因原样显示在面板里。
- **0.1.1**：新增「全部会话」页签（`/all`），可清理**其他会话**遗留的子代理；空闲标绿、运行中标琥珀；底部提示与按钮分行，避免长提示把按钮挤换行。
- **0.1.2**：加删除 loading（行内旋转指示 + 「删除中…」/「清理中…」，期间按钮禁用）。
- **0.1.2**：修侧栏「项目名称 / N 个子代理」删完不消失（要重启才消）。根因：该计数取客户端会话快照 `summaries` 的后代计数，而 `refreshSubagents()` 只刷新子代理目录、不动 `summaries`。现在删除后额外调 `sessions.refresh()`（全量重拉 `session.list` 基线），被删子代理立刻从快照消失。
- **0.1.3**：0.1.2 的两处刷新在实测里仍可能无效，补三处：
  1. client 半此前只声明 `inject: ["slots"]`，改用 `ctx.sessions`（`dsh.client.inject` 补 `sessions`），确保会话状态服务真的在手；
  2. 两个刷新调用各刷**两轮** —— 它们都是单飞（复用 in-flight 请求），第一轮可能并入了删除之前就已发出的请求，拿回来的是旧基线；
  3. Host 半删除前先 `flush` + `detachEntered` 摘除 live 会话（见「删除机制」第 4 步）——**这才是"必须重启 DSH 才消失"的根因**：已挂载会话不删文件就不算消失。
- **0.1.3**：面板底部新增诊断行「侧栏计数 目录/快照 = 目录状态 子代理数/后代数」，与页头芯片同一口径复算；每次计数变化或同步完成都会把该行上报到 `POST /subagent-reaper/diag`（可用 `GET` 读回最近一次），排障时不用再猜客户端看到了什么。

## License

[MIT](./LICENSE)


