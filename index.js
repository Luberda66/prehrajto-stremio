"use strict"

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")

/* ================= CONFIG ================= */

// Lokalny rezim (bez Renderu): Stremio sa pripaja na manifest cez 127.0.0.1
const PORT = 7001
const ADDRESS = "127.0.0.1"

// Prehrajto domény (niekedy jedna funguje lepšie než druhá)
const BASES = [
  "https://prehrajto.cz",
  "https://prehraj.to"
]

// TMDb (IMDB -> title/year). Ak nechceš, nechaj prázdne a pôjde to aj bez toho.
const TMDB_KEY = process.env.TMDB_KEY || ""

// Manifest logo (napr. raw GitHub URL na icon.png)
const MANIFEST_LOGO_URL = process.env.MANIFEST_LOGO_URL || ""

/* ================= MANIFEST ================= */

const manifest = {
  id: "community.prehrajto.czsk",
  version: "2.č4.0",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehrajto – CZ/SK, dabing, titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  logo: MANIFEST_LOGO_URL || undefined
}

const builder = new addonBuilder(manifest)

/* ================= CACHE ================= */

const CACHE_TTL = 30 * 60 * 1000
const cacheSearch = new Map()
const cacheStream = new Map()
const cacheTmdb = new Map()

function getCache(map, key) {
  const item = map.get(key)
  if (!item) return null
  if (Date.now() - item.time > CACHE_TTL) {
    map.delete(key)
    return null
  }
  return item.data
}

function setCache(map, key, data) {
  map.set(key, { time: Date.now(), data })
}

/* ================= HTTP ================= */

const http = axios.create({
  timeout: 25000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "sk-SK,sk;q=0.9,cs-CZ;q=0.9,cs;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
  },
  maxRedirects: 5,
  decompress: true
})

function looksLikeBlockedHtml(html) {
  const t = String(html || "").toLowerCase()
  return (
    t.includes("cloudflare") ||
    t.includes("attention required") ||
    t.includes("cf-challenge") ||
    t.includes("checking your browser") ||
    t.includes("captcha") ||
    t.includes("access denied")
  )
}

async function fetchFromBases(path) {
  let lastErr = null

  for (const base of BASES) {
    const url = `${base}${path}`
    try {
      const res = await http.get(url, { headers: { Referer: base + "/" } })
      const html = res.data

      if (looksLikeBlockedHtml(html)) {
        console.log(`🛑 BLOCKED HTML from ${url} (looks like protection page)`)
        continue
      }

      return { base, url, html }
    } catch (e) {
      lastErr = e
      console.log(`⚠️ fetch failed: ${url} -> ${e?.response?.status || e?.code || e?.message}`)
    }
  }

  if (lastErr) throw lastErr
  throw new Error("No base domain worked")
}

/* ================= UTILS ================= */

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
}

function isJunkRelease(title) {
  const t = String(title || "").toLowerCase()
  return (
    t.includes("trailer") ||
    t.includes("ukazka") ||
    t.includes("sample") ||
    t.includes("camrip") ||
    t.includes("telesync")
  )
}

function parseSeriesEpisodeFromId(id) {
  const s = String(id || "")
  const m = s.match(/^(tt\d+):(\d+):(\d+)$/)
  if (!m) return { baseId: s, season: null, episode: null }
  return { baseId: m[1], season: Number(m[2]), episode: Number(m[3]) }
}

function isEpisodeMatchAny(titleOrUrl, season, episode) {
  const t = String(titleOrUrl || "").toLowerCase()
  const s = String(season).padStart(2, "0")
  const e = String(episode).padStart(2, "0")
  return (
    t.includes(`s${s}e${e}`) ||
    t.includes(`${Number(season)}x${String(episode).padStart(2, "0")}`) ||
    t.includes(`${Number(season)}e${String(episode).padStart(2, "0")}`)
  )
}

function buildQueries(name, year, season, episode) {
  const q = []
  const n = String(name || "").trim()
  if (!n) return q

  if (season && episode) {
    const s = String(season).padStart(2, "0")
    const e = String(episode).padStart(2, "0")
    q.push(`${n} S${s}E${e}`)
    q.push(`${n} ${Number(season)}x${String(episode).padStart(2, "0")}`)
  }

  if (year) q.push(`${n} ${year}`)
  q.push(n)

  return [...new Set(q)]
}

function parseSizeToBytes(size) {
  const s = String(size || "").trim().replace(",", ".")
  const m = s.match(/([\d.]+)\s*(GB|MB)/i)
  if (!m) return 0
  const val = Number(m[1])
  const unit = m[2].toUpperCase()
  if (!Number.isFinite(val)) return 0
  if (unit === "GB") return Math.round(val * 1024 * 1024 * 1024)
  if (unit === "MB") return Math.round(val * 1024 * 1024)
  return 0
}

function parseDurationToSeconds(dur) {
  const s = String(dur || "").trim()
  if (!s) return 0
  const parts = s.split(":").map(p => Number(p))
  if (parts.some(n => !Number.isFinite(n))) return 0
  if (parts.length === 3) {
    const [h, m, sec] = parts
    return h * 3600 + m * 60 + sec
  }
  if (parts.length === 2) {
    const [m, sec] = parts
    return m * 60 + sec
  }
  return 0
}

function detectLangInfo(title) {
  const t = String(title || "").toLowerCase()
  const flags = []
  const tags = []
  const codes = []

  const hasCZ = /\bcz\b/.test(t) || t.includes("czech") || t.includes("cesky") || t.includes("česk")
  const hasSK = /\bsk\b/.test(t) || t.includes("slovak") || t.includes("slovensk")
  const hasEN = /\ben\b/.test(t) || t.includes("english")

  const isCzDub = /cz.*dab|dab.*cz|c[zs]\s*dabing|czdabing/.test(t)
  const isSkDub = /sk.*dab|dab.*sk|skdabing/.test(t)
  const hasSubs = /tit|sub|titulky/.test(t)

  if (hasCZ || isCzDub) flags.push("🇨🇿")
  if (hasSK || isSkDub) flags.push("🇸🇰")
  if (flags.length === 0 && hasEN) flags.push("🇬🇧")
  if (flags.length === 0) flags.push("🌍")

  if (flags.includes("🇨🇿")) codes.push("CZ")
  if (flags.includes("🇸🇰")) codes.push("SK")
  if (flags.includes("🇬🇧")) codes.push("EN")

  if (isCzDub || isSkDub || /dabing|dubbing/.test(t)) tags.push("🎙")
  if (hasSubs) tags.push("💬")

  return {
    flags: flags.join(""),
    tags: tags.join(""),
    codes: codes.join(" ")
  }
}

function qualityFromTitle(title) {
  const t = String(title || "").toLowerCase()
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return "4K"
  if (t.includes("1080")) return "FULLHD"
  if (t.includes("720")) return "HD"
  return ""
}

function detectFormatLabel(title) {
  const t = String(title || "").toLowerCase()
  if (t.includes("hdr")) return "HDR"
  if (t.includes("remux")) return "REMUX"
  if (t.includes("bluray") || t.includes("bdrip")) return "BluRay"
  if (t.includes("web-dl") || t.includes("webdl")) return "WEB-DL"
  if (t.includes("webrip")) return "WEBRip"
  return ""
}

function qualityRank(q) {
  if (q === "4K") return 4
  if (q === "FULLHD") return 3
  if (q === "HD") return 2
  return 1
}

function formatRank(f) {
  if (f === "HDR") return 5
  if (f === "REMUX") return 4
  if (f === "BluRay") return 3
  if (f === "WEB-DL") return 2
  if (f === "WEBRip") return 1
  return 0
}

function formatDurationPretty(time) {
  const t = String(time || "").trim()
  if (!t) return "—"
  return t
}

function buildHellspyBlock({ displayName, year, rawTitle, size, time }) {
  const lang = detectLangInfo(rawTitle)
  const q = qualityFromTitle(rawTitle) || "SD"
  const fmt = detectFormatLabel(rawTitle)

  const sizeBytes = parseSizeToBytes(size)
  const seconds = parseDurationToSeconds(time)
  const mbps = sizeBytes > 0 && seconds > 0 ? (sizeBytes * 8) / seconds / 1_000_000 : 0
  const mbpsTxt = mbps > 0 ? `${mbps.toFixed(1)} Mbps` : "—"

  const line1 = `📄 ${displayName}${year ? ` (${year})` : ""}`
  const line2 = `🎧 ${lang.flags || "🌍"}${lang.codes ? ` ${lang.codes}` : ""}${lang.tags ? ` ${lang.tags}` : ""}   🖥️ ${q}${fmt ? ` ${fmt}` : ""}   💾 ${size || "—"}`
  const line3 = `⚡ ${mbpsTxt}   ⏱ ${formatDurationPretty(time)}`

  return { block: `${line1}\n${line2}\n${line3}`, q, fmt }
}

/* ================= TMDb: IMDB -> Title/Year ================= */

async function tmdbFind(imdbIdFull) {
  if (!TMDB_KEY) return null

  const imdbId = String(imdbIdFull || "").split(":")[0]
  if (!imdbId.startsWith("tt")) return null

  const cached = getCache(cacheTmdb, imdbId)
  if (cached !== null) return cached

  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`
    const { data } = await axios.get(url, { timeout: 15000 })

    const movie = data?.movie_results?.[0]
    const tv = data?.tv_results?.[0]

    if (movie) {
      const res = {
        title: movie.title || "",
        original: movie.original_title || "",
        year: (movie.release_date || "").slice(0, 4) || ""
      }
      setCache(cacheTmdb, imdbId, res)
      return res
    }

    if (tv) {
      const res = {
        title: tv.name || "",
        original: tv.original_name || "",
        year: (tv.first_air_date || "").slice(0, 4) || ""
      }
      setCache(cacheTmdb, imdbId, res)
      return res
    }
  } catch (e) {
    console.log("TMDb find error:", e?.response?.status || e?.message)
  }

  setCache(cacheTmdb, imdbId, null)
  return null
}

/* ================= SCRAPING ================= */

async function searchPrehrajto(query) {
  const cached = getCache(cacheSearch, query)
  if (cached) return cached

  const path = `/hledej/${encodeURIComponent(query)}`
  const { url, html } = await fetchFromBases(path)

  console.log(`🔎 search: ${url} (len=${String(html || "").length})`)

  const $ = cheerio.load(html)
  const results = []

  $(".video--link").each((_, el) => {
    const href = $(el).attr("href")
    const title = $(el).find(".video__title").text().trim()
    const meta = $(el).find(".video__tag").text().trim()

    if (!href || !title) return
    if (isJunkRelease(title)) return

    const parent = $(el).closest(".video")
    const size = parent.find(".video__tag--size").first().text().trim()
    const time = parent.find(".video__tag--time").first().text().trim()

    results.push({
      page: href.startsWith("http")
        ? href
        : (href.startsWith("/")
            ? (url.split("/hledej/")[0] + href)
            : href),
      rawTitle: title,
      normTitle: normalize(title),
      label: `${title} ${meta}`.trim(),
      size,
      time,
      sizeBytes: parseSizeToBytes(size) || 0
    })
  })

  console.log(`✅ found results: ${results.length} for "${query}"`)
  setCache(cacheSearch, query, results)
  return results
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const { html } = await (async () => {
    if (pageUrl.startsWith("http")) {
      const res = await http.get(pageUrl, { headers: { Referer: pageUrl } })
      return { html: res.data }
    }
    const got = await fetchFromBases(pageUrl)
    return { html: got.html }
  })()

  if (looksLikeBlockedHtml(html)) {
    console.log("🛑 BLOCKED on detail page:", pageUrl)
    return null
  }

  const m = String(html).match(/file:\s*"(https:[^"]+)"/)
  const video = m ? m[1] : null

  if (video) setCache(cacheStream, pageUrl, video)
  return video
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseSeriesEpisodeFromId(id)
  const effectiveId = type === "series" ? parsed.baseId : id

  console.log("STREAM REQ:", { type, id, effectiveId, season: parsed.season, episode: parsed.episode })

  const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${effectiveId}.json`
  const metaRes = await axios.get(metaUrl, { timeout: 15000 })
  const meta = metaRes.data.meta

  const cinName = meta.name
  const cinYear = meta.year

  let name = cinName
  let year = cinYear
  let original = ""

  const tmdb = await tmdbFind(id)
  if (tmdb?.title) {
    name = tmdb.title || name
    year = tmdb.year || year
    original = tmdb.original || ""
  }

  let season = null, episode = null
  if (type === "series") {
    if (parsed.season && parsed.episode) {
      season = parsed.season
      episode = parsed.episode
    } else {
      const ep = meta.videos?.find(v => v.id === id)
      if (ep) {
        season = ep.season
        episode = ep.episode
      }
    }
  }

  const queries = []
  for (const n of [name, cinName, original].filter(Boolean)) {
    buildQueries(n, type === "movie" ? year : "", season, episode).forEach(q => queries.push(q))
  }
  const uniqQueries = [...new Set(queries)]

  const needles = [...new Set([name, cinName, original].filter(Boolean).map(normalize))]

  const streams = []
  const seen = new Set()

  for (const q of uniqQueries) {
    let results = []
    try {
      results = await searchPrehrajto(q)
    } catch (e) {
      console.log("search error:", e?.response?.status || e?.message)
      continue
    }

    for (const r of results) {
      if (seen.has(r.page)) continue
      if (isJunkRelease(r.rawTitle)) continue

      const okTitle = needles.some(n => n && r.normTitle.includes(n))
      if (!okTitle) continue

      if (type === "series" && season && episode) {
        const okEp =
          isEpisodeMatchAny(r.rawTitle, season, episode) ||
          isEpisodeMatchAny(r.page, season, episode)
        if (!okEp) continue
      }

      const video = await extractStream(r.page)
      if (!video) continue

      const key = `v:${video}`
      if (seen.has(key)) continue

      seen.add(r.page)
      seen.add(key)

      const leftName = "🎬 Prehraj.to"
      const displayName =
        type === "series" && season && episode
          ? `${name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
          : name

      const { block, q: qLbl, fmt } = buildHellspyBlock({
        displayName,
        year: type === "movie" ? year : "",
        rawTitle: r.rawTitle,
        size: r.size,
        time: r.time
      })

      streams.push({
        name: leftName,
        title: block,
        url: video,
        qRank: qualityRank(qLbl),
        fRank: formatRank(fmt),
        sizeBytes: r.sizeBytes || 0
      })
    }
  }

  // sort: kvalita > format > size
  streams.sort((a, b) => {
    if (b.qRank !== a.qRank) return b.qRank - a.qRank
    if (b.fRank !== a.fRank) return b.fRank - a.fRank
    return (b.sizeBytes || 0) - (a.sizeBytes || 0)
  })

  console.log(`✅ Found streams: ${streams.length}`)

  return {
    streams: streams.map(({ qRank, fRank, sizeBytes, ...s }) => s)
  }
})

/* ================= SERVER ================= */

serveHTTP(builder.getInterface(), {
  port: PORT,
  address: ADDRESS
})

console.log(`🚀 Prehraj.to addon beží na: http://${ADDRESS}:${PORT}`)
console.log(`📄 Manifest: /manifest.json`)
console.log(`➡️  Otvor v prehliadaci: http://${ADDRESS}:${PORT}/manifest.json`)
