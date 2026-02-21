import WebSocket from 'ws'
import chalk from 'chalk'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastBtcPrice = null

function startPolymarketChainlinkStream() {
  const ws = new WebSocket('wss://ws-live-data.polymarket.com')

  ws.on('open', () => {
    console.log(chalk.green('✅ RTDS connected (crypto_prices_chainlink)'))
    const sub = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: JSON.stringify({ symbol: 'btc/usd' }),
        },
      ],
    }
    ws.send(JSON.stringify(sub))
  })

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString())
      if (data.topic !== 'crypto_prices_chainlink') return
      if (!data.payload) return
      if (data.payload.symbol !== 'btc/usd') return
      lastBtcPrice = Number(data.payload.value)
    } catch (e) {
      console.error(chalk.red('RTDS parse error:'), e)
    }
  })

  ws.on('close', () => {
    console.log(chalk.yellow('⚠️  RTDS closed, reconnecting in 3s...'))
    setTimeout(startPolymarketChainlinkStream, 3000)
  })

  ws.on('error', (err) => {
    console.error(chalk.red('RTDS error:'), err)
    ws.close()
  })
}

function getCurrent5mTimestamp() {
  const nowSec = Math.floor(Date.now() / 1000)
  const fiveMin = 5 * 60
  return Math.floor(nowSec / fiveMin) * fiveMin
}

async function fetchBtc5mByTimestamp(ts) {
  const url = `https://api.vatic.trading/api/v1/targets/timestamp?asset=btc&type=5min&timestamp=${ts}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }

  const json = await res.json()
  return json
}

function clearConsole() {
  process.stdout.write('\x1Bc')
}

async function main() {
  startPolymarketChainlinkStream()

  while (true) {
    const ts = getCurrent5mTimestamp()
    const tsIso = new Date(ts * 1000).toISOString()

    let vaticData = null
    let targetPrice = null

    try {
      vaticData = await fetchBtc5mByTimestamp(ts)
      targetPrice =
        vaticData.target_price ??
        vaticData.target ??
        vaticData.price ??
        null
    } catch (e) {
      console.error(chalk.red('Vatic API error:'), e)
    }

    clearConsole()

    console.log(chalk.bold.cyan('┌──────────────────────────────────────────────┐'))
    console.log(chalk.bold.cyan('│           BTC 5M MARKET (Polymarket)         │'))
    console.log(chalk.bold.cyan('└──────────────────────────────────────────────┘'))
    console.log()

    console.log(
      chalk.gray('⏱  Current timestamp:'),
      chalk.white(ts),
      chalk.gray('(' + tsIso + ')')
    )

    if (vaticData) {
      console.log(
        chalk.gray('📡 Vatic asset:'),
        chalk.white('BTC')
      )
      console.log(
        chalk.gray('📅 INFO ABOUT MARKET: '),
        chalk.white(vaticData.utc_date || '')
      )
    }

    console.log()

    if (targetPrice !== null) {
      console.log(
        chalk.blueBright('🎯 Target price (5m):'),
        chalk.bold.blue(targetPrice.toString() + " USD")
      )
    } else {
      console.log(
        chalk.yellow('🎯 Target price: ') +
          chalk.reset('check Vatic JSON')
      )
    }

    if (lastBtcPrice !== null) {
      console.log(
        chalk.greenBright('💰 Live BTC price:'),
        chalk.bold.green(lastBtcPrice.toFixed(2)),
        chalk.gray('USD')
      )
    } else {
      console.log(chalk.yellow('⌛ Waiting for RTDS btc/usd price...'))
    }

    console.log()
    console.log(
      chalk.gray('Updated at:'),
      chalk.white(
        new Date().toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    )
    console.log()

    await sleep(1_000)
  }
}

main().catch((e) => {
  console.error(chalk.red('Fatal error:'), e)
  process.exit(1)
})
