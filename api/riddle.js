const cheerio = require('cheerio')

const SOURCE_BASE = 'https://www.riddles.com/difficult-riddles'
const MAX_PAGES_TO_SCRAPE = 3
const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12000

if (!globalThis.__RIDDLE_API_CACHE__) {
  globalThis.__RIDDLE_API_CACHE__ = {
    riddles: [],
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

function normalizeLines(text) {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function extractRiddlesFromPage(html, pageNumber) {
  const $ = cheerio.load(html)

  $('script, style, noscript').remove()

  const textLines = normalizeLines($('body').text())
  const riddles = []

  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i]

    if (!line.startsWith('Riddle:')) continue

    const riddleText = line.replace(/^Riddle:\s*/i, '').trim()
    if (!riddleText) continue

    let answerText = ''
    for (let j = i + 1; j < textLines.length; j++) {
      const nextLine = textLines[j]

      if (/^Answer:\s*/i.test(nextLine)) {
        answerText = nextLine.replace(/^Answer:\s*/i, '').trim()

        if (!answerText && j + 1 < textLines.length && !/^Show Answer|Hide Answer/i.test(textLines[j + 1])) {
          answerText = textLines[j + 1].trim()
        }
        break
      }

      if (/^Riddle:\s*/i.test(nextLine)) break
    }

    let title = 'Riddle'
    for (let k = i - 1; k >= 0; k--) {
      const candidate = textLines[k]
      if (
        candidate &&
        !/^Answer:|^Show Answer|^Hide Answer|^Riddle:/i.test(candidate) &&
        candidate.length > 3
      ) {
        title = candidate
        break
      }
    }

    riddles.push({
      riddle: riddleText,
      answer: answerText || 'Answer not found',
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

  const cache = globalThis.__RIDDLE_API_CACHE__
  const cacheIsValid = cache.riddles.length > 0 && Date.now() < cache.expiresAt

  try {
    if (cacheIsValid) {
      const randomRiddle = pickRandomItem(cache.riddles)
      return sendJson(res, 200, buildResponse(randomRiddle, cache.riddles, true, cache.expiresAt))
    }

    const freshRiddles = await refreshRiddlePool()
    cache.riddles = freshRiddles
    cache.expiresAt = Date.now() + CACHE_TTL_MS
    cache.updatedAt = new Date().toISOString()

    const randomRiddle = pickRandomItem(freshRiddles)
    return sendJson(res, 200, buildResponse(randomRiddle, freshRiddles, false, cache.expiresAt))
  } catch (error) {
    if (cache.riddles.length > 0) {
      const fallbackRiddle = pickRandomItem(cache.riddles)

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

    return sendJson(res, 500, {
      success: false,
      error: 'Failed to fetch riddle',
      message: error.message,
      timestamp: new Date().toISOString()
    })
  }
}