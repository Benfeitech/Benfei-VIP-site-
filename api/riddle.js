const cheerio = require('cheerio')

const SOURCE_BASE = 'https://www.riddles.com/difficult-riddles'
const MAX_PAGES_TO_SCRAPE = 3
const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12000

if (!globalThis.__RIDDLE_API_CACHE__) {
  globalThis.__RIDDLE_API_CACHE__ = {
    riddles: [],
    expiresAt: 0,
    updatedAt: null,
    lastServedKey: ''
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

function pickRandomItem(items, excludeKey = '') {
  if (!Array.isArray(items) || items.length === 0) return null
  if (items.length === 1) return items[0]

  const filtered = excludeKey
    ? items.filter((item) => `${item.riddle}::${item.answer}` !== excludeKey)
    : items

  const pool = filtered.length ? filtered : items
  return pool[Math.floor(Math.random() * pool.length)]
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (RiddleScraper/1.0)',
        Accept: 'text/html,application/xhtml+xml'
      }
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToLooseText(html) {
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '\n')
  )
}

function extractRiddlesFromPage(html, pageNumber) {
  const $ = cheerio.load(html)
  const bodyHtml = $('body').html() || ''
  const text = htmlToLooseText(bodyHtml)
  const lines = text
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean)

  const riddles = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!/^Riddle:\s*/i.test(line)) continue

    const riddleText = cleanText(line.replace(/^Riddle:\s*/i, ''))
    if (!riddleText) continue

    let answerText = 'Answer not found'

    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j]

      if (/^Answer:\s*/i.test(nextLine)) {
        answerText = cleanText(nextLine.replace(/^Answer:\s*/i, ''))

        if (!answerText && j + 1 < lines.length) {
          answerText = cleanText(lines[j + 1])
        }

        break
      }

      if (/^Riddle:\s*/i.test(nextLine)) {
        break
      }
    }

    let title = 'Riddle'
    for (let k = i - 1; k >= 0; k--) {
      const candidate = lines[k]
      if (
        candidate &&
        !/^Answer:\s*/i.test(candidate) &&
        !/^Show Answer/i.test(candidate) &&
        !/^Hide Answer/i.test(candidate) &&
        !/^Page \d+ of \d+/i.test(candidate) &&
        candidate.length > 3
      ) {
        title = candidate
        break
      }
    }

    riddles.push({
      riddle: riddleText,
      answer: answerText,
      title,
      sourceUrl: `${SOURCE_BASE}?page=${pageNumber}`,
      page: pageNumber
    })
  }

  return riddles
}

async function scrapePage(pageNumber) {
  const pageUrl = `${SOURCE_BASE}?page=${pageNumber}`
  const response = await fetchWithTimeout(pageUrl)

  if (!response.ok) {
    throw new Error(`Failed to fetch page ${pageNumber} (${response.status})`)
  }

  const html = await response.text()
  return extractRiddlesFromPage(html, pageNumber)
}

async function refreshRiddlePool() {
  const pageNumbers = Array.from({ length: MAX_PAGES_TO_SCRAPE }, (_, index) => index + 1)
  const results = await Promise.allSettled(pageNumbers.map((page) => scrapePage(page)))

  const allRiddles = results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .filter((item) => item && item.riddle)

  if (!allRiddles.length) {
    throw new Error('No riddles could be scraped from the source website')
  }

  return allRiddles
}

function buildResponse(riddle, riddles, cached, cacheExpiresAt) {
  const key = `${riddle.riddle}::${riddle.answer}`

  return {
    success: true,
    riddle: riddle.riddle,
    answer: riddle.answer || 'Answer not found',
    title: riddle.title || 'Riddle',
    currentRiddle: riddle,
    riddles,
    source: 'riddles.com',
    sourceUrl: riddle.sourceUrl || SOURCE_BASE,
    cached,
    totalRiddles: riddles.length,
    cacheExpiresAt: new Date(cacheExpiresAt).toISOString(),
    timestamp: new Date().toISOString(),
    servedKey: key
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

  const cache = globalThis.__RIDDLE_API_CACHE__
  const cacheIsValid = cache.riddles.length > 0 && Date.now() < cache.expiresAt

  try {
    if (cacheIsValid) {
      const randomRiddle = pickRandomItem(cache.riddles, cache.lastServedKey)

      if (!randomRiddle) {
        throw new Error('No cached riddles available')
      }

      cache.lastServedKey = `${randomRiddle.riddle}::${randomRiddle.answer}`

      return sendJson(res, 200, buildResponse(randomRiddle, cache.riddles, true, cache.expiresAt))
    }

    const freshRiddles = await refreshRiddlePool()

    cache.riddles = freshRiddles
    cache.expiresAt = Date.now() + CACHE_TTL_MS
    cache.updatedAt = new Date().toISOString()

    const randomRiddle = pickRandomItem(freshRiddles)

    if (!randomRiddle) {
      throw new Error('No riddles available after refresh')
    }

    cache.lastServedKey = `${randomRiddle.riddle}::${randomRiddle.answer}`

    return sendJson(res, 200, buildResponse(randomRiddle, freshRiddles, false, cache.expiresAt))
  } catch (error) {
    if (cache.riddles.length > 0) {
      const fallbackRiddle = pickRandomItem(cache.riddles, cache.lastServedKey)

      if (fallbackRiddle) {
        cache.lastServedKey = `${fallbackRiddle.riddle}::${fallbackRiddle.answer}`

        return sendJson(res, 200, {
          ...buildResponse(
            fallbackRiddle,
            cache.riddles,
            true,
            cache.expiresAt || Date.now() + CACHE_TTL_MS
          ),
          warning: 'Returned a cached riddle because the scraper failed to refresh.',
          error: error.message
        })
      }
    }

    return sendJson(res, 500, {
      success: false,
      error: 'Failed to fetch riddle',
      message: error.message,
      timestamp: new Date().toISOString()
    })
  }
}