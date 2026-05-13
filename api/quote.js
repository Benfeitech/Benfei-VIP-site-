const cheerio = require('cheerio')

const CACHE_TTL = 5 * 60 * 1000

globalThis.__QUOTE_CACHE__ = globalThis.__QUOTE_CACHE__ || {
  data: null,
  expiresAt: 0,
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function scrapeQuote() {
  const response = await fetch('https://quotes.toscrape.com')

  if (!response.ok) {
    throw new Error(`Source request failed: ${response.status}`)
  }

  const html = await response.text()
  const $ = cheerio.load(html)

  const quotes = []

  $('.quote').each((_, el) => {
    const quote = $(el).find('.text').text().trim()
    const author = $(el).find('.author').text().trim() || 'Unknown'

    if (quote) {
      quotes.push({ quote, author })
    }
  })

  if (!quotes.length) {
    throw new Error('No quotes found on the source page')
  }

  const randomIndex = Math.floor(Math.random() * quotes.length)
  return quotes[randomIndex]
}

module.exports = async (req, res) => {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      success: false,
      error: 'Method not allowed',
    })
  }

  try {
    const cache = globalThis.__QUOTE_CACHE__

    if (cache.data && Date.now() < cache.expiresAt) {
      return sendJson(res, 200, {
        ...cache.data,
        cached: true,
      })
    }

    const quote = await scrapeQuote()

    const payload = {
      success: true,
      quote: quote.quote,
      author: quote.author,
      source: 'quotes.toscrape.com',
      cached: false,
      timestamp: new Date().toISOString(),
    }

    cache.data = payload
    cache.expiresAt = Date.now() + CACHE_TTL

    return sendJson(res, 200, payload)
  } catch (error) {
    return sendJson(res, 500, {
      success: false,
      error: 'Failed to fetch quote',
      message: error.message,
    })
  }
}