const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")
const fs = require("fs")
const path = require("path")

/* ================= MANIFEST ================= */

function loadIconDataUri() {
  try {
    const p = path.join(__dirname, "icon.png")
    const b64 = fs.readFileSync(p).toString("base64")
    return `data:image/png;base64,${b64}`
  } catch (e) {
    // keď icon.png chýba, addon stále funguje
    return undefined
  }
}

const manifest = {
  id: "community.prehrajto",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehraj.to – CZ/SK, dabing, titulky (auto párovanie cez Cinemeta)",
  icon: loadIconDataUri(),
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: []
}

const builder = new addonBuilder(manifest)

/* ================= HTTP CLIENT ================= */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

const http = axios.create({
  timeout: 20000,
  headers: { "User-Agent": UA }
})

/* ================= CACHE ================= */

const CACHE_TTL = 30 * 60 * 1000 // 30 min
const cacheSearch = new Map() // query -> results
const cachePageHtml = new Map() // pageUrl -> html
const cacheStream = new Map() // pageUrl -> videoUrl

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
    .replace(/[^a-z0-9]+/g, "")
}

function pad2(n) {
  return String(n).padStart(2, "0")
}

function parseSizeToBytes(text) {
  // napr. "7.26 GB", "850 MB"
  const t = String(text || "").replace(",", ".").trim().toUpperCase()
  const m = t.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)/)
  if (!m) return null
  const val = parseFloat(m[1])
  const unit = m[2]
  const mul =
    unit === "KB" ? 1024 :
    unit === "MB" ? 1024 ** 2 :
    unit === "GB" ? 1024 ** 3 :
    unit === "TB" ? 1024 ** 4 : 1
  return Math.round(val * mul)
}

function parseDurationFromText(text) {
  // veľmi jednoduché: hľadá "2h 58m" alebo "2h58m" alebo "01:11:28"
  const t = String(text || "").trim()

  const hms = t.match(/(\d{1,2}):(\d{2}):(\d{2})/)
  if (hms) return `${hms[1]}:${hms[2]}:${hms[3]}`

  const hm = t.match(/(\d+)\s*h\s*(\d+)\s*m/i) || t.match(/(\d+)h(\d+)m/i)
  if (hm) return `${hm[1]}h ${hm[2]}m`

  return null
}

function detectQuality(title) {
  const t = title.toLowerCase()
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return { label: "4K", rank: 4 }
  if (t.includes("1080") || t.includes("fullhd") || t.includes("fhd")) return { label: "FULLHD", rank: 3 }
  if (t.includes("720") || t.includes("hd")) return { label: "HD", rank: 2 }
  return { label: "SD", rank: 1 }
}

function detectSource(title) {
  const t = title.toLowerCase()
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bdremux")) return "BluRay"
  if (t.includes("web-dl") || t.includes("webdl")) return "WEB-DL"
  if (t.includes("webrip")) return "WEBRip"
  if (t.includes("hdtv")) return "HDTV"
  if (t.includes("dvdrip")) return "DVDRip"
  return ""
}

function detectHDR(title) {
  const t = title.toLowerCase()
  if (t.includes("hdr") || t.includes("dolby vision") || t.includes("dv")) return true
  return false
}

function detectLang(title) {
  const t = title.toLowerCase()
  // preferujeme CZ/SK info
  const czDab = /cz.*dab|dab.*cz|czdabing|cz dabing/.test(t)
  const skDab = /sk.*dab|dab.*sk|skdabing|sk dabing/.test(t)
  const czSub = /cz.*tit|cz.*sub|titulky|cz titulky|cz sub/.test(t)

  if (czDab) return "CZ"
  if (skDab) return "SK"
  if (czSub) return "CZ-Sub"
  // fallback: občas sú tam značky "cz" alebo "sk"
  if (/\bcz\b/.test(t)) return "CZ"
  if (/\bsk\b/.test(t)) return "SK"
  return ""
}

function isEpisodeMatch(title, s, e) {
  const t = title.toLowerCase()
  const s2 = String(s).padStart(2, "0")
  const e2 = String(e).padStart(2, "0")
  return (
    t.includes(`s${s2}e${e2}`) ||
    t.includes(`${parseInt(s2, 10)}x${e2}`) ||
    t.includes(`${parseInt(s2, 10)}x${parseInt(e2, 10)}`)
  )
}

function buildQueries(name, year, s, e) {
  const q = []
  if (s && e) {
    q.push(`${name} S${s}E${e}`)
    q.push(`${name} ${parseInt(s, 10)}x${parseInt(e, 10)}`)
  }
  if (year) q.push(`${name} ${year}`)
  q.push(name)
  return [...new Set(q.filter(Boolean))]
}

/* ================= ICONS & "HELLSPY FEELING" ================= */

function langIcon(lang) {
  if (lang === "CZ") return "cz"
  if (lang === "SK") return "sk"
  if (lang === "CZ-Sub") return "cz 💬"
  return ""
}

function titleToIcons(rawTitle) {
  const q = detectQuality(rawTitle)
  const src = detectSource(rawTitle)
  const hdr = detectHDR(rawTitle)
  const lang = detectLang(rawTitle)

  const icons = []
  // jazyk hore (ako hellspy vibe)
  if (lang) icons.push(langIcon(lang))

  // kvalita
  if (q.label === "4K") icons.push("🌍")
  else if (q.label === "FULLHD") icons.push("🖥️")
  else if (q.label === "HD") icons.push("📺")
  else icons.push("📼")

  // HDR / zdroj
  if (hdr) icons.push("🌈")
  if (src) {
    if (src === "BluRay") icons.push("💿")
    else if (src === "WEB-DL") icons.push("🌐")
    else if (src === "WEBRip") icons.push("📡")
    else icons.push("🎞️")
  }

  return { icons: icons.join(" "), quality: q, src, hdr, lang }
}

function computeScore(rawTitle) {
  const t = rawTitle.toLowerCase()
  let score = 0

  // jazyk
  if (/cz.*dab|dab.*cz|czdabing/.test(t)) score += 1200
  else if (/sk.*dab|dab.*sk|skdabing/.test(t)) score += 1100
  else if (/titulky|cz.*tit|cz.*sub/.test(t)) score += 600

  // kvalita
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) score += 900
  else if (t.includes("1080") || t.includes("fullhd") || t.includes("fhd")) score += 700
  else if (t.includes("720") || t.includes("hd")) score += 500
  else score += 200

  // HDR & zdroj
  if (t.includes("hdr") || t.includes("dolby vision") || t.includes("dv")) score += 400
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bdremux")) score += 350
  else if (t.includes("web-dl") || t.includes("webdl")) score += 250
  else if (t.includes("webrip")) score += 200

  return score
}

/* ================= SCRAPING ================= */

async function searchPrehrajto(query) {
  const cached = getCache(cacheSearch, query)
  if (cached) return cached

  const url = `https://prehrajto.cz/hledej/${encodeURIComponent(query)}`
  const { data } = await http.get(url)

  const $ = cheerio.load(data)
  const results = []

  $(".video--link").each((_, el) => {
    const href = $(el).attr("href")
    const title = $(el).find(".video__title").text().trim()

    if (!href || !title) return
    if (title.toLowerCase().includes("trailer")) return

    // metadáta (size, time) sú v tagoch – skúsime vytiahnuť konkrétne
    const sizeText = $(el).find(".video__tag--size").text().trim() || ""
    const timeText = $(el).find(".video__tag--time").text().trim() || ""

    // fallback: všetky tagy dokopy
    const metaAll = $(el).find(".video__tag").text().trim() || ""

    const page = "https://prehrajto.cz" + href
    const sizeBytes = parseSizeToBytes(sizeText || metaAll)
    const duration = parseDurationFromText(timeText || metaAll)

    results.push({
      page,
      rawTitle: title,
      normTitle: normalize(title),
      sizeText: sizeText || "",
      timeText: timeText || "",
      metaAll,
      sizeBytes,
      duration
    })
  })

  setCache(cacheSearch, query, results)
  return results
}

async function getPageHtml(pageUrl) {
  const cached = getCache(cachePageHtml, pageUrl)
  if (cached) return cached

  const { data } = await http.get(pageUrl)
  setCache(cachePageHtml, pageUrl, data)
  return data
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const html = await getPageHtml(pageUrl)

  // najčastejšie: file: "https:...."
  let m = html.match(/file:\s*"(https:[^"]+)"/)
  if (!m) {
    // fallback niekedy býva src: "https..."
    m = html.match(/src:\s*"(https:[^"]+)"/)
  }

  const video = m ? m[1] : null
  if (video) setCache(cacheStream, pageUrl, video)
  return video
}

/* ================= META (CINEMETA) ================= */

async function fetchCinemeta(type, id) {
  // Dôležité: pre series epizódu typu ttXXXX:1:1 je meta na base ttXXXX
  const isEpisodeId = type === "series" && String(id).includes(":")
  const baseId = isEpisodeId ? String(id).split(":")[0] : id

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`
  const res = await http.get(url)
  return { meta: res.data && res.data.meta ? res.data.meta : null, baseId, isEpisodeId }
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    console.log("STREAM REQ:", { type, id })

    const { meta, isEpisodeId } = await fetchCinemeta(type, id)
    if (!meta) return { streams: [] }

    const name = meta.name
    const year = meta.year

    let s = ""
    let e = ""

    if (type === "series") {
      // pokus 1: z id tt..:S:E
      if (String(id).includes(":")) {
        const parts = String(id).split(":")
        if (parts.length >= 3) {
          s = pad2(parts[1])
          e = pad2(parts[2])
        }
      }

      // pokus 2: ak by sedelo video id v meta.videos (niekedy pomôže)
      if ((!s || !e) && Array.isArray(meta.videos)) {
        const ep = meta.videos.find(v => v && v.id === id)
        if (ep) {
          s = pad2(ep.season)
          e = pad2(ep.episode)
        }
      }
    }

    const queries = buildQueries(name, year, s, e)

    const streams = []
    const seen = new Set()

    const normName = normalize(name)

    for (const q of queries) {
      const results = await searchPrehrajto(q)

      for (const r of results) {
        if (seen.has(r.page)) continue

        // základné párovanie názvu (aby nebral hovadiny)
        // (pri seriáloch necháme trochu voľnejšie, lebo názvy epizód bývajú divné)
        const okName = r.normTitle.includes(normName) || normName.includes(r.normTitle)
        if (type === "movie" && !okName) continue

        // seriál: musí sedieť epizóda, ak máme S/E
        if (type === "series") {
          if (s && e) {
            if (!isEpisodeMatch(r.rawTitle, s, e)) continue
          } else {
            // ak nemáme s/e, radšej nevracaj nič (aby to nebolo random)
            continue
          }
        }

        const video = await extractStream(r.page)
        if (!video) continue

        seen.add(r.page)

        const { icons, quality, src, hdr, lang } = titleToIcons(r.rawTitle)

        // “Hellspy feeling”: ľavý stĺpec je `name`, vpravo multiline `title`
        // 1. riadok: jazyk + ikonky + názov
        // 2. riadok: kvalita + zdroj + HDR
        // 3. riadok: veľkosť + čas (ak je)
        const row1 = `${icons}  ${r.rawTitle}`
        const row2Parts = []
        if (quality?.label) row2Parts.push(quality.label)
        if (src) row2Parts.push(src)
        if (hdr) row2Parts.push("HDR")
        const row2 = row2Parts.length ? row2Parts.join("  ") : ""

        const row3Parts = []
        if (r.sizeText) row3Parts.push(`💾 ${r.sizeText}`)
        if (r.duration) row3Parts.push(`⏱ ${r.duration}`)
        const row3 = row3Parts.join("   ")

        const prettyTitle = [row1, row2, row3].filter(Boolean).join("\n")

        const score = computeScore(r.rawTitle)

        streams.push({
          name: "Prehraj.to",
          title: prettyTitle,
          url: video,
          _score: score,
          _qRank: quality.rank,
          _size: r.sizeBytes || 0,
          _lang: lang || ""
        })
      }
    }

    // Inteligentné triedenie:
    // 1) kvalita (4K > 1080 > 720 > SD)
    // 2) v rámci kvality väčšia veľkosť vyššie
    // 3) potom score (jazyk/zdroj/HDR)
    streams.sort((a, b) => {
      if (b._qRank !== a._qRank) return b._qRank - a._qRank
      if ((b._size || 0) !== (a._size || 0)) return (b._size || 0) - (a._size || 0)
      return (b._score || 0) - (a._score || 0)
    })

    // vráť len Stremio polia
    const out = streams.map(s => ({ name: s.name, title: s.title, url: s.url }))

    console.log(`✅ Streams found: ${out.length}`)
    return { streams: out }
  } catch (err) {
    console.error("❌ Stream handler error:", err?.message || err)
    return { streams: [] }
  }
})

/* ================= SERVER (Render + Local) ================= */

const PORT = process.env.PORT || 7001

serveHTTP(builder.getInterface(), {
  port: PORT,
  address: "0.0.0.0"
})

console.log(`🚀 Prehraj.to addon beží na porte ${PORT}`)
console.log(`📄 Manifest: /manifest.json`)
