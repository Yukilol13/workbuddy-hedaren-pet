/**
 * 和大人捕大肥鱼：判定参数、台词、几何。
 *
 * 纯数据 + 纯函数，方便单测；主进程只负责按结果播动作、说台词、写状态。
 */

/** 失败概率区间：10%–25%，飞得越快越容易失手 */
const FAIL_MIN = 0.1
const FAIL_MAX = 0.25
/** 速度映射区间（px/s）：低于 SLOW 按 20%，高于 FAST 按 50% */
const SPEED_SLOW = 600
const SPEED_FAST = 3200
/** 「速度过快」的界线：超过它失手会破口大骂、怪老纪催得太急 */
const SPEED_RECKLESS = 2000

/** 邀功：网住之后和大人得意的话 */
const BRAG_LINES = [
  '主子您瞧！奴才这网一撒，大肥鱼就插翅也难飞了！',
  '（搓手）托主子的福，这条肥鱼奴才给您逮回来了，您赏奴才一句好就行。',
  '哎哟喂，这鱼可肥得很！奴才回去仔细称称，一两都不短您的。',
  '主子圣明！奴才这手上功夫，老纪那大烟袋再练十年也赶不上。',
  '（得意）奴才早说了，这鱼就该进咱们府里的池子，如今可不就进去了。',
  '这网是奴才特意捡着好丝编的，就为大肥鱼这等上品备着。',
  '主子放心，府里已经挖好池子，就等这条鱼下锅——啊不，下水。',
  '（拱手）奴才这条小命，全凭主子赏脸；这条肥鱼，全凭主子洪福。',
  '您瞧它刚才还横着走，这会儿老实了吧？跟奴才在朝堂上一个规矩。',
  '奴才这就去把鱼记在府里的账上，主子要看，随时给您报数。',
]

/** 请罪：撞上去没网住 */
const APOLOGY_LINES = [
  '（扑通跪下）奴才该死！这一网撒偏了，让主子白看了场笑话。',
  '哎哟喂，奴才这手不争气，鱼没网着，倒叫它溜了……奴才认罚。',
  '（作揖）主子息怒，是奴才贪功心切，出网急了半拍。',
  '奴才该死！方才那一下，奴才只想着在主面前露脸，把火候丢了。',
  '（抹汗）奴才这网是好的，是奴才的腿没跟上，主子容奴才再来一回。',
  '奴才认栽——这鱼太滑，比老纪那张嘴还滑。',
  '（跪）回主子的话，奴才失手了；您要打要罚，奴才都受着。',
  '请主子责罚！奴才回头就去渔具铺子重新置办，下回定不给主子丢人。',
]

/** 失手且速度过快：怪老纪催命（也会混进普通失手的台词池） */
const BLAME_LINES = [
  '老纪你着什么急！都怪你！要不是你在旁边催，奴才这一网能偏吗！',
  '（跺脚）纪大烟袋你少啰嗦！你一句"快点"，奴才这网就撒歪了！',
  '都怪老纪！在那儿挥着烟袋瞎指挥，主子您评评理，这叫帮倒忙！',
  '老纪你个催命的！这鱼跑了，账记你头上，奴才可不认！',
]

/** 大肥鱼不在桌面/DSH 窗口里：和大人骂老纪把人藏了 */
const HIDDEN_BLAME_LINES = [
  '（跳脚）老纪！你把大肥鱼藏到哪儿去了？你可别袒护罪人！',
  '好个纪大烟袋，人赃并藏！这鱼不在明处，你却在这儿装糊涂！',
  '（拍腿）主子您瞧，鱼影都没见着！准是老纪把犯人藏了，还护着他！',
  '老纪你这叫窝藏！大肥鱼不在桌面、不在窗口，你能不知道？',
]

/**
 * 本次碰撞的失败概率：速度越快越高，夹在 10%–25%。
 * @param {number} speed px/s
 */
function failChance(speed) {
  const v = Number(speed)
  if (!Number.isFinite(v) || v <= SPEED_SLOW) return FAIL_MIN
  const t = Math.min(1, (v - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW))
  return FAIL_MIN + (FAIL_MAX - FAIL_MIN) * t
}

/**
 * 判定一次捕捉。
 * @param {{speed:number, visible:boolean, random:()=>number}} input
 *   speed 撞击瞬间速度；visible 大肥鱼是否在显示范围内（不在则必定失败）；random 0..1
 * @returns {{result:'success'|'fail'|'hidden', chance:number, reckless:boolean, speed:number}}
 */
function judgeCapture({ speed, visible, random = Math.random }) {
  const v = Math.max(0, Number(speed) || 0)
  if (!visible) return { result: 'hidden', chance: 1, reckless: true, speed: v }
  const chance = failChance(v)
  const failed = random() < chance
  return {
    result: failed ? 'fail' : 'success',
    chance,
    reckless: failed && v > SPEED_RECKLESS,
    speed: v,
  }
}

/** 大肥鱼的命中盒尺寸（dsh-pet 的 16:9 舞台：462 宽、462×9/16≈260 高） */
const FISH_BOX = { w: 462, h: 260 }

/**
 * 手动校准出来的「大肥鱼中心」→ 命中框。
 * @param {{cx:number, cy:number}} manual 屏幕 DIP 中心
 * @returns {{x:number,y:number,w:number,h:number,manual:true}|null}
 */
function rectFromManual(manual) {
  const cx = Number(manual?.cx)
  const cy = Number(manual?.cy)
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return {
    x: Math.round(cx - FISH_BOX.w / 2),
    y: Math.round(cy - FISH_BOX.h / 2),
    w: FISH_BOX.w,
    h: FISH_BOX.h,
    manual: true,
  }
}

/** 两个矩形是否相交（可留一点容差，负数=更宽松） */
function rectsOverlap(a, b, slop = 0) {
  if (!a || !b) return false
  return (
    a.x + a.w > b.x - slop &&
    a.x < b.x + b.w + slop &&
    a.y + a.h > b.y - slop &&
    a.y < b.y + b.h + slop
  )
}

function pickLine(lines, random = Math.random) {
  if (!Array.isArray(lines) || !lines.length) return ''
  return lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))]
}

/** 捕鱼失败的全部台词：普通失手 + 数落老纪，混在一个池子里随机 */
const FAIL_LINES = [...APOLOGY_LINES, ...BLAME_LINES]

module.exports = {
  FAIL_LINES,
  FISH_BOX,
  rectFromManual,
  FAIL_MIN,
  FAIL_MAX,
  SPEED_SLOW,
  SPEED_FAST,
  SPEED_RECKLESS,
  BRAG_LINES,
  APOLOGY_LINES,
  BLAME_LINES,
  HIDDEN_BLAME_LINES,
  failChance,
  judgeCapture,
  rectsOverlap,
  pickLine,
}
