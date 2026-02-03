"use strict"

const http = require("http")
const axios = require("axios")
const cheerio = require("cheerio")
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")

// ======================================================
// CONFIG
// ======================================================

const ADDON_PORT = parseInt(process.env.PORT || "7001", 10)
const TMDB_KEY =
  process.env.TMDB_KEY || "f69f0cab027c48a502e74a6c3019c57a" // môžeš prepísať env premennou

// Limity
const stopAt = 60 // max streamov, čo vrátime

// Prehraj.to base (pre istotu keď by redirectovalo)
const PREHRAJTO_BASE = "https://prehrajto.cz"

// ======================================================
// MANIFEST
// ======================================================

const manifest = {
  id: "community.prehrajto.czsk",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z Prehraj.to – CZ/SK",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  logo: "https://raw.githubusercontent.com/Luberda66/prehrajto-stremio/main/icon.png",
}

// ======================================================
// HELPERS
// ======================================================

function safeStr(v) {
  return v == null ? "" : String(v)
}

function normalize(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleMatches(candidate, wantedNames) {
  const c = normalize(candidate)
  if (!c) return false
  for (const n of wantedNames) {
    const nn = normalize(n)
    if (!nn) continue
    if (c.includes(nn)) return true
  }
  return false
}

function parseSizeToBytes(text) {
  const t = safeStr(text).replace(",", ".").toLowerCase()
  const m = t.match(/(\d+(?:\.\d+)?)\s*(gb|g|mb|m|kb|k|tb|t)\b/)
  if (!m) return 0
  const num = parseFloat(m[1])
  const unit = m[2]
  const map = {
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  }
  return Math.round(num * (map[unit] || 0))
}

function formatBytes(bytes) {
  const b = Number(bytes || 0)
  if (!b) return ""
  const gb = b / (1024 ** 3)
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 2)} GB`.replace(".00", "")
  const mb = b / (1024 ** 2)
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 2)} MB`.replace(".00", "")
  return `${Math.round(b / 1024)} KB`
}

function qualityFromTitle(raw) {
  const t = String(raw || "").toLowerCase()

  // 2160 / 4k
  if (/(2160p|4k|uhd)/.test(t)) return "4K"

  // 1080 -> FullHD
  if (/(1080p|full\s*hd)/.test(t)) return "FullHD"

  // 720 -> HD
  if (/(720p|[^a-z]hd[^a-z])/.test(t)) return "HD"

  // 480/576/360 -> SD
  if (/(480p|576p|360p|sd)/.test(t)) return "SD"

  return "?"
}

function isHdr(raw) {
  const t = String(raw || "").toLowerCase()
  return /(hdr10\+?|dolby\s*vision|dv\b|hdr\b)/.test(t)
}

function languageScore(raw) {
  const t = String(raw || "").toLowerCase()

  // CZ/SK priorita
  if (/(cz|czech|česk|cesk|dabing|dubbing)/.test(t)) return 100
  if (/(sk|slovak|slovensk)/.test(t)) return 80

  // pôvodné/ostatné
  return 10
}

function resScore(q) {
  if (q === "4K") return 400
  if (q === "FullHD") return 300
  if (q === "HD") return 200
  if (q === "SD") return 100
  return 0
}

function bitrateFromSizeAndTime(sizeBytes, minutes) {
  const b = Number(sizeBytes || 0)
  const m = Number(minutes || 0)
  if (!b || !m) return 0
  const seconds = m * 60
  const bits = b * 8
  const bps = bits / seconds
  const mbps = bps / 1_000_000
  return mbps
}

function formatMbps(mbps) {
  if (!mbps || !isFinite(mbps)) return ""
  return `${mbps.toFixed(mbps >= 10 ? 0 : 1)} Mbps`
}

function isJunkRelease(rawTitle) {
  const t = String(rawTitle || "").toLowerCase()
  // promo/nesúvisiace
  if (t.includes("nahla") && t.includes("video")) return true
  if (t.includes("stah") && t.includes("soubor")) return true
  if (t.includes("vyzkousejte") && t.includes("prehravac")) return true
  if (t.includes("aplikaci") && t.includes("prehraj")) return true
  if (t.includes("google") && t.includes("play")) return true
  if (t.includes("video stopped")) return true
  return false
}

function isEpisodeMatchAny(text, season, episode) {
  const s = Number(season)
  const e = Number(episode)
  if (!s || !e) return false

  const t = String(text || "").toLowerCase()

  // S01E02 / s1e2 / S1 E2
  const re1 = new RegExp(`s\\s*0?${s}\\s*[\\._\\-\\s]*e\\s*0?${e}(?!\\d)`, "i")

  // 1x02 / 01x02
  const re2 = new RegExp(`0?${s}\\s*[x×]\\s*0?${e}(?!\\d)`, "i")

  // "season 1 episode 2"
  const re3 = new RegExp(`season\\s*0?${s}.*episode\\s*0?${e}(?!\\d)`, "i")

  // CZ/SK: slabší fallback – keď sa spomenie aj sezóna aj diel
  const hasSeasonWord = new RegExp(
    `(s(eason)?\\s*0?${s})|(\\b0?${s}\\b\\s*(serie|sezon|séria|sezona))`,
    "i"
  ).test(t)
  const hasEpisodeWord = new RegExp(
    `(e(pisode)?\\s*0?${e})|(d[ií]l\\s*0?${e})|(ep\\.?\\s*0?${e})`,
    "i"
  ).test(t)

  return re1.test(t) || re2.test(t) || re3.test(t) || (hasSeasonWord && hasEpisodeWord)
}

function buildUiBlock({ displayName, year, rawTitle, size, time, video }) {
  const q = qualityFromTitle(rawTitle)
  const hdr = isHdr(rawTitle)

  const sizeText = formatBytes(size)
  const mbps = bitrateFromSizeAndTime(size, time)
  const mbpsText = formatMbps(mbps)

  const lang = languageScore(rawTitle) >= 100 ? "CZ" : languageScore(rawTitle) >= 80 ? "SK" : ""

  const line1 = `${displayName}${year ? `(${year})` : ""} • ${q}${sizeText ? ` • ${sizeText}` : ""}`
  const line2 = `${lang ? `🌐 ${lang}` : "🌐"}${q ? `  📺 ${q}` : ""}${hdr ? "  🌈 HDR" : ""}`
  const line3 = `${mbpsText ? `⚡ ${mbpsText}` : ""}${time ? `  🕒 ${time}m` : ""}`.trim()

  // Stremio title multi-line
  // (URL samotný Stremio zobrazí cez stream.url)
  return [line1, line2, line3].filter(Boolean).join("\n")
}

// ======================================================
// HTTP FETCH (PREHRAJTO)
// ======================================================

async function httpGet(url) {
  return axios.get(url, {
    timeout: 25000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "cs-CZ,cs;q=0.9,sk-SK;q=0.8,sk;q=0.7,en;q=0.4",
      Referer: PREHRAJTO_BASE + "/",
    },
    validateStatus: (s) => s >= 200 && s < 400,
  })
}

function absUrl(u) {
  const s = safeStr(u)
  if (!s) return ""
  if (s.startsWith("http")) return s
  if (s.startsWith("/")) return PREHRAJTO_BASE + s
  return PREHRAJTO_BASE + "/" + s
}

async function searchPrehrajto(query) {
  const q = encodeURIComponent(query)
  const url = `${PREHRAJTO_BASE}/hledej/${q}`

  const res = await httpGet(url)
  const $ = cheerio.load(res.data)

  const out = []

  // zachytávanie "kariet" s výsledkami
  // prehraj.to to občas mení, preto berieme viac možností selektorov
  const items = $(".video, .video-item, .box, .item, .thumb").toArray()

  for (const el of items) {
    const a = $(el).find("a").first()
    const href = a.attr("href")
    if (!href) continue

    const title =
      $(el).find(".title").first().text().trim() ||
      a.attr("title") ||
      a.text().trim() ||
      $(el).text().trim()

    if (!title) continue

    // veľkosť býva v kartách
    const sizeText =
      $(el).find(".size").first().text().trim() ||
      $(el).text().match(/(\d+(?:[.,]\d+)?)\s*(GB|MB|KB|TB)\b/i)?.[0] ||
      ""

    out.push({
      rawTitle: title,
      page: absUrl(href),
      size: parseSizeToBytes(sizeText),
    })
  }

  // fallback: keď selektory nič nedali, aspoň linky
  if (out.length === 0) {
    $("a[href^='/']").each((_, a) => {
      const href = $(a).attr("href")
      const t = $(a).attr("title") || $(a).text()
      if (!href || !t) return
      const title = safeStr(t).trim()
      if (!title) return
      out.push({ rawTitle: title, page: absUrl(href), size: 0 })
    })
  }

  // jemné čistenie duplicitných stránok
  const seen = new Set()
  const uniq = []
  for (const r of out) {
    if (!r || !r.page) continue
    if (seen.has(r.page)) continue
    seen.add(r.page)
    uniq.push(r)
  }

  return uniq
}

async function extractStream(pageUrl) {
  const res = await httpGet(pageUrl)
  const html = safeStr(res.data)

  // priame m3u8/mp4 v HTML (najčastejšie)
  let direct =
    html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)?.[0] ||
    html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i)?.[0] ||
    null

  // často je to v JS ako: file: "https://....mp4?...token..."
  if (!direct) {
    direct = html.match(/file\s*:\s*"([^"]+)"/i)?.[1] || null
  }

  if (direct) {
    const u = String(direct)
    // nechceme promo/redirect stránky – len priame video
    const ok = /\.(m3u8|mp4)(\?|$)/i.test(u) || /premiumcdn\.net|pf-storage/i.test(u)
    if (!ok) return null
    return u
  }

  return null
}

// ======================================================
// CINEMETA
// ======================================================

async function getCinemetaMeta(type, id) {
  // Cinemeta meta je spoľahlivé (názov, rok, atď.)
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`
  const res = await axios.get(url, { timeout: 12000 })
  return res.data && res.data.meta ? res.data.meta : null
}

function buildWantedNames(meta) {
  const names = []
  if (!meta) return names

  if (meta.name) names.push(meta.name)
  if (meta.originalName) names.push(meta.originalName)

  // niekedy je v meta aj alternatívny názov
  if (Array.isArray(meta.aliases)) {
    for (const a of meta.aliases) if (a) names.push(a)
  }

  // uniq
  const seen = new Set()
  const out = []
  for (const n of names) {
    const k = normalize(n)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

// ======================================================
// STREAM HANDLER
// ======================================================

const builder = new addonBuilder(manifest)

builder.defineStreamHandler(async (args) => {
  const { type, id } = args || {}
  if (!type || !id) return { streams: [] }

  const streams = []
  const deferredEpisodeCandidates = []

  // id pre seriály je tt...:season:episode
  let imdbId = id
  let season = null
  let episode = null

  if (type === "series" && String(id).includes(":")) {
    const parts = String(id).split(":")
    imdbId = parts[0]
    season = parts[1] ? parseInt(parts[1], 10) : null
    episode = parts[2] ? parseInt(parts[2], 10) : null
  }

  let meta = null
  try {
    meta = await getCinemetaMeta(type === "series" ? "series" : "movie", imdbId)
  } catch (e) {
    console.error("cinemeta error:", e && e.message ? e.message : e)
  }

  const cinName = meta?.name || ""
  const year = meta?.releaseInfo ? safeStr(meta.releaseInfo).slice(0, 4) : ""

  const wantedNames = buildWantedNames(meta)
  const baseQuery = wantedNames[0] || cinName || imdbId

  // query pre seriály doplníme o SxxEyy
  let query = baseQuery
  if (type === "series" && season && episode) {
    query = `${baseQuery} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
  }

  let results = []
  try {
    results = await searchPrehrajto(query)
  } catch (e) {
    console.error("search error:", e && e.message ? e.message : e)
    return { streams: [] }
  }

  const seen = new Set()

  for (const r of results.slice(0, 150)) {
    if (streams.length >= stopAt) break
    if (!r || !r.page || !r.rawTitle) continue

    // filtrovanie odpadu ešte pred tým, než ideme na detail
    if (isJunkRelease(r.rawTitle)) continue

    // pri seriáloch sa pokúsime strážiť epizódu (ale s fallbackom)
    if (type === "series" && season && episode) {
      const okEp =
        isEpisodeMatchAny(r.rawTitle, season, episode) ||
        isEpisodeMatchAny(r.page, season, episode)
      if (!okEp) {
        deferredEpisodeCandidates.push(r)
        continue
      }
    }

    // aspoň názov nech sedí
    if (!titleMatches(r.rawTitle, wantedNames)) continue

    const video = await extractStream(r.page)
    if (!video) continue

    const key = `v:${video}`
    if (seen.has(key)) continue
    seen.add(key)

    const displayName =
      type === "series" && season && episode
        ? `${wantedNames[0] || cinName} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
        : wantedNames[0] || cinName

    // dĺžku zatiaľ nevyťahujeme z prehraj.to spoľahlivo – nech je radšej prázdna než blbosť
    const title = buildUiBlock({
      displayName,
      year,
      rawTitle: r.rawTitle,
      size: r.size,
      time: "",
      video,
    })

    streams.push({ title, url: video })
  }

  // Fallback pre seriály: keď ep-check nič nepustí (iný formát názvu na prehraj.to),
  // skús ešte pár kandidátov bez ep-checku.
  if (type === "series" && season && episode && streams.length === 0 && deferredEpisodeCandidates.length) {
    for (const r of deferredEpisodeCandidates.slice(0, 20)) {
      if (streams.length >= stopAt) break
      if (seen.has(r.page)) continue
      if (isJunkRelease(r.rawTitle)) continue
      if (!titleMatches(r.rawTitle, wantedNames)) continue

      const video = await extractStream(r.page)
      if (!video) continue

      const key = `v:${video}`
      if (seen.has(key)) continue
      seen.add(r.page)
      seen.add(key)

      const displayName = `${wantedNames[0] || cinName} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      const title = buildUiBlock({
        displayName,
        year: "",
        rawTitle: r.rawTitle,
        size: r.size,
        time: "",
        video,
      })

      streams.push({ title, url: video })
    }
  }

  // Triedenie: CZ/SK > kvalita > veľkosť
  streams.sort((a, b) => {
    const at = safeStr(a.title)
    const bt = safeStr(b.title)

    const as = languageScore(at)
    const bs = languageScore(bt)
    if (bs !== as) return bs - as

    const aq = resScore(qualityFromTitle(at))
    const bq = resScore(qualityFromTitle(bt))
    if (bq !== aq) return bq - aq

    // veľkosť len približne: je už v titulku, takže necháme stabilné
    return 0
  })

  return { streams }
})

const addonInterface = builder.getInterface()

// ======================================================
// START SERVER
// ======================================================

serveHTTP(addonInterface, { port: ADDON_PORT, address: "0.0.0.0" })

console.log(`🚀 Prehraj.to addon beží na: http://0.0.0.0:${ADDON_PORT}`)
console.log(`📌 Manifest: /manifest.json`)
console.log(`🌐 HTTP addon accessible at: http://127.0.0.1:${ADDON_PORT}/manifest.json`)
console.log(
  `👉 Android TV použi IP tvojho PC, napr.: http://192.168.0.175:${ADDON_PORT}/manifest.json`
)

// exporty kvôli Vercel / api wrapperom (ak sa niekedy vrátiš späť)
module.exports = { addonInterface, manifest }
