/**
 * 和大人三层记忆
 *
 *   主记忆 main.json      画像 + 少量旧事 + 目录（索引）
 *   目录 catalog          每个分类（情感/情绪/工作/学习/管理/其他）挂若干分记忆
 *   分记忆 shards/*.json  分片记忆体：情感1、情感2、工作1……
 *
 * 平衡点（见 BUDGET）：记忆量小的时候条目直接躺在主记忆里，够省事；
 * 一旦主记忆的 token 超过 mainKeepTokens，就把既有条目按分类分片、建立目录，
 * 之后新条目直接进分记忆；每轮只按问题挑 1–2 片注入，不把全部记忆塞进 prompt。
 *
 * 这个模块不联网、不调用模型，纯本地规则：分类靠关键词，压缩靠截句。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const CATS = ['情感', '情绪', '工作', '学习', '管理', '其他']

export const CATEGORY_KEYWORDS = {
  情感: [
    '喜欢', '暗恋', '追', '表白', '告白', '约会', '相亲', '恋爱', '分手', '前任',
    '暧昧', '结婚', '老婆', '老公', '媳妇', '异地', '好感', '拉黑', '冷淡',
    '回消息', '姑娘', '女孩', '女生', '男孩', '男生', '对象', '女朋友', '男朋友',
    '婚', '恋爱脑', '吃醋', '心动',
  ],
  情绪: [
    '难过', '焦虑', '烦', '生气', '委屈', '崩溃', '压力', '失眠', '害怕', '孤独',
    '累', '抑郁', '郁闷', '内耗', '心态', '情绪', '失恋', '哭', 'emo', '不甘',
    '后悔', '自责', '迷茫', '丧', '烦死', '憋屈', '沮丧', '紧张', '伤心', '烦躁',
  ],
  工作: [
    '工作', '上班', '加班', '老板', '同事', '项目', '辞职', '跳槽', '面试', '工资',
    '裁员', '汇报', '职场', '客户', '需求', '甲方', '方案', '升职', '离职', '试用期',
    'KPI', 'kpi', '打工', '业务', '单子', '绩效', '任务', '行情',
  ],
  学习: [
    '学习', '考试', '考研', '考公', '复习', '备考', '背单词', '记不住', '论文', '英语',
    '技能', '课程', '刷题', '知识', '读书', '专业', '证书', '雅思', '托福', '编程',
    '学', '作业', '毕设', '上课',
  ],
  管理: [
    '管理', '团队', '下属', '带人', '分工', '授权', '制度', '部门', '招人', '决策',
    '领导力', '激励', '流程', '跨部门', '协作', '冲突', '考核', '定目标', '开会',
    '带团队', '管人', '领导', '下属犯', '躺平',
  ],
  其他: [],
}

/** 预算与平衡点：改这里就能调整「多大的记忆量才分片」 */
export const BUDGET = {
  persona: 1300, // 人格文件实测约 1276 token（账本里做对比用）
  mainKeepTokens: 900, // 主记忆直存上限：低于它就别建目录
  mainInjectTokens: 600, // 记忆量小时主记忆注入预算
  shardInjectTokens: 700, // 单轮注入分记忆预算
  maxShardsPerTurn: 2, // 每轮最多注入几片分记忆
  shardMaxItems: 12, // 一片分记忆最多装多少条
  historyMessages: 16, // 带多少条最近对话
  historyTokens: 900, // 最近对话的 token 预算
  replyMaxTokens: 520, // 回复长度上限
}

/** 中文按 0.9 token/字、其它字符 0.4 token/字估算，够用且偏保守 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u9fff\uff00-\uffef]/.test(ch)) cjk++
    else if (!/\s/.test(ch)) other++
  }
  return Math.ceil(cjk * 0.9 + other * 0.4)
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function bigrams(text) {
  const s = String(text ?? '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

function overlapCount(setA, setB) {
  let n = 0
  for (const a of setA) if (setB.has(a)) n++
  return n
}

/** 关键词分类：命中越多的分类胜出；都没命中算「其他」 */
export function classify(text) {
  const s = String(text ?? '')
  if (!s.trim()) return '其他'
  let best = '其他'
  let bestScore = 0
  for (const cat of CATS) {
    if (cat === '其他') continue
    let score = 0
    for (const kw of CATEGORY_KEYWORDS[cat]) {
      if (kw && s.includes(kw)) score += kw.length >= 2 ? 2 : 1
    }
    if (score > bestScore) {
      bestScore = score
      best = cat
    }
  }
  return bestScore > 0 ? best : '其他'
}

/** 从用户的话里捞「主子的来历」，只认很明确的说法，宁可漏不可错 */
const PROFILE_PATTERNS = [
  { re: /(?:我|朕|俺)叫([\u3400-\u9fffA-Za-z0-9]{1,10})/, make: (m) => `主子的名字：${m[1]}` },
  {
    re: /(?:我|朕|俺)(?:在|是)([\u3400-\u9fffA-Za-z0-9]{1,14}?(?:公司|单位|部门|学校|大学|上班|学生|工作))/,
    make: (m) => `主子在${m[1]}`,
  },
  {
    re: /(?:我|朕|俺)(?:最近|现在|正在|在|一直|想|要)*(?:追|喜欢|暗恋)([\u3400-\u9fffA-Za-z0-9]{1,12})/,
    make: (m) => `主子在追/喜欢${m[1]}`,
  },
  { re: /(?:记住|记着|别忘了)[:：,，\s]*([^\n。！？]{2,40})/, make: (m) => clip(m[1], 36) },
]

export function profileCandidates(text) {
  const s = String(text ?? '')
  const out = []
  for (const { re, make } of PROFILE_PATTERNS) {
    const m = s.match(re)
    if (m) out.push(make(m))
  }
  return out
}

function mergeProfile(profile, text) {
  const next = [...profile]
  for (const candidate of profileCandidates(text)) {
    if (!candidate || candidate.length < 3) continue
    const exists = next.some((x) => x === candidate || x.includes(candidate) || candidate.includes(x))
    if (!exists) next.push(candidate)
  }
  return next.slice(-8)
}

export function createMemoryStore({ root, log = console } = {}) {
  const baseDir = root || join(process.cwd(), '.hedaren-pet')
  const memoryDir = join(baseDir, 'memory')
  const shardDir = join(memoryDir, 'shards')
  const mainFile = join(memoryDir, 'main.json')
  const statsFile = join(memoryDir, 'stats.json')
  const historyFile = join(memoryDir, 'history.json')
  const legacyFile = join(baseDir, 'chat-memory.json')

  const data = { version: 2, profile: [], items: [], catalog: [], updatedAt: 0 }
  const stats = { totalTurns: 0, totalPromptTokens: 0, totalReplyTokens: 0, lastInjected: null, lastAt: 0 }
  let history = []
  let loaded = false
  let queue = Promise.resolve()

  const shardCache = new Map()

  function lock(fn) {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  async function readJson(file, fallback) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : fallback
    } catch {
      return fallback
    }
  }

  async function writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
  }

  function itemLine(item) {
    const text = clip(item?.text, 90)
    const reply = clip(item?.reply, 60)
    return reply ? `${text}（当时和大人答：${reply}）` : text
  }

  function mainTokens() {
    let n = 0
    for (const p of data.profile) n += estimateTokens(p)
    for (const item of data.items) n += Number(item.tokens) || estimateTokens(itemLine(item))
    return n
  }

  function catalogTokens() {
    if (!data.catalog.length) return 0
    return estimateTokens(catalogLines())
  }

  function shardTotalTokens() {
    return data.catalog.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0)
  }

  async function loadShard(name) {
    if (shardCache.has(name)) return shardCache.get(name)
    const shard = await readJson(join(shardDir, `${name}.json`), null)
    if (shard) shardCache.set(name, shard)
    return shard
  }

  async function saveShard(shard) {
    shard.updatedAt = Date.now()
    shard.tokens = shard.items.reduce((sum, item) => sum + (Number(item.tokens) || 0), 0)
    shard.keywords = shardKeywords(shard)
    shard.summary = summarize(shard.items)
    shardCache.set(shard.name, shard)
    await writeJson(join(shardDir, `${shard.name}.json`), shard)
    return shard
  }

  function shardKeywords(shard) {
    const set = new Set()
    const text = shard.items.map((item) => itemLine(item)).join('\n')
    for (const cat of CATS) {
      for (const kw of CATEGORY_KEYWORDS[cat] || []) {
        if (kw && text.includes(kw)) set.add(kw)
      }
    }
    const counts = new Map()
    for (const bigram of bigrams(text)) counts.set(bigram, (counts.get(bigram) || 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
    return [...[...set].slice(0, 10), ...top].slice(0, 12)
  }

  function summarize(items) {
    const pieces = []
    for (const item of items.slice(-6)) {
      const text = String(item?.text || '')
      const cut = text.split(/[，。！？；,.!?;\n]/)[0]
      if (!cut) continue
      const piece = clip(cut, 16)
      if (!pieces.includes(piece)) pieces.push(piece)
    }
    return clip(pieces.join('·'), 40)
  }

  /** 同一句话（忽略标点空格）只留一条，免得重复问话把记忆撑大 */
  function normText(text) {
    return String(text ?? '')
      .replace(/[\s，。！？；：、,.!?;:""''（）()]/g, '')
      .slice(0, 60)
  }

  function catalogLines() {
    if (!data.catalog.length) return ''
    const byCat = new Map()
    for (const entry of data.catalog) {
      if (!byCat.has(entry.cat)) byCat.set(entry.cat, [])
      byCat.get(entry.cat).push(entry)
    }
    const lines = ['【记忆目录】（问到这些事就翻对应的分记忆）']
    for (const cat of CATS) {
      const list = byCat.get(cat)
      if (!list || !list.length) continue
      const body = list
        .map((entry) => `${entry.name}（${clip(entry.summary || '无摘要', 18)}）`)
        .join('·')
      lines.push(`- ${cat}：${body}`)
    }
    return lines.join('\n')
  }

  /** 主记忆里的旧事直接进分记忆（跨过平衡点时调用） */
  async function spillMain() {
    const pending = [...data.items]
    if (!pending.length) return []
    data.items = []
    const created = []
    for (const item of pending) {
      const shard = await pushShard(item)
      if (shard) created.push(shard.name)
    }
    return created
  }

  /** 把一条记忆塞进该分类的分记忆：满了就开下一片（情感1 → 情感2 …） */
  async function pushShard(item) {
    const cat = CATS.includes(item.cat) ? item.cat : '其他'
    let index = 1
    let shard = null
    for (;;) {
      const name = `${cat}${index}`
      const existing = await loadShard(name)
      if (existing && existing.items.length < BUDGET.shardMaxItems) {
        shard = existing
        break
      }
      if (!existing) {
        shard = { name, cat, createdAt: Date.now(), updatedAt: Date.now(), summary: '', keywords: [], items: [], tokens: 0 }
        break
      }
      index++
    }
    shard.items.push({ at: item.at, cat, text: item.text, reply: item.reply, tokens: item.tokens })
    const saved = await saveShard(shard)
    upsertCatalog(saved)
    return saved
  }

  function upsertCatalog(saved) {
    const entry = {
      cat: saved.cat,
      name: saved.name,
      summary: saved.summary,
      keywords: saved.keywords,
      tokens: saved.tokens,
      items: saved.items.length,
      updatedAt: saved.updatedAt,
    }
    const at = data.catalog.findIndex((x) => x.name === saved.name)
    if (at >= 0) data.catalog[at] = entry
    else data.catalog.push(entry)
    return entry
  }

  /** 同一句话是否已经在某片分记忆里（同分类才找） */
  async function findShardItem(item) {
    const norm = normText(item.text)
    for (const entry of data.catalog) {
      if (entry.cat !== item.cat) continue
      const shard = await loadShard(entry.name)
      if (!shard) continue
      const found = shard.items.find((x) => normText(x.text) === norm)
      if (found) return { shard, found }
    }
    return null
  }

  function scoreShard(entry, question) {
    const q = String(question || '')
    let score = 0
    if (entry.cat === classify(q)) score += 4
    for (const kw of entry.keywords || []) {
      if (kw && kw.length >= 2 && q.includes(kw)) score += 3
    }
    score += overlapCount(bigrams(q), bigrams(entry.summary || ''))
    const ageDays = (Date.now() - (Number(entry.updatedAt) || 0)) / 86400000
    if (ageDays < 7) score += 1
    return score
  }

  function pickItemsFor(shard, question, budget) {
    const qSet = bigrams(question)
    const ranked = shard.items
      .map((item, index) => ({ item, index, hit: overlapCount(qSet, bigrams(itemLine(item))) }))
      .sort((a, b) => b.hit - a.hit || b.index - a.index)
    const picked = []
    let used = 0
    for (const { item } of ranked) {
      const line = itemLine(item)
      const tokens = estimateTokens(line)
      if (used + tokens > budget) break
      used += tokens
      picked.push(item)
    }
    // 恢复时间顺序，读起来顺
    picked.sort((a, b) => Number(a.at) - Number(b.at))
    return picked
  }

  async function retrieve(question) {
    await load()
    const parts = []
    const used = { profile: 0, main: 0, catalog: 0, shard: 0 }
    const picked = []

    if (data.profile.length) {
      const block = `【主记忆·主子的来历】\n${data.profile.slice(-8).map((x) => `- ${x}`).join('\n')}`
      used.profile = estimateTokens(block)
      parts.push(block)
    }

    if (!data.catalog.length) {
      // 记忆量小：主记忆里的旧事直接全量注入
      const lines = []
      let tokens = 0
      for (const item of [...data.items].reverse()) {
        const line = `- ${itemLine(item)}`
        const t = estimateTokens(line)
        if (tokens + t > BUDGET.mainInjectTokens) break
        tokens += t
        lines.unshift(line)
      }
      if (lines.length) {
        const block = `【主记忆·旧事】\n${lines.join('\n')}`
        used.main = estimateTokens(block)
        parts.push(block)
      }
    } else {
      const block = catalogLines()
      used.catalog = estimateTokens(block)
      parts.push(block)

      const ranked = data.catalog
        .map((entry) => ({ entry, score: scoreShard(entry, question) }))
        .filter((x) => x.score >= 2) // 分数太低就是巧合撞词，别硬塞
        .sort((a, b) => b.score - a.score)
      let budget = BUDGET.shardInjectTokens
      for (const { entry } of ranked) {
        if (picked.length >= BUDGET.maxShardsPerTurn) break
        if (budget <= 80) break
        const shard = await loadShard(entry.name)
        if (!shard) continue
        const items = pickItemsFor(shard, question, budget - 40)
        if (!items.length) continue
        const lines = items.map((item) => `- ${itemLine(item)}`)
        const body = `【分记忆·${shard.name}】${shard.summary}\n${lines.join('\n')}`
        const tokens = estimateTokens(body)
        if (tokens > budget) continue
        budget -= tokens
        used.shard += tokens
        picked.push(shard.name)
        parts.push(body)
      }
    }

    return { text: parts.join('\n\n'), picked, used, hasCatalog: data.catalog.length > 0 }
  }

  async function remember({ question, reply, at } = {}) {
    return lock(async () => {
      await load()
      const q = String(question ?? '').trim()
      if (!q) return null
      const cat = classify(q)
      const item = {
        at: Number(at) || Date.now(),
        cat,
        text: clip(q, 120),
        reply: clip(String(reply ?? ''), 90),
      }
      item.tokens = estimateTokens(itemLine(item))
      data.profile = mergeProfile(data.profile, q)

      const finish = (where, shardName, deduped = false) => ({
        cat,
        where,
        shard: shardName,
        deduped,
        tokens: item.tokens,
        mainTokens: mainTokens(),
        catalogTokens: catalogTokens(),
        shardTokens: shardTotalTokens(),
      })

      // 去重：同一句话不重复记，只把答复和时间换成最新的，省 token
      const dupMain = data.items.find((x) => normText(x.text) === normText(item.text))
      if (dupMain) {
        dupMain.at = item.at
        dupMain.reply = item.reply
        dupMain.tokens = item.tokens
        data.updatedAt = Date.now()
        await saveMain()
        return finish('main', '', true)
      }
      const dupShard = await findShardItem(item)
      if (dupShard) {
        dupShard.found.at = item.at
        dupShard.found.reply = item.reply
        dupShard.found.tokens = item.tokens
        upsertCatalog(await saveShard(dupShard.shard))
        data.updatedAt = Date.now()
        await saveMain()
        return finish('shard', dupShard.shard.name, true)
      }

      let where = 'main'
      let shardName = ''
      if (!data.catalog.length && mainTokens() + item.tokens <= BUDGET.mainKeepTokens) {
        // 记忆量还小：直接在主记忆里保存
        data.items.push(item)
      } else {
        // 记忆量大了：先建目录，再把这条塞进分记忆
        if (!data.catalog.length) await spillMain()
        const shard = await pushShard(item)
        where = 'shard'
        shardName = shard?.name || ''
      }
      data.updatedAt = Date.now()
      await saveMain()
      return finish(where, shardName)
    })
  }

  async function saveMain() {
    await writeJson(mainFile, data)
  }

  async function load() {
    if (loaded) return
    loaded = true
    await mkdir(shardDir, { recursive: true })
    const raw = await readJson(mainFile, null)
    if (raw) {
      data.profile = Array.isArray(raw.profile) ? raw.profile.slice(-8) : []
      data.items = Array.isArray(raw.items) ? raw.items : []
      data.catalog = Array.isArray(raw.catalog) ? raw.catalog : []
      data.updatedAt = Number(raw.updatedAt) || 0
      data.version = 2
    } else {
      await migrateLegacy()
    }
    const stat = await readJson(statsFile, null)
    if (stat) Object.assign(stats, stat)
    const hist = await readJson(historyFile, null)
    if (hist && Array.isArray(hist.messages)) history = hist.messages.slice(-24)
  }

  /** 老版本只有一个 chat-memory.json（facts + 原文消息），搬进新结构 */
  async function migrateLegacy() {
    if (!existsSync(legacyFile)) return
    try {
      const raw = JSON.parse(await readFile(legacyFile, 'utf8'))
      data.profile = Array.isArray(raw.facts) ? raw.facts.map((x) => clip(x, 40)).slice(-8) : []
      const messages = Array.isArray(raw.messages) ? raw.messages : []
      let lastUser = ''
      for (const m of messages) {
        if (m?.role === 'user') {
          lastUser = String(m.text || '')
        } else if (m?.role === 'assistant' && lastUser) {
          const cat = classify(lastUser)
          const text = clip(lastUser, 120)
          const reply = clip(String(m.text || ''), 90)
          data.items.push({ at: Number(m.at) || Date.now(), cat, text, reply, tokens: estimateTokens(text) + estimateTokens(reply) })
          lastUser = ''
        }
      }
      // 旧记忆多半已经不少了，直接跨过平衡点：分片建目录
      if (mainTokens() > BUDGET.mainKeepTokens) await spillMain()
      await saveMain()
      await rename(legacyFile, `${legacyFile}.migrated`)
      log.info?.(`[hedaren-pet] 旧记忆已迁入三层记忆：画像 ${data.profile.length} 条，分记忆 ${data.catalog.length} 片`)
    } catch (error) {
      log.warn?.(`[hedaren-pet] 旧记忆迁移失败：${error?.message || String(error)}`)
    }
  }

  async function recordTurn({ personaTokens = 0, injected = null, replyTokens = 0, cat = '其他', where = 'main' } = {}) {
    return lock(async () => {
      await load()
      stats.totalTurns += 1
      const promptTokens =
        personaTokens + (injected ? injected.used.profile + injected.used.main + injected.used.catalog + injected.used.shard : 0)
      stats.totalPromptTokens += promptTokens
      stats.totalReplyTokens += replyTokens
      stats.lastInjected = { ...(injected?.used || {}), persona: personaTokens, total: promptTokens }
      stats.lastPicked = Array.isArray(injected?.picked) ? injected.picked : []
      stats.lastAt = Date.now()
      stats.lastCat = cat
      stats.lastWhere = where
      const tail = `${new Date().toISOString().slice(11, 19)} ${cat}/${where} prompt≈${promptTokens} reply≈${replyTokens}`
      stats.history = [tail, ...(Array.isArray(stats.history) ? stats.history : [])].slice(0, 40)
      await writeJson(statsFile, stats)
      return stats
    })
  }

  async function pushHistory(role, text) {
    history.push({ role, text: String(text ?? ''), at: Date.now() })
    if (history.length > 24) history = history.slice(-24)
    await writeJson(historyFile, { messages: history })
  }

  /** 按 token 预算取最近对话 */
  function historyForPrompt() {
    const picked = []
    let tokens = 0
    for (const m of [...history].reverse()) {
      if (picked.length >= BUDGET.historyMessages) break
      const t = estimateTokens(m.text)
      if (tokens + t > BUDGET.historyTokens) break
      tokens += t
      picked.unshift(m)
    }
    return { messages: picked.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })), tokens }
  }

  function ledger() {
    const totals = {
      main: mainTokens() + catalogTokens(),
      shard: shardTotalTokens(),
    }
    const last = stats.lastInjected || {}
    const lines = ['【和某的记忆账本】']
    lines.push(`主记忆：画像 ${data.profile.length} 条 · 旧事 ${data.items.length} 条 · 目录 ${data.catalog.length} 片 · 约 ${totals.main} tokens`)
    if (data.catalog.length) {
      const byCat = new Map()
      for (const entry of data.catalog) {
        if (!byCat.has(entry.cat)) byCat.set(entry.cat, [])
        byCat.get(entry.cat).push(entry)
      }
      for (const cat of CATS) {
        const list = byCat.get(cat)
        if (!list || !list.length) continue
        lines.push(`· ${cat}：${list.map((e) => `${e.name}(${e.items}条/${e.tokens}t)`).join('、')}`)
      }
    } else {
      lines.push('· 还没建目录——记忆量还小，都直接存在主记忆里')
    }
    if (last.total) {
      lines.push(
        `上轮注入：人格 ${last.persona || 0} + 画像 ${last.profile || 0} + 目录 ${last.catalog || 0} + 分记忆 ${last.shard || 0} = ${last.total} tokens`,
      )
    }
    if (stats.lastPicked && stats.lastPicked.length) {
      lines.push(`上轮翻到的分记忆：${stats.lastPicked.join('、')}`)
    }
    lines.push(
      `平衡点：主记忆 ≤${BUDGET.mainKeepTokens}t 直存；超过即建目录分片；单轮分记忆注入 ≤${BUDGET.shardInjectTokens}t；对话 ≤${BUDGET.historyTokens}t`,
    )
    lines.push(`累计：${stats.totalTurns} 轮 · prompt 约 ${stats.totalPromptTokens} tokens · 回复约 ${stats.totalReplyTokens} tokens`)
    return lines.join('\n')
  }

  function snapshot() {
    return {
      profile: [...data.profile],
      items: [...data.items],
      catalog: [...data.catalog],
      history: history.length,
      stats: { ...stats },
      totals: { main: mainTokens() + catalogTokens(), shard: shardTotalTokens(), catalog: catalogTokens() },
    }
  }

  // ---------- 和大人日记：一份记忆文件算一篇，只能焚毁、不能改写 ----------

  async function sizeOf(file) {
    try {
      return (await stat(file)).size
    } catch {
      return 0
    }
  }

  /**
   * 日记库 = 每份形成记忆的文件各算一篇：主记忆一份 + 每片分记忆一份。
   * 返回 { stats, files:[{ id, name, cat, file, bytes, items, tokens, updatedAt, preview[] }] }
   */
  async function diaryFiles() {
    await load()
    const mainLines = [
      ...data.profile.map((p) => `画像：${String(p || '')}`),
      ...data.items.map((item) => itemLine(item)),
    ]
    const files = [
      {
        id: 'main',
        name: '主记忆',
        cat: '主账',
        file: 'main.json',
        burnable: false,
        bytes: await sizeOf(mainFile),
        items: data.items.length,
        profile: data.profile.length,
        tokens: mainTokens(),
        updatedAt: Number(data.updatedAt) || 0,
        preview: [
          ...data.profile.slice(-2).map((p) => `画像：${clip(p, 60)}`),
          ...data.items.slice(-3).map((item) => itemLine(item)),
        ],
        lines: mainLines.slice(-120),
      },
    ]
    for (const entry of data.catalog) {
      const shard = await loadShard(entry.name)
      if (!shard) continue
      files.push({
        id: shard.name,
        name: shard.name,
        cat: shard.cat,
        file: `shards/${shard.name}.json`,
        burnable: true,
        bytes: await sizeOf(join(shardDir, `${shard.name}.json`)),
        items: shard.items.length,
        tokens: Number(shard.tokens) || 0,
        createdAt: Number(shard.createdAt) || 0,
        updatedAt: Number(shard.updatedAt) || 0,
        preview: shard.items.slice(-3).map((item) => itemLine(item)),
        lines: shard.items.slice(-200).map((item) => itemLine(item)),
      })
    }
    const byCat = {}
    for (const f of files) byCat[f.cat] = (byCat[f.cat] || 0) + 1
    const summary = {
      files: files.length,
      entries: files.reduce((n, f) => n + (Number(f.items) || 0), 0),
      tokens: files.reduce((n, f) => n + (Number(f.tokens) || 0), 0),
      bytes: files.reduce((n, f) => n + (Number(f.bytes) || 0), 0),
      byCat,
      profile: data.profile.length,
      turns: Number(stats.totalTurns) || 0,
      newestAt: files.reduce((m, f) => Math.max(m, Number(f.updatedAt) || 0), 0),
    }
    return { stats: summary, files }
  }

  /**
   * 焚毁整份日记文件。毛笔账本的规矩：不改写、不涂改，烧掉就是烧掉。
   * - 分记忆：删文件 + 从目录摘除
   * - 主记忆：清空画像与旧事（保留分记忆目录，不然分记忆文件会变成没人认领的孤儿）
   */
  async function burnFiles(names = []) {
    const wanted = new Set(
      (Array.isArray(names) ? names : []).map(String).filter((name) => name && name !== 'main'),
    )
    if (!wanted.size) return { burned: [], left: 0 }
    return lock(async () => {
      await load()
      const burned = []
      if (wanted.has('main')) {
        data.profile = []
        data.items = []
        data.updatedAt = Date.now()
        await saveMain()
        burned.push('main')
      }
      let catalogChanged = false
      for (const name of [...wanted]) {
        if (name === 'main') continue
        if (!data.catalog.some((x) => x.name === name)) continue
        try {
          await rm(join(shardDir, `${name}.json`), { force: true })
        } catch {}
        shardCache.delete(name)
        data.catalog = data.catalog.filter((x) => x.name !== name)
        catalogChanged = true
        burned.push(name)
      }
      if (catalogChanged) await saveMain()
      const after = await diaryFiles()
      return { burned, left: after.stats.files }
    })
  }

  return {
    baseDir,
    memoryDir,
    shardDir,
    load,
    remember,
    retrieve,
    recordTurn,
    pushHistory,
    historyForPrompt,
    ledger,
    snapshot,
    diary: diaryFiles,
    burn: burnFiles,
    classify,
    estimateTokens,
  }
}
