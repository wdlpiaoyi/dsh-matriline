/**
 * @wdlpiaoyi/dsh-matriline — Client half: the right-sidebar subagent topology tab.
 *
 * A right-sidebar topology graph of the subagents this session delegated to:
 * the main session sits at the centre, every child on a small golden-angle
 * orbit around ITS OWN parent (a child tends to sit farther out than its
 * parent, but "next to the parent" always wins), message traffic drawn as
 * dashed quadratic curves. Positions are
 * relaxed every frame (mutual exclusion, message-edge attraction, a spring to
 * each node's parent-anchored home, damped) and written straight to the DOM,
 * so React only re-renders on data/UI changes — never per physics tick.
 *
 * Data contract (host side, verified):
 *   useSessions(s => s.byId)                Record<id, SessionSummary>
 *   summary.id / displayTitle / title / parentId / origin / running / updatedAt
 *   summary.projectionValues.tokenUsage     { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *   summary.projectionValues.subagentEdges  { incoming: [{ from, at }],
 *                                             context: { pressureTokens } | undefined }
 *
 * `subagentEdges.context.pressureTokens` is the last request's prompt size
 * (uncached input + cache reads), folded host-side because the built-in
 * `contextPressure` projection is excluded from session summaries.
 *
 * Anything absent degrades to an explicit "—", never to a fabricated value.
 */
window.__ModuleLoader__.load({
  id: '@wdlpiaoyi/dsh-matriline',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const useIso = React.useLayoutEffect ?? React.useEffect

    const LOG = '[matriline]'
    const TYPE_ID = 'matriline:graph'
    // The official client packages are resolvable here (the Team toggle itself
    // requires the same module). Fall back to a local control if a deployment
    // does not expose the primitives module.
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = undefined
      console.warn(LOG, 'primitives unavailable; using fallback controls', error)
    }
    const Switch = primitives?.Switch
    const Modal = primitives?.Modal
    const Button = primitives?.Button
    const KIND = 'matriline'

    /* ---------------------------------------------------------------- geometry */
    /* Card size is also baked into the stylesheet below; both read these.      */
    /* A near-square card: the previous 140x54 ribbon wrapped titles badly.    */
    const NODE_W = 120
    const NODE_H = 84
    /** Mutual-exclusion radius per node: the rendered corner plus breathing room (≈92px). */
    const EXCLUDE_GAP = 28
    const EDGE_PAD = 7
    const VIEW_PAD = 26
    /** Parent-anchored orbit: a child's home sits this far from ITS parent. */
    const ORBIT_MIN = 110
    const ORBIT_MAX = 160
    /**
     * Requirement 18: a node that still has children is pushed to the OUTER
     * edge of its ring (a leaf stays on the inner edge), so parents visibly
     * make room for their own school. Applied once, in the layout, never as a
     * per-frame force.
     */
    const PARENT_ORBIT_BONUS = 50
    /** Hard outer limit for the frozen parent orbit (relaxation may push a crowded child out). */
    const ORBIT_LIMIT = 260
    /** Soft "outside the parent" nudge: radial gap, dead zone, strength, and per-frame cap. */
    const OUTSIDE_GAP = 18
    const OUTSIDE_DEAD_ZONE = 24
    const OUTSIDE_PULL = 0.0075
    const OUTSIDE_CAP = 0.38
    /** A drag displacement decays every step (fast enough to settle inside ~60 frames). */
    const OFFSET_DECAY = 0.72
    /** Pointer travel (px) above which a press counts as a drag, not a click. */
    const CLICK_SLOP = 4
    /** Weak spring along message edges; weaker than every other force. */
    const MSG_PULL = 0.0015
    const MSG_MAX_FORCE = 0.25
    /** Message pull only kicks in beyond this distance: never pull cards through each other. */
    const MSG_MIN_DIST = 150
    const GOLDEN_ANGLE = (137.5 * Math.PI) / 180
    const MAX_MAP_NODES = 24
    /**
     * 一次批量打开/全选的上限。与拓扑图上限同值：超过它的批量打开会一次性塞满
     * 侧栏标签页，宿主也没有「全部关闭」；批量操作与拓扑图保持同一个可见范围，
     * 用户点「全选筛选结果」得到的数量一定和拓扑图上限一致。
     */
    const MAX_BATCH_OPEN = MAX_MAP_NODES
    const SCALE_MIN = 0.42
    const SCALE_MAX = 2.4
    const SPRING = 0.05
    /**
     * Per-step velocity retention: the fraction of velocity that survives one
     * fixed step. SMALLER = more dissipation = 越小越稳、停得越快 (steadier and
     * stops sooner); larger = livelier and rings longer.
     * Tunable knob: 0.80 → even calmer, 0.84 (default) → stable, 0.90 → livelier.
     */
    const VELOCITY_RETENTION = 0.84
    const SEPARATION = 0.5
    /** Hard speed cap per step: no single frame can overshoot and bounce back. */
    const MAX_SPEED = 4.5
    /** One physics step, in seconds. The loop never reads wall-clock time. */
    const FIXED_STEP = 1 / 60
    /** Sleep when Σv² stays under this ... */
    const SLEEP_ENERGY = 2
    /** ... for this many consecutive frames. */
    const SLEEP_FRAMES = 8
    /** One-shot relaxation rounds run when the layout (data/filter/size) changes. */
    const RELAX_ROUNDS = 120
    /** Repulsion softening distance: below it the push is scaled down, not blown up. */
    const SOFT_DIST = 48
    /** Repulsion is ignored within this tolerance, so the baked layout has no residual force (and can sleep). */
    const OVERLAP_TOLERANCE = 12
    const WAIT_WINDOW_MS = 120000
    const CLOCK_MS = 30000
    const TOAST_MS = 2600
    const LOAD_TIMEOUT_MS = 3500

    /* ------------------------------------------------------------- 自动隐藏 */
    /* 纯展示过滤，不删除任何数据：一个节点同时满足“终态 + 结束够久 + 不在最近
       完成的 8 个里”才会被自动隐藏；隐藏集合任何时刻都能被工具条的「显示已隐藏」
       开关原样揭开。常量集中在这里，规则只在 hiddenPlan 里实现一次。 */
    /** 终态节点结束多久之后才允许自动隐藏（2 小时）。 */
    const AUTO_HIDE_AFTER_MS = 2 * 3600 * 1000
    /** 最近完成的前 N 个节点永远可见（按 endedAt 倒序取前 N）。 */
    const AUTO_HIDE_KEEP_RECENT = 8
    /** 宿主 delegate 结果契约里的终态状态值。 */
    const TERMINAL_RUN_STATUSES = new Set(['ok', 'partial', 'denied', 'error', 'timeout', 'interrupted', 'depth-exhausted'])

    const STATUS_LABEL = { running: '运行中', waiting: '等待', idle: '空闲', failed: '失败', unknown: '未知' }
    /* 宿主 runStatus 的展示名：它既决定自动隐藏，也要显示在卡片与详情里。
       「超时 / 被拒绝 / 部分完成」这类结局不能只用来把节点藏起来。 */
    const RUN_STATUS_LABEL = {
      running: '运行中',
      waiting: '等待',
      ok: '完成',
      partial: '部分完成',
      denied: '被拒绝',
      error: '失败',
      timeout: '超时',
      interrupted: '已中断',
      'depth-exhausted': '深度耗尽',
    }
    /* 卡片上值得单独标出的宿主终态：ok 不标（状态徽标已说明结束），推导出的
       failed / idle 也不标 —— 它们在 STATUS_LABEL 里已有自己的名字。 */
    const runStatusBadgeOf = (node) => {
      try {
        const run = node?.runStatus
        if (typeof run !== 'string' || run === 'ok') return undefined
        return TERMINAL_RUN_STATUSES.has(run) ? (RUN_STATUS_LABEL[run] ?? run) : undefined
      } catch {
        return undefined
      }
    }
    const STATUS_COLOR_KEY = { running: 'running', waiting: 'waiting', idle: 'idle', failed: 'failed', unknown: 'unknown' }
    const STATUS_ORDER = ['running', 'waiting', 'failed', 'idle', 'unknown']
    const STATUS_FILTERS = ['running', 'waiting', 'idle', 'failed']
    const STATUS_GROUP_ORDER = ['running', 'waiting', 'failed', 'idle', 'unknown']
    const TIME_GROUP_ORDER = ['fresh', 'recent', 'today', 'older', 'unknown']
    const TIME_LABEL = { fresh: '15 分钟内', recent: '1 小时内', today: '24 小时内', older: '更早', unknown: '时间未知' }
    const TIME_FILTERS = [
      ['all', '全部时间'],
      ['15m', '15 分钟内'],
      ['1h', '1 小时内'],
      ['24h', '24 小时内'],
    ]
    const TIME_SPAN = { '15m': 900000, '1h': 3600000, '24h': 86400000 }
    const EDGE_FILTERS = [
      ['all', '全部往来'],
      ['with', '有消息往来'],
      ['without', '无消息往来'],
    ]
    const GROUP_OPTIONS = [
      ['status', '按状态分组'],
      ['time', '按时间分组'],
    ]
    /* One order for both views: the list renders it, the map takes its first
       MAX_MAP_NODES from it, so "first in the list" and "on the map" agree. */
    const SORT_OPTIONS = [
      ['recent', '最近活动'],
      ['tokens', 'token 用量'],
      ['context', '上下文占用'],
      ['title', '名称'],
      ['depth', '层级（深度）'],
    ]

    /* ------------------------------------------------------------------ utils */
    const isObj = (value) => value !== null && typeof value === 'object'

    const messageOf = (error) => {
      if (error === undefined || error === null) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      try {
        return String(error)
      } catch {
        return '未知错误'
      }
    }

    const numOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

    const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

    const pickTitle = (summary, fallback) => {
      try {
        for (const key of ['displayTitle', 'title', 'name']) {
          const value = summary?.[key]
          if (typeof value === 'string' && value.trim() !== '') return value.trim()
        }
      } catch {
        /* a malformed summary must not blank the panel */
      }
      return fallback
    }

    /** Summaries out of `Record<id, SessionSummary>`, tolerant of a Map and of junk. */
    const listSessions = (byId) => {
      const out = []
      try {
        if (byId === null || byId === undefined) return out
        if (byId instanceof Map) {
          for (const value of byId.values()) if (isObj(value)) out.push(value)
          return out
        }
        if (typeof byId !== 'object') return out
        for (const key of Object.keys(byId)) {
          const value = byId[key]
          if (isObj(value)) out.push(value)
        }
      } catch {
        /* unreadable store: behave like "no data" */
      }
      return out
    }

    const lookupSession = (byId, id) => {
      if (typeof id !== 'string' || byId === null || byId === undefined) return undefined
      try {
        if (byId instanceof Map) {
          const value = byId.get(id)
          return isObj(value) ? value : undefined
        }
        if (typeof byId !== 'object') return undefined
        const value = byId[id]
        return isObj(value) ? value : undefined
      } catch {
        return undefined
      }
    }

    /** `{ inputTotal, outputTokens, total }` plus the individual fields, or undefined. */
    const tokensOf = (summary) => {
      try {
        const usage = summary?.projectionValues?.tokenUsage
        if (!isObj(usage)) return undefined
        const uncachedInput = numOf(usage.uncachedInputTokens)
        const outputTokens = numOf(usage.outputTokens)
        const cacheReadTokens = numOf(usage.cacheReadTokens)
        const cacheWriteTokens = numOf(usage.cacheWriteTokens)
        if (uncachedInput === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) {
          return undefined
        }
        const inputTotal = (uncachedInput ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
        const output = outputTokens ?? 0
        return { uncachedInput, outputTokens, cacheReadTokens, cacheWriteTokens, inputTotal, total: inputTotal + output }
      } catch {
        return undefined
      }
    }

    /** A failure reason the summary actually carries, or undefined when it carries none. */
    const FAILURE_KEYS = ['failure', 'failed', 'error', 'errorMessage', 'lastError', 'failureReason', 'aborted']
    const failureOf = (summary) => {
      try {
        for (const key of FAILURE_KEYS) {
          const value = summary?.[key]
          if (value === undefined || value === null || value === false) continue
          if (value === true) return '失败（会话摘要报告失败）'
          if (typeof value === 'string') {
            if (value.trim() !== '') return value.trim()
            continue
          }
          if (isObj(value)) {
            const text = value.message ?? value.reason ?? value.code
            if (typeof text === 'string' && text !== '') return text
            return '失败（无详情）'
          }
        }
        const status = summary?.status
        if (typeof status === 'string' && /fail|error|abort/i.test(status)) return `状态：${status}`
      } catch {
        /* a throwing summary is just an unknown failure */
      }
      return undefined
    }

    const statusOf = (summary, now) => {
      try {
        if (!isObj(summary)) return 'unknown'
        if (summary.running === true) return 'running'
        if (failureOf(summary) !== undefined) return 'failed'
        const updatedAt = numOf(summary.updatedAt)
        if (updatedAt !== undefined && now >= updatedAt && now - updatedAt < WAIT_WINDOW_MS) return 'waiting'
        if (summary.running === false) return 'idle'
      } catch {
        /* fall through */
      }
      return 'unknown'
    }

    /**
     * The status the auto-hide rule reads. The host's own vocabulary wins
     * (`ok|partial|denied|error|timeout|interrupted|depth-exhausted`); this
     * client derives `failed`/`idle` for a run that is over, so those count as
     * terminal too. `running`/`waiting` never do, and `unknown` (no data at all)
     * never does — an unknown node is shown rather than guessed away.
     */
    const isTerminalRunStatus = (status) =>
      typeof status === 'string' && (TERMINAL_RUN_STATUSES.has(status) || status === 'failed' || status === 'idle')

    /** The host-reported run status of one summary, when it speaks our vocabulary. */
    const runStatusOf = (summary) => {
      try {
        const candidates = [
          summary?.status,
          summary?.runStatus,
          summary?.lastRunStatus,
          summary?.lastResult?.status,
          summary?.projectionValues?.runStatus,
          summary?.projectionValues?.lastResult?.status,
        ]
        for (const value of candidates) {
          if (typeof value !== 'string' || value === '') continue
          if (isTerminalRunStatus(value) || value === 'running' || value === 'waiting') return value
        }
      } catch {
        /* a throwing summary falls back to the derived status */
      }
      return undefined
    }

    /** Inbound agent-message edges folded by the host projection. */
    const incomingOf = (summary) => {
      const out = []
      try {
        const incoming = summary?.projectionValues?.subagentEdges?.incoming
        if (!Array.isArray(incoming)) return out
        for (const item of incoming) {
          if (!isObj(item)) continue
          const from = typeof item.from === 'string' ? item.from : undefined
          if (from === undefined) continue
          out.push({ from, at: numOf(item.at) })
        }
      } catch {
        /* projection missing or malformed: no edges */
      }
      return out
    }

    /** Context pressure folded by the host: the last request's prompt size. */
    const contextOf = (summary) => {
      try {
        const context = summary?.projectionValues?.subagentEdges?.context
        if (!isObj(context)) return undefined
        const pressureTokens = numOf(context.pressureTokens)
        if (pressureTokens === undefined) return undefined
        /* The host does not ship a window size with the pressure; look for one
           in the places a host may expose it, and degrade to absolute only. */
        const contextWindow =
          numOf(context.contextWindow) ??
          numOf(context.window) ??
          numOf(summary?.contextWindow) ??
          numOf(summary?.projectionValues?.contextWindow) ??
          numOf(summary?.projectionValues?.contextPressure?.contextWindow)
        return { pressureTokens, contextWindow }
      } catch {
        return undefined
      }
    }

    /** 1 000 000 以下从 k 进位到 M 的阈值：999 500 四舍五入会变成「1000k」，
        所以从它开始就走 M 分支（显示 1.0M），不让四位数的 k 出现在界面上。 */
    const K_MAX = 999500

    const fmtTokens = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value < 1000) return String(Math.round(value))
      if (value < K_MAX) {
        const thousands = value / 1000
        return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
      }
      const millions = value / 1000000
      return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`
    }

    const fmtAgo = (timestamp, now) => {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      const diff = Math.max(0, now - timestamp)
      if (diff < 10000) return '刚刚'
      if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
      if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
      return fmtDate(timestamp)
    }

    const fmtDate = (timestamp) => {
      try {
        const date = new Date(timestamp)
        return `${date.getMonth() + 1}月${date.getDate()}日`
      } catch {
        return '—'
      }
    }

    /** Compact, never-truncating age for a node card: 9m / 2h / 3d. */
    const fmtAgoShort = (timestamp, now) => {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      const diff = Math.max(0, now - timestamp)
      if (diff < 10000) return '刚刚'
      if (diff < 60000) return `${Math.floor(diff / 1000)}s`
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
      if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`
      return fmtDate(timestamp)
    }

    /** Exact integer with grouping, for the detail view (no k/M rounding). */
    const fmtExact = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return Math.round(value).toLocaleString('en-US')
      } catch {
        return String(Math.round(value))
      }
    }

    const fmtClock = (timestamp) => {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
    }

    const timeBucketOf = (timestamp, now) => {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'unknown'
      const age = Math.max(0, now - timestamp)
      if (age <= 900000) return 'fresh'
      if (age <= 3600000) return 'recent'
      if (age <= 86400000) return 'today'
      return 'older'
    }

    /** Everything the toolbar can filter by; a thrown field degrades to "matches". */
    const nodeMatches = (node, query, statusFilter, timeFilter, edgeFilter, now) => {
      try {
        if (statusFilter !== 'all' && node.status !== statusFilter) return false
        if (timeFilter !== 'all') {
          const span = TIME_SPAN[timeFilter]
          if (span !== undefined) {
            if (node.updatedAt === undefined) return false
            if (now - node.updatedAt > span) return false
          }
        }
        if (edgeFilter === 'with' && node.messageTotal === 0) return false
        if (edgeFilter === 'without' && node.messageTotal > 0) return false
        if (query !== '') {
          const haystack = `${node.title}\u0000${node.id}\u0000${node.parentTitle ?? ''}`.toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      } catch {
        return true
      }
    }

    /**
     * Total order over child nodes, shared by the list and the map so both
     * agree on "first". The primary key follows `sortBy`; the secondary key is
     * always the id, so the same data always produces the same order — no
     * flicker between renders, no dependence on insertion order.
     */
    const compareNodes = (left, right, sortBy) => {
      let primary = 0
      try {
        if (sortBy === 'tokens') {
          const a = left?.tokens === undefined ? -1 : left.tokens.total
          const b = right?.tokens === undefined ? -1 : right.tokens.total
          primary = a === b ? 0 : b > a ? 1 : -1
        } else if (sortBy === 'context') {
          const a = numOf(left?.pressure?.pressureTokens) ?? -1
          const b = numOf(right?.pressure?.pressureTokens) ?? -1
          primary = a === b ? 0 : b > a ? 1 : -1
        } else if (sortBy === 'title') {
          primary = String(left?.title ?? '').localeCompare(String(right?.title ?? ''), 'zh-Hans-CN')
        } else if (sortBy === 'depth') {
          primary = (left?.depth ?? 0) - (right?.depth ?? 0)
        } else {
          const a = numOf(left?.updatedAt) ?? Number.NEGATIVE_INFINITY
          const b = numOf(right?.updatedAt) ?? Number.NEGATIVE_INFINITY
          primary = a === b ? 0 : b > a ? 1 : -1
        }
      } catch {
        primary = 0
      }
      if (primary !== 0) return primary
      return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
    }

    const buildGroups = (nodes, groupBy, now) => {
      const order = groupBy === 'time' ? TIME_GROUP_ORDER : STATUS_GROUP_ORDER
      const labels = groupBy === 'time' ? TIME_LABEL : STATUS_LABEL
      const buckets = new Map()
      for (const node of nodes) {
        let key
        try {
          key = groupBy === 'time' ? timeBucketOf(node.updatedAt, now) : node.status
        } catch {
          key = 'unknown'
        }
        if (key === undefined) key = 'unknown'
        const bucket = buckets.get(key)
        if (bucket === undefined) buckets.set(key, [node])
        else bucket.push(node)
      }
      const groups = []
      for (const key of order) {
        const bucket = buckets.get(key)
        if (bucket === undefined || bucket.length === 0) continue
        let tokens = 0
        for (const node of bucket) if (node.tokens !== undefined) tokens += node.tokens.total
        groups.push({ key, label: labels[key] ?? key, nodes: bucket, tokens })
      }
      return groups
    }

    /** Where an edge meets a card: the scaled rectangle boundary, padded a little. */
    const rectPort = (from, to, halfW, halfH, pad) => {
      const edgePad = typeof pad === 'number' && Number.isFinite(pad) ? pad : EDGE_PAD
      const dx = to.x - from.x
      const dy = to.y - from.y
      const distance = Math.hypot(dx, dy)
      if (distance < 0.001) return { x: from.x, y: from.y }
      const ux = dx / distance
      const uy = dy / distance
      const paddedW = halfW + edgePad
      const paddedH = halfH + edgePad
      const tx = Math.abs(ux) < 1e-6 ? Infinity : paddedW / Math.abs(ux)
      const ty = Math.abs(uy) < 1e-6 ? Infinity : paddedH / Math.abs(uy)
      const step = Math.min(tx, ty)
      return { x: from.x + ux * step, y: from.y + uy * step }
    }

    /**
     * Quadratic edge with the control point pushed away from the map centre,
     * so a spoke bows outward instead of cutting across the middle.
     * Coordinates come in already zoom-scaled (see syncScene), so `pad` scales
     * too and the SVG stays vector-crisp at every zoom level.
     */
    const edgePath = (from, to, fromDim, toDim, bow, center, pad) => {
      const start = rectPort(from, to, fromDim.hw, fromDim.hh, pad)
      const end = rectPort(to, from, toDim.hw, toDim.hh, pad)
      const midX = (start.x + end.x) / 2
      const midY = (start.y + end.y) / 2
      const hub = center ?? { x: 0, y: 0 }
      let ox = midX - hub.x
      let oy = midY - hub.y
      const outward = Math.hypot(ox, oy)
      if (outward < 0.5) {
        ox = 0
        oy = -1
      } else {
        ox /= outward
        oy /= outward
      }
      const dx = end.x - start.x
      const dy = end.y - start.y
      const span = Math.hypot(dx, dy) || 1
      const push = Math.min(72, 18 + span * 0.16)
      const px = -dy / span
      const py = dx / span
      const cx = midX + ox * push + px * bow
      const cy = midY + oy * push + py * bow
      return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
    }

    /** Rendered half-extents of one node, honouring its depth scale. */
    const nodeHalf = (node) => {
      const scale = typeof node?.scale === 'number' && node.scale > 0 ? node.scale : 1
      return { hw: (NODE_W * scale) / 2, hh: (NODE_H * scale) / 2 }
    }

    /** Mutual-exclusion radius from the real rendered card, not a guess. */
    const nodeRadius = (node) => {
      const half = nodeHalf(node)
      return Math.hypot(half.hw, half.hh) + EXCLUDE_GAP
    }

    /**
     * Soft hierarchy ordering — a nudge, never a band.
     *
     * The "n 级在外围" intuition is kept only as a weak outward force: when a
     * child sits closer to the hub than its parent (plus a small gap) it is
     * pushed outward a little. It is deliberately weak and capped, because
     * "next to its parent" wins any conflict; a crowded parent keeps its
     * children close instead of having them flung onto a fixed radius.
     * Returns an outward force >= 0.
     */
    const outsideParentForce = (childRadius, parentRadius, gap, strength, cap, deadZone) => {
      const slack = typeof deadZone === 'number' && deadZone > 0 ? deadZone : 0
      const deficit = parentRadius + gap + slack - childRadius
      if (!(deficit > 0)) return 0
      return Math.min(cap, deficit * strength)
    }

    /**
     * Weak spring along every message edge (from → to): nodes that talk to
     * each other drift together. It only pulls when the pair is farther apart
     * than `minDist`, so it can never drag two cards through each other; the
     * force is also capped and weaker than the parent spring (priority:
     * parent proximity > message pull > plain repulsion).
     */
    const attractMessageEdges = (positions, edges, pull, maxForce, minDist) => {
      if (!Array.isArray(edges)) return
      const floor = typeof minDist === 'number' && minDist > 0 ? minDist : 0
      for (const edge of edges) {
        if (edge === undefined || edge === null || edge.kind !== 'message') continue
        const a = positions.get(edge.from)
        const b = positions.get(edge.to)
        if (a === undefined || b === undefined || a === b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy)
        if (dist < 0.001 || dist <= floor) continue
        const force = Math.min(maxForce, pull * (dist - floor))
        const ux = dx / dist
        const uy = dy / dist
        a.vx += ux * force
        a.vy += uy * force
        b.vx -= ux * force
        b.vy -= uy * force
      }
    }

    /**
     * Arrow marker id for one edge. Every edge gets one at its `to` end:
     * message and orphan edges use the warning arrow, plain spawn edges the
     * muted one, and a highlighted edge switches to the strong colour so the
     * head recolours together with the line (requirement 17).
     */
    const markerFor = (edge, hot, arrowId) => {
      if (hot === true) return `${arrowId}-hot`
      if (edge === undefined || edge === null) return `${arrowId}-spawn`
      if (edge.kind === 'message' || edge.orphan === true) return arrowId
      return `${arrowId}-spawn`
    }

    /**
     * Parent-anchored homes for the visible subtree.
     *
     *   1. the root sits at the origin (and is centred in the canvas below);
     *   2. every other node is placed next to ITS OWN parent, at
     *      ORBIT_MIN..ORBIT_MAX px, its siblings fanned by the golden angle so
     *      they do not stack in the same direction;
     *   3. a node that still has children gets PARENT_ORBIT_BONUS extra radius,
     *      which pushes parents to the outer edge of the ring and leaves the
     *      inner edge to leaves — applied here, once, never as a per-frame force;
     *   4. placement is level by level: when a node overlaps something that is
     *      already placed, it is nudged around its OWN parent (rotate + grow a
     *      little, still capped at ORBIT_MAX + bonus) and its whole subtree
     *      moves with it — so the parent link is never broken;
     *   5. the cloud is centred on the root in a canvas that grows with the
     *      population.
     *
     * Deliberately NO per-depth rings and no fixed slots: a child stays beside
     * its parent even when that puts it at a radius that overlaps another
     * level's radius. The depth order is only a soft runtime nudge.
     */
    const buildTreeLayout = (nodes, rootNode) => {
      const homeById = new Map()
      homeById.set(rootNode.id, { x: 0, y: 0 })

      /* Level order, so a parent always has a home before its children. */
      const ordered = nodes.slice().sort((left, right) => (left.depth ?? 1) - (right.depth ?? 1))
      const siblings = new Map()
      for (const node of ordered) {
        const parentId = node.parentId ?? rootNode.id
        const bucket = siblings.get(parentId)
        if (bucket === undefined) siblings.set(parentId, [node])
        else bucket.push(node)
      }
      /* Requirement 18 ordering: within one sibling ring, leaves take the inner
         spokes and nodes with children take the outer ones, so the parent bonus
         below always reads as "parents live at the ring's outer edge". */
      const hasChildrenOf = (id) => (siblings.get(id) ?? []).length > 0
      for (const bucket of siblings.values()) {
        bucket.sort((left, right) => {
          const leftOuter = hasChildrenOf(left.id) ? 1 : 0
          const rightOuter = hasChildrenOf(right.id) ? 1 : 0
          if (leftOuter !== rightOuter) return leftOuter - rightOuter
          return String(left.id).localeCompare(String(right.id))
        })
      }

      /* First pass: the ideal parent-relative orbit of every node. */
      const orbit = new Map()
      const seen = new Map()
      for (const node of ordered) {
        const parentId = node.parentId ?? rootNode.id
        const anchor = homeById.get(parentId) ?? homeById.get(rootNode.id) ?? { x: 0, y: 0 }
        const bucket = siblings.get(parentId) ?? [node]
        const index = seen.get(parentId) ?? 0
        seen.set(parentId, index + 1)
        /* 110 → 160px from the parent, spread over up to five golden-angle
           spokes, plus the parent bonus below for nodes that have children. */
        const span = Math.max(1, Math.min(bucket.length - 1, 4))
        const hasChildren = (siblings.get(node.id) ?? []).length > 0
        const bonus = hasChildren ? PARENT_ORBIT_BONUS : 0
        const radius = ORBIT_MIN + (ORBIT_MAX - ORBIT_MIN) * Math.min(1, index / span) + bonus
        let angle = index * GOLDEN_ANGLE + (node.depth ?? 1) * 0.7
        /* Soft "outer ring" preference: if this spoke would drop the child
           closer to the hub than its own parent, mirror the spoke so the child
           hangs outward. Still the same distance from the parent, just on the
           far side. */
        const parentOutward = Math.hypot(anchor.x, anchor.y)
        const candidateX = anchor.x + Math.cos(angle) * radius
        const candidateY = anchor.y + Math.sin(angle) * radius
        if (Math.hypot(candidateX, candidateY) < parentOutward + 8) angle += Math.PI
        orbit.set(node.id, { angle, radius, bonus })
        homeById.set(node.id, { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius })
      }

      /* Descendants, so moving a node can carry its whole family. */
      const nodeById = new Map()
      nodeById.set(rootNode.id, rootNode)
      for (const node of nodes) nodeById.set(node.id, node)
      const descendants = new Map()
      const collectDescendants = (id) => {
        const kids = siblings.get(id) ?? []
        const list = []
        for (const kid of kids) {
          list.push(kid)
          for (const childId of collectDescendants(kid.id)) list.push(childId)
        }
        descendants.set(id, list)
        return list
      }
      collectDescendants(rootNode.id)

      const shiftSubtree = (node, dx, dy) => {
        const home = homeById.get(node.id)
        if (home === undefined) return
        home.x += dx
        home.y += dy
        for (const childId of descendants.get(node.id) ?? []) {
          const childHome = homeById.get(childId)
          if (childHome === undefined) continue
          childHome.x += dx
          childHome.y += dy
        }
      }

      /* Parent-preserving relaxation, level by level. */
      const placed = [nodeById.get(rootNode.id) ?? rootNode]
      for (const node of ordered) {
        const parentId = node.parentId ?? rootNode.id
        const parent = nodeById.get(parentId) ?? nodeById.get(rootNode.id) ?? rootNode
        const parentHome = homeById.get(parent.id) ?? { x: 0, y: 0 }
        const base = orbit.get(node.id) ?? { angle: 0, radius: ORBIT_MIN }
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const angle = base.angle + attempt * GOLDEN_ANGLE * 0.618
          const radius = Math.min(ORBIT_MAX + (base.bonus ?? 0), base.radius + attempt * 5)
          const currentHome = homeById.get(node.id) ?? { x: 0, y: 0 }
          shiftSubtree(
            node,
            parentHome.x + Math.cos(angle) * radius - currentHome.x,
            parentHome.y + Math.sin(angle) * radius - currentHome.y,
          )
          let clear = true
          const home = homeById.get(node.id)
          for (const other of placed) {
            const otherHome = homeById.get(other.id)
            if (home === undefined || otherHome === undefined) continue
            const needed = nodeRadius(node) + nodeRadius(other) + 2
            if (Math.hypot(home.x - otherHome.x, home.y - otherHome.y) < needed) {
              clear = false
              break
            }
          }
          if (clear) break
        }
        placed.push(node)
      }

      /* Canvas symmetric around the root at the origin, so the hub really is
         in the middle and no home is clipped by the canvas box. */
      let reachX = 0
      let reachY = 0
      for (const node of [rootNode, ...nodes]) {
        const home = homeById.get(node.id) ?? { x: 0, y: 0 }
        const half = nodeHalf(node)
        reachX = Math.max(reachX, Math.abs(home.x) + half.hw)
        reachY = Math.max(reachY, Math.abs(home.y) + half.hh)
      }
      const worldW = Math.max(320, Math.round(reachX * 2 + VIEW_PAD * 2))
      const worldH = Math.max(420, Math.round(reachY * 2 + VIEW_PAD * 2))
      const offsetX = worldW / 2
      const offsetY = worldH / 2
      const homeMap = new Map()
      for (const [id, home] of homeById) homeMap.set(id, { x: home.x + offsetX, y: home.y + offsetY })
      return {
        worldW,
        worldH,
        homes: homeMap,
        rootHome: homeMap.get(rootNode.id) ?? { x: worldW / 2, y: worldH / 2 },
      }
    }

    const emptyModel = () => ({
      rootNode: {
        id: '',
        isRoot: true,
        depth: 0,
        scale: 1,
        title: '主会话',
        status: 'unknown',
        tokens: undefined,
        pressure: undefined,
        updatedAt: undefined,
        parentId: undefined,
        parentTitle: undefined,
        failure: undefined,
        origin: undefined,
        childCount: 0,
        messageIn: 0,
        messageOut: 0,
        messageTotal: 0,
        lastMessageAt: undefined,
        home: { x: 240, y: 360 },
        summary: undefined,
      },
      nodes: [],
      mapNodes: [],
      world: { w: 480, h: 720 },
      edges: [],
      incomingByNode: new Map(),
      titleById: new Map(),
      hasRoot: false,
    })

    const scaleForDepth = (depth) => (depth <= 1 ? 1 : depth === 2 ? 0.86 : 0.74)

    const buildModel = (byId, sessionId, now) => {
      try {
        const all = listSessions(byId)
        if (all.length === 0) return emptyModel()
        const hasSession = typeof sessionId === 'string' && sessionId !== ''

        const titleById = new Map()
        for (const summary of all) {
          const id = typeof summary?.id === 'string' ? summary.id : undefined
          if (id !== undefined) titleById.set(id, pickTitle(summary, `会话 ${id.slice(0, 6)}`))
        }

        const childrenMap = new Map()
        for (const summary of all) {
          const parentId = typeof summary?.parentId === 'string' ? summary.parentId : undefined
          if (parentId === undefined) continue
          const bucket = childrenMap.get(parentId)
          if (bucket === undefined) childrenMap.set(parentId, [summary])
          else bucket.push(summary)
        }
        for (const bucket of childrenMap.values()) {
          bucket.sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
        }

        const rootSummary = hasSession ? lookupSession(byId, sessionId) : undefined
        const rootNode = {
          id: hasSession ? sessionId : '',
          isRoot: true,
          depth: 0,
          scale: 1,
          title: pickTitle(rootSummary, '主会话'),
          status: statusOf(rootSummary, now),
          runStatus: runStatusOf(rootSummary),
          tokens: tokensOf(rootSummary),
          pressure: contextOf(rootSummary),
          updatedAt: numOf(rootSummary?.updatedAt),
          endedAt: numOf(rootSummary?.endedAt),
          parentId: typeof rootSummary?.parentId === 'string' ? rootSummary.parentId : undefined,
          parentTitle: undefined,
          failure: failureOf(rootSummary),
          origin: typeof rootSummary?.origin === 'string' ? rootSummary.origin : undefined,
          childCount: 0,
          messageIn: 0,
          messageOut: 0,
          messageTotal: 0,
          lastMessageAt: undefined,
          home: { x: 240, y: 360 },
          summary: rootSummary,
        }

        /* The WHOLE subtree below this session, breadth first, so a parent is */
        /* always placed before its children and cycles cannot slip in.        */
        const ordered = []
        const depthById = new Map()
        const parentById = new Map()
        if (hasSession) {
          const seen = new Set([sessionId])
          const queue = [{ id: sessionId, depth: 0 }]
          while (queue.length > 0) {
            const current = queue.shift()
            const children = childrenMap.get(current.id) ?? []
            for (const summary of children) {
              const id = typeof summary?.id === 'string' ? summary.id : undefined
              if (id === undefined || seen.has(id)) continue
              seen.add(id)
              depthById.set(id, current.depth + 1)
              parentById.set(id, current.id)
              ordered.push(summary)
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }
        const nodeIds = new Set()
        if (hasSession) nodeIds.add(sessionId)
        for (const summary of ordered) {
          if (typeof summary?.id === 'string') nodeIds.add(summary.id)
        }

        /* Message traffic across the whole subtree, not just direct children. */
        const incomingByNode = new Map()
        for (const summary of all) {
          const to = typeof summary?.id === 'string' ? summary.id : undefined
          if (to === undefined || !nodeIds.has(to)) continue
          const list = incomingOf(summary)
          if (list.length > 0) incomingByNode.set(to, list)
        }
        const messageIn = new Map()
        const messageOut = new Map()
        const lastMessageAt = new Map()
        for (const [to, list] of incomingByNode) {
          for (const item of list) {
            if (!nodeIds.has(item.from) || item.from === to) continue
            messageIn.set(to, (messageIn.get(to) ?? 0) + 1)
            messageOut.set(item.from, (messageOut.get(item.from) ?? 0) + 1)
            const previous = lastMessageAt.get(to) ?? 0
            if (item.at !== undefined && item.at > previous) lastMessageAt.set(to, item.at)
          }
        }

        const childNodes = ordered.map((summary) => {
          const id = typeof summary?.id === 'string' ? summary.id : ''
          const depth = depthById.get(id) ?? 1
          const parentId = parentById.get(id)
          const inCount = messageIn.get(id) ?? 0
          const outCount = messageOut.get(id) ?? 0
          return {
            id,
            isRoot: false,
            depth,
            scale: scaleForDepth(depth),
            title: pickTitle(summary, `子代理 ${id.slice(0, 6)}`),
            status: statusOf(summary, now),
            runStatus: runStatusOf(summary),
            tokens: tokensOf(summary),
            pressure: contextOf(summary),
            updatedAt: numOf(summary?.updatedAt),
            endedAt: numOf(summary?.endedAt),
            parentId,
            parentTitle: parentId === undefined ? undefined : (titleById.get(parentId) ?? parentId),
            failure: failureOf(summary),
            origin: typeof summary?.origin === 'string' ? summary.origin : undefined,
            childCount: (childrenMap.get(id) ?? []).length,
            messageIn: inCount,
            messageOut: outCount,
            messageTotal: inCount + outCount,
            lastMessageAt: lastMessageAt.get(id),
            home: { x: rootNode.home.x, y: rootNode.home.y },
            summary,
          }
        })

        rootNode.childCount = (childrenMap.get(sessionId) ?? []).length
        rootNode.messageIn = messageIn.get(rootNode.id) ?? 0
        rootNode.messageOut = messageOut.get(rootNode.id) ?? 0
        rootNode.messageTotal = rootNode.messageIn + rootNode.messageOut
        rootNode.lastMessageAt = lastMessageAt.get(rootNode.id)

        /* Edges follow the REAL parent chain; message traffic rides on top. */
        const edgeMap = new Map()
        const spawnKeys = new Set()
        for (const node of childNodes) {
          const parentId = node.parentId
          if (parentId === undefined || !nodeIds.has(parentId)) continue
          const key = `spawn:${parentId}->${node.id}`
          spawnKeys.add(key)
          edgeMap.set(key, { key, from: parentId, to: node.id, kind: 'spawn', count: 1, at: undefined, bow: 0 })
        }
        for (const [to, list] of incomingByNode) {
          for (const item of list) {
            if (!nodeIds.has(item.from) || item.from === to) continue
            const key = `message:${item.from}->${to}`
            const existing = edgeMap.get(key)
            if (existing === undefined) {
              edgeMap.set(key, { key, from: item.from, to, kind: 'message', count: 1, at: item.at, bow: 0 })
            } else {
              existing.count += 1
              if (item.at !== undefined && (existing.at === undefined || item.at > existing.at)) existing.at = item.at
            }
          }
        }
        const edges = Array.from(edgeMap.values())
        for (const edge of edges) {
          if (edge.kind !== 'message') continue
          /* A message mirroring the spawn edge of the same pair would hide    */
          /* under it, so it bows; opposite directions bow the other way.      */
          const pairedWithSpawn = spawnKeys.has(`spawn:${edge.from}->${edge.to}`)
          const pairedOpposite = edgeMap.has(`message:${edge.to}->${edge.from}`) || spawnKeys.has(`spawn:${edge.to}->${edge.from}`)
          if (pairedWithSpawn || pairedOpposite) edge.bow = String(edge.from) < String(edge.to) ? 14 : -14
        }
        edges.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'spawn' ? -1 : 1))

        /* 图上的邻接关系由 mapNeighbors 用「真正画出来的边」算（见下方
           sceneModel），模型层不再预计算一份永远被覆盖的 neighbors；统计口径
           只有 viewStats 一处，也不在这里重复累加。 */
        return {
          rootNode,
          nodes: childNodes,
          edges,
          incomingByNode,
          titleById,
          hasRoot: hasSession,
        }
      } catch (error) {
        console.warn(LOG, 'model build failed', error)
        return emptyModel()
      }
    }

    /**
     * The edges actually drawn on the map, derived from the REAL parent chain.
     *
     * For every drawn non-root node the spawn edge starts at its parent — never
     * at the hub — so `root → A → B` reads as two edges, not `root → B`.
     * When that parent is not drawn (depth filter, "only checked", node cap),
     * the walk climbs to the nearest drawn ancestor and marks the edge
     * `cross` (it skips levels). Only when no ancestor is drawn at all does it
     * fall back to the hub, and then it is flagged `orphan` so the UI can warn
     * instead of silently pretending the hub is the parent.
     *
     * Message edges keep their recorded direction (from → to) and appear only
     * when both endpoints are drawn.
     */
    const buildMapEdges = (shownNodes, allNodes, rootNode, messageEdges, onMap) => {
      const byId = new Map()
      if (Array.isArray(allNodes)) for (const node of allNodes) if (node !== undefined && node !== null) byId.set(node.id, node)
      if (rootNode !== undefined && rootNode !== null) byId.set(rootNode.id, rootNode)
      const drawn = onMap instanceof Set ? onMap : new Set()
      const out = []
      const seen = new Set()
      for (const node of Array.isArray(shownNodes) ? shownNodes : []) {
        if (node === undefined || node === null || node.isRoot === true) continue
        let cursor = node.parentId === undefined ? undefined : byId.get(node.parentId)
        let skipped = 0
        const guard = new Set([node.id])
        while (cursor !== undefined && !drawn.has(cursor.id) && !guard.has(cursor.id)) {
          guard.add(cursor.id)
          skipped += 1
          cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
        }
        let fromNode = cursor
        let orphan = false
        if (fromNode === undefined || fromNode.id === node.id) {
          if (rootNode === undefined || rootNode === null || !drawn.has(rootNode.id)) continue
          fromNode = rootNode
          orphan = true
          skipped = 0
        }
        const key = `spawn:${fromNode.id}->${node.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          key,
          from: fromNode.id,
          to: node.id,
          kind: 'spawn',
          at: undefined,
          bow: 0,
          skipped,
          cross: orphan !== true && skipped > 0,
          orphan,
        })
      }
      for (const edge of Array.isArray(messageEdges) ? messageEdges : []) {
        if (edge === undefined || edge === null || edge.kind !== 'message') continue
        if (!drawn.has(edge.from) || !drawn.has(edge.to)) continue
        if (edge.from === edge.to || seen.has(edge.key)) continue
        seen.add(edge.key)
        out.push({
          key: edge.key,
          from: edge.from,
          to: edge.to,
          kind: 'message',
          at: edge.at,
          bow: edge.bow,
          skipped: 0,
          cross: false,
          orphan: false,
        })
      }
      return out
    }

    const probeCapability = (ctx) => {
      let workspace
      try {
        workspace = ctx.get('uiWorkspace')
      } catch (error) {
        return { ok: false, reason: `读取 uiWorkspace 失败：${messageOf(error)}` }
      }
      if (workspace === undefined || workspace === null) return { ok: false, reason: '宿主未提供 uiWorkspace 服务' }
      if (typeof workspace.openSession !== 'function') return { ok: false, reason: 'uiWorkspace 未暴露 openSession()' }
      return { ok: true, reason: '' }
    }

    /* ------------------------------------------- child transcript in the sidebar */
    /* Address + open path mirror the host's own subagent chat tab:             */
    /*   dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode> */
    const SUBAGENT_CHAT_PREFIX = 'dsh-resource://subagentchat/session/'
    const normalizeMode = (mode) => (mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown')

    const buildSubagentChatAddress = (parentSessionId, childSessionId, mode) => {
      try {
        const search = new URLSearchParams({ parent: parentSessionId, mode })
        return `${SUBAGENT_CHAT_PREFIX}${encodeURIComponent(childSessionId)}?${String(search)}`
      } catch {
        return `${SUBAGENT_CHAT_PREFIX}${encodeURIComponent(childSessionId)}?parent=${encodeURIComponent(parentSessionId)}&mode=${encodeURIComponent(mode)}`
      }
    }

    /**
     * Whether the host can show a child transcript in its right column. Both
     * pieces are required, and either may simply be absent on another build.
     */
    const probeSideChat = (ctx) => {
      try {
        const tabs = ctx.get('sidebarRightTabs')
        if (tabs === undefined || tabs === null || typeof tabs.get !== 'function') {
          return { ok: false, reason: '宿主未提供 sidebarRightTabs 服务' }
        }
        if (tabs.get('subagentchat') === undefined) {
          return { ok: false, reason: '宿主未注册 subagentchat 侧栏页' }
        }
        const right = ctx.get('sidebarRight')
        const canOpenResource = right !== undefined && right !== null && typeof right.openResource === 'function'
        const canOpenTab = right !== undefined && right !== null && typeof right.openTab === 'function'
        if (!canOpenResource && !canOpenTab) {
          return { ok: false, reason: '宿主未提供 sidebarRight.openTab() / openResource()' }
        }
        return { ok: true, reason: '' }
      } catch (error) {
        return { ok: false, reason: messageOf(error) }
      }
    }

    /**
     * Read the sidebar's settled tab back, so an open that silently did nothing
     * is not reported as a success. `active()` is the only read the sidebar
     * exposes; it returns the active tab of the active pane, or undefined when
     * no surface is on screen.
     *
     * 回验只接受「确定矛盾」：宿主没有任何可读记录、或活动标签是别的 kind 时都算
     * 无法判定（浮窗可能仍是活动格，新标签落在停靠格里），不能因此误判失败；
     * 只有「同 kind、但 contentId 不是刚打开的那个」才说明导航没有落在目标上。
     */
    const verifyOpenedTab = (right, expectedContentId) => {
      try {
        if (right === null || right === undefined || typeof right.active !== 'function') return { ok: true, reason: '' }
        const record = right.active()
        if (record === null || record === undefined || typeof record !== 'object') return { ok: true, reason: '' }
        if (typeof record.kind === 'string' && record.kind !== 'subagentchat') return { ok: true, reason: '' }
        if (
          expectedContentId !== undefined
          && typeof record.contentId === 'string'
          && record.contentId !== expectedContentId
        ) {
          return { ok: false, reason: '侧栏活动标签不是刚打开的目标会话' }
        }
        return { ok: true, reason: '' }
      } catch {
        /* a throwing active() is a host we cannot read, not a failed open */
        return { ok: true, reason: '' }
      }
    }

    const writeClipboard = async (text) => {
      try {
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(text)
          return true
        }
      } catch {
        /* insecure context or denied permission: try the fallback path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.left = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let ok = false
        try {
          ok = document.execCommand('copy') === true
        } finally {
          area.remove()
        }
        return ok
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ icons */
    const glyphProps = (props) => ({
      width: props?.size ?? 14,
      height: props?.size ?? 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      className: props?.className,
      'aria-hidden': 'true',
      focusable: 'false',
    })

    function FishIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', {
          d: 'M2.6 12.2c2.4-3.3 5.7-5 9.5-5 2.6 0 4.9.7 6.9 2.1l2.2-2.5v10.8l-2.2-2.5c-2 1.4-4.3 2.1-6.9 2.1-3.8 0-7.1-1.7-9.5-5Z',
          fill: 'currentColor',
          fillOpacity: 0.92,
        }),
        h('circle', { cx: 7.3, cy: 10.9, r: 1.05, fill: 'var(--dsw-alias-bg-layer-1, #ffffff)' }),
        h('path', {
          d: 'M15.4 4.1c1.2-.8 2.6-1.2 4.1-1.1l-.4 1.5 1.1 1.1c-1.2.5-2.4.6-3.6.2Z',
          fill: 'currentColor',
          fillOpacity: 0.4,
        }),
      )
    }

    function SearchIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('circle', { cx: 10.5, cy: 10.5, r: 6.4, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M15.4 15.4 20 20', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function MapIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('circle', { cx: 12, cy: 12, r: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 4.6, cy: 6.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 19.4, cy: 17.6, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M10.3 10.6 6.1 7.5M13.7 13.4 17.9 16.5', stroke: 'currentColor', strokeWidth: 1.4 }),
      )
    }

    function ListIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', { d: 'M8.5 6.5h11M8.5 12h11M8.5 17.5h11', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 4.6, cy: 6.5, r: 1.3, fill: 'currentColor' }),
        h('circle', { cx: 4.6, cy: 12, r: 1.3, fill: 'currentColor' }),
        h('circle', { cx: 4.6, cy: 17.5, r: 1.3, fill: 'currentColor' }),
      )
    }

    function ChevronIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', { d: 'M6.5 9.5 12 15l5.5-5.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function CloseIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', { d: 'M6 6 18 18M18 6 6 18', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function CopyIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M15.5 5.5h-9a2 2 0 0 0-2 2v9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function OpenIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', { d: 'M13.5 4.5H19v5.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M19 4.5 11 12.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M17 14.5v3a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function PlusIcon(props) {
      return h('svg', glyphProps(props), h('path', { d: 'M12 5.5v13M5.5 12h13', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    function MinusIcon(props) {
      return h('svg', glyphProps(props), h('path', { d: 'M5.5 12h13', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    function FitIcon(props) {
      return h(
        'svg',
        glyphProps(props),
        h('path', {
          d: 'M4 9.5V4h5.5M20 9.5V4h-5.5M4 14.5V20h5.5M20 14.5V20h-5.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /* -------------------------------------------------------------------- css */
    /* Every surface that carries text is explicitly opaque (theme token plus a */
    /* real hex fallback, and a dark-theme fallback for older hosts). The map   */
    /* may be airy; the text layers never are.                                  */
    const STYLE_ATTR = 'data-matriline-style'
    const CSS = `
[data-fs-root] {
  --fs-panel: var(--dsw-alias-bg-layer-1, #ffffff);
  --fs-canvas: var(--dsw-alias-bg-base, #f5f7fa);
  --fs-raised: var(--dsw-alias-bg-layer-2, #eef1f6);
  --fs-sunken: var(--dsw-alias-bg-layer-3, #e6eaf1);
  --fs-ink: var(--dsw-alias-label-primary, #14161c);
  --fs-ink2: var(--dsw-alias-label-secondary, #545c6b);
  --fs-ink3: var(--dsw-alias-label-tertiary, #838b99);
  --fs-line: var(--dsw-alias-border-l2, rgba(15, 17, 21, 0.16));
  --fs-line-soft: var(--dsw-alias-border-l1, rgba(15, 17, 21, 0.08));
  --fs-accent: var(--dsw-alias-brand-primary, #3f6cf0);
  --fs-accent-soft: var(--dsw-alias-accent-soft, rgba(63, 108, 240, 0.14));
  --fs-edge: var(--dsw-alias-label-secondary, #545c6b);
  --fs-edge-strong: var(--dsw-alias-label-primary, #14161c);
  --fs-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --fs-dot: var(--dsw-alias-label-tertiary, #838b99);
  --fs-dot-soft: rgba(131, 139, 153, 0.16);
  --fs-c: var(--fs-dot);
  --fs-soft: var(--fs-dot-soft);
  position: relative; display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden; isolation: isolate;
  background-color: #f5f7fa;
  background: var(--fs-panel);
  color: var(--fs-ink);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 12px; line-height: 1.45; -webkit-font-smoothing: antialiased;
}
body[data-ds-dark-theme] [data-fs-root] {
  --fs-panel: var(--dsw-alias-bg-layer-1, #232324);
  --fs-canvas: var(--dsw-alias-bg-base, #171719);
  --fs-raised: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --fs-sunken: var(--dsw-alias-bg-layer-3, #353536);
  --fs-ink: var(--dsw-alias-label-primary, #f2f4f8);
  --fs-ink2: var(--dsw-alias-label-secondary, #cfd3d6);
  --fs-ink3: var(--dsw-alias-label-tertiary, #adb2b8);
  --fs-line: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
  --fs-line-soft: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  --fs-accent: var(--dsw-alias-brand-primary, #f9fafb);
  --fs-accent-soft: var(--dsw-alias-accent-soft, rgba(255, 255, 255, 0.14));
  --fs-edge: var(--dsw-alias-label-secondary, #cfd3d6);
  --fs-edge-strong: var(--dsw-alias-label-primary, #f9fafb);
  --fs-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --fs-dot: var(--dsw-alias-label-tertiary, #adb2b8);
  background-color: #1b1b1d;
}
[data-fs-root] *, [data-fs-root] *::before, [data-fs-root] *::after { box-sizing: border-box; }
[data-fs-root] button, [data-fs-root] input, [data-fs-root] select { font: inherit; color: inherit; }
[data-fs-root] [data-fs-status="running"] { --fs-c: var(--dsw-alias-state-success-primary, #22c55e); --fs-soft: rgba(34, 197, 94, 0.18); }
[data-fs-root] [data-fs-status="waiting"] { --fs-c: var(--dsw-alias-state-warn-primary, #f59e0b); --fs-soft: rgba(245, 158, 11, 0.18); }
[data-fs-root] [data-fs-status="idle"] { --fs-c: var(--dsw-alias-label-secondary, #545c6b); --fs-soft: rgba(84, 92, 107, 0.14); }
[data-fs-root] [data-fs-status="failed"] { --fs-c: var(--dsw-alias-state-error-primary, #ec1313); --fs-soft: rgba(236, 19, 19, 0.16); }
[data-fs-root] [data-fs-status="unknown"] { --fs-c: var(--dsw-alias-label-tertiary, #838b99); --fs-soft: rgba(131, 139, 153, 0.14); }
body[data-ds-dark-theme] [data-fs-root] [data-fs-status="idle"] { --fs-c: var(--dsw-alias-label-secondary, #cfd3d6); --fs-soft: rgba(207, 211, 214, 0.16); }
body[data-ds-dark-theme] [data-fs-root] [data-fs-status="failed"] { --fs-c: var(--dsw-alias-state-error-primary, #f25a5a); --fs-soft: rgba(242, 90, 90, 0.18); }

/* Shapes carry the status too: filled+pulse / diamond / hollow / square+! */
[data-fs-root] .fs-dot {
  position: relative; flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: var(--fs-c); box-shadow: 0 0 0 3px var(--fs-soft);
  display: inline-grid; place-items: center; transition: background 0.16s ease, border-color 0.16s ease;
}
[data-fs-status="running"] .fs-dot, .fs-dot[data-fs-status="running"] {
  background: var(--fs-c); border-radius: 50%; box-shadow: 0 0 0 3px var(--fs-soft);
  animation: fs-pulse 1.8s ease-in-out infinite;
}
[data-fs-status="waiting"] .fs-dot, .fs-dot[data-fs-status="waiting"] {
  background: transparent; border: 1.6px solid var(--fs-c); border-radius: 1.5px;
  transform: rotate(45deg); box-shadow: none; animation: none;
}
[data-fs-status="idle"] .fs-dot, .fs-dot[data-fs-status="idle"] {
  background: transparent; border: 1.6px solid var(--fs-c); border-radius: 50%;
  box-shadow: none; opacity: 0.8; animation: none;
}
[data-fs-status="failed"] .fs-dot, .fs-dot[data-fs-status="failed"] {
  background: var(--fs-c); border-radius: 2px; box-shadow: none; animation: none;
}
[data-fs-status="failed"] .fs-dot::after, .fs-dot[data-fs-status="failed"]::after {
  content: "!"; color: #ffffff; font-size: 6.5px; font-weight: 800; line-height: 1;
}
[data-fs-status="unknown"] .fs-dot, .fs-dot[data-fs-status="unknown"] {
  background: transparent; border: 1.5px dashed var(--fs-c); border-radius: 50%;
  box-shadow: none; opacity: 0.7; animation: none;
}

.fs-head {
  flex: none; display: flex; flex-direction: column; gap: 7px;
  padding: 9px 11px 8px; position: relative; z-index: 9;
  background-color: #ffffff; background: var(--fs-panel);
  border-bottom: 1px solid var(--fs-line-soft);
}
.fs-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 位置类样式只对 [data-fs-root] 生效：样式表是全局注入的，宿主或其他插件的
   同名 class（.fs-canvas / .fs-node / .fs-popover …）不应被这里的 absolute/inset
   覆盖。纯外观规则仍保持全局，避免整表重写。 */
[data-fs-root] .fs-search { position: relative; flex: 1 1 auto; min-width: 0; display: flex; align-items: center; }
[data-fs-root] .fs-search-icon { position: absolute; left: 8px; color: var(--fs-ink3); pointer-events: none; }
.fs-input {
  width: 100%; height: 27px; padding: 0 8px 0 25px; font-size: 11.5px; color: var(--fs-ink); outline: none;
  background-color: #f2f4f8; background: var(--fs-raised);
  border: 1px solid var(--fs-line-soft); border-radius: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.fs-input::placeholder { color: var(--fs-ink3); }
.fs-input:focus { border-color: var(--fs-accent); box-shadow: 0 0 0 2px var(--fs-accent-soft); }
.fs-seg {
  flex: none; display: flex; gap: 2px; padding: 2px;
  background-color: #eef1f6; background: var(--fs-raised);
  border-radius: 8px; border: 1px solid var(--fs-line-soft);
}
.fs-seg-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fs-ink2);
  cursor: pointer; white-space: nowrap; transition: background 0.15s ease, color 0.15s ease;
}
.fs-seg-btn:hover { color: var(--fs-ink); }
.fs-seg-btn[data-active="true"] {
  background-color: #ffffff; background: var(--fs-panel); color: var(--fs-ink);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.16);
}
.fs-chips { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; padding-bottom: 1px; }
.fs-chips::-webkit-scrollbar { display: none; }
.fs-chip {
  flex: none; display: inline-flex; align-items: center; gap: 4px; height: 21px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 999px; cursor: pointer; white-space: nowrap;
  background-color: #eef1f6; background: var(--fs-raised); color: var(--fs-ink2); font-size: 11px;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.fs-chip:hover { color: var(--fs-ink); }
.fs-chip[data-active="true"] {
  border-color: var(--fs-accent); background: var(--fs-accent-soft); color: var(--fs-ink);
}
.fs-chip-count { color: var(--fs-ink3); font-variant-numeric: tabular-nums; }
.fs-chip-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--fs-c); flex: none; }
.fs-select {
  flex: 1 1 0; min-width: 0; height: 25px; padding: 0 4px; font-size: 11px; color: var(--fs-ink2); cursor: pointer; outline: none;
  background-color: #eef1f6; background: var(--fs-raised);
  border: 1px solid var(--fs-line-soft); border-radius: 6px;
}
.fs-select:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 1px; }
.fs-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.fs-stat {
  padding: 4px 7px; border-radius: 8px;
  background-color: #eef1f6; background: var(--fs-raised);
  border: 1px solid var(--fs-line-soft);
}
.fs-stat-label { font-size: 10px; color: var(--fs-ink3); white-space: nowrap; }
.fs-stat-value {
  font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums; color: var(--fs-ink);
}
.fs-stat[data-fs-status="running"] .fs-stat-value { color: var(--fs-c); }
.fs-stat[data-fs-status="failed"] .fs-stat-value { color: var(--fs-c); }

.fs-body { position: relative; flex: 1 1 auto; min-height: 0; background-color: #f5f7fa; background: var(--fs-panel); }

[data-fs-root] .fs-canvas {
  position: absolute; inset: 0; overflow: hidden; touch-action: none;
  user-select: none; -webkit-user-select: none; cursor: grab;
  background-color: #f5f7fa; background: var(--fs-canvas);
  background-image: radial-gradient(circle at 1px 1px, var(--fs-line-soft) 1px, transparent 0);
  background-size: 24px 24px;
  /* The pan limit is a real limit, so make the canvas edge visible instead of
     letting it feel like an invisible wall. */
  box-shadow: inset 0 0 0 1px var(--fs-line-soft);
}
.fs-canvas[data-panning="true"] { cursor: grabbing; }
[data-fs-root] .fs-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
[data-fs-root] .fs-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.fs-edge {
  fill: none; stroke: var(--fs-edge); stroke-width: 1.4; opacity: 0.66;
  transition: opacity 0.16s ease, stroke 0.16s ease, stroke-width 0.16s ease;
}
.fs-edge[data-kind="spawn"] { stroke: var(--fs-edge); stroke-width: 1.4; opacity: 0.66; }
.fs-edge[data-kind="message"] { stroke: var(--fs-warn); stroke-width: 1.8; stroke-dasharray: 6 4; opacity: 0.95; }
/* Parent filtered out of the map: the edge climbs to the nearest drawn
   ancestor, and the short dashes say "levels were skipped here". */
.fs-edge[data-kind="spawn"][data-cross="true"] {
  stroke-dasharray: 2 4; stroke-width: 1.2; opacity: 0.55;
}
/* No drawn ancestor at all: attach to the hub, but say so in orange. */
.fs-edge[data-kind="spawn"][data-orphan="true"] {
  stroke: var(--fs-warn); stroke-dasharray: 5 3; stroke-width: 2; opacity: 1;
}
.fs-canvas[data-focus="true"] .fs-edge { opacity: 0.14; }
.fs-canvas[data-focus="true"] .fs-edge[data-hot="true"] {
  opacity: 1; stroke: var(--fs-edge-strong); stroke-width: 2.4;
}

[data-fs-root] .fs-node {
  /* Zoom is folded into the geometry: --fs-k = view.scale × depth scale.
     The element itself is only TRANSLATED (no CSS scale()), so text is
     rasterised at its final size and stays sharp at every zoom level. */
  --fs-k: 1;
  position: absolute; left: 0; top: 0;
  width: calc(${NODE_W}px * var(--fs-k, 1));
  height: calc(${NODE_H}px * var(--fs-k, 1));
  transform-origin: 50% 50%;
  display: flex; flex-direction: column; justify-content: space-between;
  gap: calc(2px * var(--fs-k, 1));
  padding: calc(7px * var(--fs-k, 1)) calc(8px * var(--fs-k, 1)) calc(7px * var(--fs-k, 1)) calc(10px * var(--fs-k, 1));
  cursor: grab; outline: none;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line);
  border-radius: calc(12px * var(--fs-k, 1));
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1), 0 6px 16px rgba(15, 23, 42, 0.07);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, opacity 0.18s ease;
  will-change: transform;
}
[data-fs-root] .fs-node::before {
  content: ""; position: absolute; left: 0;
  top: calc(12px * var(--fs-k, 1)); bottom: calc(12px * var(--fs-k, 1));
  width: max(1.5px, calc(2px * var(--fs-k, 1)));
  border-radius: 0 2px 2px 0; background: var(--fs-c); opacity: 0.95;
}
.fs-node:hover {
  border-color: var(--fs-edge); box-shadow: 0 2px 4px rgba(15, 23, 42, 0.12), 0 10px 22px rgba(15, 23, 42, 0.14);
}
.fs-node:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 2px; }
.fs-node[data-selected="true"] {
  border-color: var(--fs-accent);
  box-shadow: 0 0 0 2px var(--fs-accent-soft), 0 8px 22px rgba(15, 23, 42, 0.18);
}
.fs-node[data-root="true"] {
  background: linear-gradient(180deg, var(--fs-panel), var(--fs-raised));
  border-color: var(--fs-edge);
  border-width: 1.5px;
}
.fs-node[data-dim="true"] { opacity: 0.5; }
/* 「显示已隐藏」打开时，隐藏节点仍可看但一眼可分：~0.45 透明度 + 虚线圈。 */
.fs-node[data-hidden] {
  opacity: 0.45; border-style: dashed;
  outline: 1px dashed var(--fs-edge); outline-offset: 1px;
}
.fs-node[data-hidden]:hover { opacity: 0.8; }
.fs-node[data-status="running"] { border-color: var(--fs-c); }
.fs-node[data-status="failed"] { border-color: var(--fs-c); }
.fs-node-flag {
  flex: none; padding: 0 calc(4px * var(--fs-k, 1)); height: calc(13px * var(--fs-k, 1));
  line-height: calc(13px * var(--fs-k, 1)); border-radius: calc(4px * var(--fs-k, 1));
  background: var(--fs-accent-soft); color: var(--fs-accent);
  font-size: calc(9px * var(--fs-k, 1)); font-weight: 700;
}
.fs-node-top {
  display: flex; align-items: center; gap: calc(4px * var(--fs-k, 1)); min-width: 0;
  padding-right: calc(12px * var(--fs-k, 1));
}
.fs-node-status {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: calc(9.5px * var(--fs-k, 1)); font-weight: 700; letter-spacing: 0.02em; color: var(--fs-c);
}
.fs-node-title {
  flex: 1 1 auto; min-height: 0; display: flex; align-items: center;
}
.fs-node-title-text {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere;
  font-size: calc(11px * var(--fs-k, 1)); line-height: 1.3; font-weight: 600; color: var(--fs-ink);
}
.fs-node-bottom {
  display: flex; align-items: baseline; gap: calc(4px * var(--fs-k, 1)); min-width: 0;
  font-size: calc(9px * var(--fs-k, 1)); color: var(--fs-ink3); font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fs-node-depth {
  flex: none; padding: 0 calc(3px * var(--fs-k, 1)); border-radius: calc(3px * var(--fs-k, 1)); font-weight: 700;
  background: var(--fs-raised); color: var(--fs-ink2);
}
/* 宿主终态（超时 / 被拒绝 / 部分完成 …）：和状态徽标并列，卡片太窄时省略。 */
.fs-node-run {
  flex: none; max-width: 52%; padding: 0 calc(3px * var(--fs-k, 1));
  border-radius: calc(3px * var(--fs-k, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--fs-warn); color: #14161c;
  font-size: calc(8.5px * var(--fs-k, 1)); font-weight: 700;
}
.fs-node-token { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-node-ctx { flex: none; color: var(--fs-ink2); }
.fs-node-time { flex: none; margin-left: auto; }
[data-fs-root] .fs-node-check {
  position: absolute; top: calc(5px * var(--fs-k, 1)); right: calc(5px * var(--fs-k, 1));
  opacity: 0; transition: opacity 0.15s ease;
}
.fs-node:hover .fs-node-check, .fs-node[data-checked="true"] .fs-node-check, .fs-canvas[data-selecting="true"] .fs-node-check { opacity: 1; }
/* Status dot + checkbox scale with the card so they keep their proportions. */
.fs-node .fs-dot {
  width: calc(7px * var(--fs-k, 1)); height: calc(7px * var(--fs-k, 1));
  box-shadow: 0 0 0 calc(3px * var(--fs-k, 1)) var(--fs-soft);
}
.fs-node .fs-check {
  width: calc(13px * var(--fs-k, 1)); height: calc(13px * var(--fs-k, 1));
  border-radius: calc(3.5px * var(--fs-k, 1));
}
.fs-node .fs-check:checked::after {
  left: calc(3.5px * var(--fs-k, 1)); top: calc(1.2px * var(--fs-k, 1));
  width: calc(5px * var(--fs-k, 1)); height: calc(8px * var(--fs-k, 1));
  border-width: 0 max(1px, calc(1.5px * var(--fs-k, 1))) max(1px, calc(1.5px * var(--fs-k, 1))) 0;
}

[data-fs-root] .fs-check {
  appearance: none; -webkit-appearance: none; flex: none;
  width: 13px; height: 13px; margin: 0; padding: 0; border-radius: 3.5px; cursor: pointer;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-edge); position: relative;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.fs-check:hover { border-color: var(--fs-accent); }
.fs-check:checked { background: var(--fs-accent); border-color: var(--fs-accent); }
.fs-check:checked::after {
  content: ""; position: absolute; left: 3.5px; top: 1.2px; width: 5px; height: 8px;
  border: solid #ffffff; border-width: 0 1.5px 1.5px 0; transform: rotate(42deg);
}
body[data-ds-dark-theme] [data-fs-root] .fs-check:checked::after { border-color: #14161c; }
.fs-check:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 1px; }

[data-fs-root] .fs-legend {
  position: absolute; left: 9px; bottom: 9px; z-index: 3; pointer-events: none;
  display: flex; flex-direction: column; gap: 3px; max-width: calc(100% - 58px);
  padding: 6px 8px; border-radius: 8px;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line-soft);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
  font-size: 9.5px; color: var(--fs-ink2);
}
.fs-legend-row { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.fs-legend-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--fs-c); flex: none; }
.fs-legend-dash { width: 14px; height: 0; border-top: 1.6px dashed var(--fs-warn); flex: none; }
.fs-legend-line { width: 14px; height: 0; border-top: 1.4px solid var(--fs-edge); flex: none; }
.fs-legend-cross { width: 14px; height: 0; border-top: 1.2px dashed var(--fs-edge); opacity: 0.7; flex: none; }
.fs-legend-orphan { width: 14px; height: 0; border-top: 2px dashed var(--fs-warn); flex: none; }

[data-fs-root] .fs-map-note {
  position: absolute; top: 9px; left: 9px; z-index: 3; max-width: calc(100% - 60px);
  padding: 5px 8px; border-radius: 7px; pointer-events: none;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line-soft); color: var(--fs-ink2);
  font-size: 9.5px; line-height: 1.5; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
}

[data-fs-root] .fs-zoom {
  position: absolute; right: 9px; bottom: 9px; z-index: 4;
  display: flex; flex-direction: column; gap: 1px; padding: 2px; border-radius: 8px;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line-soft);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.1);
}
.fs-iconbtn {
  width: 25px; height: 25px; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--fs-ink2);
  cursor: pointer; transition: background 0.15s ease, color 0.15s ease;
}
.fs-iconbtn:hover { background-color: #eef1f6; background: var(--fs-raised); color: var(--fs-ink); }
.fs-iconbtn:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: -1px; }

/* Map detail: a small floating card next to the node, never a full-height
   drawer — the topology graph must stay readable while one node is inspected. */
[data-fs-root] .fs-popover {
  position: absolute; z-index: 6;
  width: min(260px, calc(100% - 16px)); max-height: 60%;
  display: flex; flex-direction: column;
  border-radius: 10px; overflow: hidden;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.24);
  animation: fs-fade 0.14s ease-out;
}
.fs-popover-head {
  flex: none; display: flex; align-items: flex-start; gap: 6px; padding: 8px 6px 7px 9px;
  border-bottom: 1px solid var(--fs-line-soft);
  background-color: #ffffff; background: var(--fs-panel);
}
.fs-popover-title {
  flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.4;
  color: var(--fs-ink); overflow-wrap: anywhere;
}
.fs-popover-body {
  flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 8px 9px 12px; display: flex; flex-direction: column; gap: 9px;
  background-color: #ffffff; background: var(--fs-panel);
}
.fs-popover-body::-webkit-scrollbar { width: 6px; }
.fs-popover-body::-webkit-scrollbar-thumb { background: var(--fs-line); border-radius: 4px; }
/* List detail: an inline block under its own row, so the list is not covered. */
.fs-row-detail {
  display: flex; flex-direction: column; gap: 9px;
  margin: 2px 0 3px 18px; padding: 8px 9px 10px;
  border-radius: 8px; border: 1px dashed var(--fs-line);
  background-color: #eef1f6; background: var(--fs-raised);
  animation: fs-fade 0.14s ease-out;
}
.fs-toggle {
  flex: none; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
  font-size: 11px; color: var(--fs-ink2); cursor: pointer; padding: 0 2px;
}
.fs-toggle[data-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.fs-toggle:hover[data-disabled="false"] { color: var(--fs-ink); }
.fs-section { display: flex; flex-direction: column; gap: 5px; }
.fs-section-title {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--fs-ink3);
}
.fs-kv { display: flex; gap: 7px; align-items: flex-start; font-size: 11px; line-height: 1.55; }
.fs-kv-key { flex: none; width: 52px; color: var(--fs-ink3); }
.fs-kv-val { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--fs-ink); }
.fs-kv-total .fs-kv-val { font-weight: 600; }
.fs-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 10.5px; }
.fs-pill {
  display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 7px; flex: none;
  border-radius: 999px; background: var(--fs-soft); color: var(--fs-c);
  font-size: 10.5px; font-weight: 700; white-space: nowrap;
}
.fs-pill .fs-dot { box-shadow: none; }
.fs-note { font-size: 10.5px; line-height: 1.6; color: var(--fs-ink3); margin: 0; }
.fs-note[data-tone="warn"] {
  color: var(--fs-warn); background: rgba(245, 158, 11, 0.12);
  border-radius: 6px; padding: 5px 7px; border: 1px solid rgba(245, 158, 11, 0.3);
}
.fs-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.fs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; cursor: pointer;
  height: 25px; padding: 0 8px; font-size: 11px; color: var(--fs-ink);
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line); border-radius: 6px;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.fs-btn:hover:not(:disabled) { background-color: #eef1f6; background: var(--fs-raised); }
/* 「显示已隐藏」开关：aria-pressed=true 时高亮，状态一眼可见。 */
.fs-btn[data-active="true"] {
  border-color: var(--fs-accent); background-color: #eef1f6; background: var(--fs-accent-soft); color: var(--fs-accent);
}
.fs-btn:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 1px; }
.fs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fs-btn[data-tone="primary"] {
  background-color: #3f6cf0; background: var(--fs-accent); border-color: transparent; color: #ffffff;
}
body[data-ds-dark-theme] [data-fs-root] .fs-btn[data-tone="primary"] { color: #14161c; }
.fs-btn[data-tone="primary"]:hover:not(:disabled) { filter: brightness(1.06); }

[data-fs-root] .fs-batch {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 7;
  display: flex; align-items: center; gap: 4px; max-width: calc(100% - 18px);
  padding: 5px 6px; border-radius: 10px;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.24);
  animation: fs-rise 0.16s ease-out;
}
.fs-batch-count { padding: 0 4px; font-size: 10.5px; font-weight: 700; white-space: nowrap; color: var(--fs-ink2); }

[data-fs-root] .fs-toast {
  position: absolute; left: 10px; right: 10px; bottom: 54px; z-index: 8;
  padding: 6px 9px; border-radius: 7px; font-size: 11px; line-height: 1.45;
  background: var(--fs-ink); color: var(--fs-panel);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.28);
  animation: fs-fade 0.16s ease-out;
}
.fs-toast[data-tone="error"] { background: var(--fs-warn); color: #14161c; }

[data-fs-root] .fs-list {
  position: absolute; inset: 0; z-index: 2; overflow: auto; overscroll-behavior: contain;
  padding: 8px 9px 58px; flex-direction: column; gap: 9px;
  background-color: #ffffff; background: var(--fs-panel);
}
.fs-list::-webkit-scrollbar { width: 7px; }
.fs-list::-webkit-scrollbar-thumb { background: var(--fs-line); border-radius: 4px; }
.fs-list-note {
  flex: none; padding: 4px 6px; border-radius: 6px;
  background-color: #eef1f6; background: var(--fs-raised);
  border: 1px dashed var(--fs-line-soft); color: var(--fs-ink2);
  font-size: 9.5px; line-height: 1.5; font-variant-numeric: tabular-nums;
}
.fs-group { display: flex; flex-direction: column; gap: 4px; }
.fs-group-head { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 1px 2px; }
.fs-group-toggle {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 5px;
  border: 0; background: transparent; padding: 2px 0; cursor: pointer; text-align: left;
  font-size: 11px; font-weight: 700; color: var(--fs-ink2);
}
.fs-group-toggle:hover { color: var(--fs-ink); }
.fs-group-toggle:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 2px; border-radius: 4px; }
.fs-chevron { flex: none; transition: transform 0.16s ease; color: var(--fs-ink3); }
.fs-group-toggle[data-open="false"] .fs-chevron { transform: rotate(-90deg); }
.fs-group-count {
  flex: none; min-width: 16px; height: 15px; padding: 0 4px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--fs-raised); color: var(--fs-ink2); font-size: 9.5px; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.fs-group-tokens { flex: none; font-size: 9.5px; color: var(--fs-ink3); font-variant-numeric: tabular-nums; }
.fs-row {
  display: flex; align-items: center; gap: 6px; padding: 5px 7px; border-radius: 7px;
  background-color: #ffffff; background: var(--fs-panel);
  border: 1px solid var(--fs-line-soft);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.fs-row:hover { border-color: var(--fs-line); background-color: #eef1f6; background: var(--fs-raised); }
.fs-row[data-selected="true"] { border-color: var(--fs-accent); }
.fs-row-root { background-color: #eef1f6; background: var(--fs-raised); border-style: dashed; }
/* 列表里的隐藏节点：同拓扑图，降透明度 + 虚线边。 */
.fs-row[data-hidden] { opacity: 0.45; border-style: dashed; }
.fs-row[data-hidden]:hover { opacity: 0.85; }
.fs-row-main {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px;
  border: 0; background: transparent; padding: 0; text-align: left; cursor: pointer;
}
.fs-row-main:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 2px; border-radius: 4px; }
.fs-row-title {
  font-size: 11.5px; color: var(--fs-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fs-row-meta {
  display: flex; align-items: center; gap: 4px; font-size: 9.5px;
  color: var(--fs-ink3); font-variant-numeric: tabular-nums;
  overflow: hidden; white-space: nowrap;
}
.fs-row-depth {
  flex: none; padding: 0 3px; border-radius: 3px; background: var(--fs-sunken);
  color: var(--fs-ink2); font-weight: 700;
}
.fs-row-run {
  flex: none; padding: 0 3px; border-radius: 3px;
  background: var(--fs-warn); color: #14161c; font-weight: 700;
}
.fs-row-root-tag {
  flex: none; padding: 0 4px; border-radius: 4px; font-size: 9px; font-weight: 700;
  background: var(--fs-accent-soft); color: var(--fs-accent);
}

[data-fs-root] .fs-state {
  position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; padding: 22px; text-align: center;
  background-color: #ffffff; background: var(--fs-panel);
  animation: fs-fade 0.18s ease-out;
}
.fs-state-icon { color: var(--fs-ink3); opacity: 0.6; }
.fs-state-title { font-size: 12.5px; font-weight: 700; color: var(--fs-ink); }
.fs-state-desc { max-width: 250px; font-size: 10.5px; line-height: 1.65; color: var(--fs-ink2); }
.fs-skeletons { display: flex; flex-direction: column; gap: 6px; width: min(260px, 100%); }
.fs-skel {
  height: 34px; border-radius: 8px;
  background: linear-gradient(90deg, var(--fs-raised) 25%, var(--fs-panel) 37%, var(--fs-raised) 63%);
  background-size: 400% 100%; animation: fs-shimmer 1.5s ease infinite;
}

.fs-fallback {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  height: 100%; padding: 20px; text-align: center;
  background: #f5f7fa; color: #14161c;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
}
.fs-fallback pre {
  max-width: 100%; max-height: 160px; overflow: auto; margin: 0; padding: 6px 8px;
  border-radius: 6px; background: rgba(20, 24, 33, 0.08); font-size: 10px; text-align: left;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

.fs-gate-row {
  position: relative; display: flex; flex-wrap: wrap; align-items: center;
  justify-content: space-between; gap: 4px 16px; min-height: 34px; padding: 0 8px;
  border-radius: var(--dsw-radius-md, 8px);
  color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px;
}
.fs-gate-label { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
/* Same hit area and hover treatment as the official Team toggle row. */
.fs-gate-toggle { position: static; }
.fs-gate-toggle:after {
  content: ""; position: absolute; inset: 0; border-radius: var(--dsw-radius-md, 8px);
}
.fs-gate-row:has(.fs-gate-toggle:focus-visible) {
  background: var(--dsw-alias-interactive-bg-hover);
}
@media (hover: hover) {
  .fs-gate-row:has(.fs-gate-toggle:not(:disabled)):hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
/* Fallback only when the host does not expose the primitives module. */
.fs-gate-switch {
  flex: none; width: 32px; height: 18px; padding: 0;
  border: none; border-radius: 9px; cursor: pointer; transition: background-color 0.15s;
  background: var(--dsw-alias-interactive-bg-hover-solid, #d9dde3);
}
.fs-gate-switch:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-fluid, #cfd4dc);
}
.fs-gate-switch[aria-checked="true"] { background: var(--dsw-static-deepseek-500, #4d6bfe); }
.fs-gate-switch[aria-checked="true"]:hover:not(:disabled) {
  background: var(--dsw-static-deepseek-600, #3b5bdb);
}
.fs-gate-switch:disabled { opacity: 0.55; cursor: default; }
.fs-gate-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 0.15s;
}
.fs-gate-switch[aria-checked="true"] .fs-gate-knob { transform: translateX(14px); }
.fs-gate-error {
  flex-basis: 100%; font-size: 11px; line-height: 1.4;
  color: var(--dsw-alias-state-error-primary, #d92d20);
}
/* Same dialog/copy treatment as the official Team-disable confirmation. */
.fs-confirm-dialog { width: min(440px, 100%); max-height: 100%; }
.fs-confirm-content { overscroll-behavior: contain; min-height: 0; overflow-y: auto; }
.fs-confirm-copy {
  overflow-wrap: anywhere; min-width: 0; color: var(--dsw-alias-label-secondary);
  font-size: 14px; line-height: 22px;
}
.fs-confirm-copy p { margin: 0; }
.fs-confirm-copy p + p { margin-top: 12px; }
.fs-confirm-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }

@keyframes fs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes fs-slide { from { transform: translateX(20px); opacity: 0.35; } to { transform: none; opacity: 1; } }
@keyframes fs-rise { from { transform: translate(-50%, 8px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
@keyframes fs-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes fs-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

@media (prefers-reduced-motion: reduce) {
  [data-fs-root] *, [data-fs-root] *::before, [data-fs-root] *::after {
    animation: none !important; transition: none !important;
  }
}
`

    const injectStyles = () => {
      try {
        if (typeof document === 'undefined') return () => {}
        /* Always a fresh tag: on a client hot-reload the old module's disposer
           can run after the new module mounted, and a shared tag would then be
           removed while the new panel is live (unstyled, transparent). */
        const element = document.createElement('style')
        element.setAttribute(STYLE_ATTR, '')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          try {
            element.remove()
          } catch {
            /* already gone */
          }
        }
      } catch (error) {
        console.warn(LOG, 'stylesheet injection failed', error)
        return () => {}
      }
    }

    const setIndeterminate = (element, value) => {
      try {
        if (element !== null && element !== undefined) element.indeterminate = value === true
      } catch {
        /* a detached input needs nothing */
      }
    }

    /** Catches a render-time throw so a broken summary can never blank the panel. */
    class MatrilineBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.warn(LOG, 'render failed', error, info)
      }

      render() {
        if (this.state.error !== undefined) {
          return h(
            'div',
            { className: 'fs-fallback', role: 'alert' },
            h(FishIcon, { size: 26 }),
            h('div', null, '子代理拓扑渲染出错'),
            h('pre', null, messageOf(this.state.error)),
          )
        }
        return this.props.children
      }
    }

    function makeBody(ctx) {
      const noopStore = () => undefined
      const noopProjection = () => undefined

      const MatrilineBody = function MatrilineBody(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        /* 宿主在面板生命周期内固定 slot props，但热更新 / slot 重注册可能让同一个
           组件实例在后续渲染里拿到另一套 hook。首帧就把实现定下来（useState 的
           惰性初始化只跑一次），每次渲染都调用同一个函数实例：React 看到的 hook
           序列永远稳定，不会出现「这次渲染比上次多调了一个 hook」。拿不到宿主
           hook 时退回模块级 noop，它自己不含任何 hook，面板显示「无法读取会话
           数据」而不是在渲染期抛错。 */
        const [sessionStore] = useState(() =>
          typeof props?.useSessions === 'function' ? props.useSessions : noopStore,
        )
        const [projectionReader] = useState(() =>
          typeof props?.useProjection === 'function' ? props.useProjection : noopProjection,
        )

        /* ------------------------------------------------------------------ state */
        const [clock, setClock] = useState(() => Date.now())
        const [viewMode, setViewMode] = useState('map')
        const [search, setSearch] = useState('')
        const [statusFilter, setStatusFilter] = useState('all')
        const [timeFilter, setTimeFilter] = useState('all')
        const [edgeFilter, setEdgeFilter] = useState('all')
        const [groupBy, setGroupBy] = useState('status')
        const [collapsedMap, setCollapsedMap] = useState({})
        const [detailId, setDetailId] = useState(undefined)
        const [hoveredId, setHoveredId] = useState(undefined)
        const [checked, setChecked] = useState([])
        const [toast, setToast] = useState(undefined)
        const [waited, setWaited] = useState(false)
        const [retryTick, setRetryTick] = useState(0)
        const [panning, setPanning] = useState(false)
        const [expandDepth, setExpandDepth] = useState('all')
        const [sortBy, setSortBy] = useState('recent')
        const [onlyChecked, setOnlyChecked] = useState(false)
        /* 「显示已隐藏」: false = 自动隐藏的节点不参与布局、不画、不计入
           计数（默认）；true = 全部显示，隐藏节点用视觉区别标出来。 */
        const [showHidden, setShowHidden] = useState(false)

        /* ------------------------------------------------------------------- refs */
        const rootRef = useRef(null)
        const bodyRef = useRef(null)
        const canvasRef = useRef(null)
        const worldRef = useRef(null)
        const edgeSvgRef = useRef(null)
        const popoverRef = useRef(null)
        const detailIdRef = useRef(undefined)
        const popoverSyncRef = useRef(() => {})
        const nodeElsRef = useRef(new Map())
        const edgeElsRef = useRef(new Map())
        const syncSceneRef = useRef(() => {})
        const positionsRef = useRef(new Map())
        const viewRef = useRef({ x: 0, y: 0, scale: 1 })
        const modelRef = useRef(emptyModel())
        const dragRef = useRef(undefined)
        const panRef = useRef(undefined)
        const wakeRef = useRef(() => {})
        const activeRef = useRef(false)
        const mountedRef = useRef(true)
        const toastTimerRef = useRef(undefined)
        const userAdjustedRef = useRef(false)
        const lastCheckedRef = useRef(undefined)
        const visibleOrderRef = useRef([])
        /** Persistent rest offset baked from the one-shot relaxation (per layout). */
        const restOffsetsRef = useRef(new Map())
        /** Temporary drag displacement; decays every step back to the rest spot. */
        const dragOffsetsRef = useRef(new Map())
        const layoutSignatureRef = useRef('')
        const arrowIdRef = useRef(`fs-arrow-${Math.random().toString(36).slice(2, 9)}`)

        /* ------------------------------------------------------------ store read */
        /* Both hooks above are frozen on the first render, so these calls are     */
        /* unconditional AND always reach the same implementation: the hook order  */
        /* can never change between renders, even if the slot props did.           */
        let byId
        try {
          byId = sessionStore((state) => (state === null || state === undefined ? undefined : state.byId))
        } catch (error) {
          console.warn(LOG, 'sessions store read failed', error)
          byId = undefined
        }

        /* `subagentCatalog` carries each child's durable mode, which the native */
        /* subagent-chat address requires; without it we degrade to "unknown".   */
        let catalog
        try {
          catalog = projectionReader('subagentCatalog')
        } catch (error) {
          console.warn(LOG, 'subagent catalog read failed', error)
          catalog = undefined
        }
        const modeById = new Map()
        if (Array.isArray(catalog)) {
          for (const entry of catalog) {
            if (entry === null || entry === undefined) continue
            const id = typeof entry.id === 'string' ? entry.id : undefined
            if (id === undefined) continue
            modeById.set(id, normalizeMode(entry.mode))
          }
        }

        /* ---------------------------------------------------------------- model */
        const model = useMemo(() => buildModel(byId, sessionId, clock), [byId, sessionId, clock])
        const query = search.trim().toLowerCase()

        /* ------------------------------------------------------------- 隐藏集合 */
        /* 自动隐藏的判据（唯一实现处）：status 是终态 AND endedAt（无则 updatedAt）
           距今 > AUTO_HIDE_AFTER_MS AND 不在最近完成的 AUTO_HIDE_KEEP_RECENT 个
           里。根节点永不隐藏。 */
        const hiddenPlan = useMemo(() => {
          const auto = new Set()
          const reasonById = new Map()
          try {
            /* “最近完成的 8 个”是全局概念，不随工具条筛选变化。 */
            const finished = []
            for (const node of model.nodes) {
              if (node.isRoot === true) continue
              /* 先看节点此刻是否活着：宿主的 runStatus 可能是上一次运行的终态，
                 而摘要已经报告 running = true；endedAt 同样是上一次运行留下的，
                 对运行中/等待中的节点没有意义。活动状态永远压过终态。 */
              if (node.status === 'running' || node.status === 'waiting') continue
              if (!isTerminalRunStatus(node.runStatus ?? node.status)) continue
              const endedAt = node.endedAt ?? node.updatedAt
              if (endedAt === undefined) continue
              finished.push({ id: node.id, endedAt })
            }
            finished.sort((left, right) => right.endedAt - left.endedAt)
            const recent = new Set()
            for (const item of finished.slice(0, AUTO_HIDE_KEEP_RECENT)) recent.add(item.id)
            for (const item of finished) {
              if (recent.has(item.id)) continue
              if (clock - item.endedAt <= AUTO_HIDE_AFTER_MS) continue
              auto.add(item.id)
            }
            for (const id of auto) reasonById.set(id, 'auto')
            /* 主会话就是这张图的中心，任何规则都不隐藏它（防呆）。 */
            const rootId = model.rootNode.id
            if (rootId !== '') {
              auto.delete(rootId)
              reasonById.delete(rootId)
            }
          } catch (error) {
            console.warn(LOG, 'auto-hide plan failed', error)
          }
          return { auto, reasonById, total: reasonById.size }
        }, [model.nodes, model.rootNode.id, clock])
        /** 'auto' | undefined — undefined 表示可见。 */
        const hiddenKindOf = (id) => hiddenPlan.reasonById.get(id)

        /* 搜索 / 时间 / 消息往来命中的全部子节点（**不含状态筛选**，也还没去掉
           隐藏节点）。状态 chip 的计数要基于它，否则选中「运行中」之后其他 chip
           都会被自己的筛选清零。 */
        const matchedChildren = useMemo(
          () => model.nodes.filter((node) => nodeMatches(node, query, 'all', timeFilter, edgeFilter, clock)),
          [model.nodes, query, timeFilter, edgeFilter, clock],
        )
        /* 计数基准：命中筛选且未隐藏的子节点。Requirement 5: 自动隐藏只是取点前
           过滤 —— 层级过滤、排序、「只画选中」、节点上限照旧作用在它上面。 */
        const visibleBase = useMemo(
          () => (showHidden ? matchedChildren : matchedChildren.filter((node) => hiddenKindOf(node.id) === undefined)),
          [matchedChildren, showHidden, hiddenPlan],
        )
        /* 真正进入列表与拓扑图的节点：基准再叠加状态筛选。 */
        const filteredChildren = useMemo(
          () => (statusFilter === 'all' ? visibleBase : visibleBase.filter((node) => node.status === statusFilter)),
          [visibleBase, statusFilter],
        )
        /* 工具条计数只看屏幕上的子节点：隐藏节点、根节点都不计入（根节点在列表
           顶部单独展示，但「总数 / 总 token」说的是这一群后代）。状态筛选不参与，
           所以每个 chip 的数字都是「切到这个状态会看到几个」。 */
        const viewStats = useMemo(() => {
          const stats = { total: 0, running: 0, waiting: 0, idle: 0, failed: 0, unknown: 0, tokens: 0 }
          for (const node of visibleBase) {
            stats.total += 1
            if (node.status === 'running') stats.running += 1
            else if (node.status === 'waiting') stats.waiting += 1
            else if (node.status === 'idle') stats.idle += 1
            else if (node.status === 'failed') stats.failed += 1
            else stats.unknown += 1
            if (node.tokens !== undefined) stats.tokens += node.tokens.total
          }
          return stats
        }, [visibleBase])
        /* Both views consume `ordered`: the list renders it, the map takes its
           first MAX_MAP_NODES from it, so the list order and the map order
           can never disagree. */
        const ordered = useMemo(() => {
          const list = filteredChildren.slice()
          list.sort((left, right) => compareNodes(left, right, sortBy))
          return list
        }, [filteredChildren, sortBy])
        const groups = useMemo(() => buildGroups(ordered, groupBy, clock), [ordered, groupBy, clock])

        /* Map picking: depth filter → "only checked" (when anything is
           checked) → first MAX_MAP_NODES in sort order → then every ancestor
           needed to hang those nodes off the root, so the layered layout can
           actually attach each child to its parent. */
        const picked = useMemo(() => {
          const limit = expandDepth === 'all' ? Number.POSITIVE_INFINITY : expandDepth
          const pool = ordered.filter((node) => node.depth <= limit)
          const wanted = onlyChecked && checked.length > 0 ? pool.filter((node) => checked.includes(node.id)) : pool
          const capped = wanted.slice(0, MAX_MAP_NODES)
          const byId = new Map(model.nodes.map((node) => [node.id, node]))
          const rootId = model.rootNode.id
          const nodes = []
          const seen = new Set()
          const include = (node) => {
            if (node === undefined || seen.has(node.id)) return
            seen.add(node.id)
            if (node.parentId !== undefined && node.parentId !== '' && node.parentId !== rootId) {
              const parent = byId.get(node.parentId)
              /* 父链补全不许把隐藏节点拉回图上（否则「不画」就破了）：遇到隐藏
                 祖先就停，边随后由 buildMapEdges 接到最近可见祖先并标成跨层。 */
              if (showHidden || parent === undefined || hiddenKindOf(parent.id) === undefined) include(parent)
            }
            nodes.push(node)
          }
          for (const node of capped) include(node)
          return { nodes, cappedCount: capped.length }
        }, [ordered, expandDepth, onlyChecked, checked, model.nodes, model.rootNode.id, showHidden, hiddenPlan])
        const shownNodes = picked.nodes
        const ancestorExtra = Math.max(0, shownNodes.length - picked.cappedCount)
        const layout = useMemo(() => buildTreeLayout(shownNodes, model.rootNode), [shownNodes, model.rootNode])
        const mapNodes = useMemo(
          () =>
            [Object.assign({}, model.rootNode, { home: layout.rootHome })].concat(
              shownNodes.map((node) => Object.assign({}, node, { home: layout.homes.get(node.id) ?? layout.rootHome })),
            ),
          [model.rootNode, shownNodes, layout],
        )
        const mapIds = useMemo(() => new Set(mapNodes.map((node) => node.id)), [mapNodes])
        const mapEdges = useMemo(
          () => buildMapEdges(shownNodes, model.nodes, model.rootNode, model.edges, mapIds),
          [shownNodes, model.nodes, model.rootNode, model.edges, mapIds],
        )
        const mapNeighbors = useMemo(() => {
          const result = new Map()
          const link = (a, b) => {
            if (!result.has(a)) result.set(a, new Set())
            result.get(a).add(b)
          }
          for (const edge of mapEdges) {
            link(edge.from, edge.to)
            link(edge.to, edge.from)
          }
          return result
        }, [mapEdges])
        const mapWorld = { w: layout.worldW, h: layout.worldH }
        /* Filtered nodes that did not make it onto the map, i.e. what the list
           still holds. Counted against the filtered set, not the raw tree, so
           the caption never claims phantom hidden nodes. */
        const hiddenFromMap = useMemo(() => {
          let count = 0
          for (const node of filteredChildren) if (!mapIds.has(node.id)) count += 1
          return count
        }, [filteredChildren, mapIds])

        /* --------------------------------------------------------------- derived */
        const hasStore = typeof props?.useSessions === 'function'
        const sessionCount = listSessions(byId).length
        const storeState = !hasStore
          ? 'unavailable'
          : byId === undefined || (sessionCount === 0 && !waited)
            ? 'loading'
            : sessionCount === 0
              ? 'empty-store'
              : 'ready'
        const childCount = model.nodes.length
        const hasChildren = childCount > 0
        const filteredCount = filteredChildren.length
        const detailNode =
          detailId === undefined
            ? undefined
            : (model.nodes.concat(mapNodes).find((node) => node.id === detailId) ??
              (model.rootNode.id === detailId ? model.rootNode : undefined))
        /* 隐藏节点不画时，它的详情也不浮出来（开关打开后照常可看）。 */
        const hasDetail = detailNode !== undefined && (showHidden || hiddenKindOf(detailNode.id) === undefined)
        const openProbe = probeCapability(ctx)
        const sideProbe = probeSideChat(ctx)
        const activeFilterCount =
          (statusFilter === 'all' ? 0 : 1) +
          (timeFilter === 'all' ? 0 : 1) +
          (edgeFilter === 'all' ? 0 : 1) +
          (query === '' ? 0 : 1)
        const neighborSet = (hoveredId === undefined ? undefined : mapNeighbors.get(hoveredId)) ?? new Set()
        const sortLabel = (SORT_OPTIONS.find((option) => option[0] === sortBy) ?? ['', '最近活动'])[1]
        const onlyCheckedActive = onlyChecked && checked.length > 0

        /* -------------------------------------------------------------- feedback */
        const notify = useCallback((text, tone) => {
          try {
            setToast({ text: String(text), tone: tone === 'error' ? 'error' : 'ok' })
            if (toastTimerRef.current !== undefined) clearTimeout(toastTimerRef.current)
            toastTimerRef.current = setTimeout(() => {
              toastTimerRef.current = undefined
              setToast(undefined)
            }, TOAST_MS)
          } catch (error) {
            console.warn(LOG, 'toast failed', error)
          }
        }, [])

        /* ------------------------------------------------------------ view maths */
        /** Seeding target of one node: its layout home plus the baked rest offset and any drag displacement. */
        const targetPosition = (node) => {
          const rest = restOffsetsRef.current.get(node.id)
          const drag = dragOffsetsRef.current.get(node.id)
          return {
            x: node.home.x + (rest === undefined ? 0 : rest.x) + (drag === undefined ? 0 : drag.x),
            y: node.home.y + (rest === undefined ? 0 : rest.y) + (drag === undefined ? 0 : drag.y),
          }
        }

        /**
         * Runtime resting target: the parent's CURRENT position plus this
         * node's home offset from that parent, plus the baked rest offset and
         * the decaying drag displacement. Anchoring to the live parent (not to
         * a frozen home) is what keeps a child beside its parent. The root has
         * no parent, so it falls back to its own home.
         */
        const restingTarget = (node, nodeById, positions) => {
          const rest = restOffsetsRef.current.get(node.id)
          const drag = dragOffsetsRef.current.get(node.id)
          const dx = (rest === undefined ? 0 : rest.x) + (drag === undefined ? 0 : drag.x)
          const dy = (rest === undefined ? 0 : rest.y) + (drag === undefined ? 0 : drag.y)
          const parentNode = node.parentId === undefined ? undefined : nodeById.get(node.parentId)
          const parentHome = parentNode === undefined ? undefined : parentNode.home
          const parentPosition = parentNode === undefined ? undefined : positions.get(parentNode.id)
          if (parentHome !== undefined && parentPosition !== undefined) {
            return {
              x: parentPosition.x + (node.home.x - parentHome.x) + dx,
              y: parentPosition.y + (node.home.y - parentHome.y) + dy,
            }
          }
          return { x: node.home.x + dx, y: node.home.y + dy }
        }

        /**
         * Freeze the settled scene: bake each node's current offset from its
         * parent-relative rest spot into restOffsetsRef. After this the spring
         * has nothing left to pull, which is what lets the loop actually sleep
         * instead of simmering forever (the old continuous relaxation never
         * fully settled and looked like jitter).
         */
        const bakeRestOffsets = () => {
          try {
            const currentModel = modelRef.current
            const positions = positionsRef.current
            const nodeById = new Map()
            for (const node of currentModel.mapNodes) nodeById.set(node.id, node)
            const rest = restOffsetsRef.current
            rest.clear()
            for (const node of currentModel.mapNodes) {
              if (node.isRoot === true) continue
              const position = positions.get(node.id)
              if (position === undefined) continue
              const parentNode = node.parentId === undefined ? undefined : nodeById.get(node.parentId)
              const parentHome = parentNode === undefined ? undefined : parentNode.home
              const parentPosition = parentNode === undefined ? undefined : positions.get(parentNode.id)
              const baseX =
                parentHome !== undefined && parentPosition !== undefined
                  ? parentPosition.x + (node.home.x - parentHome.x)
                  : node.home.x
              const baseY =
                parentHome !== undefined && parentPosition !== undefined
                  ? parentPosition.y + (node.home.y - parentHome.y)
                  : node.home.y
              rest.set(node.id, { x: position.x - baseX, y: position.y - baseY })
            }
          } catch (error) {
            console.warn(LOG, 'rest bake failed', error)
          }
        }

        /* ------------------------------------------------------------ view maths */
        /** Keep the edge <svg> big enough for the current zoom factor. */
        const updateEdgeLayerSize = () => {
          try {
            const svg = edgeSvgRef.current
            if (svg === null || svg === undefined) return
            const world = modelRef.current.world ?? { w: 480, h: 720 }
            const factor = viewRef.current.scale
            const width = Math.max(1, Math.round(world.w * factor))
            const height = Math.max(1, Math.round(world.h * factor))
            if (typeof svg.setAttribute === 'function') {
              svg.setAttribute('width', String(width))
              svg.setAttribute('height', String(height))
              svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
            }
          } catch (error) {
            console.warn(LOG, 'edge layer resize failed', error)
          }
        }

        const applyView = useCallback((next) => {
          try {
            const canvas = canvasRef.current
            const current = modelRef.current
            const previousScale = viewRef.current.scale
            const scale = clamp(next.scale, SCALE_MIN, SCALE_MAX)
            let x = next.x
            let y = next.y
            if (canvas !== null && canvas !== undefined) {
              const rect = canvas.getBoundingClientRect()
              const width = rect.width || 320
              const height = rect.height || 380
              /* Pan limits come from the drawn content (the layout world plus
                 anything the user dragged off it) with a generous screen of
                 slack, never a fixed ratio, so the map is not pinned. */
              let minX = 0
              let minY = 0
              let maxX = current.world?.w ?? 480
              let maxY = current.world?.h ?? 720
              for (const node of current.mapNodes) {
                const position = positionsRef.current.get(node.id) ?? node.home
                if (position === undefined) continue
                const half = nodeHalf(node)
                minX = Math.min(minX, position.x - half.hw)
                minY = Math.min(minY, position.y - half.hh)
                maxX = Math.max(maxX, position.x + half.hw)
                maxY = Math.max(maxY, position.y + half.hh)
              }
              const slackX = Math.max(64, width * 0.75)
              const slackY = Math.max(64, height * 0.75)
              x = clamp(x, -maxX * scale - slackX, width - minX * scale + slackX)
              y = clamp(y, -maxY * scale - slackY, height - minY * scale + slackY)
            }
            const value = { x, y, scale }
            viewRef.current = value
            const element = worldRef.current
            if (element !== null && element !== undefined) {
              /* Translation only — NO scale() here. The zoom factor is folded
                 into the node geometry (position, size, font-size via --fs-k)
                 and into the vector edge paths, so text is rasterised at its
                 final size and stays sharp at every zoom level. */
              element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
            }
            if (scale !== previousScale) {
              /* Only the zoom factor changed the geometry; repaint the DOM
                 imperatively (no React state, no layout, no physics). */
              updateEdgeLayerSize()
              syncSceneRef.current()
            }
            /* The popover is positioned in screen space, so a pure pan moves the
               node under it too — re-anchor after every view change, not only
               when the zoom factor changed. */
            popoverSyncRef.current()
          } catch (error) {
            console.warn(LOG, 'view update failed', error)
          }
        }, [])

        const zoomAt = useCallback((factor, clientX, clientY) => {
          try {
            const canvas = canvasRef.current
            if (canvas === null || canvas === undefined) return
            const rect = canvas.getBoundingClientRect()
            const px = clientX - rect.left
            const py = clientY - rect.top
            const current = viewRef.current
            const scale = clamp(current.scale * factor, SCALE_MIN, SCALE_MAX)
            const ratio = scale / current.scale
            applyView({ x: px - ratio * (px - current.x), y: py - ratio * (py - current.y), scale })
          } catch (error) {
            console.warn(LOG, 'zoom failed', error)
          }
        }, [applyView])

        const zoomAtRef = useRef(zoomAt)
        useIso(() => {
          zoomAtRef.current = zoomAt
        }, [zoomAt])

        const fitView = useCallback(() => {
          try {
            const canvas = canvasRef.current
            if (canvas === null || canvas === undefined) return
            const rect = canvas.getBoundingClientRect()
            const width = rect.width
            const height = rect.height
            if (width < 24 || height < 24) return
            const currentModel = modelRef.current
            if (currentModel.mapNodes.length === 0) return
            let minX = Infinity
            let minY = Infinity
            let maxX = -Infinity
            let maxY = -Infinity
            for (const node of currentModel.mapNodes) {
              const half = nodeHalf(node)
              const position = positionsRef.current.get(node.id) ?? node.home
              minX = Math.min(minX, position.x - half.hw)
              minY = Math.min(minY, position.y - half.hh)
              maxX = Math.max(maxX, position.x + half.hw)
              maxY = Math.max(maxY, position.y + half.hh)
            }
            const boundsW = Math.max(NODE_W * 1.5, maxX - minX)
            const boundsH = Math.max(NODE_H * 1.5, maxY - minY)
            const scale = clamp(
              Math.min((width - VIEW_PAD * 2) / boundsW, (height - VIEW_PAD * 2) / boundsH),
              SCALE_MIN,
              1.05,
            )
            applyView({
              x: (width - boundsW * scale) / 2 - minX * scale,
              y: (height - boundsH * scale) / 2 - minY * scale,
              scale,
            })
          } catch (error) {
            console.warn(LOG, 'fit failed', error)
          }
        }, [applyView])

        /* ------------------------------------------------------ element registry */
        const registerNodeElement = useCallback((id, element) => {
          if (element === null || element === undefined) {
            nodeElsRef.current.delete(id)
            return
          }
          nodeElsRef.current.set(id, element)
          const position = positionsRef.current.get(id)
          const node = modelRef.current.mapNodes.find((item) => item.id === id)
          if (position !== undefined) {
            /* Zoom is folded into geometry (no CSS scale): --fs-k drives the
               card box + font sizes, the transform only positions it. */
            const factor = viewRef.current.scale
            const nodeScale = node === undefined ? 1 : node.scale
            const k = factor * (typeof nodeScale === 'number' && nodeScale > 0 ? nodeScale : 1)
            element.style.setProperty('--fs-k', k.toFixed(4))
            element.style.transform = `translate3d(${(position.x * factor - (NODE_W * k) / 2).toFixed(2)}px, ${(position.y * factor - (NODE_H * k) / 2).toFixed(2)}px, 0)`
          }
        }, [])

        const registerEdgeElement = useCallback((key, element) => {
          if (element === null || element === undefined) {
            edgeElsRef.current.delete(key)
            return
          }
          edgeElsRef.current.set(key, element)
        }, [])

        /* -------------------------------------------------------------- physics */
        const ensurePositions = useCallback((currentModel) => {
          try {
            const positions = positionsRef.current
            const keep = new Set()
            for (const node of currentModel.mapNodes) {
              keep.add(node.id)
              if (!positions.has(node.id)) {
                const target = targetPosition(node)
                positions.set(node.id, { x: target.x, y: target.y, vx: 0, vy: 0 })
              }
            }
            for (const id of Array.from(positions.keys())) {
              if (!keep.has(id)) positions.delete(id)
            }
            const keepOffsets = new Set(currentModel.nodes.map((node) => node.id))
            if (currentModel.rootNode.id !== '') keepOffsets.add(currentModel.rootNode.id)
            for (const map of [dragOffsetsRef.current, restOffsetsRef.current]) {
              for (const id of Array.from(map.keys())) {
                if (!keepOffsets.has(id)) map.delete(id)
              }
            }
          } catch (error) {
            console.warn(LOG, 'position seeding failed', error)
          }
        }, [])

        const syncScene = useCallback(() => {
          try {
            const currentModel = modelRef.current
            const positions = positionsRef.current
            const factor = viewRef.current.scale
            const nodeById = new Map(currentModel.mapNodes.map((node) => [node.id, node]))
            updateEdgeLayerSize()
            for (const node of currentModel.mapNodes) {
              const element = nodeElsRef.current.get(node.id)
              const position = positions.get(node.id)
              if (element === undefined || position === undefined) continue
              /* Zoom × depth scale drives the geometry, NOT a CSS scale():
                 --fs-k feeds width/height/font-size/padding via calc(), and the
                 transform is a pure translation, so text render stays crisp. */
              const nodeScale = typeof node.scale === 'number' && node.scale > 0 ? node.scale : 1
              const k = factor * nodeScale
              element.style.setProperty('--fs-k', k.toFixed(4))
              element.style.transform = `translate3d(${(position.x * factor - (NODE_W * k) / 2).toFixed(2)}px, ${(position.y * factor - (NODE_H * k) / 2).toFixed(2)}px, 0)`
            }
            const rootPosition = positions.get(currentModel.rootNode.id) ?? currentModel.rootNode.home
            const scaledPoint = (point) => ({ x: point.x * factor, y: point.y * factor })
            const scaledHub = scaledPoint(rootPosition)
            for (const edge of currentModel.edges) {
              const element = edgeElsRef.current.get(edge.key)
              if (element === undefined) continue
              const from = positions.get(edge.from)
              const to = positions.get(edge.to)
              const fromNode = nodeById.get(edge.from)
              const toNode = nodeById.get(edge.to)
              if (from === undefined || to === undefined || fromNode === undefined || toNode === undefined) continue
              const fromHalf = nodeHalf(fromNode)
              const toHalf = nodeHalf(toNode)
              const path = edgePath(
                scaledPoint(from),
                scaledPoint(to),
                { hw: fromHalf.hw * factor, hh: fromHalf.hh * factor },
                { hw: toHalf.hw * factor, hh: toHalf.hh * factor },
                edge.bow * factor,
                scaledHub,
                EDGE_PAD * factor,
              )
              if (element.getAttribute('d') !== path) element.setAttribute('d', path)
            }
            /* Physics and relaxation move cards without a React render; the
               screen-space popover has to follow, or it detaches from its node. */
            popoverSyncRef.current()
          } catch (error) {
            console.warn(LOG, 'scene sync failed', error)
          }
        }, [])

        /* applyView (defined earlier) needs the latest syncScene; keep a ref so
           the memoised callback never captures a stale one. */
        useIso(() => {
          syncSceneRef.current = syncScene
        }, [syncScene])

        const stepPhysics = useCallback((dt, useOutsideNudge) => {
          try {
            const currentModel = modelRef.current
            const positions = positionsRef.current
            const drag = dragRef.current
            const dragOffsets = dragOffsetsRef.current
            const nodes = currentModel.mapNodes
            const nodeById = new Map()
            for (const node of nodes) nodeById.set(node.id, node)
            /* Fixed timestep: the loop always advances exactly FIXED_STEP (one
               rAF tick = 1/60 s); no wall-clock dt is ever consulted, so the
               same data always settles the same way. `step` is 1 at that fixed
               step and only exists so the integrator is written in time units. */
            const step = typeof dt === 'number' && dt > 0 ? dt / FIXED_STEP : 1

            /* A drag displacement decays every step, so a card the user shoved
               away drifts back to its parent-anchored rest spot. */
            for (const [id, offset] of dragOffsets) {
              offset.x *= OFFSET_DECAY
              offset.y *= OFFSET_DECAY
              if (Math.abs(offset.x) < 0.2 && Math.abs(offset.y) < 0.2) dragOffsets.delete(id)
            }

            /* Damped spring toward the resting target: the PARENT-anchored rest
               spot (following the parent's live position, plus the decaying
               drag displacement). There is no global ring to return to. */
            for (const node of nodes) {
              const position = positions.get(node.id)
              if (position === undefined) continue
              if (drag !== undefined && drag.id === node.id) {
                position.vx = 0
                position.vy = 0
                continue
              }
              const target = restingTarget(node, nodeById, positions)
              position.vx += (target.x - position.x) * SPRING * step
              position.vy += (target.y - position.y) * SPRING * step
            }

            /* Requirement 16: message pull is the weakest force; it only acts
               beyond MSG_MIN_DIST, so cards that are already close are never
               pulled through each other. */
            attractMessageEdges(positions, currentModel.edges, MSG_PULL, MSG_MAX_FORCE, MSG_MIN_DIST)

            /* Soft hierarchy ordering: a child should sit a little farther from
               the hub than its parent. This runs ONLY during the one-shot
               relaxation — as a permanent force it would fight the frozen rest
               layout every frame and keep the scene simmering (jitter). The
               layout itself already mirrors a spoke outward, so the preference
               survives in the frozen picture. */
            const rootHome = currentModel.rootNode.home ?? { x: 0, y: 0 }
            const rootPosition = positions.get(currentModel.rootNode.id) ?? rootHome
            if (useOutsideNudge === true) {
              for (const node of nodes) {
                if (node.isRoot === true) continue
                if (drag !== undefined && drag.id === node.id) continue
                const position = positions.get(node.id)
                if (position === undefined) continue
                const parentNode = node.parentId === undefined ? undefined : nodeById.get(node.parentId)
                const parentPosition = parentNode === undefined ? undefined : positions.get(parentNode.id)
                if (parentPosition === undefined) continue
                const childRadius = Math.hypot(position.x - rootPosition.x, position.y - rootPosition.y)
                if (childRadius < 0.001) continue
                const parentRadius = Math.hypot(parentPosition.x - rootPosition.x, parentPosition.y - rootPosition.y)
                const push = outsideParentForce(
                  childRadius,
                  parentRadius,
                  OUTSIDE_GAP,
                  OUTSIDE_PULL,
                  OUTSIDE_CAP,
                  OUTSIDE_DEAD_ZONE,
                )
                if (push <= 0) continue
                position.vx += ((position.x - rootPosition.x) / childRadius) * push * step
                position.vy += ((position.y - rootPosition.y) / childRadius) * push * step
              }
            }

            /* Mutual exclusion, softened: the push is scaled down at very close
               range instead of exploding, and it is a velocity so MAX_SPEED
               below applies to it like every other force. */
            for (let i = 0; i < nodes.length; i += 1) {
              const nodeA = nodes[i]
              const a = positions.get(nodeA.id)
              if (a === undefined) continue
              for (let j = i + 1; j < nodes.length; j += 1) {
                const nodeB = nodes[j]
                const b = positions.get(nodeB.id)
                if (b === undefined) continue
                const needed = nodeRadius(nodeA) + nodeRadius(nodeB) - OVERLAP_TOLERANCE
                let dx = b.x - a.x
                let dy = b.y - a.y
                let distance = Math.hypot(dx, dy)
                if (distance >= needed) continue
                if (distance < 0.001) {
                  dx = 1
                  dy = 0
                  distance = 1
                }
                const soften = distance / Math.max(distance, SOFT_DIST)
                const push = ((needed - distance) * 0.5) * SEPARATION * soften
                const ux = dx / distance
                const uy = dy / distance
                const aPinned = nodeA.isRoot === true || (drag !== undefined && drag.id === nodeA.id)
                const bPinned = nodeB.isRoot === true || (drag !== undefined && drag.id === nodeB.id)
                if (!aPinned) {
                  a.vx -= ux * push * step
                  a.vy -= uy * push * step
                }
                if (!bPinned) {
                  b.vx += ux * push * step
                  b.vy += uy * push * step
                }
              }
            }

            /* Integrate and damp with a hard speed cap: no single frame can
               overshoot and bounce back. Deliberately NO clamp to the layout
               box — the user may drag a card anywhere, and the home spring
               brings it back. The hub itself is pinned. */
            for (const node of nodes) {
              const position = positions.get(node.id)
              if (position === undefined) continue
              if (node.isRoot === true) {
                position.x = node.home.x
                position.y = node.home.y
                position.vx = 0
                position.vy = 0
                continue
              }
              if (drag !== undefined && drag.id === node.id) continue
              const speed = Math.hypot(position.vx, position.vy)
              if (speed > MAX_SPEED) {
                position.vx = (position.vx / speed) * MAX_SPEED
                position.vy = (position.vy / speed) * MAX_SPEED
              }
              position.x += position.vx * step
              position.y += position.vy * step
              position.vx *= VELOCITY_RETENTION
              position.vy *= VELOCITY_RETENTION
            }
          } catch (error) {
            console.warn(LOG, 'physics step failed', error)
          }
        }, [])

        const wake = useCallback(() => {
          try {
            wakeRef.current()
          } catch (error) {
            console.warn(LOG, 'wake failed', error)
          }
        }, [])

        /**
         * 「重置布局」: forget every drag displacement and baked rest offset,
         * stop the springs and re-fit. The escape hatch for a map dragged into
         * a mess — nothing can be lost permanently, because no node is clamped
         * to a box any more.
         */
        const resetLayout = useCallback(() => {
          try {
            userAdjustedRef.current = false
            dragOffsetsRef.current.clear()
            restOffsetsRef.current.clear()
            layoutSignatureRef.current = ''
            for (const position of positionsRef.current.values()) {
              position.vx = 0
              position.vy = 0
            }
            fitView()
            wake()
          } catch (error) {
            console.warn(LOG, 'layout reset failed', error)
          }
        }, [fitView, wake])

        /* ------------------------------------------------------------ selection */
        const toggleChecked = useCallback((id, extend) => {
          setChecked((current) => {
            try {
              if (extend === true) {
                const order = visibleOrderRef.current
                const anchor = lastCheckedRef.current
                const fromIndex = anchor === undefined ? -1 : order.indexOf(anchor)
                const toIndex = order.indexOf(id)
                if (fromIndex !== -1 && toIndex !== -1) {
                  const start = Math.min(fromIndex, toIndex)
                  const end = Math.max(fromIndex, toIndex)
                  const next = new Set(current)
                  for (const item of order.slice(start, end + 1)) next.add(item)
                  return Array.from(next)
                }
              }
              return current.includes(id) ? current.filter((item) => item !== id) : current.concat([id])
            } catch {
              return current
            }
          })
          lastCheckedRef.current = id
        }, [])

        /* 清空多选时把 Shift 连选的锚点一起清掉：否则下一次 shift-click 会从
           旧锚点开始，把一段用户刚取消的范围又选回来。 */
        const clearChecked = useCallback(() => {
          lastCheckedRef.current = undefined
          setChecked([])
        }, [])

        const setSelectionForNodes = (nodes, select) => {
          const ids = nodes.map((node) => node.id)
          setChecked((current) => {
            const next = new Set(current)
            for (const id of ids) {
              if (select === true) next.add(id)
              else next.delete(id)
            }
            return Array.from(next)
          })
        }

        /* ------------------------------------------------------------- clipboard */
        const copyText = useCallback((text, label) => {
          try {
            writeClipboard(String(text))
              .then((ok) => {
                notify(ok ? `已复制${label}` : '复制失败：剪贴板不可用', ok ? 'ok' : 'error')
              })
              .catch(() => notify('复制失败：剪贴板不可用', 'error'))
          } catch (error) {
            notify(`复制失败：${messageOf(error)}`, 'error')
          }
        }, [notify])

        /**
         * Open one child transcript in the native right column (main column untouched).
         *
         * 0.2.2 的 `openResource` / `openTab` 是同步 void、失败才抛出，所以「返回了」
         * 不等于「打开了」。宿主暴露 `active()` 时把落定的标签读回来核对，落后
         * 不一致就返回失败、交给调用方走主栏，而不是假装成功。较新的宿主可能返回
         * Promise：await 它，拒绝同样当作失败（绝不吞掉一个 rejected promise）。
         */
        const openInSidebar = async (node) => {
          const probe = probeSideChat(ctx)
          if (!probe.ok) return { ok: false, reason: probe.reason }
          if (node.isRoot) return { ok: false, reason: '主会话就是当前对话，无需在侧栏打开' }
          try {
            const right = ctx.get('sidebarRight')
            const parentId = typeof node.parentId === 'string' ? node.parentId : sessionId
            const mode = modeById.get(node.id) ?? 'unknown'
            const address = buildSubagentChatAddress(parentId, node.id, mode)
            /* Requirement 23: a NEW TAB in the CURRENT right sidebar — never a
               second pane/split. The host splits only when preferNewPane is
               truthy, so it is pinned to false here (the same options the
               better-sidebar plugin uses when it opens a child transcript). */
            const options = { kind: 'subagentchat', preferNewPane: false }
            const attempts = []
            if (typeof right.openResource === 'function') {
              attempts.push({
                label: 'openResource()',
                run: () => right.openResource(address, options),
                /* openResource records the resource address as the tab's contentId. */
                expectedContentId: address,
              })
            }
            if (typeof right.openTab === 'function') {
              attempts.push({
                label: 'openTab()',
                run: () => right.openTab('subagentchat', { params: { address }, preferNewPane: false }),
                /* 页标签记录的是页地址，不是子会话地址：只能核对 kind。 */
                expectedContentId: undefined,
              })
            }
            if (attempts.length === 0) return { ok: false, reason: '宿主没有可用的侧栏打开接口' }
            let reason = ''
            for (const attempt of attempts) {
              try {
                const returned = attempt.run()
                if (returned !== null && returned !== undefined && typeof returned.then === 'function') await returned
              } catch (error) {
                reason = `${attempt.label} 抛出：${messageOf(error)}`
                continue
              }
              const verified = verifyOpenedTab(right, attempt.expectedContentId)
              if (!verified.ok) {
                reason = verified.reason
                continue
              }
              return { ok: true, reason: '' }
            }
            return { ok: false, reason: reason === '' ? '宿主没有可用的侧栏打开接口' : reason }
          } catch (error) {
            return { ok: false, reason: messageOf(error) }
          }
        }

        /** Main-column jump, used only when the host cannot host the transcript aside. */
        const openInMain = (node) => {
          const probe = probeCapability(ctx)
          if (!probe.ok) return { ok: false, reason: probe.reason }
          try {
            const workspace = ctx.get('uiWorkspace')
            const parentId = typeof node.parentId === 'string' ? node.parentId : sessionId
            const mode = modeById.get(node.id) ?? 'unknown'
            const targets = node.isRoot
              ? [{ kind: 'session', sessionId: node.id }, node.id]
              : [{ kind: 'subagent', parentSessionId: parentId, childSessionId: node.id, mode }, node.id]
            let lastReason = ''
            for (const target of targets) {
              try {
                workspace.openSession(target)
                return { ok: true, reason: '' }
              } catch (error) {
                lastReason = messageOf(error)
              }
            }
            return { ok: false, reason: lastReason }
          } catch (error) {
            return { ok: false, reason: messageOf(error) }
          }
        }

        /* openInSidebar 现在是 async（要 await 宿主可能返回的 Promise 并回验）；
           openNode 因此也 async。内部全程 catch，onClick 里不 await 也不会产生
           未处理的 rejection。 */
        const openNode = async (node, place) => {
          if (node === undefined) return
          try {
            const preferSide = place === undefined ? sideProbe.ok : place === 'side'
            if (preferSide) {
              const result = await openInSidebar(node)
              if (result.ok) {
                notify('已在当前右侧栏新建标签页打开子会话，主栏对话未被打断', 'ok')
                return
              }
              /* Requirement 23: never pretend success — fall back to the main
                 column and say exactly what failed. */
              const fallback = openInMain(node)
              if (fallback.ok) notify(`侧栏打开失败（${result.reason}），已退回主栏打开`, 'error')
              else notify(`无法打开会话：侧栏失败（${result.reason}）；主栏失败（${fallback.reason}）`, 'error')
              return
            }
            const result = openInMain(node)
            if (result.ok) notify(node.isRoot ? '已切回主会话' : '已在主栏打开会话', 'ok')
            else notify(`无法打开会话：${result.reason}`, 'error')
          } catch (error) {
            notify(`无法打开会话：${messageOf(error)}`, 'error')
          }
        }

        const copyCheckedIds = () => {
          if (checked.length === 0) return
          copyText(checked.join('\n'), `${checked.length} 个会话 ID`)
        }

        const openCheckedIds = async () => {
          if (checked.length === 0) return
          /* 上限与拓扑图一致：一次点击最多打开 MAX_BATCH_OPEN 个标签页（宿主没有
             「全部关闭」），超出的部分明确说出来，而不是默默全开或默默丢掉。 */
          const ids = checked.slice(0, MAX_BATCH_OPEN)
          try {
            let sideCount = 0
            let mainCount = 0
            let fallbackCount = 0
            let failed = 0
            let lastReason = ''
            for (const id of ids) {
              const node = model.nodes.find((item) => item.id === id) ?? (model.rootNode.id === id ? model.rootNode : undefined)
              if (node === undefined) continue
              const useSide = sideProbe.ok && !node.isRoot
              let result = useSide ? await openInSidebar(node) : openInMain(node)
              let usedMain = !useSide
              let fellBack = false
              if (!result.ok && useSide) {
                result = openInMain(node)
                usedMain = true
                fellBack = true
              }
              if (result.ok) {
                /* 「侧栏失败、改走主栏」单列：否则用户会以为是自己选择在主栏打开的。 */
                if (fellBack) fallbackCount += 1
                else if (usedMain) mainCount += 1
                else sideCount += 1
              } else {
                failed += 1
                lastReason = result.reason
              }
            }
            const parts = []
            if (sideCount > 0) parts.push(`侧栏新标签页 ${sideCount} 个`)
            if (mainCount > 0) parts.push(`主栏打开 ${mainCount} 个`)
            if (fallbackCount > 0) parts.push(`侧栏失败、改走主栏 ${fallbackCount} 个`)
            if (failed > 0) parts.push(`${failed} 个失败：${lastReason}`)
            const skipped = checked.length - ids.length
            if (skipped > 0) parts.push(`另有 ${skipped} 个超出单次上限 ${MAX_BATCH_OPEN} 未打开`)
            notify(parts.length === 0 ? '没有可打开的会话' : parts.join('，'), failed > 0 ? 'error' : 'ok')
          } catch (error) {
            notify(`批量打开失败：${messageOf(error)}`, 'error')
          }
        }

        const copyDetail = (node) => {
          const payload = {
            id: node.id,
            title: node.title,
            status: node.status,
            depth: node.depth,
            parentId: node.parentId,
            updatedAt: node.updatedAt,
            tokens: node.tokens,
            pressure: node.pressure,
            messages: { incoming: node.messageIn, outgoing: node.messageOut, lastAt: node.lastMessageAt },
            childCount: node.childCount,
          }
          copyText(JSON.stringify(payload, null, 2), '节点详情')
        }

        /* -------------------------------------------------------------- dragging */
        const startNodeDrag = (event, node) => {
          try {
            if (event.button !== undefined && event.button !== 0) return
            const target = event.target
            if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.fs-check') !== null) return
            const canvas = canvasRef.current
            const position = positionsRef.current.get(node.id)
            if (canvas === null || canvas === undefined || position === undefined) return
            /* Requirement 20: grabbing the hub pans the whole view. The root
               never moves and no physics runs — it is exactly a canvas pan. */
            if (node.isRoot === true) {
              const currentView = viewRef.current
              panRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: currentView.x,
                originY: currentView.y,
                moved: false,
                nodeId: node.id,
              }
              userAdjustedRef.current = true
              setPanning(true)
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              } catch {
                /* pointer capture is a nicety, not a requirement */
              }
              return
            }
            const rect = canvas.getBoundingClientRect()
            const currentView = viewRef.current
            /* Requirement 22: a node whose detail is already open is NOT
               draggable — the press only arms a click that toggles the detail. */
            if (detailId === node.id) {
              dragRef.current = {
                id: node.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
                clickOnly: true,
              }
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              } catch {
                /* pointer capture is a nicety, not a requirement */
              }
              return
            }
            const pointerX = (event.clientX - rect.left - currentView.x) / currentView.scale
            const pointerY = (event.clientY - rect.top - currentView.y) / currentView.scale
            dragRef.current = {
              id: node.id,
              pointerId: event.pointerId,
              offsetX: position.x - pointerX,
              offsetY: position.y - pointerY,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            }
            /* Requirement 15: pointerdown only arms a click candidate. The
               detail opens on pointerup, and only if the pointer barely moved. */
            setHoveredId(node.id)
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* pointer capture is a nicety, not a requirement */
            }
            wake()
          } catch (error) {
            console.warn(LOG, 'drag start failed', error)
          }
        }

        const moveNodeDrag = (event) => {
          try {
            const drag = dragRef.current
            if (drag === undefined) return
            if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return
            /* Requirement 22: a click-only candidate (detail already open) never
               moves the card; beyond the slop it simply stops being a click. */
            if (drag.clickOnly === true) {
              const slopX = event.clientX - (drag.startX ?? event.clientX)
              const slopY = event.clientY - (drag.startY ?? event.clientY)
              if (Math.hypot(slopX, slopY) > CLICK_SLOP) drag.moved = true
              return
            }
            /* Below the slop threshold this is still a click: do not move the
               card yet, or a 1px tremor would drag it and suppress the detail. */
            if (drag.moved !== true) {
              const slopX = event.clientX - (drag.startX ?? event.clientX)
              const slopY = event.clientY - (drag.startY ?? event.clientY)
              if (Math.hypot(slopX, slopY) < CLICK_SLOP) return
              drag.moved = true
            }
            const canvas = canvasRef.current
            const position = positionsRef.current.get(drag.id)
            if (canvas === null || canvas === undefined || position === undefined) return
            const rect = canvas.getBoundingClientRect()
            const currentView = viewRef.current
            position.x = (event.clientX - rect.left - currentView.x) / currentView.scale + drag.offsetX
            position.y = (event.clientY - rect.top - currentView.y) / currentView.scale + drag.offsetY
            position.vx = 0
            position.vy = 0
            wake()
          } catch (error) {
            console.warn(LOG, 'drag failed', error)
          }
        }

        const endNodeDrag = (event, allowOpenDetail) => {
          const drag = dragRef.current
          if (drag === undefined) return
          dragRef.current = undefined
          try {
            if (event?.currentTarget !== null && event?.currentTarget !== undefined && typeof event.currentTarget.releasePointerCapture === 'function') {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          } catch {
            /* capture already released */
          }
          if (drag.moved !== true) {
            /* Requirement 15: a press that never travelled is a click. A click
               toggles the detail (requirement 22), so the same node closes it. */
            if (allowOpenDetail === true) setDetailId((current) => (current === drag.id ? undefined : drag.id))
            return
          }
          /* A drag attempt on a node whose detail is open does nothing at all. */
          if (drag.clickOnly === true) return
          /* Keep the drop spot for a moment: the drag displacement decays, so
             the card drifts back to its parent-anchored rest spot. */
          try {
            const node = modelRef.current.mapNodes.find((item) => item.id === drag.id)
            const position = positionsRef.current.get(drag.id)
            if (node !== undefined && position !== undefined) {
              const rest = restOffsetsRef.current.get(node.id)
              const restX = rest === undefined ? 0 : rest.x
              const restY = rest === undefined ? 0 : rest.y
              dragOffsetsRef.current.set(node.id, { x: position.x - node.home.x - restX, y: position.y - node.home.y - restY })
            }
          } catch (error) {
            console.warn(LOG, 'keeping the dropped position failed', error)
          }
          wake()
        }

        /** A cancelled/lost pointer must not leave a hub-pan half-open. */
        const endNodePan = () => {
          const pan = panRef.current
          if (pan === undefined || pan.nodeId === undefined) return
          panRef.current = undefined
          setPanning(false)
        }

        /* ------------------------------------------------------------------ pan */
        const onCanvasPointerDown = (event) => {
          try {
            if (event.button !== undefined && event.button !== 0) return
            const target = event.target
            if (target !== null && target !== undefined && typeof target.closest === 'function') {
              if (target.closest('[data-fs-node]') !== null) return
              if (target.closest('[data-fs-overlay]') !== null) return
            }
            const currentView = viewRef.current
            panRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: currentView.x,
              originY: currentView.y,
              moved: false,
            }
            userAdjustedRef.current = true
            setPanning(true)
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* panning still works without capture */
            }
          } catch (error) {
            console.warn(LOG, 'pan start failed', error)
          }
        }

        const onCanvasPointerMove = (event) => {
          try {
            const pan = panRef.current
            if (pan === undefined) return
            if (pan.pointerId !== undefined && event.pointerId !== pan.pointerId) return
            const dx = event.clientX - pan.startX
            const dy = event.clientY - pan.startY
            if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true
            applyView({ x: pan.originX + dx, y: pan.originY + dy, scale: viewRef.current.scale })
          } catch (error) {
            console.warn(LOG, 'pan failed', error)
          }
        }

        /**
         * End a canvas pan. `allowClick === false` for pointercancel / lost
         * capture: the browser took the pointer away (touch gesture, scroll,
         * another element capturing), which is not a click — it must never
         * open or dismiss a detail.
         */
        const endCanvasPan = (event, allowClick) => {
          const pan = panRef.current
          if (pan === undefined) return
          panRef.current = undefined
          setPanning(false)
          try {
            if (event?.currentTarget !== null && event?.currentTarget !== undefined && typeof event.currentTarget.releasePointerCapture === 'function') {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          } catch {
            /* nothing to release */
          }
          if (!pan.moved && allowClick === true) {
            if (pan.nodeId !== undefined) {
              /* A click (no travel) on the hub toggles its detail; only a real
                 drag is a pan. */
              setDetailId((current) => (current === pan.nodeId ? undefined : pan.nodeId))
            } else {
              /* A blank-canvas click only dismisses the detail. The multi-select
                 survives it — only Esc (or 取消选择) clears the selection. */
              setDetailId(undefined)
            }
          }
        }
        const onCanvasPointerUp = (event) => endCanvasPan(event, true)
        const onCanvasPointerCancel = (event) => endCanvasPan(event, false)

        const zoomBy = (factor) => {
          try {
            const canvas = canvasRef.current
            if (canvas === null || canvas === undefined) return
            const rect = canvas.getBoundingClientRect()
            userAdjustedRef.current = true
            zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
          } catch (error) {
            console.warn(LOG, 'zoom button failed', error)
          }
        }

        /* ------------------------------------------------------------- keyboard */
        const onRootKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          if (detailId === undefined && checked.length === 0) return
          /* Esc stays the "clear everything" key: close the detail AND drop
             the multi-select in one press. */
          event.preventDefault()
          setDetailId(undefined)
          clearChecked()
        }

        const onSearchKeyDown = (event) => {
          if (event.key === 'Escape' && search !== '') {
            event.preventDefault()
            event.stopPropagation()
            setSearch('')
          }
        }

        const onSearchChange = (event) => {
          try {
            setSearch(typeof event?.target?.value === 'string' ? event.target.value : '')
          } catch {
            setSearch('')
          }
        }

        const resetFilters = () => {
          setSearch('')
          setStatusFilter('all')
          setTimeFilter('all')
          setEdgeFilter('all')
        }

        const toggleGroup = (key, collapsed) => {
          setCollapsedMap((current) => ({ ...current, [`${groupBy}:${key}`]: !collapsed }))
        }

        /* 说明里必须同时交代两套状态：本面板推导的 status 与宿主报告的
           runStatus（timeout / denied / partial …）。自动隐藏只认后者中的终态，
           但 running/waiting 永远优先（见 hiddenPlan）。 */
        const statusNote = (node) => {
          const run = typeof node.runStatus === 'string' ? node.runStatus : undefined
          const runNote = run === undefined ? '' : `；宿主 runStatus = ${RUN_STATUS_LABEL[run] ?? run}（${run}）`
          if (node.status === 'running') return `会话摘要报告 running = true${runNote}；运行中的节点永不自动隐藏。`
          if (node.status === 'waiting') return `非运行中，但最近 2 分钟内有活动${runNote}；等待中的节点同样不自动隐藏。`
          if (node.status === 'failed') {
            return node.failure === undefined
              ? `摘要包含失败标记${runNote}。`
              : `摘要包含失败标记（见下方失败原因）${runNote}。`
          }
          if (node.status === 'idle') return `running = false，且 2 分钟内无活动${runNote}。`
          return `摘要缺少 running / updatedAt，无法判定状态${runNote}。`
        }

        /* --------------------------------------------------------------- effects */
        useEffect(() => {
          const timer = setInterval(() => {
            if (!mountedRef.current) return
            setClock(Date.now())
          }, CLOCK_MS)
          return () => clearInterval(timer)
        }, [])

        useEffect(() => {
          if (byId !== undefined) return undefined
          const timer = setTimeout(() => setWaited(true), LOAD_TIMEOUT_MS)
          return () => clearTimeout(timer)
        }, [byId, retryTick])

        /* Esc 只在本面板内生效：不再挂 window 监听。窗口级监听会在用户于主栏
           聊天框里按 Esc（或任何别处）时清掉这里的详情与多选，属于跨面板抢键；
           根节点的 onKeyDown（onRootKeyDown）已经覆盖面板内的焦点冒泡。 */

        useEffect(() => () => {
          if (toastTimerRef.current !== undefined) clearTimeout(toastTimerRef.current)
        }, [])

        /* Keep React's model, the DOM positions and the selection list in step. */
        useIso(() => {
          const sceneModel = Object.assign({}, model, {
            world: mapWorld,
            mapNodes,
            edges: mapEdges,
            neighbors: mapNeighbors,
            hiddenFromMap,
          })
          modelRef.current = sceneModel
          detailIdRef.current = detailId
          ensurePositions(sceneModel)
          /* When the visible set or its layout changes, run the relaxation ONCE
             instead of leaving a force simulation running: RELAX_ROUNDS fixed
             steps settle the new layout, then the result is baked in as the
             rest state and the loop is left asleep. Nothing changes → nothing
             moves, which is what removes the jitter. */
          /* 布局签名：可见集合或它的 home 变了就重跑一次性松弛。开关状态本身也
             进签名，所以「显示已隐藏」一按就必然重布局（隐藏集合变化通常已经改了
             mapNodes，这里再兜一层，保证状态变化一定触发布局）。 */
          const signature =
            mapNodes.map((node) => `${node.id}@${Math.round(node.home.x)},${Math.round(node.home.y)}`).join('|') +
            `#hidden:${showHidden ? 1 : 0}`
          if (signature !== layoutSignatureRef.current) {
            layoutSignatureRef.current = signature
            restOffsetsRef.current.clear()
            dragOffsetsRef.current.clear()
            for (let round = 0; round < RELAX_ROUNDS; round += 1) stepPhysics(FIXED_STEP, true)
            /* The one-shot relaxation may have pushed a crowded child away from
               its parent; re-anchor outliers to the parent orbit so the frozen
               layout still reads as families. Runs once, never per frame. */
            const relaxNodes = sceneModel.mapNodes.slice().sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0))
            const relaxById = new Map()
            for (const node of relaxNodes) relaxById.set(node.id, node)
            const relaxPositions = positionsRef.current
            for (const node of relaxNodes) {
              if (node.isRoot === true) continue
              const position = relaxPositions.get(node.id)
              const parentNode = node.parentId === undefined ? undefined : relaxById.get(node.parentId)
              const parentPosition = parentNode === undefined ? undefined : relaxPositions.get(parentNode.id)
              if (position === undefined || parentPosition === undefined) continue
              const dx = position.x - parentPosition.x
              const dy = position.y - parentPosition.y
              const distance = Math.hypot(dx, dy)
              if (distance <= ORBIT_LIMIT || distance < 0.001) continue
              const ratio = ORBIT_LIMIT / distance
              position.x = parentPosition.x + dx * ratio
              position.y = parentPosition.y + dy * ratio
            }
            bakeRestOffsets()
            for (const position of positionsRef.current.values()) {
              position.vx = 0
              position.vy = 0
            }
            /* Data/layout change is an allowed wake event; the loop confirms the
               scene is settled and goes straight back to sleep. */
            wake()
          }
          syncScene()
          visibleOrderRef.current = ordered.map((node) => node.id)
          const alive = new Set(model.nodes.map((node) => node.id))
          if (model.rootNode.id !== '') alive.add(model.rootNode.id)
          if (checked.length > 0 && checked.some((id) => !alive.has(id))) {
            setChecked((current) => current.filter((id) => alive.has(id)))
          }
          if (detailId !== undefined && !alive.has(detailId)) {
            setDetailId(undefined)
          }
        })

        useEffect(() => {
          if (viewMode !== 'map' || !hasChildren || userAdjustedRef.current) return undefined
          const timer = setTimeout(() => fitView(), 40)
          return () => clearTimeout(timer)
        }, [viewMode, hasChildren, shownNodes.length, layout.worldW, layout.worldH, fitView])

        useEffect(() => {
          const canvas = canvasRef.current
          if (canvas === null || canvas === undefined || typeof ResizeObserver !== 'function') return undefined
          const observer = new ResizeObserver(() => {
            if (userAdjustedRef.current) return
            fitView()
          })
          try {
            observer.observe(canvas)
          } catch {
            return () => observer.disconnect()
          }
          return () => observer.disconnect()
        }, [fitView])

        useEffect(() => {
          const canvas = canvasRef.current
          if (canvas === null || canvas === undefined) return undefined
          const handleWheel = (event) => {
            try {
              if (event.deltaY === 0) return
              /* The map owns the wheel inside its own box only: the page keeps
                 its scroll everywhere else. */
              event.preventDefault()
              event.stopPropagation()
              const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016))
              userAdjustedRef.current = true
              zoomAtRef.current(factor, event.clientX, event.clientY)
            } catch (error) {
              console.warn(LOG, 'wheel zoom failed', error)
            }
          }
          canvas.addEventListener('wheel', handleWheel, { passive: false })
          return () => {
            try {
              canvas.removeEventListener('wheel', handleWheel)
            } catch {
              /* canvas already detached */
            }
          }
        }, [])

        useEffect(() => {
          mountedRef.current = true
          let frame = 0
          let calm = 0

          /** Total kinetic energy Σv² of the scene. */
          const kineticEnergy = () => {
            let energy = 0
            for (const position of positionsRef.current.values()) {
              energy += position.vx * position.vx + position.vy * position.vy
            }
            return energy
          }

          const tick = () => {
            frame = 0
            if (!mountedRef.current) return
            try {
              stepPhysics(FIXED_STEP)
              syncScene()
              /* Convergence → sleep (requirement 2): below the kinetic-energy
                 threshold for SLEEP_FRAMES consecutive frames the rAF loop is
                 stopped outright, so a resting map does not jitter or burn CPU. */
              if (kineticEnergy() < SLEEP_ENERGY) {
                calm += 1
                if (calm >= SLEEP_FRAMES) {
                  activeRef.current = false
                  return
                }
              } else {
                calm = 0
              }
              frame = requestAnimationFrame(tick)
            } catch (error) {
              console.warn(LOG, 'animation frame failed', error)
              activeRef.current = false
            }
          }

          const start = () => {
            if (!mountedRef.current || activeRef.current) return
            activeRef.current = true
            calm = 0
            if (frame === 0) frame = requestAnimationFrame(tick)
          }

          wakeRef.current = start
          start()

          return () => {
            mountedRef.current = false
            wakeRef.current = () => {}
            activeRef.current = false
            if (frame !== 0) cancelAnimationFrame(frame)
          }
        }, [stepPhysics, syncScene])

        /* ---------------------------------------------------------------- render */
        const rootNode = model.rootNode
        const arrowId = arrowIdRef.current

        const statusPill = (status) =>
          h(
            'span',
            { className: 'fs-pill', 'data-fs-status': status },
            h('span', { className: 'fs-dot' }),
            STATUS_LABEL[status] ?? status,
          )

        const kv = (key, value) =>
          h('div', { className: 'fs-kv', key }, h('span', { className: 'fs-kv-key' }, key), h('span', { className: 'fs-kv-val' }, value))

        const renderChip = (key, label, count, dotStatus) =>
          h(
            'button',
            {
              key: `chip-${key}`,
              type: 'button',
              className: 'fs-chip',
              'data-active': statusFilter === key ? 'true' : 'false',
              'aria-pressed': statusFilter === key ? 'true' : 'false',
              onClick: () => setStatusFilter(key),
            },
            dotStatus === undefined ? null : h('span', { className: 'fs-chip-dot', 'data-fs-status': dotStatus }),
            h('span', null, label),
            count === undefined ? null : h('span', { className: 'fs-chip-count' }, count),
          )

        const renderSeg = (mode, label, Icon) =>
          h(
            'button',
            {
              key: `seg-${mode}`,
              type: 'button',
              className: 'fs-seg-btn',
              'data-active': viewMode === mode ? 'true' : 'false',
              'aria-pressed': viewMode === mode ? 'true' : 'false',
              onClick: () => setViewMode(mode),
            },
            h(Icon, { size: 12 }),
            h('span', null, label),
          )

        const renderStat = (label, value, status, title) =>
          h(
            'div',
            { key: `stat-${label}`, className: 'fs-stat', 'data-fs-status': status ?? 'unknown', title },
            h('div', { className: 'fs-stat-label' }, label),
            h('div', { className: 'fs-stat-value' }, value),
          )

        const renderSelect = (value, options, onChange, label) =>
          h(
            'select',
            {
              className: 'fs-select',
              value,
              'aria-label': label,
              onChange: (event) => {
                try {
                  onChange(event.target.value)
                } catch (error) {
                  console.warn(LOG, 'filter change failed', error)
                }
              },
            },
            options.map(([key, text]) => h('option', { key, value: key }, text)),
          )

        /**
         * The detail content, shared by the map popover and the inline list
         * expansion: a four-line summary first (status / level / tokens /
         * last activity), then the full field set, actions and raw sections.
         */
        const renderDetailSections = (node) => {
          const incoming = model.incomingByNode.get(node.id) ?? []
          const preview = incoming.slice(-4).reverse()
          const canSide = sideProbe.ok && !node.isRoot
          const canMain = openProbe.ok
          let primary = null
          if (canSide) {
            primary = h(
              'button',
              { className: 'fs-btn', type: 'button', 'data-tone': 'primary', onClick: () => openNode(node, 'side') },
              h(OpenIcon, { size: 12 }),
              '在当前侧栏新建标签页',
            )
          } else if (canMain && !node.isRoot) {
            primary = h(
              'button',
              { className: 'fs-btn', type: 'button', 'data-tone': 'primary', onClick: () => openNode(node, 'main') },
              h(OpenIcon, { size: 12 }),
              '在主栏打开',
            )
          } else if (!canMain && !canSide) {
            primary = h('button', { className: 'fs-btn', type: 'button', disabled: true }, '无法打开')
          }
          const rows = [
            h(
              'section',
              { key: 'summary', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, '概要'),
              kv('状态', statusPill(node.status)),
              hiddenKindOf(node.id) === undefined
                ? null
                : kv('可见性', '已隐藏（自动）'),
              node.depth > 0 ? kv('层级', `第 ${node.depth} 层`) : kv('层级', '根（当前会话）'),
              kv('token 合计', node.tokens === undefined ? '—' : `${fmtTokens(node.tokens.total)} tokens`),
              kv('最近活动', fmtAgo(node.updatedAt, clock)),
            ),
            h(
              'section',
              { key: 'full', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, '完整字段'),
              kv('说明', statusNote(node)),
              kv(
                '宿主终态',
                node.runStatus === undefined
                  ? '—（宿主未提供 runStatus）'
                  : `${RUN_STATUS_LABEL[node.runStatus] ?? node.runStatus}（runStatus = ${node.runStatus}）`,
              ),
              node.depth > 0
                ? kv('层级', `第 ${node.depth} 层${node.parentTitle === undefined ? '' : ` · 父：${node.parentTitle}`}`)
                : kv('层级', '根（当前会话）'),
              kv('最近活动', `${fmtAgo(node.updatedAt, clock)}${node.updatedAt === undefined ? '' : ` · ${fmtClock(node.updatedAt)}`}`),
              kv('来源', node.origin === undefined ? '—' : node.origin === 'subagent' ? '子代理（subagent）' : node.origin),
              kv('下级', node.childCount === 0 ? '无' : `${node.childCount} 个直接子代理`),
              kv('会话 ID', h('span', { className: 'fs-mono' }, node.id === '' ? '—' : node.id)),
              kv('父会话', node.parentId === undefined ? '—（根会话）' : (node.parentTitle ?? node.parentId)),
            ),
            h(
              'section',
              { key: 'actions', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, '操作'),
              h(
                'div',
                { className: 'fs-actions' },
                primary,
                canSide && canMain && !node.isRoot
                  ? h('button', { className: 'fs-btn', type: 'button', onClick: () => openNode(node, 'main') }, '主栏打开')
                  : null,
                h('button', { className: 'fs-btn', type: 'button', onClick: () => copyText(node.id, '会话 ID') }, h(CopyIcon, { size: 12 }), '复制 ID'),
                h('button', { className: 'fs-btn', type: 'button', onClick: () => copyDetail(node) }, h(CopyIcon, { size: 12 }), '复制详情'),
              ),
              node.isRoot
                ? h('p', { className: 'fs-note' }, '这是当前主会话本身，图中的其他节点都是它这一棵树里的后代。')
                : canSide
                  ? h('p', { className: 'fs-note' }, '「在当前侧栏新建标签页」会在现有右侧栏里新开一个标签页（不新建第二个侧栏），也不会打断主栏当前对话。')
                  : canMain
                    ? h('p', { className: 'fs-note', 'data-tone': 'warn' }, `宿主未注册 subagentchat 侧栏页（${sideProbe.reason}）：「在主栏打开」会切走主栏当前对话。`)
                    : h('p', { className: 'fs-note', 'data-tone': 'warn' }, `跳转不可用：${openProbe.reason}。可复制会话 ID 后手动切换；本面板不会假装成功。`),
            ),
            h(
              'section',
              { key: 'tokens', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, 'Token 用量'),
              node.tokens === undefined
                ? h('p', { className: 'fs-note' }, '该会话没有 tokenUsage 投影数据。')
                : h(
                    React.Fragment,
                    null,
                    kv('输入', fmtTokens(node.tokens.uncachedInput)),
                    kv('输出', fmtTokens(node.tokens.outputTokens)),
                    kv('缓存读', fmtTokens(node.tokens.cacheReadTokens)),
                    kv('缓存写', fmtTokens(node.tokens.cacheWriteTokens)),
                    h(
                      'div',
                      { className: 'fs-kv fs-kv-total' },
                      h('span', { className: 'fs-kv-key' }, '合计'),
                      h('span', { className: 'fs-kv-val' }, `${fmtTokens(node.tokens.total)} tokens`),
                    ),
                  ),
            ),
            h(
              'section',
              { key: 'context', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, '上下文占用'),
              node.pressure === undefined
                ? h(
                    React.Fragment,
                    null,
                    kv('本次请求 prompt', '—'),
                    kv('占比', '—'),
                    h('p', { className: 'fs-note' }, '该会话没有 context.pressureTokens 数据（宿主未折叠或尚无请求）。'),
                  )
                : h(
                    React.Fragment,
                    null,
                    kv('本次请求 prompt', `${fmtExact(node.pressure.pressureTokens)} tokens（${fmtTokens(node.pressure.pressureTokens)}）`),
                    (() => {
                      const contextWindow = node.pressure.contextWindow
                      /* 0 / 负数 / NaN 都不能当分母，否则这里会渲染出 Infinity%。 */
                      if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
                        return kv('占比', '—（宿主未提供有效的 contextWindow）')
                      }
                      return kv(
                        '占比',
                        `${((node.pressure.pressureTokens / contextWindow) * 100).toFixed(1)}%（${fmtExact(node.pressure.pressureTokens)} / ${fmtExact(contextWindow)}）`,
                      )
                    })(),
                  ),
            ),
            h(
              'section',
              { key: 'messages', className: 'fs-section' },
              h('div', { className: 'fs-section-title' }, '消息往来'),
              kv('收到', node.messageIn === 0 ? '无' : `${node.messageIn} 条`),
              kv('发出', node.messageOut === 0 ? '无' : `${node.messageOut} 条`),
              node.lastMessageAt === undefined ? null : kv('最近一条', `${fmtAgo(node.lastMessageAt, clock)} · ${fmtClock(node.lastMessageAt)}`),
              preview.length === 0
                ? h('p', { className: 'fs-note' }, '没有记录到 agent 间消息。')
                : preview.map((item, index) =>
                    kv(
                      `来源 ${index + 1}`,
                      `${model.titleById.get(item.from) ?? item.from}${item.at === undefined ? '' : ` · ${fmtAgo(item.at, clock)}`}`,
                    ),
                  ),
            ),
            node.failure === undefined
              ? null
              : h(
                  'section',
                  { key: 'failure', className: 'fs-section' },
                  h('div', { className: 'fs-section-title' }, '失败原因'),
                  h('p', { className: 'fs-note', 'data-tone': 'warn' }, node.failure),
                ),
            node.isRoot
              ? null
              : h(
                  'section',
                  { key: 'batch', className: 'fs-section' },
                  h('div', { className: 'fs-section-title' }, '批量'),
                  h(
                    'div',
                    { className: 'fs-actions' },
                    h(
                      'button',
                      { className: 'fs-btn', type: 'button', onClick: () => toggleChecked(node.id, false) },
                      checked.includes(node.id) ? '取消选择' : '加入批量选择',
                    ),
                  ),
                ),
          ]
          return rows.filter((row) => row !== null && row !== undefined)
        }

        /**
         * Where a node sits right now, in coordinates local to the body box:
         * the canvas rect supplies the screen offset, and the live view
         * transform maps the node's logical position into that space.
         */
        const nodeAnchor = (node) => {
          let left = 0
          let top = 0
          let width = 320
          let height = 380
          let hw = NODE_W / 2
          let hh = NODE_H / 2
          try {
            const position =
              (node === undefined || node === null ? undefined : positionsRef.current.get(node.id)) ??
              (node === undefined || node === null ? undefined : node.home) ?? { x: 0, y: 0 }
            const nodeScale = typeof node?.scale === 'number' && node.scale > 0 ? node.scale : 1
            const canvas = canvasRef.current
            const body = bodyRef.current
            const canvasRect =
              canvas !== null && canvas !== undefined && typeof canvas.getBoundingClientRect === 'function'
                ? canvas.getBoundingClientRect()
                : undefined
            const bodyRect =
              body !== null && body !== undefined && typeof body.getBoundingClientRect === 'function'
                ? body.getBoundingClientRect()
                : canvasRect
            if (bodyRect !== undefined) {
              width = bodyRect.width || width
              height = bodyRect.height || height
            }
            const originX = canvasRect === undefined || bodyRect === undefined ? 0 : canvasRect.left - bodyRect.left
            const originY = canvasRect === undefined || bodyRect === undefined ? 0 : canvasRect.top - bodyRect.top
            /* The live view lives in a ref (pan/zoom never re-render), so read
               the current transform here instead of a state snapshot. */
            const currentView = viewRef.current
            left = originX + currentView.x + position.x * currentView.scale
            top = originY + currentView.y + position.y * currentView.scale
            hw = (NODE_W * nodeScale * currentView.scale) / 2
            hh = (NODE_H * nodeScale * currentView.scale) / 2
          } catch (error) {
            console.warn(LOG, 'popover anchor failed', error)
          }
          return { left, top, width, height, hw, hh }
        }

        /**
         * Screen-space frame of the popover for one node: beside the card,
         * flipped left past the right edge, above past the bottom edge, then
         * clamped inside the canvas.
         */
        const popoverFrame = (node) => {
          const anchor = nodeAnchor(node)
          const EDGE = 8
          const GAP = 10
          const width = Math.min(260, Math.max(140, anchor.width - 16))
          const maxH = Math.max(120, Math.round(anchor.height * 0.6))
          let left = anchor.left + anchor.hw + GAP
          if (left + width > anchor.width - EDGE) left = anchor.left - anchor.hw - GAP - width
          left = clamp(left, EDGE, Math.max(EDGE, anchor.width - EDGE - width))
          let top = anchor.top - anchor.hh
          if (top + maxH > anchor.height - EDGE) top = anchor.top - anchor.hh - maxH - GAP
          top = clamp(top, EDGE, Math.max(EDGE, anchor.height - EDGE - maxH))
          return { left: Math.round(left), top: Math.round(top) }
        }

        /**
         * Imperative re-anchor for the open popover after a zoom: the overlay is
         * positioned in screen space, and zooming does not re-render (by design),
         * so the node moves while the popover would otherwise stay behind.
         */
        const syncPopoverPosition = () => {
          try {
            const element = popoverRef.current
            const id = detailIdRef.current
            if (element === null || element === undefined || id === undefined) return
            const node = modelRef.current.mapNodes.find((item) => item.id === id)
            if (node === undefined) return
            const frame = popoverFrame(node)
            element.style.left = `${frame.left}px`
            element.style.top = `${frame.top}px`
          } catch (error) {
            console.warn(LOG, 'popover reposition failed', error)
          }
        }

        useIso(() => {
          popoverSyncRef.current = syncPopoverPosition
        }, [])

        /**
         * Map detail: a compact card next to its node instead of a drawer that
         * covered the whole right column.
         */
        const renderPopover = (node) => {
          try {
            const frame = popoverFrame(node)
            return h(
              'aside',
              {
                key: 'detail',
                className: 'fs-popover',
                role: 'dialog',
                'aria-label': '节点详情',
                'data-fs-overlay': '',
                ref: popoverRef,
                style: { left: `${frame.left}px`, top: `${frame.top}px` },
                /* Requirement 22: the popover swallows pointer events — pressing
                   on it must never start a node drag or a canvas pan. */
                onPointerDown: (event) => {
                  if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                },
                onPointerMove: (event) => {
                  if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                },
                onPointerUp: (event) => {
                  if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                },
              },
              h(
                'div',
                { className: 'fs-popover-head' },
                statusPill(node.status),
                h('div', { className: 'fs-popover-title' }, node.title),
                h(
                  'button',
                  { className: 'fs-iconbtn', type: 'button', title: '关闭详情（Esc）', 'aria-label': '关闭详情', onClick: () => setDetailId(undefined) },
                  h(CloseIcon, { size: 13 }),
                ),
              ),
              h('div', { className: 'fs-popover-body' }, renderDetailSections(node)),
            )
          } catch (error) {
            console.warn(LOG, 'popover render failed', error)
            return null
          }
        }

        const header = h(
          'header',
          { className: 'fs-head' },
          h(
            'div',
            { className: 'fs-row' },
            h(
              'div',
              { className: 'fs-search' },
              h(SearchIcon, { size: 12, className: 'fs-search-icon' }),
              h('input', {
                className: 'fs-input',
                type: 'search',
                value: search,
                placeholder: '搜索标题或会话 ID',
                'aria-label': '搜索子代理',
                spellCheck: false,
                onChange: onSearchChange,
                onKeyDown: onSearchKeyDown,
              }),
            ),
            h('div', { className: 'fs-seg', role: 'group', 'aria-label': '视图' }, renderSeg('map', '拓扑图', MapIcon), renderSeg('list', '列表', ListIcon)),
          ),
          h(
            'div',
            { className: 'fs-chips', role: 'group', 'aria-label': '按状态筛选' },
            renderChip('all', '全部', viewStats.total, undefined),
            STATUS_FILTERS.map((status) => renderChip(status, STATUS_LABEL[status], viewStats[status], status)),
          ),
          h(
            'div',
            { className: 'fs-row' },
            renderSelect(timeFilter, TIME_FILTERS, setTimeFilter, '按时间筛选'),
            renderSelect(edgeFilter, EDGE_FILTERS, setEdgeFilter, '按消息往来筛选'),
            viewMode === 'map'
              ? renderSelect(
                  expandDepth === 'all' ? 'all' : String(expandDepth),
                  [
                    ['all', '全部层级'],
                    ['2', '2 层以内'],
                    ['1', '仅直接子代理'],
                  ],
                  (value) => setExpandDepth(value === 'all' ? 'all' : Number(value)),
                  '按层级显示',
                )
              : renderSelect(groupBy, GROUP_OPTIONS, setGroupBy, '分组方式'),
            activeFilterCount > 0 ? h('button', { className: 'fs-btn', type: 'button', onClick: resetFilters }, '重置') : null,
          ),
          h(
            'div',
            { className: 'fs-row' },
            renderSelect(sortBy, SORT_OPTIONS, setSortBy, '排序方式'),
            h(
              'label',
              {
                className: 'fs-toggle',
                title: '先在列表或节点上勾选；为空时按排序+上限自动选',
                'data-disabled': checked.length === 0 ? 'true' : 'false',
              },
              h('input', {
                type: 'checkbox',
                className: 'fs-check',
                checked: onlyChecked,
                disabled: checked.length === 0 && !onlyChecked,
                'aria-label': '只画选中',
                onChange: (event) => {
                  try {
                    setOnlyChecked(event?.target?.checked === true)
                  } catch (error) {
                    console.warn(LOG, 'only-checked toggle failed', error)
                  }
                },
              }),
              h('span', null, '只画选中'),
            ),
            h(
              'button',
              {
                className: 'fs-btn fs-btn-hidden',
                type: 'button',
                'aria-pressed': showHidden ? 'true' : 'false',
                'data-active': showHidden ? 'true' : 'false',
                title: '显示已隐藏的节点：自动隐藏 = 终态且结束超过 2 小时、且不在最近完成 8 个里',
                onClick: () => {
                  try {
                    setShowHidden((current) => !current)
                  } catch (error) {
                    console.warn(LOG, 'show-hidden toggle failed', error)
                  }
                },
              },
              showHidden ? '全部显示中' : `显示已隐藏${hiddenPlan.total > 0 ? ` (${hiddenPlan.total})` : ''}`,
            ),
            h(
              'button',
              { className: 'fs-btn', type: 'button', title: '清除所有拖动位移并复位视图', onClick: resetLayout },
              '重置布局',
            ),
          ),
          h(
            'div',
            { className: 'fs-stats' },
            renderStat('总数', viewStats.total, undefined, '列表里的子代理节点数量，不含主会话本身'),
            renderStat('运行中', viewStats.running, 'running'),
            renderStat('失败', viewStats.failed, 'failed'),
            renderStat('总 token', fmtTokens(viewStats.tokens), undefined, '只统计子代理节点，不含主会话本身的 token'),
          ),
        )

        const renderMapNode = (node) => {
          const hot = hoveredId === node.id
          const dim = hoveredId !== undefined && !hot && !neighborSet.has(node.id)
          const isChecked = checked.includes(node.id)
          const nodeScale = typeof node.scale === 'number' && node.scale > 0 ? node.scale : 1
          /* 卡片空间很小，只标出「超时 / 被拒绝 / 部分完成」这类需要一眼看见的
             宿主终态；ok 与推导状态已由状态徽标覆盖。 */
          const runBadge = runStatusBadgeOf(node)
          return h(
            'div',
            {
              key: node.id,
              className: 'fs-node',
              role: 'button',
              tabIndex: 0,
              'data-fs-node': '',
              'data-fs-status': node.status,
              'data-deep': node.depth > 1 ? 'true' : 'false',
              'data-root': node.isRoot ? 'true' : 'false',
              'data-selected': detailId === node.id ? 'true' : 'false',
              'data-dim': dim ? 'true' : 'false',
              'data-checked': isChecked ? 'true' : 'false',
              /* 已隐藏节点只在「显示已隐藏」打开时出现，用 data-hidden 标出原因，
                 样式据此做降透明度 + 虚线圈。 */
              'data-hidden': hiddenKindOf(node.id) ?? undefined,
              /* Zoom × depth scale as a CSS variable: the card box and every
                 font size derive from it via calc(), so text is rendered at its
                 final size instead of being scaled as a rasterised texture. */
              style: { '--fs-k': (viewRef.current.scale * nodeScale).toFixed(4) },
              title: `${node.title} · ${STATUS_LABEL[node.status] ?? node.status}${node.depth > 0 ? ` · 第 ${node.depth} 层` : ''}`,
              'aria-label': `${node.title}，${STATUS_LABEL[node.status] ?? node.status}${node.depth > 0 ? `，第 ${node.depth} 层` : ''}`,
              ref: (element) => registerNodeElement(node.id, element),
              onPointerDown: (event) => startNodeDrag(event, node),
              onPointerMove: moveNodeDrag,
              onPointerUp: (event) => endNodeDrag(event, true),
              onPointerCancel: (event) => {
                endNodeDrag(event, false)
                endNodePan()
              },
              onLostPointerCapture: (event) => {
                endNodeDrag(event, false)
                endNodePan()
              },
              onMouseEnter: () => setHoveredId(node.id),
              onMouseLeave: () => setHoveredId((current) => (current === node.id ? undefined : current)),
              onFocus: () => setHoveredId(node.id),
              onBlur: () => setHoveredId((current) => (current === node.id ? undefined : current)),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                  event.preventDefault()
                  setDetailId(node.id)
                }
              },
            },
            h(
              'span',
              { className: 'fs-node-top' },
              h('span', { className: 'fs-dot' }),
              h('span', { className: 'fs-node-status' }, STATUS_LABEL[node.status] ?? node.status),
              runBadge === undefined
                ? null
                : h('span', { className: 'fs-node-run', title: `宿主 runStatus = ${node.runStatus}` }, runBadge),
              node.depth > 0 ? h('span', { className: 'fs-node-depth' }, `L${node.depth}`) : null,
              node.isRoot ? h('span', { className: 'fs-node-flag' }, '主') : null,
            ),
            h('span', { className: 'fs-node-title' }, h('span', { className: 'fs-node-title-text' }, node.title)),
            h(
              'span',
              { className: 'fs-node-bottom' },
              h('span', { className: 'fs-node-token' }, node.tokens === undefined ? '—' : fmtTokens(node.tokens.total)),
              h('span', { className: 'fs-node-ctx' }, node.pressure === undefined ? 'ctx —' : `ctx ${fmtTokens(node.pressure.pressureTokens)}`),
              h('span', { className: 'fs-node-time' }, fmtAgoShort(node.updatedAt, clock)),
            ),
            node.isRoot
              ? null
              : h('input', {
                  type: 'checkbox',
                  className: 'fs-check fs-node-check',
                  checked: isChecked,
                  tabIndex: -1,
                  'aria-label': `选择 ${node.title}`,
                  onChange: (event) => toggleChecked(node.id, event?.nativeEvent?.shiftKey === true),
                  onPointerDown: (event) => event.stopPropagation(),
                }),
          )
        }

        const rootHub = positionsRef.current.get(model.rootNode.id) ?? layout.rootHome
        const renderEdge = (edge) => {
          const fromNode = mapNodes.find((node) => node.id === edge.from)
          const toNode = mapNodes.find((node) => node.id === edge.to)
          const from = positionsRef.current.get(edge.from) ?? (fromNode === undefined ? undefined : fromNode.home)
          const to = positionsRef.current.get(edge.to) ?? (toNode === undefined ? undefined : toNode.home)
          const hot = hoveredId !== undefined && (edge.from === hoveredId || edge.to === hoveredId)
          /* Requirement 17: every edge carries an arrow at its `to` end — the
             delegated child for spawn edges — and the head recolours with the
             line while the edge is highlighted (or when it is a warning edge). */
          const markerId = markerFor(edge, hot, arrowId)
          /* Edge geometry is zoom-scaled here (the SVG is never CSS-scaled), so
             the vector curves stay crisp at every zoom factor. */
          const factor = viewRef.current.scale
          const fromHalf = fromNode === undefined ? undefined : nodeHalf(fromNode)
          const toHalf = toNode === undefined ? undefined : nodeHalf(toNode)
          const path =
            from !== undefined && to !== undefined && fromHalf !== undefined && toHalf !== undefined
              ? edgePath(
                  { x: from.x * factor, y: from.y * factor },
                  { x: to.x * factor, y: to.y * factor },
                  { hw: fromHalf.hw * factor, hh: fromHalf.hh * factor },
                  { hw: toHalf.hw * factor, hh: toHalf.hh * factor },
                  edge.bow * factor,
                  { x: rootHub.x * factor, y: rootHub.y * factor },
                  EDGE_PAD * factor,
                )
              : ''
          return h('path', {
            key: edge.key,
            ref: (element) => registerEdgeElement(edge.key, element),
            className: 'fs-edge',
            'data-kind': edge.kind,
            'data-hot': hot ? 'true' : 'false',
            'data-cross': edge.cross === true ? 'true' : 'false',
            'data-orphan': edge.orphan === true ? 'true' : 'false',
            d: path,
            markerEnd: `url(#${markerId})`,
            vectorEffect: 'non-scaling-stroke',
          })
        }

        const viewScale = viewRef.current.scale
        const edgeLayerW = Math.max(1, Math.round(mapWorld.w * viewScale))
        const edgeLayerH = Math.max(1, Math.round(mapWorld.h * viewScale))
        const canvas = h(
          'div',
          {
            className: 'fs-canvas',
            ref: canvasRef,
            style: { display: viewMode === 'map' ? 'block' : 'none' },
            'data-focus': hoveredId === undefined ? 'false' : 'true',
            'data-selecting': checked.length > 0 ? 'true' : 'false',
            'data-panning': panning ? 'true' : 'false',
            onPointerDown: onCanvasPointerDown,
            onPointerMove: onCanvasPointerMove,
            onPointerUp: onCanvasPointerUp,
            onPointerCancel: onCanvasPointerCancel,
            onLostPointerCapture: () => {
              panRef.current = undefined
              setPanning(false)
            },
          },
          h(
            'div',
            {
              className: 'fs-world',
              ref: worldRef,
              style: {
                width: `${mapWorld.w}px`,
                height: `${mapWorld.h}px`,
                transform: `translate3d(${Math.round(viewRef.current.x)}px, ${Math.round(viewRef.current.y)}px, 0)`,
              },
            },
            h(
              'svg',
              {
                className: 'fs-edges',
                ref: edgeSvgRef,
                width: edgeLayerW,
                height: edgeLayerH,
                viewBox: `0 0 ${edgeLayerW} ${edgeLayerH}`,
                'aria-hidden': 'true',
              },
              h(
                'defs',
                null,
                h(
                  'marker',
                  { id: arrowId, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' },
                  h('path', { d: 'M0 0 L8 4 L0 8 Z', fill: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }),
                ),
                h(
                  'marker',
                  { id: `${arrowId}-spawn`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' },
                  h('path', { d: 'M0 0 L8 4 L0 8 Z', fill: 'var(--dsw-alias-label-secondary, #545c6b)' }),
                ),
                h(
                  'marker',
                  { id: `${arrowId}-hot`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' },
                  h('path', { d: 'M0 0 L8 4 L0 8 Z', fill: 'var(--dsw-alias-label-primary, #0f1115)' }),
                ),
              ),
              mapEdges.map(renderEdge),
            ),
            mapNodes.map(renderMapNode),
          ),
          h(
            'div',
            { className: 'fs-legend', 'data-fs-overlay': '', 'aria-hidden': 'true' },
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-dot', 'data-fs-status': 'running' }), '运行中'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-dot', 'data-fs-status': 'waiting' }), '等待'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-dot', 'data-fs-status': 'idle' }), '空闲'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-dot', 'data-fs-status': 'failed' }), '失败'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-line' }), '委派（父 → 子）'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-dash' }), '消息（虚线，from → to）'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-cross' }), '跨层委派（跳过中间层）'),
            h('div', { className: 'fs-legend-row' }, h('span', { className: 'fs-legend-orphan' }), '父节点不在图内（连到主代理）'),
          ),
          h(
            'div',
            { className: 'fs-zoom', 'data-fs-overlay': '', role: 'group', 'aria-label': '视图缩放' },
            h('button', { className: 'fs-iconbtn', type: 'button', title: '放大', 'aria-label': '放大', onClick: () => zoomBy(1.18) }, h(PlusIcon, { size: 14 })),
            h('button', { className: 'fs-iconbtn', type: 'button', title: '缩小', 'aria-label': '缩小', onClick: () => zoomBy(1 / 1.18) }, h(MinusIcon, { size: 14 })),
            h(
              'button',
              {
                className: 'fs-iconbtn',
                type: 'button',
                title: '重置布局：清除拖动并复位视图',
                'aria-label': '重置布局',
                onClick: resetLayout,
              },
              h(FitIcon, { size: 13 }),
            ),
          ),
          h(
            'div',
            {
              className: 'fs-map-note',
              'data-fs-overlay': '',
            },
            `拓扑图按「${sortLabel}」取前 ${MAX_MAP_NODES} 个${onlyChecked ? (onlyCheckedActive ? '（仅已勾选）' : '（勾选为空，自动选取）') : ''}：当前 ${shownNodes.length} 个${shownNodes.length > MAX_MAP_NODES ? `（含父链补全，已超 ${MAX_MAP_NODES} 个上限）` : ''}，另有 ${hiddenFromMap} 个在「列表」${ancestorExtra > 0 ? `；为接上父链补入 ${ancestorExtra} 个祖先` : ''}；已隐藏 ${hiddenPlan.total} 个${hiddenPlan.total > 0 && !showHidden ? '，可打开工具条「显示已隐藏」查看' : ''}`,
          ),
        )

        const renderRow = (node, isRoot) => {
          const open = detailId === node.id
          const row = h(
            'div',
            {
              key: `row-${node.id}`,
              className: isRoot ? 'fs-row fs-row-root' : 'fs-row',
              style: node.depth > 1 ? { marginLeft: `${Math.min(node.depth - 1, 3) * 12}px` } : undefined,
              'data-fs-status': node.status,
              'data-selected': open ? 'true' : 'false',
              'data-hidden': hiddenKindOf(node.id) ?? undefined,
            },
            isRoot
              ? null
              : h('input', {
                  type: 'checkbox',
                  className: 'fs-check',
                  checked: checked.includes(node.id),
                  'aria-label': `选择 ${node.title}`,
                  onChange: (event) => toggleChecked(node.id, event?.nativeEvent?.shiftKey === true),
                }),
            h(
              'button',
              {
                type: 'button',
                className: 'fs-row-main',
                'aria-expanded': open ? 'true' : 'false',
                title: open ? '收起详情' : '展开详情',
                onClick: () => setDetailId((current) => (current === node.id ? undefined : node.id)),
              },
              h('span', { className: 'fs-row-title' }, node.title),
              h(
                'span',
                { className: 'fs-row-meta' },
                h('span', { className: 'fs-dot' }),
                h('span', null, STATUS_LABEL[node.status] ?? node.status),
                runStatusBadgeOf(node) === undefined
                  ? null
                  : h('span', { className: 'fs-row-run', title: `宿主 runStatus = ${node.runStatus}` }, runStatusBadgeOf(node)),
                node.depth > 0 ? h('span', { className: 'fs-row-depth' }, `L${node.depth}`) : null,
                h('span', null, '·'),
                h('span', null, node.tokens === undefined ? 'token —' : `${fmtTokens(node.tokens.total)} tok`),
                h('span', null, '·'),
                h('span', null, fmtAgo(node.updatedAt, clock)),
                node.messageTotal > 0 ? h('span', null, `· ${node.messageTotal} 条往来`) : null,
                isRoot ? h('span', { className: 'fs-row-root-tag' }, '主会话') : null,
              ),
            ),
          )
          /* List detail is inline, directly under its own row: it never covers
             the picture the way the old full-height drawer did. */
          return h(
            React.Fragment,
            { key: `rowwrap-${node.id}` },
            row,
            open
              ? h('div', { className: 'fs-row-detail', 'data-fs-row-detail': '' }, renderDetailSections(node))
              : null,
          )
        }

        const renderGroup = (group) => {
          const stored = collapsedMap[`${groupBy}:${group.key}`]
          const collapsed =
            typeof stored === 'boolean'
              ? stored
              : groupBy === 'status'
                ? group.key === 'idle' || group.key === 'failed' || group.key === 'unknown'
                : group.key === 'today' || group.key === 'older' || group.key === 'unknown'
          const ids = group.nodes.map((node) => node.id)
          const selectedInGroup = ids.filter((id) => checked.includes(id)).length
          const allSelected = ids.length > 0 && selectedInGroup === ids.length
          return h(
            'section',
            { key: `group-${group.key}`, className: 'fs-group' },
            h(
              'div',
              { className: 'fs-group-head' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'fs-group-toggle',
                  'data-open': collapsed ? 'false' : 'true',
                  'aria-expanded': collapsed ? 'false' : 'true',
                  onClick: () => toggleGroup(group.key, collapsed),
                },
                h(ChevronIcon, { size: 12, className: 'fs-chevron' }),
                h('span', null, group.label),
                h('span', { className: 'fs-group-count' }, group.nodes.length),
                h('span', { className: 'fs-group-tokens' }, `${fmtTokens(group.tokens)} tok`),
              ),
              h('input', {
                type: 'checkbox',
                className: 'fs-check',
                checked: allSelected,
                'aria-label': `选择「${group.label}」中的全部节点`,
                ref: (element) => setIndeterminate(element, selectedInGroup > 0 && !allSelected),
                onChange: () => setSelectionForNodes(group.nodes, !allSelected),
              }),
            ),
            collapsed ? null : group.nodes.map((node) => renderRow(node, false)),
          )
        }

        const list = h(
          'div',
          { className: 'fs-list', style: { display: viewMode === 'list' ? 'flex' : 'none' } },
          /* 列表 tab 顶部同样一行统计（与拓扑图说明同一口径）。 */
          h(
            'div',
            { className: 'fs-list-note' },
            `当前 ${filteredChildren.length} 个（已隐藏 ${hiddenPlan.total} 个）${hiddenPlan.total > 0 && !showHidden ? ' · 可打开工具条「显示已隐藏」查看' : ''}`,
          ),
          renderRow(model.rootNode, true),
          groups.map(renderGroup),
          groups.length === 0 && hasChildren
            ? h('p', { className: 'fs-note', style: { padding: '6px 2px', margin: 0 } }, '没有符合当前筛选条件的后代节点。')
            : null,
        )

        const renderStateOverlay = () => {
          if (storeState === 'loading') {
            return h(
              'div',
              { className: 'fs-state', 'aria-busy': 'true' },
              h('div', { className: 'fs-state-title' }, '正在读取会话树…'),
              h(
                'div',
                { className: 'fs-skeletons' },
                h('div', { className: 'fs-skel' }),
                h('div', { className: 'fs-skel' }),
                h('div', { className: 'fs-skel' }),
              ),
              h('div', { className: 'fs-state-desc' }, '子代理节点与消息边会在数据到达后自动出现。'),
            )
          }
          if (storeState === 'unavailable') {
            return h(
              'div',
              { className: 'fs-state' },
              h('span', { className: 'fs-state-icon' }, h(FishIcon, { size: 42 })),
              h('div', { className: 'fs-state-title' }, '无法读取会话数据'),
              h('div', { className: 'fs-state-desc' }, '宿主未向本面板注入 useSessions 钩子，拓扑图没有数据来源。请确认 DSH 版本与该插件的契约一致。'),
            )
          }
          if (storeState === 'empty-store') {
            return h(
              'div',
              { className: 'fs-state' },
              h('span', { className: 'fs-state-icon' }, h(FishIcon, { size: 42 })),
              h('div', { className: 'fs-state-title' }, '暂无可读会话数据'),
              h('div', { className: 'fs-state-desc' }, '会话存储没有返回任何摘要；派发一次子代理或稍后重试。'),
              h(
                'button',
                {
                  className: 'fs-btn',
                  type: 'button',
                  onClick: () => {
                    setWaited(false)
                    setRetryTick((value) => value + 1)
                  },
                },
                '重试',
              ),
            )
          }
          if (!hasChildren) {
            return h(
              'div',
              { className: 'fs-state' },
              h('span', { className: 'fs-state-icon' }, h(FishIcon, { size: 46 })),
              h('div', { className: 'fs-state-title' }, '还没有子代理'),
              h('div', { className: 'fs-state-desc' }, '在当前会话里派发一个子代理后，它会作为节点出现在拓扑图上；派给它的子代理继续挂在它下面。'),
              h('div', { className: 'fs-state-desc' }, '提示：模型菜单里的「启用子代理工具裁剪」可开启裁剪与派发引导。'),
            )
          }
          /* 状态筛选不参与 matchedChildren/visibleBase 的拆分：筛选命中的节点
             全被隐藏时才提示「都在已隐藏里」；只是被状态筛选排空时走下面的通用
             提示，否则会把「筛选没结果」误报成「都被隐藏了」。 */
          if (filteredCount === 0 && matchedChildren.length > 0 && visibleBase.length === 0) {
            return h(
              'div',
              { className: 'fs-state' },
              h('span', { className: 'fs-state-icon' }, h(FishIcon, { size: 42 })),
              h('div', { className: 'fs-state-title' }, '筛选结果都在已隐藏里'),
              h(
                'div',
                { className: 'fs-state-desc' },
                `有 ${hiddenPlan.total} 个节点被自动隐藏。打开「显示已隐藏」即可查看。`,
              ),
              h('button', { className: 'fs-btn', type: 'button', onClick: () => setShowHidden(true) }, '显示已隐藏'),
            )
          }
          if (filteredCount === 0) {
            return h(
              'div',
              { className: 'fs-state' },
              h('span', { className: 'fs-state-icon' }, h(SearchIcon, { size: 34 })),
              h('div', { className: 'fs-state-title' }, '没有符合条件的节点'),
              h('div', { className: 'fs-state-desc' }, '当前的状态 / 时间 / 消息往来筛选把全部后代节点都排除了。'),
              h('button', { className: 'fs-btn', type: 'button', onClick: resetFilters }, '清除筛选'),
            )
          }
          return null
        }

        const batchBar =
          checked.length === 0
            ? null
            : h(
                'div',
                { className: 'fs-batch', role: 'toolbar', 'aria-label': '批量操作', 'data-fs-overlay': '' },
                h('span', { className: 'fs-batch-count' }, `已选 ${checked.length}`),
                h('button', { className: 'fs-btn', type: 'button', onClick: copyCheckedIds }, '复制 ID'),
                h(
                  'button',
                  {
                    className: 'fs-btn',
                    type: 'button',
                    onClick: openCheckedIds,
                    disabled: !sideProbe.ok && !openProbe.ok ? true : undefined,
                    title: sideProbe.ok ? '逐个在当前右侧栏新建标签页打开' : openProbe.ok ? '逐个在主栏打开' : openProbe.reason,
                  },
                  sideProbe.ok ? '侧栏新标签页' : '打开',
                ),
                h(
                  'button',
                  {
                    className: 'fs-btn',
                    type: 'button',
                    /* 选中数量与一次能打开的数量对齐：否则「全选筛选结果」会选中
                       几百个，而打开只走前 MAX_BATCH_OPEN 个，选择与结果不一致。 */
                    title: `最多选中前 ${MAX_BATCH_OPEN} 个（与批量打开上限一致）`,
                    onClick: () => setChecked(filteredChildren.slice(0, MAX_BATCH_OPEN).map((node) => node.id)),
                  },
                  '全选筛选结果',
                ),
                h(
                  'button',
                  {
                    className: 'fs-btn',
                    type: 'button',
                    title: '只清空当前多选，不影响筛选与折叠',
                    onClick: clearChecked,
                  },
                  '取消选择',
                ),
              )

        const toastNode =
          toast === undefined
            ? null
            : h(
                'div',
                { className: 'fs-toast', 'data-tone': toast.tone, role: 'status', 'aria-live': 'polite', 'data-fs-overlay': '' },
                toast.text,
              )

        return h(
          'div',
          { 'data-fs-root': '', ref: rootRef, role: 'region', 'aria-label': '子代理拓扑图', onKeyDown: onRootKeyDown },
          header,
          h(
            'div',
            { className: 'fs-body', ref: bodyRef },
            canvas,
            list,
            hasDetail && viewMode === 'map' ? renderPopover(detailNode) : null,
            batchBar,
            toastNode,
            renderStateOverlay(),
          ),
        )

      }

      const MatrilineGuarded = function MatrilineGuarded(props) {
        return h(MatrilineBoundary, null, h(MatrilineBody, props))
      }

      return MatrilineGuarded
    }

    function MatrilineTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
        h(FishIcon, { size: 13 }),
        h('span', null, '子代理拓扑'),
      )
    }

    /**
     * One pending "turn trimming off" request, shared between the model-menu row
     * and the shell overlay. The overlay survives the menu closing, exactly like
     * the official Team toggle's confirmation.
     */
    let disableRequest = null
    const disableListeners = new Set()
    function publishDisable(next) {
      disableRequest = next
      for (const listener of [...disableListeners]) {
        try {
          listener(next)
        } catch (error) {
          console.warn(LOG, 'disable listener failed', error)
        }
      }
    }
    function useDisableRequest() {
      const [value, setValue] = useState(disableRequest)
      useEffect(() => {
        const listener = (next) => { setValue(next) }
        disableListeners.add(listener)
        setValue(disableRequest)
        return () => { disableListeners.delete(listener) }
      }, [])
      return value
    }

    function MatrilineDisableDialog({ sessionId, cancelDisable, disableTrim }) {
      const [state, setState] = useState({ kind: 'ready' })
      const saving = state.kind === 'saving'
      const cancel = () => { if (!saving) cancelDisable(sessionId) }
      const confirm = () => {
        if (saving) return
        setState({ kind: 'saving' })
        Promise.resolve(disableTrim(sessionId))
          .then(() => { cancelDisable(sessionId) })
          .catch((error) => {
            setState({ kind: 'failed', message: String(error?.message ?? error) })
          })
      }
      return h(
        Modal,
        {
          open: true,
          tone: 'warning',
          title: '关闭子代理工具裁剪？',
          closeLabel: '关闭',
          onClose: cancel,
          className: 'fs-confirm-dialog',
          contentClassName: 'fs-confirm-content',
          footer: h(
            React.Fragment,
            null,
            h(Button, {
              variant: 'outline',
              disabled: saving,
              'data-modal-autofocus': true,
              onClick: cancel,
            }, '取消'),
            h(Button, {
              variant: 'primary',
              disabled: saving,
              onClick: confirm,
            }, saving ? '正在关闭…' : '确认关闭'),
          ),
        },
        h(
          'div',
          { className: 'fs-confirm-copy' },
          h('p', null, '子代理将恢复完整工具面；本会话的工具表会变化，提示词缓存失效一次。'),
          h('p', null, '正在运行的子代理不受影响。'),
        ),
        state.kind === 'failed'
          ? h('p', { role: 'alert', className: 'fs-confirm-error' }, state.message)
          : null,
      )
    }

    function MatrilineDisableConfirmation(props) {
      const request = props.useDisableRequest()
      if (request === null || Modal === undefined || Button === undefined) return null
      return h(MatrilineDisableDialog, {
        key: request.sessionId,
        sessionId: request.sessionId,
        cancelDisable: props.cancelDisable,
        disableTrim: props.disableTrim,
      })
    }

    /**
     * The model-menu switch under the official Team switch: it shows and changes
     * this plugin's trimming, NOT Team mode. The host exposes the explicit choice
     * as `matrilineGate`; absent means the plugin default (on).
     */
    function MatrilineGateRow(props) {
      const { useProjection, useSession, useSessions, sessionId, setTrim, requestDisable } = props
      const gate = useProjection('matrilineGate')
      const addressedChild = useSession(snapshot => snapshot.subagent !== null)
      const listedChild = useSessions(state => state.byId[sessionId]?.origin === 'subagent')
      const [pending, setPending] = useState(false)
      const [error, setError] = useState('')
      if (addressedChild || listedChild) return null
      const enabled = gate?.enabled !== false
      const apply = (target) => {
        setPending(true)
        setError('')
        Promise.resolve(setTrim(target))
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setPending(false) })
      }
      const toggle = (next) => {
        if (pending) return
        const target = typeof next === 'boolean' ? next : !enabled
        if (target === false) {
          if (typeof requestDisable === 'function') requestDisable()
          return
        }
        apply(true)
      }
      const control = Switch === undefined
        ? h(
            'button',
            {
              className: 'fs-gate-toggle fs-gate-switch',
              type: 'button',
              role: 'switch',
              'aria-checked': enabled ? 'true' : 'false',
              'aria-label': '启用子代理工具裁剪',
              disabled: pending ? true : undefined,
              title: '切换后立即生效；工具表会变化，本会话提示词缓存失效一次',
              onClick: toggle,
            },
            h('span', { className: 'fs-gate-knob' }),
          )
        : h(Switch, {
            className: 'fs-gate-toggle',
            checked: enabled,
            disabled: pending,
            label: '启用子代理工具裁剪',
            onChange: toggle,
          })
      return h(
        'div',
        { className: 'fs-gate-row', 'data-fs-gate': '' },
        h(
          'span',
          {
            className: 'fs-gate-label',
            title: '按 kind 裁剪子代理的工具集、系统提示词与沙箱；切换会改变工具表，本会话的提示词缓存会失效一次',
          },
          '启用子代理工具裁剪',
        ),
        control,
        error === '' ? null : h('span', { className: 'fs-gate-error', role: 'alert' }, error),
      )
    }

    return {
      name: 'matriline-client',
      inject: ['slots'],

      apply(ctx) {
        const disposers = []

        const disposeStyles = injectStyles()
        disposers.push(disposeStyles)

        const Body = makeBody(ctx)

        /* The tab registry can appear after the client module loads, so the    */
        /* registration retries for ~10 s before giving up quietly.             */
        let stopped = false
        let attempts = 0
        let retryTimer
        let disposeTab
        const registerTab = () => {
          if (stopped) return
          let tabs
          try {
            tabs = ctx.get('sidebarRightTabs')
          } catch {
            tabs = undefined
          }
          if (tabs !== undefined && tabs !== null && typeof tabs.register === 'function') {
            try {
              disposeTab = tabs.register({
                id: TYPE_ID,
                kind: KIND,
                priority: 'extension',
                title: () => '子代理拓扑',
                guide: [
                  {
                    id: KIND,
                    order: 40,
                    title: () => '子代理拓扑',
                    description: () => '主会话居中的子代理拓扑图：消息边、拖动与缩放',
                    icon: FishIcon,
                  },
                ],
              })
              console.info(LOG, 'tab type registered')
            } catch (error) {
              console.warn(LOG, 'tab type registration failed', error)
            }
            return
          }
          attempts += 1
          if (attempts >= 100) {
            console.warn(LOG, 'sidebarRightTabs never appeared; subagent topology tab unavailable')
            return
          }
          retryTimer = setTimeout(registerTab, 100)
        }
        registerTab()

        disposers.push(() => {
          stopped = true
          if (retryTimer !== undefined) clearTimeout(retryTimer)
          if (typeof disposeTab === 'function') {
            try {
              disposeTab()
            } catch (error) {
              console.warn(LOG, 'tab dispose failed', error)
            }
          }
        })

        try {
          const off = ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TYPE_ID, inject: (sessionId) => ({ sessionId }) },
              Body,
            ),
          )
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          console.warn(LOG, 'body slot registration failed', error)
        }

        try {
          const off = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, MatrilineTitle),
          )
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          console.warn(LOG, 'title slot registration failed', error)
        }

        try {
          const off = ctx.inject(['remote', 'remote.settings'], (scope) => {
            const setTrimFor = async (sessionId, enabled) => {
              if (typeof sessionId !== 'string' || sessionId === '' || typeof enabled !== 'boolean') return false
              const response = await scope.remote.settings.update('matriline-state', {
                sessions: { [sessionId]: enabled },
              }, undefined)
              if (!response.ok) throw new Error(response.error?.message ?? 'settings update refused')
              return true
            }
            // The confirmation lives on the shell overlay, not in the menu row:
            // the model menu closes on selection and would unmount the dialog.
            const overlayOff = scope.slots.inject('shell.overlay', () =>
              scope.slots.register({
                name: 'shell.overlay',
                id: 'matriline.confirm',
                inject: () => ({
                  useDisableRequest,
                  cancelDisable: (sessionId) => {
                    if (disableRequest !== null && disableRequest.sessionId === sessionId) publishDisable(null)
                  },
                  disableTrim: (sessionId) => setTrimFor(sessionId, false),
                }),
              }, MatrilineDisableConfirmation),
            )
            if (typeof overlayOff === 'function') disposers.push(overlayOff)
            const slotOff = scope.slots.inject('conversation.input.model.options', () =>
              scope.slots.register({
                name: 'conversation.input.model.options',
                id: 'matriline-gate',
                order: 12,
                inject: (sessionId) => ({
                  sessionId,
                  setTrim: (enabled) => setTrimFor(sessionId, enabled),
                  requestDisable: () => {
                    if (Modal === undefined || Button === undefined) {
                      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                        && window.confirm('关闭子代理工具裁剪？子代理将恢复完整工具面；本会话的工具表会变化，提示词缓存失效一次。')
                      if (ok) {
                        setTrimFor(sessionId, false).catch((error) => {
                          console.warn(LOG, 'fallback trim-off failed', error)
                        })
                      }
                      return
                    }
                    publishDisable({ sessionId })
                  },
                }),
              }, MatrilineGateRow),
            )
            if (typeof slotOff === 'function') disposers.push(slotOff)
            return () => {}
          })
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          console.warn(LOG, 'gate switch registration failed', error)
        }

        const cleanup = () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch (error) {
              console.warn(LOG, 'cleanup failed', error)
            }
          }
        }
        try {
          ctx.effect(() => cleanup)
        } catch {
          /* older hosts: nothing to own the lifetime, the panel still works */
        }
      },
    }
  },
})
