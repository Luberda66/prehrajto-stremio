const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")

/* ================= MANIFEST ================= */

const manifest = {
  id: "community.prehrajto",
  version: "2.4.3",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehraj.to / prehrajto.cz – CZ/SK, dabing, titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  // logo: "https://raw.githubusercontent.com/<user>/<repo>/main/icon.png", // ak bude repo public
}

const builder = new addonBuilder(manifest)

/* ================= CONFIG ================= */

// Render: PORT je povinný (Render ti ho nastaví sám)
const PORT = Number(process.env.PORT || 7001)
const ADDR = "0.0.0.0"

// domény – niekedy jedna vypadne alebo blokne
const BASES = ["https://prehrajto.cz", "https://prehraj.to"]

/* ================= AXIOS ================= */

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Accept-Language": "sk-SK,sk;q=0.9,cs-CZ;q=0.8,cs;q=0.7,en;q=0.5",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
})

/* ================= CACHE ================= */

const CACHE_TTL = 30 * 60 * 1000
const cacheSearch = new Map()
const cacheStream = new Map()
const cacheMeta = new Map()

function getCache(map, key) {
  const v = map.get(key)
  if (!v) return null
  if (Date.now() - v.time > CACHE_TTL) {
    map.delete(key)
    return null
  }
  return v.data
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

// Stremio:
// movie id: tt0499549
// series episode id: tt4574334:1:1
function parseId(type, id) {
  if (type !== "series") return { imdb: id, season: null, episode: null, baseId: id }
  const parts = String(id).split(":")
  const imdb = parts[0]
  const season = parts[1] ? pad2(parts[1]) : null
  const episode = parts[2] ? pad2(parts[2]) : null
  return { imdb, season, episode, baseId: imdb }
}

function buildQueries(name, year, season, episode) {
  const q = []
  if (season && episode) {
    q.push(`${name} S${season}E${episode}`)
    q.push(`${name} ${season}x${episode}`)
    q.push(`${name} s${season}e${episode}`)
  }
  if (year) q.push(`${name} ${year}`)
  q.push(name)
  return [...new Set(q.filter(Boolean))]
}

function isEpisodeMatch(title, season, episode) {
  if (!season || !episode) return true
  const t = (title || "").toLowerCase()
  const s = String(parseInt(season, 10))
  const e = String(parseInt(episode, 10))
  return (
    t.includes(`s${season}e${episode}`) ||
    t.includes(`s${s}e${e}`) ||
    t.includes(`${s}x${e}`) ||
    t.includes(`${season}x${episode}`)
  )
}

/* ================= PARSE QUALITY / FORMAT / SIZE / TIME ================= */

function parseQuality(title) {
  const t = (title || "").toLowerCase()
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return "4K"
  if (t.includes("1080")) return "FULLHD"
  if (t.includes("720")) return "HD"
  return "SD"
}

function qualityRank(q) {
  if (q === "4K") return 4
  if (q === "FULLHD") return 3
  if (q === "HD") return 2
  return 1
}

function parseFormat(title) {
  const t = (title || "").toLowerCase()
  const f = []
  if (t.includes("hdr")) f.push("HDR")
  if (t.includes("remux")) f.push("REMUX")
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bdremux")) f.push("BluRay")
  if (t.includes("web-dl") || t.includes("webdl")) f.push("WEB-DL")
  if (t.includes("webrip")) f.push("WEBRip")
  return f
}

function formatRank(fmtArr) {
  const f = (fmtArr || []).join(" ")
  if (f.includes("HDR")) return 5
  if (f.includes("REMUX")) return 4
  if (f.includes("BluRay")) return 3
  if (f.includes("WEB-DL")) return 2
  if (f.includes("WEBRip")) return 1
  return 0
}

function parseLang(title) {
  const t = (title || "").toLowerCase()
  const out = []
  if (/cz.*dab|dab.*cz|czdabing/.test(t)) out.push("CZ")
  if (/sk.*dab|dab.*sk/.test(t)) out.push("SK")
  if (/titulky|subs|sub|cz.*tit|cz.*sub/.test(t)) out.push("SUB")
  return out
}

function parseSizeToBytes(text) {
  if (!text) return null
  const m = String(text).trim().match(/([\d.,]+)\s*(GB|MB|TB)/i)
  if (!m) return null
  const num = parseFloat(m[1].replace(",", "."))
  const unit = m[2].toUpperCase()
  if (Number.isNaN(num)) return null
  if (unit === "MB") return num * 1024 * 1024
  if (unit === "GB") return num * 1024 * 1024 * 1024
  if (unit === "TB") return num * 1024 * 1024 * 1024 * 1024
  return null
}

function parseDuration(text) {
  // "01:43:19" alebo "1:43:19"
  if (!text) return null
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  return `${h}h ${mi}m`
}

function padRight(str, len) {
  return String(str || "").padEnd(len, " ")
}

/* ================= HELLSY LOOK ================= */

function buildHellspyTitle({ displayName, year, rawTitle, size, time }) {
  const langs = parseLang(rawTitle)
  const q = parseQuality(rawTitle)
  const fmt = parseFormat(rawTitle)
  const tPretty = parseDuration(time) || (time || "—")

  const langIcons =
    (langs.includes("CZ") ? "cz " : "") +
    (langs.includes("SK") ? "sk " : "") +
    (langs.includes("SUB") ? "💬 " : "")

  const fmtStr = fmt.length ? fmt.join(" ") : ""
  const line1 = `${langIcons}${displayName}${year ? ` (${year})` : ""}`.trim()
  const line2 = `🖥️ ${padRight(q, 6)} ${fmtStr}`.trimEnd() + `   💾 ${size || "—"}`
  const line3 = `⏱ ${tPretty}`

  return { title: `${line1}\n${line2}\n${line3}`, q, fmt }
}

/* ================= SCRAPING ================= */

async function searchPrehrajto(query) {
  const cached = getCache(cacheSearch, query)
  if (cached) return cached

  for (const base of BASES) {
    try {
      const url = `${base}/hledej/${encodeURIComponent(query)}`
      const { data } = await http.get(url)

      const $ = cheerio.load(data)
      const results = []

      $(".video--link").each((_, el) => {
        const href = $(el).attr("href")
        const title = $(el).find(".video__title").text().trim()
        const meta = $(el).find(".video__tag").text().trim()

        if (!href || !title) return
        if (title.toLowerCase().includes("trailer")) return

        const parent = $(el).closest(".video")
        const size = parent.find(".video__tag--size").first().text().trim()
        const time = parent.find(".video__tag--time").first().text().trim()

        results.push({
          page: base + href,
          rawTitle: title,
          normTitle: normalize(title),
          label: `${title} ${meta}`.trim(),
          size,
          time,
          sizeBytes: parseSizeToBytes(size) || 0,
        })
      })

      if (results.length) {
        setCache(cacheSearch, query, results)
        return results
      }
    } catch (e) {
      // skúšame ďalšiu doménu
    }
  }

  setCache(cacheSearch, query, [])
  return []
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const { data } = await http.get(pageUrl)

  // najčastejšie:
  // file: "https://....mp4"
  const m = data.match(/file:\s*"(https:[^"]+)"/)
  const video = m ? m[1] : null

  if (video) setCache(cacheStream, pageUrl, video)
  return video
}

/* ================= META (CINEMETA) ================= */

async function getCinemeta(type, id) {
  const key = `${type}:${id}`
  const cached = getCache(cacheMeta, key)
  if (cached) return cached

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`
  const { data } = await axios.get(url, { timeout: 15000 })
  setCache(cacheMeta, key, data?.meta || null)
  return data?.meta || null
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseId(type, id)

  console.log("STREAM REQ:", { type, id, imdb: parsed.imdb, season: parsed.season, episode: parsed.episode })

  // pri seriáloch nesmieš volať cinemeta s tt:1:1, ale s base tt
  const meta = await getCinemeta(type, parsed.baseId)
  if (!meta) return { streams: [] }

  const name = meta.name || ""
  const year = meta.year || ""

  const season = parsed.season
  const episode = parsed.episode

  const queries = buildQueries(name, year, season, episode)
  const needles = [normalize(name)].filter(Boolean)

  const streams = []
  const seen = new Set()

  for (const q of queries) {
    const results = await searchPrehrajto(q)

    for (const r of results) {
      if (seen.has(r.page)) continue

      // názov musí sedieť aspoň približne
      const okTitle = needles.some(n => r.normTitle.includes(n))
      if (!okTitle) continue

      // pri seriáloch musí sedieť epizóda
      if (type === "series" && season && episode) {
        if (!isEpisodeMatch(r.rawTitle, season, episode) && !isEpisodeMatch(r.page, season, episode)) continue
      }

      const video = await extractStream(r.page)
      if (!video) continue

      const videoKey = `v:${video}`
      if (seen.has(videoKey)) continue

      seen.add(r.page)
      seen.add(videoKey)

      const displayName =
        type === "series" && season && episode
          ? `${name} S${season}E${episode}`
          : name

      const { title, q, fmt } = buildHellspyTitle({
        displayName,
        year: type === "movie" ? year : "",
        rawTitle: r.rawTitle,
        size: r.size,
        time: r.time,
      })

      streams.push({
        name: "⏵ Prehraj.to",
        title,
        url: video,
        qRank: qualityRank(q),
        fRank: formatRank(fmt),
        sizeBytes: r.sizeBytes || 0,
      })
    }
  }

  // “inteligentné” triedenie: kvalita > formát > veľkosť
  streams.sort((a, b) => {
    if (b.qRank !== a.qRank) return b.qRank - a.qRank
    if (b.fRank !== a.fRank) return b.fRank - a.fRank
    return (b.sizeBytes || 0) - (a.sizeBytes || 0)
  })

  console.log("✅ Found streams:", streams.length)

  return {
    streams: streams.map(({ qRank, fRank, sizeBytes, ...s }) => s),
  }
})

/* ================= SERVER ================= */

serveHTTP(builder.getInterface(), {
  port: PORT,
  address: ADDR,
})

console.log(`🚀 Prehraj.to addon beží na porte ${PORT}`)
console.log(`📄 Manifest: /manifest.json`)
