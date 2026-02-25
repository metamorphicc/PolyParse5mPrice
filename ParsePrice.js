import WebSocket from 'ws'
import chalk from 'chalk'
import readline from 'readline'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ASSETS = ['btc', 'eth', 'sol', 'xrp']
const TIMEFRAMES = {
  '5m': { seconds: 300, api: '5min' },
  '15m': { seconds: 900, api: '15min' },
  '1h': { seconds: 3600, api: '1h' }
}

let state = {
  asset: 'btc',
  tf: '5m',
  lastPrice: null,
  vaticData: null,
  ws: null,
  isMenuOpen: false,
  apiStatus: 'OK'
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function askQuestion(query, validOptions) {
  while (true) {
    const answer = await new Promise(resolve => rl.question(chalk.yellow(query), resolve))
    const cleanAnswer = answer.toLowerCase().trim()
    if (validOptions.includes(cleanAnswer)) return cleanAnswer
    console.log(chalk.red(`Choose among these ${validOptions.join(', ')}`))
  }
}

async function configure() {
  state.isMenuOpen = true
  console.log(chalk.bold.yellow('\n--- PAUSED FOR CONFIGURATION ---'))
  
  state.asset = await askQuestion(`Choose an asset (${ASSETS.join('/')}): `, ASSETS)
  state.tf = await askQuestion(`Choose timeframe(${Object.keys(TIMEFRAMES).join('/')}): `, Object.keys(TIMEFRAMES))
  
  state.lastPrice = null
  state.vaticData = null
  state.apiStatus = 'OK'
  state.isMenuOpen = false
  
  setupWS()
}

function setupWS() {
  if (state.ws) state.ws.terminate()
  state.ws = new WebSocket('wss://ws-live-data.polymarket.com')
  const symbol = `${state.asset}/usd`

  state.ws.on('open', () => {
    state.ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol }) }]
    }))
  })

  state.ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString())
      if (data.payload?.symbol === symbol) {
        state.lastPrice = Number(data.payload.value)
      }
    } catch (e) {}
  })
}

async function updateVatic() {
  if (state.isMenuOpen) return
  const config = TIMEFRAMES[state.tf]
  const ts = Math.floor((Date.now() / 1000) / config.seconds) * config.seconds
  
  try {
    const url = `https://api.vatic.trading/api/v1/targets/timestamp?asset=${state.asset}&type=${config.api}&timestamp=${ts}`
    const res = await fetch(url)

    if (res.status === 429) {
      state.apiStatus = '429 (Wait...)'
      return
    }

    if (res.ok) {
      state.vaticData = await res.json()
      state.apiStatus = 'OK'
    } else {
      state.apiStatus = `Error ${res.status}`
    }
  } catch (e) {
    state.apiStatus = 'Conn Error'
  }
}

function render() {
  if (state.isMenuOpen) return
  
  const config = TIMEFRAMES[state.tf]
  const ts = Math.floor((Date.now() / 1000) / config.seconds) * config.seconds
  const tsIso = new Date(ts * 1000).toISOString()
  
  process.stdout.write('\x1Bc')
  
  console.log(chalk.bold.cyan('┌──────────────────────────────────────────────┐'))
  console.log(chalk.bold.cyan(`│       ${state.asset.toUpperCase()} ${state.tf.toUpperCase()} MARKET (Polymarket)            │`))
  console.log(chalk.bold.cyan('└──────────────────────────────────────────────┘'))
  console.log()

  console.log(
    chalk.gray('⏱  Current timestamp:'),
    chalk.white(ts),
    chalk.gray('(' + tsIso + ')')
  )

  console.log(chalk.gray('📡 Vatic asset:'), chalk.white(state.asset.toUpperCase()))
  console.log(
    chalk.gray('📅 INFO ABOUT MARKET:'), 
    chalk.white(state.vaticData?.utc_date || (state.apiStatus !== 'OK' ? state.apiStatus : 'Loading...'))
  )

  console.log()

  const target = state.vaticData?.target_price || state.vaticData?.target || state.vaticData?.price
  if (target) {
    console.log(
      chalk.blueBright(`🎯 Target price (${state.tf}):`),
      chalk.bold.blue(target + " USD")
    )
  } else {
    const msg = state.apiStatus === '429 (Wait...)' ? 'API Limit (waiting...)' : 'Fetching Vatic data...'
    console.log(chalk.yellow(`🎯 Target price: `) + chalk.reset(msg))
  }

  if (state.lastPrice !== null) {
    console.log(
      chalk.greenBright('💰 Live BTC price:'),
      chalk.bold.green(state.lastPrice.toFixed(2)),
      chalk.gray('USD')
    )
  } else {
    console.log(chalk.yellow('⌛ Waiting for RTDS price...'))
  }

  console.log()
  
  console.log(
    chalk.gray('Updated at:'),
    chalk.white(new Date().toLocaleString('ru-RU'))
  )
  
}

async function main() {
  await configure()
  setInterval(updateVatic, 5000)
  setInterval(render, 1000)
}

main().catch(console.error)