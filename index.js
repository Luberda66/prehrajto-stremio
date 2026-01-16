const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")

/* ================= CONFIG ================= */

// Lokalny rezim (bez Renderu): Stremio sa pripaja na manifest cez 127.0.0.1
// (Ak niekedy budes chciet online nasadenie, vtedy sa zvykne pouzit process.env.PORT + 0.0.0.0.)
const PORT = 7001
const ADDRESS = "127.0.0.1"

const BASE_DOMAINS = [
  "https://prehrajto.cz",
  "https://prehraj.to"
]

// Stremio Cinemeta (meta pre filmy/seriály)
const CINEMETA = "https://v3-cinemeta.strem.io"

// TMDb fallback (ak chceš – je to voliteľné; nechávame podporu, ale nič nemusíš nastavovať)
const TMDB_API_KEY = process.env.TMDB_API_KEY || null

/* ================= MANIFEST ================= */

const manifest = {
  id: "community.prehrajto",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehraj.to – CZ/SK, dabing, titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: []
}

const builder = new addonBuilder(manifest)

/* ================= HTTP ================= */

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "sk-SK,sk;q=0.9,cs-CZ;q=0.8,cs;q=0.7,en;q=0.6",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  },
  maxRedirects: 5,
  validateStatus: s => s >= 200 && s < 400
})

/* ================= CACHE ================= */

const CACHE_TTL = 30 * 60 * 1000
const cacheSearch = new Map()
const cacheStream = new Map()

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
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
}

function pad2(n) {
  return String(n).padStart(2, "0")
}

function isEpisodeMatch(title, s, e) {
  const t = (title || "").toLowerCase()
  const s1 = String(s).replace(/^0/, "")
  const e1 = String(e).replace(/^0/, "")
  return (
    t.includes(`s${s}e${e}`) ||
    t.includes(`s${s1}e${e1}`) ||
    t.includes(`${s}x${e}`) ||
    t.includes(`${s1}x${e1}`)
  )
}

function buildQueries(name, year, s, e) {
  const q = []
  if (s && e) {
    q.push(`${name} S${s}E${e}`)
    q.push(`${name} ${Number(s)}x${Number(e)}`)
  }
  if (year) q.push(`${name} ${year}`)
  q.push(name)
  return [...new Set(q)].filter(Boolean)
}

function looksLikeBlockedHtml(html) {
  const t = (html || "").toLowerCase()
  // typické “ochranné” stránky / challenge
  return (
    t.includes("cloudflare") ||
    t.includes("cf-challenge") ||
    t.includes("attention required") ||
    t.includes("just a moment") ||
    t.includes("captcha") ||
    t.includes("ddos") ||
    t.includes("checking your browser") ||
    t.includes("enable javascript")
  )
}

/* ================= PARSING: SIZE / DURATION ================= */

function parseSizeToBytes(text) {
  if (!text) return null
  const m = String(text)
    .replace(",", ".")
    .match(/(\d+(?:\.\d+)?)\s*(gb|g|mb|m|kb|k)/i)
  if (!m) return null
  const v = parseFloat(m[1])
  const u = m[2].toLowerCase()
  if (Number.isNaN(v)) return null
  if (u === "gb" || u === "g") return v * 1024 * 1024 * 1024
  if (u === "mb" || u === "m") return v * 1024 * 1024
  if (u === "kb" || u === "k") return v * 1024
  return null
}

function bytesToPretty(bytes) {
  if (!bytes || bytes <= 0) return null
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

function parseDurationToSeconds(text) {
  if (!text) return null
  const s = String(text).toLowerCase()

  // 2h58m
  let m = s.match(/(\d+)\s*h\s*(\d+)\s*m/)
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60

  // 01:43:19 or 43:19
  m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    const c = m[3] ? Number(m[3]) : null
    if (c === null) return a * 60 + b
    return a * 3600 + b * 60 + c
  }

  return null
}

function secondsToPretty(sec) {
  if (!sec || sec <= 0) return null
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m`
}

/* ================= ICONS / QUALITY ================= */

function detectQuality(title) {
  const t = (title || "").toLowerCase()
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return "4K"
  if (t.includes("1080") || t.includes("fullhd") || t.includes("fhd")) return "FULLHD"
  if (t.includes("720") || t.includes("hd")) return "HD"
  return "SD"
}

function detectFormat(title) {
  const t = (title || "").toLowerCase()
  const flags = []
  if (t.includes("hdr")) flags.push("HDR")
  if (t.includes("remux")) flags.push("REMUX")
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bd-rip")) flags.push("BluRay")
  if (t.includes("web-dl") || t.includes("webdl")) flags.push("WEB-DL")
  if (t.includes("webrip")) flags.push("WEBRip")
  return flags
}

function detectLang(title) {
  const t = (title || "").toLowerCase()
  // poradie: dabing > titulky > iné
  if (/cz.*dab|dab.*cz|czdubbing|cz dab/.test(t)) return "CZ"
  if (/sk.*dab|dab.*sk|skdubbing|sk dab/.test(t)) return "SK"
  if (/cz.*tit|cz.*sub|titulky|subs|subtitles/.test(t)) return "CZ SUB"
  if (t.includes("sk")) return "SK"
  if (t.includes("cz")) return "CZ"
  if (t.includes("en")) return "EN"
  return null
}

function qualityRank(q) {
  if (q === "4K") return 4
  if (q === "FULLHD") return 3
  if (q === "HD") return 2
  return 1
}

function formatRank(flags) {
  // HDR najvyššie, potom BluRay, WEB-DL, WEBRip
  let s = 0
  if (flags.includes("HDR")) s += 40
  if (flags.includes("REMUX")) s += 35
  if (flags.includes("BluRay")) s += 30
  if (flags.includes("WEB-DL")) s += 20
  if (flags.includes("WEBRip")) s += 10
  return s
}

function streamBlock({ titleLine, quality, flags, sizePretty, bitrate, durationPretty, lang }) {
  // “Hellspy feeling” = viacriadkový popis v title
  const iconsLeft = "▶️"
  const langPart = lang ? `🇨🇿/🇸🇰 ${lang}` : "CZ/SK"
  const fmt = flags.length ? flags.join(" ") : ""
  const q = quality || ""
  const size = sizePretty || ""
  const br = bitrate ? `${bitrate} Mbps` : ""
  const dur = durationPretty ? durationPretty : ""

  // 1. riadok: zdroj + jazyk
  const line1 = `${iconsLeft} Prehraj.to (${langPart})`
  // 2. riadok: názov
  const line2 = `📄 ${titleLine}`
  // 3. riadok: kvalita + format + size
  const line3 = `🖥️ ${q}${fmt ? `  ${fmt}` : ""}${size ? `  💾 ${size}` : ""}`
  // 4. riadok: bitrate + duration
  const line4 = `${br ? `⚡ ${br}` : "⚡ —"}${dur ? `  ⏱️ ${dur}` : "  ⏱️ —"}`

  return [line1, line2, line3, line4].join("\n")
}

/* ================= SCRAPING ================= */

async function fetchFromBases(path) {
  let lastErr = null
  for (const base of BASE_DOMAINS) {
    const url = base + path
    try {
      const res = await http.get(url)
      if (typeof res.data === "string" && looksLikeBlockedHtml(res.data)) {
        console.log(`🛑 BLOCKED HTML from ${url} (looks like protection page)`)
        continue
      }
      return { base, url, html: res.data }
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr) throw lastErr
  throw new Error("No base domain worked")
}

async function searchPrehrajto(query) {
  const cached = getCache(cacheSearch, query)
  if (cached) return cached

  const path = `/hledej/${encodeURIComponent(query)}`
  const { html } = await fetchFromBases(path)

  const $ = cheerio.load(html)
  const results = []

  $(".video--link").each((_, el) => {
    const href = $(el).attr("href")
    const title = $(el).find(".video__title").text().trim()
    const meta = $(el).find(".video__tag").text().trim()

    if (!href || !title) return
    if (title.toLowerCase().includes("trailer")) return

    // meta môže niesť veľkosť/štítky (záleží od layoutu)
    results.push({
      pagePath: href,
      rawTitle: title,
      normTitle: normalize(title),
      label: `${title}${meta ? `  ${meta}` : ""}`
    })
  })

  setCache(cacheSearch, query, results)
  return results
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const res = await http.get(pageUrl)
  const html = res.data

  // video file URL
  const m = html.match(/file:\s*"(https:[^"]+)"/)
  const video = m ? m[1] : null

  // skúsiť vyťahať info (size / duration) z textu stránky
  let sizeBytes = null
  let durationSec = null

  const textAll = cheerio.load(html).text()

  // veľkosť
  sizeBytes = parseSizeToBytes(textAll)

  // dĺžka (niekedy býva v texte napr. 01:43:19)
  durationSec = parseDurationToSeconds(textAll)

  const out = { video, sizeBytes, durationSec }

  if (video) setCache(cacheStream, pageUrl, out)
  return out
}

/* ================= META HELPERS ================= */

async function getCinemetaMeta(type, id) {
  const url = `${CINEMETA}/meta/${type}/${id}.json`
  const res = await axios.get(url, { timeout: 15000 })
  return res.data && res.data.meta ? res.data.meta : null
}

function parseStremioId(type, id) {
  // movie: tt1234567
  // series episode: tt1234567:season:episode
  if (type !== "series") return { imdb: id, season: null, episode: null, baseId: id }
  const parts = String(id).split(":")
  const imdb = parts[0]
  const season = parts[1] ? Number(parts[1]) : null
  const episode = parts[2] ? Number(parts[2]) : null
  return { imdb, season, episode, baseId: imdb }
}

/* ================= SCORING / SORT ================= */

function computeScore({ title, quality, flags, sizeBytes, bitrate }) {
  let score = 0
  const lang = detectLang(title)
  if (lang === "CZ") score += 1200
  else if (lang === "SK") score += 1100
  else if (lang === "CZ SUB") score += 900
  else if (lang === "EN") score += 200

  score += qualityRank(quality) * 1000
  score += formatRank(flags)

  // bitrate a size ako jemné “v rámci kvality”
  if (bitrate) score += Math.min(500, Math.round(bitrate * 20))
  if (sizeBytes) score += Math.min(400, Math.round(sizeBytes / (1024 * 1024 * 200))) // ~ +1 za 200MB

  return score
}

function sortStreams(a, b) {
  // “inteligentne”: kvalita > format > size > bitrate
  const qa = qualityRank(a.quality)
  const qb = qualityRank(b.quality)
  if (qb !== qa) return qb - qa

  const fa = formatRank(a.flags)
  const fb = formatRank(b.flags)
  if (fb !== fa) return fb - fa

  const sa = a.sizeBytes || 0
  const sb = b.sizeBytes || 0
  if (sb !== sa) return sb - sa

  const ba = a.bitrate || 0
  const bb = b.bitrate || 0
  return bb - ba
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseStremioId(type, id)
  const effectiveId = type === "series" ? parsed.baseId : id

  console.log("STREAM REQ:", {
    type,
    id,
    effectiveId,
    imdb: parsed.imdb,
    season: parsed.season,
    episode: parsed.episode
  })

  let meta = null
  try {
    meta = await getCinemetaMeta(type === "series" ? "series" : type, effectiveId)
  } catch (e) {
    console.log("cinemeta error:", e?.message || e)
  }

  if (!meta) return { streams: [] }

  const name = meta.name
  const year = meta.year

  // season/episode pre series
  let s = null
  let e = null

  if (type === "series") {
    // Stremio ep id: tt...:S:E (už máme v parsed)
    if (parsed.season != null && parsed.episode != null) {
      s = pad2(parsed.season)
      e = pad2(parsed.episode)
    } else {
      // fallback: skúsime nájsť video v meta.videos (niekedy Stremio posiela inak)
      const ep = (meta.videos || []).find(v => v.id === id)
      if (ep) {
        s = pad2(ep.season)
        e = pad2(ep.episode)
      }
    }
  }

  const queries = buildQueries(name, year, s, e)

  const streams = []
  const seen = new Set()

  for (const q of queries) {
    let results = []
    try {
      results = await searchPrehrajto(q)
    } catch (e) {
      console.log("search error:", e?.message || e)
      continue
    }

    const normName = normalize(name)

    for (const r of results) {
      // základné párovanie názvu
      if (!r.normTitle.includes(normName)) continue
      if (type === "series" && s && e && !isEpisodeMatch(r.rawTitle, s, e)) continue

      // postavíme full url (zoberieme prvú base doménu ako default)
      const pageUrl = BASE_DOMAINS[0] + r.pagePath

      if (seen.has(pageUrl)) continue
      seen.add(pageUrl)

      let extracted = null
      try {
        extracted = await extractStream(pageUrl)
      } catch (e) {
        continue
      }
      if (!extracted || !extracted.video) continue

      const quality = detectQuality(r.rawTitle)
      const flags = detectFormat(r.rawTitle)
      const lang = detectLang(r.rawTitle)

      const sizePretty = bytesToPretty(extracted.sizeBytes)
      const durationPretty = secondsToPretty(extracted.durationSec)

      // bitrate odhad: size / duration
      let bitrate = null
      if (extracted.sizeBytes && extracted.durationSec) {
        const bits = extracted.sizeBytes * 8
        bitrate = +(bits / extracted.durationSec / 1_000_000).toFixed(1)
      }

      const score = computeScore({
        title: r.rawTitle,
        quality,
        flags,
        sizeBytes: extracted.sizeBytes,
        bitrate
      })

      const titleLine = r.label

      streams.push({
        title: streamBlock({
          titleLine,
          quality,
          flags,
          sizePretty,
          bitrate,
          durationPretty,
          lang
        }),
        url: extracted.video,
        _score: score,
        quality,
        flags,
        sizeBytes: extracted.sizeBytes,
        bitrate
      })
    }
  }

  streams.sort(sortStreams)

  console.log("✅ Found streams:", streams.length)

  // Stremio nepodporuje custom score field oficiálne, takže si ho odstránime
  return {
    streams: streams.map(({ _score, quality, flags, sizeBytes, bitrate, ...s }) => s)
  }
})

/* ================= SERVER ================= */

// Lokalny server pre Stremio
serveHTTP(builder.getInterface(), {
  port: PORT,
  address: ADDRESS
})

console.log(`🚀 Prehraj.to addon beží na: http://${ADDRESS}:${PORT}`)
console.log(`📄 Manifest: /manifest.json`)
