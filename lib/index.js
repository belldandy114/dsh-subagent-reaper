/**
 * dsh-subagent-reaper · Host 半
 *
 * 会话页头的「子代理回收」按钮（client 半）通过同源 HTTP 路由调用这里：
 *   GET  /subagent-reaper/list        列出某会话的直接子代理
 *   GET  /subagent-reaper/all         列出**所有会话**的子代理（按父会话分组）
 *   POST /subagent-reaper/purge       删除一个子代理（含其全部后代）的会话数据
 *   POST /subagent-reaper/purge-idle  删除全部空闲子代理
 *   GET  /subagent-reaper/diag        宿主侧服务可用性诊断
 *
 * 枚举（0.2.x 真实 API）：
 *   sessionQuery.observeSession(parentId).projections.values.subagentCatalog
 *     —— 官方列「直接子代理」的唯一正确来源（@deepseek-ai/dsh-subagent 内部同款）。
 *   回退：subagents.listDescendants(parentId) 过滤 depth === 1。
 *   全量：sessionQuery.listSessions() → SessionRecord[]（含 persisted 冷会话）。
 *
 * 删除（对齐 @michengai/dsh-archive-manager 的删除链）：
 *   1. sessions.flush(live)                      —— 先把缓冲事件落盘
 *   2. sessions.liveEntryFor(live) + detachEntered(entry)
 *                                                —— 把会话从进程内 SessionStore 摘除，
 *                                                   否则 sessionQuery 仍会把它当 live 返回
 *   3. sessionPersistence.stat(id).location.path —— 取产物绝对路径
 *      （回退 persistence.locate(header)）
 *   4. node:fs/promises rm(dir, {recursive:true}) —— 直接删会话目录（不走 shell/沙箱）
 *   5. ctx.emit('api-session/removed', id)       —— 通知客户端刷新
 *
 * 安全：路由要求 index 注入的随机 token（x-reaper-token），token 只出现在页面 HTML 里；
 *       删除前校验目标路径必须是 <...>/<sessionId>/ 形态，拒绝符号链接与相对路径。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const name = 'dsh-subagent-reaper'
export const inject = ['webServer']

const BASE = '/subagent-reaper'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bare = (value) => String(value === undefined || value === null ? '' : value).replace(/^session-/, '')
const str = (value) => (value === undefined || value === null ? '' : String(value))
const msg = (error) => str(error !== null && error !== undefined && error.message !== undefined ? error.message : error)
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

/** 把 subagentCatalog / listDescendants 的行统一成 UI 需要的形状。 */
function normalizeRow(row) {
  if (row === null || row === undefined || typeof row !== 'object') return null
  const id = row.id === undefined || row.id === null ? '' : String(row.id)
  if (id === '') return null
  if (row.kind === 'diagnostic') {
    return { id, diagnostic: true, reason: str(row.reason), activity: 'inactive', mode: 'unknown', label: '', hasChildren: false }
  }
  const mode = row.mode === 'continuable' ? 'continuable' : (row.mode === 'external' ? 'external' : 'one-shot')
  return {
    id,
    diagnostic: false,
    reason: '',
    activity: row.activity === 'running' ? 'running' : 'inactive',
    mode,
    label: str(row.label !== undefined && row.label !== null ? row.label : row.name),
    hasChildren: row.hasChildren === true,
  }
}

export function apply(ctx) {
  const token = randomUUID()
  const get = (key) => ctx.get(key)

  ctx.effect(() => ctx.webServer.tapIndex((html) => (
    html.indexOf('subagent-reaper-token') >= 0
      ? html
      : html.replace('</head>', '  <meta name="subagent-reaper-token" content="' + token + '">\n</head>')
  )), 'subagent-reaper.token')

  /**
   * 回收墓碑。
   *
   * 关键限制：父会话的 subagentCatalog 投影是**只追加**的（appendChunkedList），
   * 官方没有任何「移除子代理」事件，所以删掉子会话数据后，父会话目录里那一行
   * 仍然会被 listDescendants / observeSession 读出来（降级为 diagnostic）。
   * 因此本插件在本地记一份「已回收」名单，列表时过滤掉，让用户看到的结果与
   * 实际删除一致；名单可撤销（/unreap）。
   */
  const tombstoneFile = () => {
    const home = str(process.env.DSH_HOME) !== '' ? str(process.env.DSH_HOME) : join(homedir(), '.dsh')
    return join(home, 'subagent-reaper-reaped.json')
  }

  const readTombstones = async () => {
    try {
      const text = await readFile(tombstoneFile(), 'utf8')
      const parsed = JSON.parse(text)
      const ids = parsed !== null && parsed !== undefined && Array.isArray(parsed.ids) ? parsed.ids : []
      return new Set(ids.map((id) => bare(id)))
    } catch { return new Set() }
  }

  const writeTombstones = async (set) => {
    const file = tombstoneFile()
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ version: 1, ids: Array.from(set) }, null, 2), 'utf8')
      return true
    } catch { return false }
  }

  const markReaped = async (ids) => {
    const set = await readTombstones()
    let changed = false
    for (const id of ids) {
      const key = bare(id)
      if (key === '' || set.has(key)) continue
      set.add(key)
      changed = true
    }
    if (changed) await writeTombstones(set)
    return changed
  }

  const unmarkReaped = async (id) => {
    const set = await readTombstones()
    const key = bare(id)
    if (!set.has(key)) return false
    set.delete(key)
    await writeTombstones(set)
    return true
  }

  /** 清空整份「已回收」名单（面板上那一栏可以整块删掉）。 */
  const clearReaped = async () => {
    const set = await readTombstones()
    const count = set.size
    if (count === 0) return { ok: true, cleared: 0 }
    const written = await writeTombstones(new Set())
    return { ok: written, cleared: written ? count : 0 }
  }

  /** 读一个会话的 subagentCatalog 投影（官方列直接子代理的方式）。 */
  const readCatalog = async (parentId) => {
    const query = get('sessionQuery')
    if (query === undefined || query === null || typeof query.observeSession !== 'function') {
      return { ok: false, reason: 'sessionQuery-unavailable' }
    }
    let observation
    try {
      observation = await query.observeSession(parentId, { projectionMode: 'all' })
    } catch (error) {
      return { ok: false, reason: 'observe-failed: ' + msg(error) }
    }
    try {
      const entries = observation !== null && observation !== undefined && observation.projections !== undefined && observation.projections !== null
        ? observation.projections.values.subagentCatalog
        : undefined
      if (!Array.isArray(entries)) return { ok: false, reason: 'catalog-unavailable' }
      return { ok: true, entries }
    } finally {
      try { if (observation !== undefined && observation !== null && typeof observation.dispose === 'function') observation.dispose() } catch { /* lease already gone */ }
    }
  }

  /** 回退路径：subagents.listDescendants 只取 depth === 1 的直接子代理。 */
  const readDescendants = async (parentId) => {
    const subagents = get('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.listDescendants !== 'function') {
      return { ok: false, reason: 'subagents-unavailable' }
    }
    let rows
    try { rows = await subagents.listDescendants(parentId) } catch (error) {
      return { ok: false, reason: 'list-failed: ' + msg(error) }
    }
    const entries = []
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || row === undefined) continue
      if (row.kind === 'diagnostic') { entries.push(row); continue }
      if (row.kind !== 'child') continue
      if (row.depth !== undefined && row.depth !== null && row.depth !== 1) continue
      entries.push(row)
    }
    return { ok: true, entries }
  }

  /**
   * 批量读会话标题（面板里把 UUID 显示成会话名称）。
   * 优先 sessionQuery.readTitleSnapshots（一次观测、保留输入顺序、单条失败隔离），
   * 回退逐条 readTitle。读不到就返回空 Map，调用方回退短 id。
   */
  const readTitles = async (ids) => {
    const out = new Map()
    const list = Array.from(new Set(ids.map((id) => str(id)).filter((id) => id !== '')))
    if (list.length === 0) return out
    const query = get('sessionQuery')
    if (query === undefined || query === null) return out
    if (typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(list)
        for (const result of Array.isArray(results) ? results : []) {
          if (result === null || result === undefined) continue
          if (result.status !== 'fulfilled') continue
          const value = result.value
          const title = value !== null && value !== undefined && value.title !== undefined && value.title !== null
            ? str(value.title.title)
            : ''
          if (title !== '') out.set(str(result.sessionId), title)
        }
        return out
      } catch { /* 批量失败时退回逐条 */ }
    }
    if (typeof query.readTitle === 'function') {
      for (const id of list) {
        try {
          const snapshot = await query.readTitle(id)
          const title = snapshot !== null && snapshot !== undefined ? str(snapshot.title) : ''
          if (title !== '') out.set(id, title)
        } catch { /* 单条读不到就跳过 */ }
      }
    }
    return out
  }

  /** 本会话的直接子代理。 */
  const listChildren = async (parentId) => {
    if (parentId === '') return { ok: false, reason: 'no-parent' }
    let source = await readCatalog(parentId)
    let via = 'catalog'
    if (source.ok !== true) {
      const fallback = await readDescendants(parentId)
      if (fallback.ok === true) { source = fallback; via = 'descendants' } else {
        return { ok: false, reason: source.reason + ' / ' + fallback.reason }
      }
    }
    const reaped = await readTombstones()
    const children = []
    for (const row of source.entries) {
      const normalized = normalizeRow(row)
      if (normalized === null) continue
      if (reaped.has(bare(normalized.id))) continue
      children.push(normalized)
    }
    // 补会话标题：面板里优先显示名称，读不到才回退短 id。
    const titles = await readTitles(children.map((child) => child.id))
    for (const child of children) {
      const title = titles.get(str(child.id))
      child.title = title === undefined ? '' : title
    }
    return { ok: true, via, children }
  }

  /** 全量会话记录（live + persisted）。 */
  const readRecords = async () => {
    const query = get('sessionQuery')
    if (query !== undefined && query !== null && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        return { ok: true, records: Array.isArray(records) ? records : [] }
      } catch (error) {
        return { ok: false, reason: 'list-failed: ' + msg(error) }
      }
    }
    const controller = get('sessionController')
    if (controller === undefined || controller === null || typeof controller.list !== 'function') {
      return { ok: false, reason: 'query-unavailable' }
    }
    try {
      const value = await controller.list({}, undefined)
      const items = value !== undefined && value !== null && Array.isArray(value.items) ? value.items : []
      const records = []
      for (const item of items) {
        if (item === null || item === undefined) continue
        records.push({
          header: {
            id: item.sessionId,
            parentSession: item.parentSessionId,
            origin: item.origin,
            cwd: item.cwd,
          },
          live: item.running === true,
          persisted: true,
        })
      }
      return { ok: true, records }
    } catch (error) {
      return { ok: false, reason: 'list-failed: ' + msg(error) }
    }
  }

  /** 所有会话的子代理，按父会话分组（清理旧会话遗留用）。 */
  const listAll = async () => {
    const read = await readRecords()
    if (read.ok !== true) return read
    const reaped = await readTombstones()
    const groups = new Map()
    for (const record of read.records) {
      const header = record !== null && record !== undefined ? record.header : undefined
      if (header === undefined || header === null) continue
      const parent = header.parentSession === undefined || header.parentSession === null ? '' : String(header.parentSession)
      if (header.origin !== 'subagent' && parent === '') continue
      if (reaped.has(bare(header.id))) continue
      if (!groups.has(parent)) groups.set(parent, [])
      groups.get(parent).push({
        id: String(header.id),
        running: record.live === true,
        persisted: record.persisted === true,
        origin: header.origin === undefined || header.origin === null ? null : String(header.origin),
        depth: header.delegationDepth === undefined || header.delegationDepth === null ? null : Number(header.delegationDepth),
      })
    }
    const out = []
    for (const [parent, children] of groups) {
      children.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      out.push({ parent, children })
    }
    out.sort((a, b) => String(a.parent).localeCompare(String(b.parent)))
    // 补会话标题：子代理行与父会话分组标题都用名称显示。
    const wanted = []
    for (const group of out) {
      if (group.parent !== '') wanted.push(group.parent)
      for (const child of group.children) wanted.push(child.id)
    }
    const titles = await readTitles(wanted)
    for (const group of out) {
      const parentTitle = group.parent === '' ? '' : titles.get(str(group.parent))
      group.parentTitle = parentTitle === undefined ? '' : parentTitle
      for (const child of group.children) {
        const title = titles.get(str(child.id))
        child.title = title === undefined ? '' : title
      }
    }
    return { ok: true, groups: out, total: out.reduce((sum, group) => sum + group.children.length, 0) }
  }

  /** 收集某个会话的全部后代 id（含自身），用于级联删除。 */
  const collectSubtree = async (rootId) => {
    const read = await readRecords()
    if (read.ok !== true) return [rootId]
    const childrenOf = new Map()
    for (const record of read.records) {
      const header = record !== null && record !== undefined ? record.header : undefined
      if (header === undefined || header === null) continue
      const parent = header.parentSession === undefined || header.parentSession === null ? '' : String(header.parentSession)
      if (parent === '') continue
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(String(header.id))
    }
    const out = []
    const stack = [rootId]
    const seen = new Set()
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      for (const child of childrenOf.get(id) ?? []) stack.push(child)
    }
    return out
  }

  /**
   * 让宿主立刻忘掉这个会话（否则 sessionQuery 仍把它当 live 返回）。
   * 会话 id 有两种写法：裸 UUID（子代理会话）与 `session-<uuid>`（顶层会话），
   * 两种都试一遍，否则会把 live 会话误判成 not-live。
   */
  const forgetLive = async (sessionId) => {
    const sessions = get('sessions')
    if (sessions === undefined || sessions === null) return 'sessions-unavailable'
    const candidates = [sessionId, 'session-' + bare(sessionId)]
    let live
    for (const candidate of candidates) {
      try { live = sessions.get(candidate) } catch { live = undefined }
      if (live !== undefined && live !== null) break
    }
    if (live === undefined || live === null) return 'not-live'
    if (typeof sessions.flush === 'function') {
      try { await sessions.flush(live) } catch { /* 落盘失败也继续：删除优先 */ }
    }
    try {
      if (typeof sessions.liveEntryFor !== 'function' || typeof sessions.detachEntered !== 'function') return 'detach-unavailable'
      const entry = sessions.liveEntryFor(live)
      sessions.detachEntered(entry)
    } catch (error) {
      return 'detach-failed: ' + msg(error)
    }
    await sleep(120)
    return 'detached'
  }

  /** 解析会话产物路径：优先 stat().location.path，回退 locate(header)。 */
  const resolveArtifact = async (sessionId) => {
    const persistence = get('sessionPersistence')
    if (persistence === undefined || persistence === null) return { ok: false, reason: 'persistence-unavailable' }
    let snapshot
    try { snapshot = await persistence.stat(sessionId) } catch { snapshot = undefined }
    const header = snapshot !== undefined && snapshot !== null ? snapshot.header : undefined
    let location = snapshot !== undefined && snapshot !== null ? snapshot.location : undefined
    if ((location === undefined || location === null || typeof location.path !== 'string') && header !== undefined && header !== null && typeof persistence.locate === 'function') {
      try { location = persistence.locate(header) } catch { location = undefined }
    }
    if (location === undefined || location === null || typeof location.path !== 'string' || location.path === '') {
      return { ok: false, reason: 'artifact-not-found' }
    }
    return { ok: true, header, location, persistence }
  }

  /**
   * 官方 JSONL 布局：<DSH_HOME>/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd
   * 只有确认「父目录名 === 会话 id」时才删整个目录，否则只删定位到的那个文件。
   */
  const sessionDirOf = (persistence, header, location) => {
    if (persistence === undefined || persistence === null) return ''
    if (persistence.name !== 'session-persistence-jsonl') return ''
    if (location === undefined || location === null || location.kind !== 'jsonl') return ''
    if (header === undefined || header === null) return ''
    const dir = dirname(location.path)
    if (basename(dir) !== String(header.id)) return ''
    return dir
  }

  /** 物理删除一个会话的产物（目录或单文件），带路径安全校验。 */
  const removeArtifact = async (sessionId) => {
    const resolved = await resolveArtifact(sessionId)
    if (resolved.ok !== true) return resolved
    const { header, location, persistence } = resolved
    const dir = sessionDirOf(persistence, header, location)
    const target = dir !== '' ? dir : location.path
    if (!isAbsolute(target)) return { ok: false, reason: 'not-absolute: ' + target }
    if (target.indexOf('..') >= 0) return { ok: false, reason: 'suspicious-path: ' + target }
    if (dir !== '' && basename(dir) !== String(header.id)) return { ok: false, reason: 'dir-ownership-mismatch: ' + dir }
    try {
      const stat = await lstat(target)
      if (stat.isSymbolicLink()) return { ok: false, reason: 'refusing-symlink: ' + target }
    } catch (error) {
      if (msg(error).indexOf('ENOENT') < 0) return { ok: false, reason: 'lstat-failed: ' + msg(error) }
    }
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, reason: 'rm-failed: ' + msg(error), path: target }
    }
    let stillPresent = false
    try {
      const post = await persistence.stat(sessionId)
      stillPresent = post !== undefined && post !== null
    } catch { stillPresent = false }
    return { ok: true, path: target, kind: dir !== '' ? 'session-directory' : 'artifact', stillPresent }
  }

  /**
   * 清掉投影缓存里的一行（可选服务）。
   * 注意：0.2.2-rc.2 的 sessionProjectionCache 只有 cachedSnapshot / cachedPredecessorTitle /
   * hydratePrepared / write / coldSnapshot，没有 requireTable，也没有任何「删某会话投影」的接口。
   * 这里只做能力探测，拿不到就跳过——投影行由 DSH 自己按日志重建，插件无权改写。
   */
  const forgetProjection = async (sessionId) => {
    const cache = get('sessionProjectionCache')
    if (cache === undefined || cache === null) return
    if (typeof cache.forget !== 'function') return
    try { await cache.forget(sessionId) } catch { /* 缓存缺失不影响删除 */ }
  }

  /**
   * 删除一个子代理（含其全部后代）。
   * scope='child'：必须是指定会话的直接子代理；scope='any'：只要它是子代理会话即可。
   */
  const purgeOne = async (sessionId, childId, scope) => {
    const wantForeign = scope === 'any'
    let target = null
    if (wantForeign) {
      const all = await listAll()
      if (all.ok !== true) return all
      for (const group of all.groups) {
        for (const child of group.children) {
          if (child.id === childId || bare(child.id) === bare(childId)) {
            target = { id: child.id, activity: child.running ? 'running' : 'inactive', parent: group.parent, label: '' }
          }
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
    if (!UUID_RE.test(bare(target.id))) return { ok: false, reason: 'unexpected-id-format' }

    const subtree = await collectSubtree(target.id)
    // 先摘 live（由深到浅），再删文件：摘除会触发 retire→flush，必须早于 rm。
    const liveNotes = []
    for (const id of subtree) liveNotes.push({ id, note: await forgetLive(id) })
    const liveNoteOf = new Map(liveNotes.map((row) => [row.id, row.note]))
    const removed = []
    for (const id of subtree) {
      const one = await removeArtifact(id)
      // 从未落盘的子代理（只有父会话里一条 catalog 事件）没有产物可删：
      // 只要它已经不在 live 注册表里，就算回收成功，靠墓碑把它从列表里隐去。
      const note = str(liveNoteOf.get(id))
      const gone = note === 'detached' || note === 'not-live'
      const ok = one.ok === true || (str(one.reason) === 'artifact-not-found' && gone)
      const row = { id, ok, reason: str(one.reason), path: str(one.path), kind: str(one.kind), stillPresent: one.stillPresent === true }
      if (ok && one.ok !== true) row.note = 'no-artifact'
      removed.push(row)
      if (one.ok === true) await forgetProjection(id)
    }
    // 摘除 live 时 persistence 的 retire 链可能还在写盘；再确认一次没被写回来。
    for (const row of removed) {
      if (row.ok !== true) continue
      await sleep(150)
      const again = await removeArtifact(row.id)
      if (again.ok === true) row.reapedAgain = true
    }
    for (const id of subtree) {
      try { ctx.emit('api-session/removed', id) } catch { /* 通知失败不影响删除 */ }
    }
    const failed = removed.filter((row) => row.ok !== true)
    const reaped = removed.filter((row) => row.ok === true).map((row) => row.id)
    if (reaped.length > 0) await markReaped(reaped)
    return {
      ok: failed.length === 0,
      reason: failed.length === 0 ? 'deleted' : 'partial: ' + failed.map((row) => row.id.slice(0, 8) + '=' + row.reason).join(', '),
      label: target.label,
      parent: target.parent,
      removed,
      live: liveNotes,
      count: reaped.length,
    }
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

  const diag = () => {
    const has = (key, method) => {
      const service = get(key)
      if (service === undefined || service === null) return false
      return method === undefined ? true : typeof service[method] === 'function'
    }
    return {
      ok: true,
      services: {
        sessionQuery: has('sessionQuery', 'observeSession'),
        sessionQueryList: has('sessionQuery', 'listSessions'),
        subagents: has('subagents', 'listDescendants'),
        sessions: has('sessions', 'get'),
        sessionsLiveEntryFor: has('sessions', 'liveEntryFor'),
        sessionsDetachEntered: has('sessions', 'detachEntered'),
        sessionPersistence: has('sessionPersistence', 'stat'),
        sessionPersistenceLocate: has('sessionPersistence', 'locate'),
        sessionProjectionCache: has('sessionProjectionCache', 'write'),
      },
    }
  }

  const guard = (req) => {
    // 首选官方信任校验：已认证的同源浏览器请求直接放行。
    // 这样桌面版窗口即使持有旧页面（meta token 已过期）也不会 403。
    const connection = get('connection')
    if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
      try {
        if (connection.requestRejection({ headers: req.headers }) === undefined) return true
      } catch { /* 校验器异常时退回 token */ }
    }
    return req.headers['x-reaper-token'] === token
  }

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
      path: BASE + '/reaped',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        const set = await readTombstones()
        return sendJson(res, 200, { ok: true, ids: Array.from(set), count: set.size })
      },
    },
    {
      kind: 'exact',
      path: BASE + '/unreap',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        const body = await readBody(req)
        if (body === null) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
        const id = str(body.id)
        if (id === '') return sendJson(res, 400, { ok: false, reason: 'no-id' })
        const changed = await unmarkReaped(id)
        return sendJson(res, 200, { ok: true, changed })
      },
    },
    {
      kind: 'exact',
      path: BASE + '/clear-reaped',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return sendJson(res, 200, await clearReaped())
      },
    },
    {
      kind: 'exact',
      path: BASE + '/diag',
      handler: async (req, res) => {
        if (!guard(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return sendJson(res, 200, diag())
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'subagent-reaper.routes')
}
