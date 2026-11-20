#!/usr/bin/env node
/**
 * 和大人桌宠 · WorkBuddy MCP Server（stdio，零依赖）
 *
 * 暴露 hedaren_pet 工具，让 WorkBuddy Agent 主动控制桌宠：
 *   status / say / play / show / hide / work / credits / chat / memory / memory_search
 * （捕鱼相关 action 按用户要求注释）
 *
 * 使用标准 MCP stdio 传输：换行分隔的 JSON-RPC 2.0 消息。
 */

import * as core from './core.js'

const SERVER_INFO = { name: 'hedaren-pet', version: '1.0.0' }

const TOOL = {
  name: 'hedaren_pet',
  description:
    '控制和大人桌面宠物：让他说话、播放动作、显示/隐藏、模拟工作状态、查国库积分、以皇上身份对话、查看/检索记忆。' +
    '动作名例如「待机-呼吸」「待机-牢房」「待机-捻须」「点击-拱手」「银票打手」「斗嘴」「递古董」「常服进门」「琉璃厂」「跪舔」' +
    '「常服算账」「塞银票」「拍马屁」「被参一本」「府里数银」「工作-掏出」「工作-循环」「工作-收起」「工作-过渡」。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'say', 'play', 'show', 'hide', 'work', 'credits', 'chat_context', 'chat', 'submit_reply', 'models', 'set_model', 'memory', 'memory_search', 'mood', 'mood_reset', 'fish_play', 'fish_preview', 'mansion'],
        description:
          'status 查状态；say 说一句；play 播动作；show/hide 显示隐藏；work 模拟清除工作状态；' +
          'credits 查 WorkBuddy 积分国库；' +
          '【对话走 WorkBuddy 当前会话模型】先用 chat_context 取和大人人格/记忆/心气上下文，你（WorkBuddy 模型）自行写好回复，' +
          '再用 submit_reply（text=皇上原话, reply=你写的回复）写回桌宠；chat 等价于 submit_reply 的简写（reply 参数即你的回复）；' +
          'models 列出对话模型（固定 WorkBuddy 当前会话）；' +
          'memory 看记忆账本；memory_search 检索记忆；' +
          'mood 查颤栗值/官位；mood_reset 重置心气；fish_play 用 enabled 开启一次性捕鱼（开启后飞行2秒播一次撒网动画，随即自动关闭，纯视觉）；' +
          'fish_preview 预览撒网动画；mansion 打开和大人府邸设置窗口。',
      },
      text: { type: 'string', description: 'action=say / chat / chat_context / submit_reply 时的皇上原话文本。' },
      reply: { type: 'string', description: 'action=chat / submit_reply：你（WorkBuddy 当前会话模型）以和大人人格写好的回复正文。' },
      anim: { type: 'string', description: 'action=play 时的动作名。' },
      loop: { type: 'boolean', description: 'action=play 是否循环，默认 true。' },
      active: { type: 'boolean', description: 'action=work：是否处于工作状态。' },
      task: { type: 'string', description: 'action=work：任务文案。' },
      approval: { type: 'string', description: 'action=work：审批提示文案。' },
      done: { type: 'integer', description: 'action=work：已完成步骤数。' },
      total: { type: 'integer', description: 'action=work：总步骤数。' },
      query: { type: 'string', description: 'action=memory_search：检索问题。' },
      threshold: { type: 'number', description: '附加入口：设置牢房积分阈值（配合未来 action）。' },
    },
    required: ['action'],
  },
}

const money = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function renderText(action, value) {
  if (!value || !value.ok) return `和大人桌宠没有响应：${value?.error || ''}`
  if (action === 'credits' && value.report) {
    const r = value.report
    return [
      `【和大人国库账本】`,
      `国库总余额：${r.total} 积分`,
      `今日耗银：${r.today} 积分`,
      `近七日：${r.last7d} 积分`,
      `和大人小金库：${money(value.assets)} 积分（累计抽成 ${money(value.totalSiphoned ?? 0)} 积分）`,
      r.lastSession ? `最近一会话：${r.lastSession.credit} 积分 · ${r.lastSession.at}` : '',
      `数据源：WorkBuddy 本地积分消耗（非账号余额）`,
    ].filter(Boolean).join('\n')
  }
  if (action === 'chat_context') {
    if (!value.ok) return `取上下文失败：${value.error || ''}`
    return [
      '【和大人对话上下文 · 请 WorkBuddy 当前会话模型据此写回复】',
      value.instructions || '',
      value.history?.length ? `\n【最近对话】\n${value.history.map((m) => `${m.role}: ${m.content}`).join('\n')}` : '',
      `\n【皇上这句】${value.text}`,
      value.dread ? '\n（此刻胆战心惊，只认错求饶）' : '',
      `\n${value.note || ''}`,
    ].filter(Boolean).join('\n')
  }
  if (action === 'chat' || action === 'submit_reply') {
    return `和大人${value.offline ? '（本地兜底话术）' : ''}：${value.reply || '（拱手）奴才在。'}`
  }
  if (action === 'memory') return value.ledger || '（拱手）账本一时翻不开。'
  if (action === 'memory_search') {
    return `命中分记忆：${(value.picked || []).join('、') || '（没命中，走主记忆）'}\n注入约 ${value.tokens || 0} tokens\n\n${value.text || ''}`
  }
  if (action === 'status') {
    return `和大人：${value.anim?.name || '待机'}${value.say?.text ? ` · “${value.say.text}”` : ''}\n可见：${value.visible ? '是' : '否'}\n工作状态：${value.work?.active ? `${value.work.state}${value.work.task ? ' · ' + value.work.task : ''}` : '空闲'}\n对话模型：WorkBuddy 当前会话模型\n官位/心气：${value.mood?.rankLabel || '?'} / ${value.mood?.trembleLabel || '?'}`
  }
  if (action === 'mood' || action === 'mood_reset') {
    const m = value.mood || {}
    return `和大人官位：${m.rankLabel || '?'}\n颤栗值：${m.trembleLabel || '?'}（${m.band || ''}）\n心气：${m.stateLabel || '平常'}${m.state !== 'normal' ? ` · 剩 ${m.stateTurnsLeft || 0} 轮 / ${Math.round((m.stateMsLeft || 0)/1000)} 秒` : ''}`
  }
  if (action === 'fish_play') {
    return `捕鱼玩法（纯视觉·一次性）已${value.enabled ? '开启（待触发）' : '关闭'}：开启后飞行满 2 秒播一次撒网动画，随即自动关闭，下次需手动再开；不捕捉、不改数据。`
  }
  if (action === 'fish_preview') return '已通知桌宠播一次撒网动画（纯视觉）。'
  if (action === 'mansion') return value.hint || '已请求打开和大人府邸窗口。'
  if (action === 'models') {
    const list = value.models || []
    if (!list.length) return '没有配置任何对话模型。'
    return '可用对话模型：\n' + list.map((m) =>
      `${m.isDefault ? '★' : '·'} ${m.id} — ${m.label}${m.available ? '' : '（未配 Key，走本地话术）'}`
    ).join('\n')
  }
  if (action === 'set_model') {
    return `对话模型固定为：${value.label || value.model || 'WorkBuddy 当前会话模型'}（无需配置外部 Key）`
  }
  return `和大人：${value.anim?.name || '待机'}${value.say?.text ? ` · “${value.say.text}”` : ''}`
}

async function execute(args) {
  const action = String(args?.action || 'status')
  try {
    if (action === 'say') return { ok: true, ...(await core.say(args?.text, args?.anim)) }
    if (action === 'play') return { ok: true, ...(await core.play(args?.anim, args?.loop !== false)) }
    if (action === 'show') return { ok: true, ...(await core.show()) }
    if (action === 'hide') return { ok: true, ...(await core.hide()) }
    if (action === 'work') {
      return {
        ok: true,
        ...(await core.setWork({
          active: args?.active === true,
          task: args?.task, approval: args?.approval,
          done: args?.done, total: args?.total,
        })),
      }
    }
    if (action === 'credits') {
      const r = await core.refreshTreasury({ manual: true })
      return { ok: r.ok, ...r }
    }
    if (action === 'chat_context') {
      return await core.chatContext(args?.text)
    }
    if (action === 'chat') {
      const r = await core.chat(args?.text, args?.reply || '')
      return r
    }
    if (action === 'submit_reply') {
      return await core.submitReply(args?.text, args?.reply || '')
    }
    if (action === 'models') {
      return { ok: true, models: await core.listModels() }
    }
    if (action === 'set_model') {
      return await core.setChatModel('')
    }
    if (action === 'memory') {
      const cur = await core.readState()
      const ledger = await core.showLedger(cur)
      return { ok: true, ledger }
    }
    if (action === 'memory_search') {
      return await core.memorySearch(args?.query || args?.text)
    }
    if (action === 'mood') return { ok: true, mood: await core.moodView() }
    if (action === 'mood_reset') return { ok: true, mood: await core.resetMood() }
    if (action === 'fish_play') {
      const enabled = args?.enabled === true
      return { ok: true, enabled: await core.setFishPlay(enabled) }
    }
    if (action === 'fish_preview') {
      // 写一个 preview 信号到 state，Electron 窗口轮询到就播一次撒网动画
      await core.writeState({ fishPreviewAt: Date.now() })
      return { ok: true, preview: true }
    }
    if (action === 'mansion') {
      // 写信号让 Electron 打开府邸窗口（second-instance / watcher 消费）
      await core.writeState({ mansionOpenAt: Date.now() })
      return { ok: true, hint: '已请求打开和大人府邸窗口' }
    }
    if (action === 'status') return await core.statusSummary()
    // 真实捕鱼（捕捉/藏鱼）已停用：只有纯视觉撒网动画
    return { ok: false, error: `未知 action：${action}` }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    if (name !== TOOL.name) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具 ${name}` } })
      return
    }
    const action = String(args?.action || 'status')
    const value = await execute(args)
    const text = renderText(action, value)
    send({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text }],
        isError: value?.ok === false,
        structuredContent: value,
      },
    })
    return
  }
  if (method && id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } })
  }
}

// 主循环：换行分隔 JSON-RPC
let buffer = ''
let pending = 0
let stdinEnded = false
function maybeExit() {
  // 等所有异步 tool 调用都回包后再退出，避免 end 事件抢在回复前 process.exit
  if (stdinEnded && pending === 0) process.exit(0)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    pending++
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } })
    }).finally(() => {
      pending--
      maybeExit()
    })
  }
})
process.stdin.on('end', () => { stdinEnded = true; maybeExit() })

await core.init()
