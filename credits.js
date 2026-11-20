/**
 * 和大人 · 国库账房（WorkBuddy 通用版 · Node 实现）
 *
 * 只读 WorkBuddy 本地数据库 ~/.workbuddy/workbuddy.db 的 session_usage 表，
 * 把积分消耗折成「国库流水」。不依赖 Python —— 用 Node 22 内置的 node:sqlite。
 * 若 node:sqlite 不可用（老版本 Node），回退到调用 credits.py。
 *
 * 所有查询均只读，绝不修改 WorkBuddy 自身数据。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export function dbPath() {
  return process.env.WORKBUDDY_DB_PATH || join(homedir(), '.workbuddy', 'workbuddy.db')
}

function ts(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d
}

function sumCredit(creditJson) {
  if (!creditJson) return 0
  try {
    const obj = typeof creditJson === 'string' ? JSON.parse(creditJson) : creditJson
    if (!obj || typeof obj !== 'object') return 0
    let total = 0
    for (const v of Object.values(obj)) {
      const n = Number(v)
      if (Number.isFinite(n)) total += n
    }
    return total
  } catch {
    return 0
  }
}

function summarize(rows) {
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const weekAgo = now.getTime() - 7 * 86400000

  let totalAll = 0
  let totalToday = 0
  let totalWeek = 0
  let tokensAll = 0
  let last = null
  const byDay = new Map()

  for (const r of rows) {
    const c = r.credit
    totalAll += c
    tokensAll += r.used
    const d = ts(r.updated_at)
    if (d) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      byDay.set(key, (byDay.get(key) || 0) + c)
      if (key === todayKey) totalToday += c
      if (d.getTime() >= weekAgo) totalWeek += c
      if (c > 0 && (!last || d.getTime() > last.t)) {
        last = { t: d.getTime(), credit: c, used: r.used, d }
      }
    }
  }

  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 7)
    .map(([date, credit]) => ({ date, credit: r2(credit) }))

  return {
    ok: true,
    source: dbPath(),
    currency: '积分',
    today: r2(totalToday),
    last7d: r2(totalWeek),
    total: r2(totalAll),
    tokens: tokensAll,
    sessions: rows.length,
    lastSession: last
      ? {
          credit: r2(last.credit),
          tokens: last.used,
          at: `${last.d.getFullYear()}-${String(last.d.getMonth() + 1).padStart(2, '0')}-${String(last.d.getDate()).padStart(2, '0')} ${String(last.d.getHours()).padStart(2, '0')}:${String(last.d.getMinutes()).padStart(2, '0')}`,
        }
      : null,
    days,
    updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    note: '积分为 WorkBuddy 本地已消耗量（session_usage.credit_json），非账号剩余余额',
  }
}

let sqliteAvailable = null
async function trySqliteRows() {
  if (sqliteAvailable === false) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    sqliteAvailable = true
    const db = new DatabaseSync(dbPath(), { readOnly: true })
    try {
      const rows = db
        .prepare('SELECT updated_at, credit_json, used, session_id FROM session_usage')
        .all()
      return rows.map((r) => ({
        updated_at: r.updated_at,
        credit: sumCredit(r.credit_json),
        used: Number(r.used) || 0,
        session_id: r.session_id || '',
      }))
    } finally {
      db.close()
    }
  } catch (e) {
    sqliteAvailable = false
    return null
  }
}

async function tryPythonRows() {
  const pyCandidates = [
    process.env.PET_PYTHON,
    'python',
    'python3',
  ].filter(Boolean)
  const script = join(HERE, 'credits.py')
  if (!existsSync(script)) return null
  for (const py of pyCandidates) {
    try {
      const { stdout } = await execFileAsync(py, [script], {
        timeout: 10000,
        env: { ...process.env, PYTHONPATH: '' },
      })
      const rep = JSON.parse(stdout.trim())
      if (!rep.ok) return null
      // 由 python 报告反推行级数据：只有聚合，无法还原每行；构造等价聚合行
      return {
        aggregate: {
          ok: true,
          source: rep.source,
          currency: '积分',
          today: rep.today,
          last7d: rep.last7d,
          total: rep.total,
          tokens: rep.tokens,
          sessions: rep.sessions,
          lastSession: rep.last_session,
          days: rep.days,
          updatedAt: rep.updatedAt,
          note: rep.note,
        },
      }
    } catch {
      // 试下一个解释器
    }
  }
  return null
}

/** 返回完整账本报告 */
export async function getCreditsReport() {
  if (!existsSync(dbPath())) {
    return { ok: false, error: `找不到 WorkBuddy 数据库：${dbPath()}` }
  }
  const rows = await trySqliteRows()
  if (rows) return summarize(rows)
  const py = await tryPythonRows()
  if (py?.aggregate) return py.aggregate
  return { ok: false, error: '无法读取积分：node:sqlite 与 credits.py 均不可用' }
}

/** 简短播报文本 */
export function shortText(rep) {
  if (!rep?.ok) return '国库账本暂时查不着……主子容奴才再瞧瞧。'
  return [
    `国库总余额 ${rep.total} 积分`,
    `今日耗银 ${rep.today} 积分`,
    `近七日 ${rep.last7d} 积分`,
  ].join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const short = process.argv.includes('--short')
  const rep = await getCreditsReport()
  console.log(short ? shortText(rep) : JSON.stringify(rep, null, 2))
}
