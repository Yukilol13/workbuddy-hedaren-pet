/**
 * 和大人府邸 · 数据快照（ESM）
 *
 * 由 Electron 主进程（CJS）通过子进程调用，输出一段 JSON 到 stdout。
 * 复用 core.js 的 ESM 函数，避免在主进程重复实现 mood/memory/积分逻辑。
 *
 * 用法：
 *   node mansion-data.js                 -> 全量快照
 *   node mansion-data.js reset-mood      -> 重置颤栗值/官位
 *   node mansion-data.js burn-diary <ids...> -> 烧掉指定分记忆
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  init, stateDir, readState, moodView, resetMood, listModels,
} from './core.js'
import { createMemoryStore } from './memory.js'
import { getCreditsReport } from './credits.js'

const cmd = process.argv[2] || 'snapshot'
await init()

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(join(stateDir(), name), 'utf8')) }
  catch { return fallback }
}

function out(obj) { process.stdout.write(JSON.stringify(obj)) }

if (cmd === 'reset-mood') {
  out({ ok: true, mood: await resetMood() })
} else if (cmd === 'burn-diary') {
  const ids = process.argv.slice(3)
  const store = createMemoryStore({ root: stateDir() })
  try {
    const result = await store.burn(ids.filter((x) => x !== 'main'))
    out({ ok: true, ...result })
  } catch (e) {
    out({ ok: false, error: e?.message || String(e) })
  }
} else {
  // 全量快照
  const state = await readState()
  const treasury = await readJson('desktop-treasury.json', {})
  const mood = await moodView()
  let diary = { stats: {}, files: [] }
  try {
    const store = createMemoryStore({ root: stateDir() })
    diary = await store.diary()
  } catch {}
  let models = []
  try { models = await listModels() } catch {}
  let credits = null
  try { credits = await getCreditsReport() } catch {}

  out({
    ok: true,
    state: {
      visible: state.visible,
      scale: state.scale ?? 1,
      throwSettleMs: state.throwSettleMs ?? 200,
      jailThreshold: state.jailThreshold ?? 10,
      chatModel: state.chat?.model || '',
    },
    treasury,
    mood,
    diary,
    models,
    credits,
  })
}
