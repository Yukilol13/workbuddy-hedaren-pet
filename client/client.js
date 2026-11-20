// 和大人府邸 —— DSH 设置页里的一个栏目（settings.section）
// 把桌宠的所有可调项都收在这里：显示开关、甩飞阈值、亏空阈值、对话模型、余额来源。
// 数据来自宿主插件的 /hedaren-pet/settings（同源，读改写都走它）。
window.__ModuleLoader__.load({
  id: 'dsh-hedaren-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const box = {
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      padding: '4px 2px 18px',
      color: 'inherit',
      fontSize: '13px',
      lineHeight: 1.6,
    }
    const row = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
    const label = { flex: '0 0 96px', opacity: 0.72 }
    const hint = { opacity: 0.55, fontSize: '12px', margin: 0 }
    const card = {
      border: '1px solid rgba(127,127,127,.28)',
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }
    const input = {
      background: 'rgba(127,127,127,.12)',
      color: 'inherit',
      border: '1px solid rgba(127,127,127,.32)',
      borderRadius: '8px',
      padding: '4px 8px',
      fontSize: '13px',
      minWidth: '0',
    }
    const title = { fontSize: '15px', fontWeight: 600, margin: 0 }
    const miniBtn = {
      background: 'rgba(127,127,127,.14)',
      color: 'inherit',
      border: '1px solid rgba(127,127,127,.3)',
      borderRadius: '8px',
      padding: '3px 10px',
      fontSize: '12px',
      cursor: 'pointer',
    }

    async function call(patch) {
      const res = await fetch('/hedaren-pet/settings', {
        method: patch ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: patch ? { 'content-type': 'application/json' } : undefined,
        body: patch ? JSON.stringify(patch) : undefined,
      })
      return res.json()
    }

    function Field(props) {
      return h('div', { style: row }, h('span', { style: label }, props.name), props.children)
    }

    function HedarenSettings() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [refreshedAt, setRefreshedAt] = React.useState(0)

      const [diary, setDiary] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [burnNote, setBurnNote] = React.useState('')
      const [expanded, setExpanded] = React.useState([])

      // 自动刷新：stamp 没变就不重画；皇上正拖着滑块时先按住不动
      const stampRef = React.useRef('')
      const diaryStampRef = React.useRef('')
      const modelRef = React.useRef('')
      const holdRef = React.useRef(0)
      const hold = (ms = 2500) => {
        holdRef.current = Date.now() + ms
      }

      const apply = React.useCallback((payload) => {
        if (payload && payload.ok && payload.settings) setData(payload.settings)
        else setError((payload && payload.message) || '设置读不出来')
      }, [])

      const mergeLive = React.useCallback((live) => {
        if (!live) return
        setData((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            ...live,
            balance: { ...(prev.balance || {}), ...(live.balance || {}) },
            treasury: { ...(prev.treasury || {}), ...(live.treasury || {}) },
            mood: { ...(prev.mood || {}), ...(live.mood || {}) },
            models: prev.models,
          }
        })
        setRefreshedAt(Date.now())
      }, [])

      const loadDiary = React.useCallback(async () => {
        try {
          const res = await fetch('/hedaren-pet/diary', { credentials: 'same-origin', cache: 'no-store' })
          const payload = await res.json()
          if (payload && payload.ok) setDiary(payload.diary)
          else setError((payload && payload.message) || '日记读不出来')
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        call()
          .then((payload) => {
            if (alive) apply(payload)
          })
          .catch((err) => {
            if (alive) setError(String((err && err.message) || err))
          })
        void loadDiary()
        return () => {
          alive = false
        }
      }, [apply, loadDiary])

      // 每 1.5 秒问一次轻量快照：颤栗值、官位、日记、国库、资产、捕鱼数一变就重画
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive || Date.now() < holdRef.current) return
          try {
            const res = await fetch('/hedaren-pet/live', { credentials: 'same-origin', cache: 'no-store' })
            const payload = await res.json()
            if (!alive || !payload || !payload.ok) return
            const stamp = String(payload.stamp || '')
            const diaryStamp = String(payload.diaryStamp || '')
            const stampChanged = stamp && stamp !== stampRef.current
            const diaryChanged = diaryStamp && diaryStamp !== diaryStampRef.current
            if (!stampChanged && !diaryChanged) return
            if (Date.now() < holdRef.current) return
            stampRef.current = stamp
            if (stampChanged) {
              // 模型换了要连清单一起重取，不然面板上只剩一个 id
              const nextModel = (payload.settings && payload.settings.chatModel) || ''
              if (modelRef.current && nextModel && nextModel !== modelRef.current) {
                try {
                  apply(await call())
                } catch {
                  /* 取不到清单就先用轻量快照顶着 */
                }
              }
              modelRef.current = nextModel
              mergeLive(payload.settings)
            }
            if (diaryChanged) {
              diaryStampRef.current = diaryStamp
              void loadDiary()
            }
          } catch {
            /* 轮询失败就当这一拍没发生，下一拍再来 */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [apply, loadDiary, mergeLive])

      const refresh = React.useCallback(async () => {
        hold(1500)
        setBusy(true)
        setError('')
        setSaved('')
        try {
          const payload = await call()
          apply(payload)
          await loadDiary()
          diaryStampRef.current = ''
          setRefreshedAt(Date.now())
          if (payload && payload.ok) setSaved('账本重抄了一遍')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [apply, loadDiary])

      const save = React.useCallback(
        async (patch, note) => {
          hold(1800)
          setError('')
          setSaved('')
          try {
            const payload = await call(patch)
            apply(payload)
            setRefreshedAt(Date.now())
            if (payload && payload.ok) setSaved(note || '已保存')
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        },
        [apply],
      )

      if (!data) {
        return h('div', { style: box }, h('p', { style: hint }, error || '正在查和大人府邸的账本……'))
      }

      const models = Array.isArray(data.models) ? data.models : []
      const balance = data.balance || {}
      const sources = Array.isArray(balance.sources) ? balance.sources : []
      const house = data.treasury || {}

      const formatAt = (ms) => {
        const t = Number(ms)
        if (!t) return '—'
        const d = new Date(t)
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
      const formatClock = (ms) => {
        const t = Number(ms)
        if (!t) return '—'
        const d = new Date(t)
        const pad = (n) => String(n).padStart(2, '0')
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      }
      const money = (value) => {
        const v = Number(value)
        if (!Number.isFinite(v)) return '—'
        return `${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 积分`
      }
      const stat = (name, value, note) =>
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '104px' } },
          h('span', { style: hint }, name),
          h('span', { style: { fontSize: '17px', fontWeight: 600 } }, value),
          note ? h('span', { style: hint }, note) : null,
        )

      const burnPicked = async () => {
        if (!picked.length) return
        const ok =
          typeof window === 'undefined' || typeof window.confirm !== 'function'
            ? true
            : window.confirm(`烧了这 ${picked.length} 本？火一过可就没了，奴才不能给您再造一本。`)
        if (!ok) return
        setBurnNote('')
        try {
          const res = await fetch('/hedaren-pet/diary', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ burn: picked }),
          })
          const payload = await res.json()
          if (payload && payload.ok) {
            setDiary(payload.diary)
            setBurnNote(`烧了 ${(payload.burned?.burned || []).length} 本，架上还剩 ${payload.burned?.left ?? '?'} 本`)
            setPicked([])
          } else {
            setError((payload && payload.message) || '焚毁失败')
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }

      const diaryStats = diary && diary.stats ? diary.stats : null
      const diaryFiles = diary && Array.isArray(diary.files) ? diary.files : []
      const diaryMain = diaryFiles.find((f) => f.id === 'main') || null
      const diaryShards = diaryFiles.filter((f) => f.id !== 'main')

      const toggleExpand = (id) =>
        setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

      const diaryBlock = h(
        'div',
        { style: card },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '15px', fontWeight: 600 } }, '和大人日记'),
          h('span', { style: hint }, '奴才行文誊在纸上，一笔一笔的，改不得；瞧着碍眼的，只能点了火'),
        ),
        !diaryStats
          ? h('p', { style: hint }, '奴才正翻箱倒柜找账本……')
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              h(
                'div',
                { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', ...hint } },
                h('span', null, `拢共 ${diaryStats.files} 本册子`),
                h('span', null, `${diaryStats.entries} 笔旧账`),
                h('span', null, `约 ${diaryStats.tokens} tokens 的墨`),
                h('span', null, `纸重 ${Math.round((diaryStats.bytes || 0) / 102.4) / 10} KB`),
                h(
                  'span',
                  null,
                  Object.entries(diaryStats.byCat || {})
                    .map(([cat, n]) => `${cat} ${n} 本`)
                    .join(' · ') || '还没分门类',
                ),
                h('span', null, `最近一笔 ${formatAt(diaryStats.newestAt)}`),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...miniBtn, opacity: diaryShards.length ? 1 : 0.45 },
                    disabled: !diaryShards.length,
                    onClick: () => setPicked(diaryShards.map((f) => f.id)),
                  },
                  '全勾上',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...miniBtn, opacity: picked.length ? 1 : 0.45 },
                    disabled: !picked.length,
                    onClick: () => setPicked([]),
                  },
                  '都不勾',
                ),
                h('span', { style: hint }, `勾了 ${picked.length} 本`),
                h(
                  'button',
                  {
                    type: 'button',
                    style: {
                      ...miniBtn,
                      borderColor: picked.length ? 'rgba(220,90,70,.75)' : 'rgba(127,127,127,.3)',
                      color: picked.length ? '#ff9a8a' : 'inherit',
                      opacity: picked.length ? 1 : 0.45,
                    },
                    disabled: !picked.length,
                    onClick: () => void burnPicked(),
                  },
                  '烧了这几本',
                ),
                burnNote ? h('span', { style: hint }, burnNote) : null,
              ),
              // 主账单独在上：只能翻开看，不能烧
              diaryMain
                ? h(
                    'div',
                    {
                      style: {
                        border: '1px solid rgba(127,127,127,.3)',
                        borderRadius: '9px',
                        padding: '9px 11px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' } },
                      h('span', { style: { fontSize: '13.5px', fontWeight: 600 } }, '主账 · 奴才的底细'),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: miniBtn,
                          onClick: () => toggleExpand('main'),
                        },
                        expanded.includes('main') ? '收起来' : '翻开看',
                      ),
                    ),
                    h(
                      'span',
                      { style: hint },
                      `${diaryMain.profile} 条画像 · ${diaryMain.items} 笔旧事 · ${diaryMain.tokens} tokens · 这本是奴才认出皇上、记得自己是谁的底账，烧不得`,
                    ),
                    h(
                      'div',
                      {
                        style: {
                          display: expanded.includes('main') ? 'flex' : 'none',
                          flexDirection: 'column',
                          gap: '3px',
                          maxHeight: '240px',
                          overflowY: 'auto',
                          fontSize: '12px',
                          lineHeight: 1.6,
                          whiteSpace: 'pre-wrap',
                          opacity: 0.9,
                        },
                      },
                      (diaryMain.lines || []).length
                        ? (diaryMain.lines || []).join('\n')
                        : '底账还空着，皇上多问几句，奴才才有的记。',
                    ),
                  )
                : null,
              diaryShards.length
                ? h(
                    'div',
                    {
                      style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(212px, 1fr))',
                        gap: '8px',
                        maxHeight: '420px',
                        overflowY: 'auto',
                        paddingRight: '4px',
                      },
                    },
                    ...diaryShards.map((file) => {
                      const on = picked.includes(file.id)
                      const open = expanded.includes(file.id)
                      return h(
                        'div',
                        {
                          key: file.id,
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '5px',
                            borderRadius: '9px',
                            padding: '9px 10px',
                            border: `1px solid ${on ? 'rgba(212,175,55,.8)' : 'rgba(127,127,127,.26)'}`,
                            background: on ? 'rgba(212,175,55,.16)' : 'transparent',
                          },
                        },
                        h(
                          'div',
                          { style: { display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'baseline' } },
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () =>
                                setPicked((prev) =>
                                  prev.includes(file.id) ? prev.filter((x) => x !== file.id) : [...prev, file.id],
                                ),
                              title: on ? '点一下就不勾了' : '点一下勾上，等着烧',
                              style: {
                                background: 'transparent',
                                border: 0,
                                color: 'inherit',
                                font: 'inherit',
                                cursor: 'pointer',
                                padding: 0,
                                textAlign: 'left',
                              },
                            },
                            h('span', { style: { fontSize: '13.5px', fontWeight: 600 } }, `${on ? '☑ ' : '☐ '}${file.name}`),
                          ),
                          h('span', { style: hint }, file.cat),
                        ),
                        h(
                          'span',
                          { style: hint },
                          `${file.items} 笔 · ${file.tokens} tokens · 纸重 ${Math.round((file.bytes || 0) / 102.4) / 10} KB`,
                        ),
                        h('span', { style: hint }, `末笔 ${formatAt(file.updatedAt)}`),
                        h(
                          'div',
                          {
                            style: {
                              fontSize: '12px',
                              lineHeight: 1.5,
                              display: '-webkit-box',
                              WebkitLineClamp: open ? 'unset' : 3,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              whiteSpace: 'pre-wrap',
                              opacity: 0.88,
                              maxHeight: open ? '220px' : undefined,
                              overflowY: open ? 'auto' : 'hidden',
                            },
                          },
                          (file.lines && file.lines.length ? file.lines : file.preview || []).join('\n') ||
                            '这本还没落下字。',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: { ...miniBtn, alignSelf: 'flex-start', padding: '2px 9px' },
                            onClick: () => toggleExpand(file.id),
                          },
                          open ? '收起来' : '展开全文',
                        ),
                      )
                    }),
                  )
                : h('p', { style: hint }, '散账还没誊——皇上多跟奴才说几句，奴才才有得记。'),
            ),
        h(
          'p',
          { style: hint },
          '奴才的规矩：纸上落笔就不涂改，抄错了宁可重抄；皇上瞧不过眼的，点了火整本烧了便是——只是主账那本烧不得，烧了奴才可就记不得您了。',
        ),
      )

      return h(
        'div',
        { style: box },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
          h('h3', { style: title }, '和大人府邸'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h(
              'span',
              { style: hint },
              refreshedAt ? `账本翻到 ${formatClock(refreshedAt)} · 有变动自己会翻页` : '正盯着账本……',
            ),
            h(
              'button',
              { type: 'button', style: { ...miniBtn, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: () => void refresh() },
              busy ? '正在重抄…' : '刷新',
            ),
          ),
        ),
        h('p', { style: hint }, '奴才的府上：皇上要奴才见人还是躲着、个头多高、甩得多远、亏空多少就把奴才关进牢房、跟您说话使哪个脑子——都在这儿吩咐。'),

        h(
          'div',
          { style: card },
          h(
            Field,
            { name: '桌宠显示' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(data.visible),
              onChange: (e) => void save({ visible: e.target.checked }, e.target.checked ? '已叫回和大人' : '已把和大人收起来'),
            }),
            h('span', { style: hint }, data.visible ? '奴才这会儿就在皇上桌面上候着' : '奴才缩在府里没敢露面'),
          ),
          h(
            Field,
            { name: '大小' },
            h('input', {
              type: 'range',
              min: 70,
              max: 150,
              step: 5,
              value: Math.round((Number(data.scale) || 1) * 100),
              style: { flex: '1 1 160px' },
              onChange: (e) => {
                hold(2500)
                apply({ ok: true, settings: { ...data, scale: Number(e.target.value) / 100 } })
              },
              onMouseUp: (e) => void save({ scale: Number(e.currentTarget.value) / 100 }),
              onTouchEnd: (e) => void save({ scale: Number(e.currentTarget.value) / 100 }),
            }),
            h('span', { style: { minWidth: '52px' } }, `${Math.round((Number(data.scale) || 1) * 100)}%`),
          ),
          h(
            Field,
            { name: '甩飞阈值' },
            h('input', {
              type: 'range',
              min: 50,
              max: 500,
              step: 10,
              value: Number(data.throwSettleMs) || 50,
              style: { flex: '1 1 160px' },
              onChange: (e) => {
                hold(2500)
                apply({ ok: true, settings: { ...data, throwSettleMs: Number(e.target.value) } })
              },
              onMouseUp: (e) => void save({ throwSettleMs: Number(e.target.value) }),
              onTouchEnd: (e) => void save({ throwSettleMs: Number(e.currentTarget.value) }),
            }),
            h('span', { style: { minWidth: '52px' } }, `${Number(data.throwSettleMs) || 50} ms`),
            h('p', { style: hint }, '松手前静止超过这么久才甩出去；越小越灵敏。'),
          ),
          h(
            Field,
            { name: '亏空阈值' },
            h('input', {
              type: 'number',
              min: 0,
              max: 10000,
              step: 0.01,
              value: Number(data.jailThreshold) || 0,
              style: { ...input, width: '110px' },
              onChange: (e) => {
                hold(2500)
                apply({ ok: true, settings: { ...data, jailThreshold: Number(e.target.value) } })
              },
              onBlur: (e) => void save({ jailThreshold: Number(e.target.value) }, '阈值已改'),
            }),
            h('span', { style: hint }, '余额低于这个数就进牢房（0 = 不关）'),
          ),
        ),

        h(
          'div',
          { style: card },
          h(
            Field,
            { name: '对话模型' },
            h(
              'span',
              { style: { flex: '1 1 220px' } },
              (() => {
                const hit = models.find((m) => m.id === data.chatModel)
                return hit ? `${hit.providerName} · ${hit.name}` : data.chatModel || '（还没选）'
              })(),
            ),
          ),
          h(
            'p',
            { style: hint },
            '这里只显示当前用的模型。要换模型请在「与和大人说话」窗口顶部那个下拉里选——选完立刻生效，下次也记得。',
          ),
        ),

        h(
          'div',
          { style: card },
          h('span', { style: { opacity: 0.72 } }, '和珅的胆气与官位'),
          (() => {
            const mood = data.mood || {}
            const left =
              mood.state && mood.state !== 'normal'
                ? ` · 再熬 ${mood.stateTurnsLeft} 句 / ${Math.ceil((mood.stateMsLeft || 0) / 1000)} 口气就缓过来`
                : ''
            return h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                h('span', { style: { fontSize: '18px', fontWeight: 600 } }, mood.trembleLabel || '—'),
                h('span', { style: hint }, `/ 10 颤栗值 · 奴才这会儿${mood.stateLabel || '还算稳当'}${left}`),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                h('span', { style: { fontSize: '15px', fontWeight: 600 } }, mood.rankLabel || '—'),
                h('span', { style: hint }, '皇上赏的官位（一品是百官之首，九品是刚入流）'),
              ),
            )
          })(),
          h(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                style: {
                  background: 'rgba(127,127,127,.16)',
                  color: 'inherit',
                  border: '1px solid rgba(127,127,127,.35)',
                  borderRadius: '8px',
                  padding: '4px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                },
                onClick: () => void save({ resetMood: true }, '奴才把心气收回原样了'),
              },
              '把心气归回原样',
            ),
            h('span', { style: hint }, '颤栗值回五分、官位回一品，吓破的胆和乐上头一并散了'),
          ),
          h(
            'p',
            { style: hint },
            '皇上骂奴才、盘问奴才，奴才腿肚子就转筋；皇上赏奴才、疼奴才，奴才心里就松快。松快到零，奴才就飘得没边儿；紧到十分，奴才只剩下磕头。挨两句狠的（打入死牢、即刻问斩这种），奴才当场吓破胆；连着赏两回大的（黄马褂、黄金万两），奴才乐得找不着北。没头没脑的闲话，奴才自己会慢慢缓回常态。',
          ),
        ),

        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '15px', fontWeight: 600 } }, '和珅的家底'),
            h('span', { style: hint }, '国库的银子奴才不敢动，抽的这点碎银、网住的鱼，都记在这儿'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '22px', flexWrap: 'wrap' } },
            stat(
              '国库余额',
              house.guoku === null || house.guoku === undefined
                ? balance.amount === null || balance.amount === undefined
                  ? '还没查到'
                  : money(balance.amount)
                : money(house.guoku),
              balance.label ? `来自 ${balance.label}` : '还没查着来路',
            ),
            stat('和大人资产', Number.isFinite(Number(house.assets)) ? money(house.assets) : '—', '从国库积分里抽出来的'),
            stat('累计抽成', Number.isFinite(Number(house.totalSiphoned)) ? money(house.totalSiphoned) : '—', '一笔一笔攒的'),
            stat(
              '捕鱼数量',
              `${Number(house.fish) || 0} 条`,
              house.fishAt ? `最近一条 ${formatAt(house.fishAt)}${house.fishSpeed ? ` · ${house.fishSpeed}px/s` : ''}` : '还没网着过',
            ),
          ),
          h(
            'p',
            { style: hint },
            '国库余额' +
              (house.lastBalanceAt ? `查于 ${formatAt(house.lastBalanceAt)}；` : '；') +
              '能查到外部 api/plan 的余额就先报它（OpenRouter / 月之暗面），查不到才报 DeepSeek。当前已配置：' +
              (sources.filter((s) => s.configured).map((s) => s.label).join('、') || '无'),
          ),
        ),

        diaryBlock,


        error ? h('p', { style: { ...hint, color: '#e06c75' } }, error) : null,
        saved ? h('p', { style: hint }, saved) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register
          ? ctx.slots.register(
              { name: 'settings.section', id: 'hedaren-pet', order: 31, label: '和大人府邸' },
              HedarenSettings,
            )
          : undefined)
      },
    }
  },
})
