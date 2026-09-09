/**
 * dsh-subagent-reaper · Host 半
 *
 * 会话页头的「子代理」芯片（client 半）通过同源 HTTP 路由调用这里：
 *   GET  /subagent-reaper/list        列出某会话的直接子代理
 *   GET  /subagent-reaper/all         列出**所有会话**的子代理（按父会话分组，用于清理旧会话留下的）
 *   POST /subagent-reaper/purge       删除一个子代理的会话数据（scope=child 仅限本会话直接子代理；scope=any 允许跨会话）
 *   POST /subagent-reaper/purge-idle  删除全部空闲子代理
 *
 * 删除机制（2026-09-09 实测可行）：
 *   1. subagents.listChildren(parent) / sessionController.list()  —— 枚举目标，运行中的拒绝
 *   2. sessionController.inspect(child)                          —— 拿到该子代理的 SessionHeader
 *   3. sessionPersistence.locate(header)                         —— 拿到会话产物绝对路径（<DSH_HOME>/sessions/<slug>/<id>/session.jsonl.zstd）
 *   4. shell（PowerShell Remove-Item）                            —— 用调用方会话的沙箱策略删除；随后清空留下的空目录
 *
 * 安全：路由要求 index 注入的随机 token（x-reaper-token），token 只出现在页面 HTML 里；
 *       删除用的沙箱策略取自调用方会话，read-only 会话会被沙箱拒绝。
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-subagent-reaper'
export const inject = ['webServer']

const BASE = '/subagent-reaper'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bare = (value) => String(value === undefined || value === null ? '' : value).replace(/^session-/, '')
const str = (value) => (value === undefined || value === null ? '' : String(value))
const quote = (value) => String(value).replace(/'/g, "''")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload === undefined ? null : payload)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) req.destroy()
    })
    req.on('end', () => {
      if (data === '') return resolve({})
      try { resolve(JSON.parse(data)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx) {
  const token = randomUUID()
  const get = (key) => ctx.get(key)
  /** 客户端最近一次上报的侧栏计数诊断（POST /diag 写入，GET /diag 读回）。 */
  let lastDiag = null

  ctx.effect(() => ctx.webServer.tapIndex((html) => (
    html.indexOf('subagent-reaper-token') >= 0
      ? html
      : html.replace('</head>', '  <meta name="subagent-reaper-token" content="' + token + '">\n</head>')
  )), 'subagent-reaper.token')

  const policyFor = (sessionId) => {
    const sessions = get('sessions')
    const sandboxPolicy = get('sandboxPolicy')
    let session
    if (sessions !== undefined && sessionId !== '') {
      try { session = sessions.get(sessionId) } catch { session = undefined }
    }
    let policy
    if (sandboxPolicy !== undefined) {
      try { policy = sandboxPolicy.resolve(session === undefined || session === null ? {} : { session }) } catch { policy = undefined }
    }
    let workdir
    if (session !== undefined && session !== null && session.header !== undefined && typeof session.header.cwd === 'string') workdir = session.header.cwd
    else if (policy !== undefined && typeof policy.workspaceRoot === 'string') workdir = policy.workspaceRoot
    return { policy, workdir }
  }

  const runShell = async (command, sessionId) => {
    const shell = get('shell')
    if (shell === undefined) return { ok: false, reason: 'shell-unavailable' }
    const env = policyFor(sessionId)
    let result
    try {
      const request = { command, timeoutMs: 20000 }
      if (env.workdir !== undefined) request.workdir = env.workdir
      if (env.policy !== undefined) request.sandboxPolicy = env.policy
      result = await shell.run(shell.resolve(request))
    } catch (error) {
      return { ok: false, reason: 'shell-failed: ' + str(error && error.message ? error.message : error) }
    }
    const stdout = result && result.stdout ? str(result.stdout.text) : ''
    const stderr = result && result.stderr ? str(result.stderr.text) : ''
    const sandbox = result && result.sandbox ? (result.sandbox.denied === true ? 'denied' : str(result.sandbox.mode)) : ''
    return { ok: true, exitCode: result ? result.exitCode : null, stdout: stdout.trim().slice(0, 400), stderr: stderr.trim().slice(0, 400), sandbox }
  }

  /** 本会话的直接子代理。 */
  const listChildren = async (parentId) => {
    const subagents = get('subagents')
    if (subagents === undefined) return { ok: false, reason: 'subagents-unavailable' }
    if (parentId === '') return { ok: false, reason: 'no-parent' }
    let rows
    try { rows = await subagents.listChildren(parentId) } catch (error) {
      return { ok: false, reason: 'list-failed: ' + str(error && error.message ? error.message : error) }
    }
    const children = []
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || row === undefined || row.kind !== 'child') continue
      children.push({
        id: String(row.id),
        mode: row.mode === 'continuable' ? 'continuable' : 'one-shot',
        activity: row.activity === 'running' ? 'running' : 'inactive',
        label: str(row.label),
        hasChildren: row.hasChildren === true,
      })
    }
    return { ok: true, children }
  }

  /** 所有会话的子代理，按父会话分组（清理旧会话遗留用）。 */
  const listAll = async () => {
    const controller = get('sessionController')
    if (controller === undefined) return { ok: false, reason: 'controller-unavailable' }
    let value
    try { value = await controller.list({}, undefined) } catch (error) {
      return { ok: false, reason: 'list-failed: ' + str(error && error.message ? error.message : error) }
    }
    const items = value !== undefined && value !== null && Array.isArray(value.items) ? value.items : []
    const groups = new Map()
    for (const item of items) {
      if (item === null || item === undefined) continue
      const parent = item.parentSessionId === undefined || item.parentSessionId === null ? '' : String(item.parentSessionId)
      if (item.origin !== 'subagent' && parent === '') continue
      if (!groups.has(parent)) groups.set(parent, [])
      groups.get(parent).push({
        id: String(item.sessionId),
        running: item.running === true,
        blank: item.blank === true,
      })
    }
    const out = []
    for (const [parent, children] of groups) {
      children.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      out.push({ parent, children })
    }
    out.sort((a, b) => String(a.parent).localeCompare(String(b.parent)))
    return { ok: true, groups: out, total: out.reduce((sum, group) => sum + group.children.length, 0) }
  }

  const artifactOf = async (childId) => {
    const persistence = get('sessionPersistence')
    const controller = get('sessionController')
    if (persistence === undefined || controller === undefined) return ''
    try {
      const inspection = await controller.inspect(childId)
      const location = persistence.locate(inspection.meta)
      if (location !== undefined && location !== null && typeof location.path === 'string') return location.path
    } catch { /* artifact unknown */ }
    return ''
  }

  /**
   * 让宿主立刻忘掉这个子代理会话（0.1.3 的核心修复）。
   *
   * 只删磁盘产物是不够的：已挂载的会话仍留在 SessionStore 里，而
   * sessionQuery.listSessions() = 磁盘记录 + live 会话，于是 session.list 与
   * subagents.list 依然返回它 —— 客户端侧栏「项目名 / N 个子代理」取的是这两份
   * 数据的后代计数，所以计数不降，直到重启 DSH 重建进程内的会话注册表。
   *
   * 这里做进程退出时同样的那一步：先 flush 缓冲事件，再摘除 SessionStore 条目
   * （detachEntered 就是 enter() 返回给 fiber 的那个 disposer 本体）。
   * 顺序很关键：摘除会触发 persistence 的 session/disposed → retire → flush，
   * 它会把缓冲事件写回文件；所以必须等它落盘完成再删文件，否则文件会被写回来。
   */
  const forgetLive = async (childId) => {
    const sessions = get('sessions')
    if (sessions === undefined) return 'sessions-unavailable'
    let store
    try { store = sessions.store } catch { store = undefined }
    if (!(store instanceof Map)) return 'store-unavailable'
    let entry
    try { entry = store.get(childId) } catch { entry = undefined }
    if (entry === undefined) return 'not-live'
    let session
    try { session = sessions.get(childId) } catch { session = undefined }
    if (session !== undefined && session !== null && typeof sessions.flush === 'function') {
      try { await sessions.flush(session) } catch { /* 落盘失败也继续：删除优先 */ }
    }
    try {
      if (typeof sessions.detachEntered !== 'function') return 'detach-unavailable'
      sessions.detachEntered(entry)
    } catch (error) {
      return 'detach-failed: ' + str(error && error.message ? error.message : error)
    }
    await sleep(250)
    return 'detached'
  }

  /**
   * 删除一个子代理。
   * scope='child'：必须是指定会话的直接子代理；scope='any'：只要它是子代理会话即可（跨会话清理）。
   */
  const purgeOne = async (sessionId, childId, scope) => {
    const wantForeign = scope === 'any'
    let target = null
    if (wantForeign) {
      const all = await listAll()
      if (all.ok !== true) return all
      for (const group of all.groups) {
        for (const child of group.children) {
          if (child.id === childId || bare(child.id) === bare(childId)) target = { id: child.id, activity: child.running ? 'running' : 'inactive', parent: group.parent, label: '' }
        }
      }
    } else {
      const listing = await listChildren(sessionId)
      if (listing.ok !== true) return listing
      const hits = listing.children.filter((child) => child.id === childId || bare(child.id) === bare(childId))
      if (hits.length > 0) target = hits[0]
    }
    if (target === null) return { ok: false, reason: wantForeign ? 'not-a-subagent-session' : 'not-a-direct-child' }
    if (target.activity === 'running') return { ok: false, reason: 'running' }
    const uuid = bare(target.id)
    if (!UUID_RE.test(uuid)) return { ok: false, reason: 'unexpected-id-format' }
    const artifact = await artifactOf(target.id)
    if (artifact === '') return { ok: false, reason: 'artifact-not-found' }
    const liveNote = await forgetLive(target.id)
    const removed = await runShell("$ErrorActionPreference = 'Stop'; $p = '" + quote(artifact) + "'; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force; Write-Output ('DELETED') } else { Write-Output ('MISSING') }", sessionId)
    if (removed.ok !== true) return { ok: false, reason: removed.reason, path: artifact, live: liveNote }
    if (removed.stdout.indexOf('DELETED') !== 0) {
      return { ok: false, reason: 'exit=' + String(removed.exitCode) + ' out=' + removed.stdout + ' err=' + removed.stderr, path: artifact, live: liveNote }
    }
    const dir = artifact.replace(/[\\/][^\\/]+$/, '')
    let dirNote = ''
    if (dir.endsWith(uuid)) {
      const cleaned = await runShell("$ErrorActionPreference = 'SilentlyContinue'; $d = '" + quote(dir) + "'; if (Test-Path -LiteralPath $d) { $n = @(Get-ChildItem -LiteralPath $d -Force).Count; if ($n -eq 0) { Remove-Item -LiteralPath $d -Force; Write-Output ('DIR_REMOVED') } else { Write-Output ('DIR_KEPT ' + $n) } } else { Write-Output ('DIR_GONE') }", sessionId)
      dirNote = cleaned.ok === true ? cleaned.stdout : ''
    }
    // 摘除 live 会话时，persistence 的 retire 链可能还在写盘；再确认一次文件没被写回来。
    let lateNote = ''
    if (liveNote === 'detached') {
      await sleep(200)
      const again = await runShell("$ErrorActionPreference = 'SilentlyContinue'; $p = '" + quote(artifact) + "'; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force; Write-Output ('REAPED_AGAIN') } else { Write-Output ('STAYED_GONE') }", sessionId)
      lateNote = again.ok === true ? again.stdout : ''
    }
    return { ok: true, reason: 'deleted', path: artifact, label: target.label, parent: target.parent, dir: dirNote, live: liveNote, late: lateNote }
  }

  const purgeIdle = async (sessionId, scope) => {
    const results = []
    if (scope === 'any') {
      const all = await listAll()
      if (all.ok !== true) return all
      for (const group of all.groups) {
        for (const child of group.children) {
          if (child.running) { results.push({ id: child.id, ok: false, reason: 'running' }); continue }
          const one = await purgeOne(sessionId, child.id, 'any')
          results.push({ id: child.id, ok: one.ok === true, reason: str(one.reason) })
        }
      }
    } else {
      const listing = await listChildren(sessionId)
      if (listing.ok !== true) return listing
      for (const child of listing.children) {
        if (child.activity === 'running') { results.push({ id: child.id, ok: false, reason: 'running' }); continue }
        const one = await purgeOne(sessionId, child.id, 'child')
        results.push({ id: child.id, ok: one.ok === true, reason: str(one.reason) })
      }
    }
    return { ok: true, removed: results.filter((row) => row.ok === true).length, total: results.length, results }
  }

  const guard = (req) => req.headers['x-reaper-token'] === token

  const routes = [
    {
      kind: 'exact',
      path: BASE + '/list',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return sendJson(res, 200, await listChildren(str(req.headers['x-reaper-parent'])))
      },
    },
    {
      kind: 'exact',
      path: BASE + '/all',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return sendJson(res, 200, await listAll())
      },
    },
    {
      kind: 'exact',
      path: BASE + '/purge',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        const body = await readBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
        const childId = str(body.childId)
        if (childId === '') return sendJson(res, 400, { ok: false, reason: 'no-child' })
        const scope = body.scope === 'any' ? 'any' : 'child'
        return sendJson(res, 200, await purgeOne(str(body.parentId), childId, scope))
      },
    },
    {
      kind: 'exact',
      path: BASE + '/purge-idle',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        const body = await readBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
        const scope = body.scope === 'any' ? 'any' : 'child'
        return sendJson(res, 200, await purgeIdle(str(body.parentId), scope))
      },
    },
    {
      kind: 'exact',
      path: BASE + '/diag',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        if (req.method === 'GET') return sendJson(res, 200, lastDiag === null ? { ok: false, reason: 'no-diag' } : lastDiag)
        const body = await readBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
        // 只保留已知标量字段，避免把任意对象存进内存。
        lastDiag = {
          ok: true,
          at: Date.now(),
          parent: str(body.parent).slice(0, 80),
          counts: str(body.counts).slice(0, 80),
          phase: str(body.phase).slice(0, 40),
          sync: str(body.sync).slice(0, 40),
          hasRefresh: body.hasRefresh === true,
          hasCatalog: body.hasCatalog === true,
        }
        return sendJson(res, 200, { ok: true })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'subagent-reaper.routes')
}
