
import WebSocket from 'ws'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import readline from 'readline'


const ASSETS = ['btc', 'eth', 'sol', 'xrp']
const TIMEFRAMES = {
  '5m':  { seconds: 300,  api: '5min' },
  '15m': { seconds: 900,  api: '15min' },
  '1h':  { seconds: 3600, api: '1h' }
}

const COLORS = {
  border:    '#1e3a5f',
  accent:    '#00e5ff',
  purple:    '#b388ff',
  green:     '#69ff47',
  red:       '#ff5252',
  yellow:    '#ffd740',
  gray:      '#546e7a',
  text:      '#eceff1'
}


let state = {
  asset: 'btc',
  tf: '5m',

  lastPrice: null,
  vaticData: null,
  apiStatus: 'OK',

  ws: null,

  priceHistory: [],       
  volumeHistory: [],      

  beliefUp: 0.5,
  marketProb: null,
  edge: null,


  rsi14: null,
  ema5: null,
  ema20: null,
  vwap: null,
  macd: null,
  macdSignal: null,
  macdHist: null,

  // signals
  signals: [],
  trendScore: 0
}



const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function ask(prompt, valid) {
  while (true) {
    const a = await new Promise(r => rl.question(prompt, r))
    const c = a.toLowerCase().trim()
    if (valid.includes(c)) return c
    console.log(`Choose among: ${valid.join(', ')}`)
  }
}

function getTimeConfig() { return TIMEFRAMES[state.tf] }

function getTarget() {
  if (!state.vaticData) return null
  const t = state.vaticData.target_price ??
            state.vaticData.target ??
            state.vaticData.price
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function sigmaProb(price, target) {
  const rel = (price - target) / target
  const p   = 1 / (1 + Math.exp(-8 * rel))
  return Math.min(0.98, Math.max(0.02, p))
}



function calcEMA(prices, period) {
  if (prices.length < period) return null
  const k   = 2 / (period + 1)
  let ema   = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }
  return ema
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null
  const slice = prices.slice(-(period + 1))
  let gains = 0, losses = 0
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1]
    if (diff >= 0) gains  += diff
    else           losses -= diff
  }
  const avgGain = gains  / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

function calcVWAP(prices, vols) {
  if (prices.length === 0) return null
  const len = Math.min(prices.length, vols.length)
  let totalPV = 0, totalV = 0
  for (let i = 0; i < len; i++) {
    totalPV += prices[i] * vols[i]
    totalV  += vols[i]
  }
  return totalV === 0 ? null : totalPV / totalV
}

function calcMACD(prices) {
  if (prices.length < 26) return { macd: null, signal: null, hist: null }
  const ema12 = calcEMA(prices, 12)
  const ema26 = calcEMA(prices, 26)
  if (ema12 == null || ema26 == null) return { macd: null, signal: null, hist: null }

  const macdLine = ema12 - ema26


  const signal = macdLine * 0.9  
  const hist   = macdLine - signal

  return { macd: macdLine, signal, hist }
}

function updateIndicators() {
  const prices = state.priceHistory
  const vols   = state.volumeHistory

  state.ema5      = calcEMA(prices, 5)
  state.ema20     = calcEMA(prices, 20)
  state.rsi14     = calcRSI(prices, 14)
  state.vwap      = calcVWAP(prices, vols)

  const m         = calcMACD(prices)
  state.macd      = m.macd
  state.macdSignal= m.signal
  state.macdHist  = m.hist
}


function updateSignals() {
  const signals = []
  let score = 0

  const target = getTarget()
  const price  = state.lastPrice

  if (price == null || target == null) {
    state.signals    = []
    state.trendScore = 0
    return
  }

  if (state.ema5 != null && state.ema20 != null) {
    if (state.ema5 > state.ema20) {
      signals.push({ text: 'EMA 5 > EMA 20 → bullish cross', bull: true })
      score += 1
    } else {
      signals.push({ text: 'EMA 5 < EMA 20 → death cross', bull: false })
      score -= 1
    }
  }

  if (state.rsi14 != null) {
    if (state.rsi14 < 30) {
      signals.push({ text: `RSI ${state.rsi14.toFixed(1)} → oversold`, bull: true })
      score += 1
    } else if (state.rsi14 > 70) {
      signals.push({ text: `RSI ${state.rsi14.toFixed(1)} → overbought`, bull: false })
      score -= 1
    } else {
      signals.push({ text: `RSI ${state.rsi14.toFixed(1)} → neutral`, bull: null })
    }
  }

  if (state.vwap != null) {
    if (price > state.vwap) {
      signals.push({ text: `Price above VWAP (${state.vwap.toFixed(2)})`, bull: true })
      score += 1
    } else {
      signals.push({ text: `Price below VWAP (${state.vwap.toFixed(2)})`, bull: false })
      score -= 1
    }
  }

  if (state.macdHist != null) {
    if (state.macdHist > 0) {
      signals.push({ text: 'MACD hist → bullish', bull: true })
      score += 1
    } else {
      signals.push({ text: 'MACD hist → bearish', bull: false })
      score -= 1
    }
  }

  if (price > target) {
    signals.push({ text: `Price above target (${target.toFixed(2)})`, bull: true })
    score += 1
  } else {
    signals.push({ text: `Price below target (${target.toFixed(2)})`, bull: false })
    score -= 1
  }

  if (state.beliefUp > 0.6) {
    signals.push({ text: `Belief UP (${(state.beliefUp * 100).toFixed(1)} %)`, bull: true })
    score += 1
  } else if (state.beliefUp < 0.4) {
    signals.push({ text: `Belief DOWN (${(state.beliefUp * 100).toFixed(1)} %)`, bull: false })
    score -= 1
  }

  if (state.edge != null) {
    if (state.edge > 0.05) {
      signals.push({ text: `Edge +${state.edge.toFixed(3)} → long bias`, bull: true })
      score += 1
    } else if (state.edge < -0.05) {
      signals.push({ text: `Edge ${state.edge.toFixed(3)} → short bias`, bull: false })
      score -= 1
    }
  }

  state.signals    = signals
  state.trendScore = score
}


async function configureInitial() {
  console.clear()
  console.log('Polymarket Bayes TUI v2 setup\n')
  state.asset = await ask(`Asset (${ASSETS.join('/')}): `, ASSETS)
  state.tf    = await ask(`Timeframe (${Object.keys(TIMEFRAMES).join('/')}): `, Object.keys(TIMEFRAMES))
  Object.assign(state, {
    lastPrice: null, vaticData: null, apiStatus: 'OK',
    beliefUp: 0.5, marketProb: null, edge: null,
    priceHistory: [], volumeHistory: [],
    rsi14: null, ema5: null, ema20: null,
    vwap: null, macd: null, macdSignal: null, macdHist: null,
    signals: [], trendScore: 0
  })
}

function setupWS() {
  if (state.ws) state.ws.terminate()

  const symbol = `${state.asset}/usd`
  state.ws = new WebSocket('wss://ws-live-data.polymarket.com')

  state.ws.on('open', () => {
    state.ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol })
      }]
    }))
  })

  state.ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString())
      if (data.payload?.symbol === symbol) {
        const price = Number(data.payload.value)
        if (!Number.isNaN(price)) {
          const prevPrice = state.lastPrice ?? price
          const pseudoVol = Math.abs(price - prevPrice)

          state.lastPrice = price
          state.priceHistory.push(price)
          state.volumeHistory.push(pseudoVol + 0.01)
          if (state.priceHistory.length > 200) {
            state.priceHistory.shift()
            state.volumeHistory.shift()
          }

          updateBeliefFromPrice()
          updateMarketProb()
          updateIndicators()
          updateSignals()
        }
      }
    } catch {}
  })

  state.ws.on('close', () => setTimeout(setupWS, 3000))
  state.ws.on('error', () => {})
}

async function updateVatic() {
  const cfg = getTimeConfig()
  const ts  = Math.floor(Date.now() / 1000 / cfg.seconds) * cfg.seconds
  try {
    const url = `https://api.vatic.trading/api/v1/targets/timestamp?asset=${state.asset}&type=${cfg.api}&timestamp=${ts}`
    const res = await fetch(url)
    if (res.status === 429) { state.apiStatus = '429 (Wait...)'; return }
    if (res.ok) {
      state.vaticData = await res.json()
      state.apiStatus = 'OK'
      updateMarketProb()
      updateSignals()
    } else {
      state.apiStatus = `Error ${res.status}`
    }
  } catch { state.apiStatus = 'Conn Error' }
}


function updateBeliefFromPrice() {
  if (!state.vaticData || state.lastPrice == null) return
  const target = getTarget()
  if (!target) return
  const diff  = (state.lastPrice - target) / target
  const delta = Math.max(-0.1, Math.min(0.1, diff * 0.02))
  const eps   = 1e-6
  const p0    = Math.min(1 - eps, Math.max(eps, state.beliefUp))
  const l     = Math.log(p0 / (1 - p0)) + delta
  state.beliefUp = 1 / (1 + Math.exp(-l))
  updateEdge()
}

function updateMarketProb() {
  if (!state.vaticData || state.lastPrice == null) return
  const target = getTarget()
  if (!target) return
  state.marketProb = sigmaProb(state.lastPrice, target)
  updateEdge()
}

function updateEdge() {
  state.edge = state.marketProb == null
    ? null
    : state.beliefUp - state.marketProb
}


let screen, grid
let headerBox, marketBox, analyticsBox, techBox, signalsBox

function setupTUI() {
  screen = blessed.screen({ smartCSR: true, title: 'Polymarket Bayes Desk' })

  grid = new contrib.grid({ rows: 12, cols: 12, screen })

  headerBox = grid.set(0, 0, 2, 12, blessed.box, {
    tags: true,
    style: { fg: COLORS.text, bg: 'black' }
  })

  marketBox = grid.set(2, 0, 5, 4, blessed.box, {
    label: ' MARKET ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: COLORS.text,
      border: { fg: COLORS.accent },
      label: { fg: COLORS.accent }
    }
  })

  techBox = grid.set(7, 0, 5, 4, blessed.box, {
    label: ' TECHNICAL ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: COLORS.text,
      border: { fg: COLORS.yellow },
      label: { fg: COLORS.yellow }
    }
  })

  analyticsBox = grid.set(2, 4, 5, 8, blessed.box, {
    label: ' BAYES ANALYTICS ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: COLORS.text,
      border: { fg: COLORS.purple },
      label: { fg: COLORS.purple }
    }
  })

  signalsBox = grid.set(7, 4, 5, 8, blessed.box, {
    label: ' SIGNALS ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: COLORS.text,
      border: { fg: COLORS.green },
      label: { fg: COLORS.green }
    }
  })

  screen.key(['q', 'C-c'], () => process.exit(0))
}


function col(text, color) {
  return `{${color}-fg}${text}{/${color}-fg}`
}

function renderHeader() {
  const cfg   = getTimeConfig()
  const ts    = Math.floor(Date.now() / 1000 / cfg.seconds) * cfg.seconds
  const tsIso = new Date(ts * 1000).toISOString()
  const sc    = state.apiStatus === 'OK' ? 'green' : 'red'

  headerBox.setContent(
    `{bold}${col('POLYMARKET BAYES DESK', '#00e5ff')}  ` +
    `${state.asset.toUpperCase()} ${state.tf.toUpperCase()}{/bold}  ` +
    `| ${col('Slice:', 'white')} ${tsIso}  ` +
    `| Vatic: {${sc}-fg}${state.apiStatus}{/${sc}-fg}`
  )
}

function renderMarketBox() {
  const target = getTarget()
  const lines  = []

  if (state.lastPrice != null) {
    lines.push(`${col('Spot:', 'white')}   ${col(state.lastPrice.toFixed(2) + ' USD', '#69ff47')}`)
  } else {
    lines.push(col('Spot: waiting for WS...', '#ffd740'))
  }

  if (target) {
    lines.push(`${col('Target:', 'white')}  ${col(target.toFixed(2) + ' USD', '#00e5ff')}`)
    if (state.lastPrice != null) {
      const rel = (state.lastPrice - target) / target * 100
      const dir = rel >= 0 ? '+' : ''
      const c   = rel >= 0 ? '#69ff47' : '#ff5252'
      lines.push(`${col('Δ target:', 'white')} ${col(dir + rel.toFixed(2) + ' %', c)}`)
    }
  } else {
    lines.push(col('Target: loading from Vatic...', '#ffd740'))
  }

  if (state.marketProb != null) {
    lines.push('')
    lines.push(`${col('Market prob:', 'white')} ${col((state.marketProb * 100).toFixed(1) + ' %', '#00e5ff')}`)
  }

  marketBox.setContent(lines.join('\n'))
}

function renderTechBox() {
  const lines = []

  const fmt = (label, val, unit = '', color = 'white') => {
    const v = val != null ? col(Number(val).toFixed(2) + unit, color) : col('...', '#546e7a')
    return `${col(label, '#546e7a')} ${v}`
  }

  let rsiColor = 'white'
  if (state.rsi14 != null) {
    rsiColor = state.rsi14 < 30 ? '#69ff47' : state.rsi14 > 70 ? '#ff5252' : '#ffd740'
  }

  lines.push(fmt('RSI(14)', state.rsi14, '', rsiColor))
  lines.push(fmt('EMA 5  ', state.ema5, ' USD'))
  lines.push(fmt('EMA 20 ', state.ema20, ' USD'))
  lines.push(fmt('VWAP   ', state.vwap, ' USD'))

  if (state.macd != null) {
    const hc = state.macdHist >= 0 ? '#69ff47' : '#ff5252'
    lines.push(`${col('MACD   ', '#546e7a')} ${col(state.macd.toFixed(2), 'white')} hist: ${col(state.macdHist.toFixed(2), hc)}`)
  } else {
    lines.push(`${col('MACD   ', '#546e7a')} ${col('...', '#546e7a')}`)
  }

  techBox.setContent(lines.join('\n'))
}

function renderAnalyticsBox() {
  const lines = []

  lines.push(`${col('Belief P(up):', 'white')}  ${col((state.beliefUp * 100).toFixed(1) + ' %', '#b388ff')}`)

  if (state.marketProb != null) {
    lines.push(`${col('Market prob: ', 'white')} ${col((state.marketProb * 100).toFixed(1) + ' %', '#00e5ff')}`)
  } else {
    lines.push(col('Market prob: waiting...', '#546e7a'))
  }

  lines.push('')

  if (state.edge != null) {
    const sign  = state.edge >= 0 ? '+' : ''
    const edgeC = state.edge >= 0 ? '#69ff47' : '#ff5252'
    lines.push(`${col('Edge (EV per 1$):', 'white')} ${col(sign + state.edge.toFixed(3), edgeC)}`)
  } else {
    lines.push(col('Edge: need market prob', '#546e7a'))
  }

  analyticsBox.setContent(lines.join('\n'))
}

function renderSignalsBox() {
  const lines = []

  for (const s of state.signals) {
    const c = s.bull === true ? '#69ff47' : s.bull === false ? '#ff5252' : '#546e7a'
    lines.push(col('• ' + s.text, c))
  }

  if (lines.length === 0) {
    lines.push(col('Waiting for data...', '#546e7a'))
  }

  lines.push('')

  const score = state.trendScore
  const maxS  = 7
  const clamp = Math.max(-maxS, Math.min(maxS, score))
  const abs   = Math.abs(clamp)
  const fill  = '█'.repeat(abs)
  const empty = '░'.repeat(maxS - abs)
  const barC  = clamp >= 0 ? '#69ff47' : '#ff5252'
  const label = clamp >= 0 ? 'BULLISH' : 'BEARISH'

  lines.push(
    `${col('TREND:', 'white')} ${col(label, barC)}  ` +
    `${col(fill, barC)}${col(empty, '#546e7a')} ` +
    `${col(String(clamp), barC)}`
  )

  signalsBox.setContent(lines.join('\n'))
}

function render() {
  renderHeader()
  renderMarketBox()
  renderTechBox()
  renderAnalyticsBox()
  renderSignalsBox()
  screen.render()
}


async function main() {
  await configureInitial()
  setupTUI()
  setupWS()
  setInterval(updateVatic, 5000)
  setInterval(render, 500)
}

main().catch(console.error)
