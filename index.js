const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")
const http = require("http")
const fs = require("fs")
const path = require("path")

/* ================= MANIFEST ================= */

const manifest = {
  id: "community.prehrajto",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehraj.to – CZ/SK, dabing, titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  // ikonka doplnku (servujeme lokálne)
  logo: "http://127.0.0.1:7002/icon.png",
  background: "http://127.0.0.1:7002/icon.png"
}

const builder = new addonBuilder(manifest)

/* ================= CONFIG ================= */

const TMDB_KEY = "fc168650632c6597038cf7072a7c20da"
const BASE = "https://prehrajto.cz"

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

/* ================= UTILS ================= */

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
}

function parseSeriesEpisodeFromId(id) {
  // tt4574334:1:1 -> { baseId: tt4574334, season: 1, episode: 1 }
  const s = String(id || "")
  const m = s.match(/^(tt\d+)(?::(\d+):(\d+))$/)
  if (!m) return { baseId: id, season: null, episode: null }
  return { baseId: m[1], season: parseInt(m[2], 10), episode: parseInt(m[3], 10) }
}

function isEpisodeMatchAny(text, s, e) {
  if (!s || !e) return true
  const S = String(s).padStart(2, "0")
  const E = String(e).padStart(2, "0")
  const t = String(text || "").toLowerCase()

  if (t.includes(`s${S}e${E}`)) return true
  if (t.includes(`${s}x${E}`) || t.includes(`${s}x${e}`)) return true
  if (t.includes(`s${s}e${e}`)) return true

  return false
}

function buildQueries(name, year, season, episode) {
  const q = []
  if (season && episode) {
    const S = String(season).padStart(2, "0")
    const E = String(episode).padStart(2, "0")
    q.push(`${name} S${S}E${E}`)
    q.push(`${name} ${season}x${E}`)
    q.push(`${name} ${season}x${episode}`)
  }
  if (year) q.push(`${name} ${year}`)
  q.push(name)
  return [...new Set(q)].filter(Boolean)
}

/* ================= CLEANUP / FILTERS ================= */

function isJunkRelease(title) {
  const t = String(title || "").toLowerCase()
  if (t.includes("trailer") || t.includes("teaser") || t.includes("sample")) return true
  if (/\bcam\b/.test(t) || /\bts\b/.test(t) || t.includes("telesync")) return true
  if (t.includes("promo") || t.includes("reklam") || t.includes("upout")) return true
  return false
}

/* ================= PARSING (size, time, Mbps) ================= */

function parseSizeToBytes(sizeStr) {
  const s = String(sizeStr || "").trim().replace(",", ".")
  const m = s.match(/([\d.]+)\s*(KB|MB|GB|TB)/i)
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num)) return null
  const unit = m[2].toUpperCase()
  const mult = unit === "KB" ? 1024
    : unit === "MB" ? 1024 ** 2
    : unit === "GB" ? 1024 ** 3
    : unit === "TB" ? 1024 ** 4
    : 1
  return Math.round(num * mult)
}

function parseTimeToSeconds(timeStr) {
  const s = String(timeStr || "").trim().toLowerCase().replace(/\s+/g, "")
  if (!s) return null
  let hours = 0
  let mins = 0
  const hm = s.match(/(\d+)h/)
  if (hm) hours = parseInt(hm[1], 10)
  const mm = s.match(/(\d+)m/)
  if (mm) mins = parseInt(mm[1], 10)
  const total = hours * 3600 + mins * 60
  return total > 0 ? total : null
}

function formatDurationPretty(timeStr) {
  const sec = parseTimeToSeconds(timeStr)
  if (!sec) return timeStr || "—"
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m`
}

function calcMbps(sizeStr, timeStr) {
  const bytes = parseSizeToBytes(sizeStr)
  const sec = parseTimeToSeconds(timeStr)
  if (!bytes || !sec) return null
  const mbps = (bytes * 8) / sec / 1_000_000
  if (!Number.isFinite(mbps) || mbps <= 0) return null
  return mbps
}

function formatMbps(mbps) {
  if (!mbps) return "—"
  const v = Math.round(mbps * 10) / 10
  return `${v} Mbps`
}

/* ================= DETECTION (lang/quality/format) ================= */

function detectLangInfo(t) {
  const s = String(t || "").toLowerCase()
  const hasCZ = /cz|čes/.test(s) || s.includes("cz")
  const hasSK = /sk|slov/.test(s) || s.includes("sk")
  const hasEN = /\ben\b/.test(s) || s.includes("eng") || s.includes("english")
  const hasDab = s.includes("dab")
  const hasSub = /(tit|sub|titulky)/.test(s)

  if (hasCZ && hasSK && hasDab) return { code: "CZ/SK DAB", icon: "🇨🇿🇸🇰🎙️" }
  if (hasCZ && hasSK && hasSub) return { code: "CZ/SK TIT", icon: "🇨🇿🇸🇰💬" }
  if (hasCZ && hasSK) return { code: "CZ/SK", icon: "🇨🇿🇸🇰" }

  if (hasCZ && hasDab) return { code: "CZ DAB", icon: "🇨🇿🎙️" }
  if (hasSK && hasDab) return { code: "SK DAB", icon: "🇸🇰🎙️" }
  if (hasCZ && hasSub) return { code: "CZ TIT", icon: "🇨🇿💬" }

  if (hasCZ) return { code: "CZ", icon: "🇨🇿" }
  if (hasSK) return { code: "SK", icon: "🇸🇰" }
  if (hasEN) return { code: "EN", icon: "🇬🇧" }

  return { code: "", icon: "🌍" }
}

function detectFormatLabel(t) {
  const s = String(t || "").toLowerCase()
  if (s.includes("hdr") || s.includes("dolby")) return "HDR"
  if (s.includes("remux")) return "REMUX"
  if (s.includes("bluray") || s.includes("bdrip")) return "BluRay"
  if (s.includes("web-dl") || s.includes("webdl")) return "WEB-DL"
  if (s.includes("webrip")) return "WEBRip"
  return ""
}

function qualityFromTitle(t) {
  const s = String(t || "").toLowerCase()
  if (s.includes("2160") || s.includes("4k") || s.includes("uhd")) return "4K"
  if (s.includes("1080")) return "FULLHD"
  if (s.includes("720")) return "HD"
  if (s.includes("480")) return "SD"
  return ""
}

function qualityFromBitrate(mbps) {
  if (!mbps) return ""
  if (mbps >= 18) return "4K"
  if (mbps >= 8) return "FULLHD"
  if (mbps >= 4) return "HD"
  return "SD"
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

/* ================= SCORE ================= */

function computeScore(title) {
  const t = String(title || "").toLowerCase()
  let score = 0

  if (/cz.*dab|dab.*cz/.test(t)) score += 1000
  else if (/sk.*dab|dab.*sk/.test(t)) score += 900
  else if (/cz.*tit|cz.*sub|titulky/.test(t)) score += 600

  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) score += 900
  else if (t.includes("1080")) score += 700
  else if (t.includes("720")) score += 500
  else score += 200

  if (t.includes("hdr")) score += 600
  if (t.includes("remux")) score += 550
  if (t.includes("bluray") || t.includes("bdrip")) score += 500
  else if (t.includes("web-dl") || t.includes("webdl")) score += 400
  else if (t.includes("webrip")) score += 300

  return score
}

/* ================= TMDb: IMDB -> Title/Year ================= */

async function tmdbFind(imdbIdFull) {
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
  } catch (_) {}

  setCache(cacheTmdb, imdbId, null)
  return null
}

/* ================= SCRAPING ================= */

async function searchPrehrajto(query) {
  const cached = getCache(cacheSearch, query)
  if (cached) return cached

  const url = `${BASE}/hledej/${encodeURIComponent(query)}`
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 20000
  })

  const $ = cheerio.load(data)
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
      page: BASE + href,
      rawTitle: title,
      normTitle: normalize(title),
      label: `${title} ${meta}`.trim(),
      size,
      time,
      sizeBytes: parseSizeToBytes(size) || 0
    })
  })

  setCache(cacheSearch, query, results)
  return results
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const { data } = await axios.get(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 20000
  })

  const m = data.match(/file:\s*"(https:[^"]+)"/)
  const video = m ? m[1] : null

  if (video) setCache(cacheStream, pageUrl, video)
  return video
}

/* ================= HELLSY-LIKE MULTILINE TITLE ================= */

function pad3(s) {
  return String(s || "").padEnd(8, " ")
}

function buildHellspyBlock({ displayName, year, rawTitle, size, time }) {
  const lang = detectLangInfo(rawTitle)

  const mbpsVal = calcMbps(size, time)
  const qFromTitle = qualityFromTitle(rawTitle)
  const q = qFromTitle || qualityFromBitrate(mbpsVal) || "SD"

  const fmt = detectFormatLabel(rawTitle)
  const fmtShort = fmt ? ` ${fmt}` : ""

  const line1 = `${lang.icon} ${displayName}${year ? ` (${year})` : ""}`.trim()
  const line2 = `🖥️ ${pad3(q)}${fmtShort}   💾 ${size || "—"}`
  const line3 = `⚡ ${formatMbps(mbpsVal)}   ⏱ ${formatDurationPretty(time)}`

  return { block: `${line1}\n${line2}\n${line3}`, q, fmt, mbpsVal }
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseSeriesEpisodeFromId(id)
  const effectiveId = (type === "series") ? parsed.baseId : id

  const metaRes = await axios.get(
    `https://v3-cinemeta.strem.io/meta/${type}/${effectiveId}.json`,
    { timeout: 15000 }
  )
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
    const results = await searchPrehrajto(q)

    for (const r of results) {
      if (seen.has(r.page)) continue
      if (isJunkRelease(r.rawTitle)) continue

      const okTitle = needles.some(n => n && r.normTitle.includes(n))
      if (!okTitle) continue

      if (type === "series" && season && episode) {
        const okEp = isEpisodeMatchAny(r.rawTitle, season, episode) || isEpisodeMatchAny(r.page, season, episode)
        if (!okEp) continue
      }

      const video = await extractStream(r.page)
      if (!video) continue

      const key = `v:${video}`
      if (seen.has(key)) continue

      seen.add(r.page)
      seen.add(key)

      const leftName = "⏵ Prehraj.to"
      const displayName =
        (type === "series" && season && episode)
          ? `${name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
          : name

      const { block, q: qLbl, fmt, mbpsVal } = buildHellspyBlock({
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
        sizeBytes: r.sizeBytes || 0,
        mbps: mbpsVal || 0,
        score: computeScore(r.rawTitle)
      })
    }
  }

  streams.sort((a, b) => {
    if (b.qRank !== a.qRank) return b.qRank - a.qRank
    if (b.fRank !== a.fRank) return b.fRank - a.fRank
    if ((b.sizeBytes || 0) !== (a.sizeBytes || 0)) return (b.sizeBytes || 0) - (a.sizeBytes || 0)
    if ((b.mbps || 0) !== (a.mbps || 0)) return (b.mbps || 0) - (a.mbps || 0)
    return (b.score || 0) - (a.score || 0)
  })

  return { streams: streams.map(({ qRank, fRank, sizeBytes, mbps, score, ...s }) => s) }
})

/* ================= ADDON SERVER (7001) ================= */

const PORT = process.env.PORT || 7001

serveHTTP(builder.getInterface(), {
  port: PORT,
  address: "0.0.0.0"
})

console.log(`🚀 Prehraj.to addon beží na porte ${PORT}`)


/* ================= ICON SERVER (7002) ================= */

const ICON_PORT = 7002
const ICON_PATH = path.join(__dirname, "icon.png")

http.createServer((req, res) => {
  if (req.url === "/icon.png") {
    fs.readFile(ICON_PATH, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("icon.png not found")
        return
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" })
      res.end(data)
    })
    return
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not found")
}).listen(ICON_PORT, "127.0.0.1", () => {
  console.log("🖼️ Ikona: http://127.0.0.1:7002/icon.png")
})

console.log("🚀 Prehraj.to addon beží na http://127.0.0.1:7001")
console.log("📄 Manifest: http://127.0.0.1:7001/manifest.json")
