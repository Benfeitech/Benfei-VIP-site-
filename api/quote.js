const cheerio = require('cheerio')

const SOURCE_BASE = 'https://quotes.toscrape.com'
const MAX_PAGES_TO_SCRAPE = 3
const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12000

if (!globalThis.__QUOTE_API_CACHE__) {
  globalThis.__QUOTE_API_CACHE__ = {
    quotes: [],
    expiresAt: 0,
    updatedAt: null
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
}

function setCacheHeaders(res) {
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400')
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function pickRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)]
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (MotivationQuoteScraper/1.0)',
        Accept: 'text/html,application/xhtml+xml'
      }
    })

    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

async function scrapePage(pageNumber) {
  const pageUrl = `${SOURCE_BASE}/page/${pageNumber}/`
  const response = await fetchWithTimeout(pageUrl)

  if (!response.ok) {
    throw new Error(`Failed to fetch page ${pageNumber} (${response.status})`)
  }

  const html = await response.text()
  const $ = cheerio.load(html)

  const quotes = []

  $('.quote').each((_, el) => {
    const quote = $(el).find('.text').text().trim()
    const author = $(el).find('.author').text().trim() || 'Unknown'
    const tags = $(el)
      .find('.tags .tag')
      .map((_, tagEl) => $(tagEl).text().trim())
      .get()
      .filter(Boolean)

    if (quote) {
      quotes.push({
        quote,
        author,
        tags,
        sourceUrl: pageUrl
      })
    }
  })

  return quotes
}

async function refreshQuotePool() {
  const pageNumbers = Array.from({ length: MAX_PAGES_TO_SCRAPE }, (_, index) => index + 1)

  const results = await Promise.allSettled(pageNumbers.map((page) => scrapePage(page)))

  const allQuotes = results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value)

  if (!allQuotes.length) {
    throw new Error('No quotes could be scraped from the source website')
  }

  return allQuotes
}

function buildResponseFromQuote(quote, cached, poolSize, cacheExpiresAt) {
  return {
    success: true,
    quote: quote.quote,
    author: quote.author || 'Unknown',
    tags: Array.isArray(quote.tags) ? quote.tags : [],
    source: 'quotes.toscrape.com',
    sourceUrl: quote.sourceUrl || SOURCE_BASE,
    cached,
    totalQuotes: poolSize,
    cacheExpiresAt: new Date(cacheExpiresAt).toISOString(),
    timestamp: new Date().toISOString()
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(res)
  setCacheHeaders(res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      success: false,
      error: 'Method not allowed',
      allowedMethods: ['GET', 'OPTIONS'],
      timestamp: new Date().toISOString()
    })
  }

  const cache = globalThis.__QUOTE_API_CACHE__
  const cacheIsValid = cache.quotes.length > 0 && Date.now() < cache.expiresAt

  try {
    if (cacheIsValid) {
      const cachedQuote = pickRandomItem(cache.quotes)

      return sendJson(res, 200, buildResponseFromQuote(
        cachedQuote,
        true,
        cache.quotes.length,
        cache.expiresAt
      ))
    }

    const freshQuotes = await refreshQuotePool()

    cache.quotes = freshQuotes
    cache.expiresAt = Date.now() + CACHE_TTL_MS
    cache.updatedAt = new Date().toISOString()

    const freshQuote = pickRandomItem(freshQuotes)

    return sendJson(res, 200, buildResponseFromQuote(
      freshQuote,
      false,
      freshQuotes.length,
      cache.expiresAt
    ))
  } catch (error) {
    if (cache.quotes.length > 0) {
      const fallbackQuote = pickRandomItem(cache.quotes)

      return sendJson(res, 200, {
        ...buildResponseFromQuote(
          fallbackQuote,
          true,
          cache.quotes.length,
          cache.expiresAt || Date.now() + CACHE_TTL_MS
        ),
        warning: 'Returned a cached quote because the scraper failed to refresh.',
        error: error.message
      })
    }

    return sendJson(res, 500, {
      success: false,
      error: 'Failed to fetch quote',
      message: error.message,
      timestamp: new Date().toISOString()
    })
  }
}