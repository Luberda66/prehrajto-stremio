const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")
const path = require("path")
const fs = require("fs")

/* ================= MANIFEST ================= */

const BASE_URL = process.env.PUBLIC_URL || "" // na Render si to nechaj prázdne, Stremio použije URL z manifestu

const manifest = {
  id: "community.prehrajto",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z prehrajto.cz – CZ/SK, dabing, titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  // ⚠️ Stremio logo vie byť URL. Ak máš repo private, RAW z GitHubu nepôjde.
  // Keď bude repo public, môžeš sem dať raw link na icon.png.
  // logo: "https://raw.githubusercontent.com/<user>/<repo>/main/icon.png",
}

const builder = new addonBuilder(manifest)

/* ================= AXIOS (anti-bot friendly) ================= */

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "sk-SK,sk;q=0.9,cs-CZ;q=0.8,cs;q=0.7,en;q=0.5",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Connection: "keep-alive",
  },
})

/* ================= CACHE ================= */

const CACHE_TTL = 30 * 60 * 1000
const cacheSearch = new Map()
const cacheStream = new Map()
const cacheMeta = new Map()

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

function parseStremioId(type, id) {
  // movie: tt0499549
  // series episode: tt4574334:1:1  (imdb:season:episode)
  if (type !== "series") return { imdb: id, season: null, episode: null, fullId: id }
  const parts = String(id).split(":")
  const imdb = parts[0]
  const season = parts[1] ? pad2(parts[1]) : null
  const episode = parts[2] ? pad2(parts[2]) : null
  return { imdb, season, episode, fullId: id }
}

function buildQueries(name, year, season, episode) {
  const q = []
  if (season && episode) {
    q.push(`${name} S${season}E${episode}`)
    q.push(`${name} ${season}x${episode}`)
    q.push(`${name} s${season}e${episode}`)
    q.push(`${name} ${season}e${episode}`)
  }
  if (year) q.push(`${name} ${year}`)
  q.push(name)
  return [...new Set(q.filter(Boolean))]
}

function isEpisodeMatch(title, season, episode) {
  if (!season || !episode) return true
  const t = (title || "").toLowerCase()
  return (
    t.includes(`s${season}e${episode}`) ||
    t.includes(`${parseInt(season, 10)}x${parseInt(episode, 10)}`) ||
    t.includes(`${season}x${episode}`)
  )
}

/* ================= PARSE QUALITY / SIZE / TIME ================= */

function parseQuality(title) {
  const t = (title || "").toLowerCase()
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return "4K"
  if (t.includes("1080")) return "FULLHD"
  if (t.includes("720")) return "HD"
  return "SD"
}

function parseSourceFlags(title) {
  const t = (title || "").toLowerCase()
  const flags = []
  if (t.includes("hdr")) flags.push("HDR")
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bdremux")) flags.push("BluRay")
  if (t.includes("web-dl") || t.includes("webdl")) flags.push("WEB-DL")
  if (t.includes("webrip")) flags.push("WEBRip")
  return flags
}

function parseLangFlags(title) {
  const t = (title || "").toLowerCase()
  const flags = []
  if (/cz.*dab|dab.*cz|czdabing/.test(t)) flags.push("CZ")
  if (/sk.*dab|dab.*sk/.test(t)) flags.push("SK")
  if (/titulky|subs|sub|cz.*tit|cz.*sub/.test(t)) flags.push("SUB")
  return flags
}

function streamIcons(title) {
  const t = (title || "").toLowerCase()
  let icons = "🔗"

  const langs = parseLangFlags(t)
  if (langs.includes("CZ")) icons += " 🇨🇿"
  if (langs.includes("SK")) icons += " 🇸🇰"
  if (langs.includes("SUB")) icons += " 💬"

  const q = parseQuality(t)
  if (q === "4K") icons += " 🚀"
  else if (q === "FULLHD") icons += " 🎬"
  else if (q === "HD") icons += " 📺"
  else icons += " 📼"

  const src = parseSourceFlags(t)
  if (src.includes("HDR")) icons += " 🌈"
  if (src.includes("BluRay")) icons += " 💿"
  if (src.includes("WEB-DL")) icons += " 🌐"
  if (src.includes("WEBRip")) icons += " 📡"

  return icons
}

/* ================= SCORE / SORT ================= */

function qualityRank(q) {
  if (q === "4K") return 4
  if (q === "FULLHD") return 3
  if (q === "HD") return 2
  return 1
}

function computeScore(title, sizeBytes) {
  const t = (title || "").toLowerCase()
  let score = 0

  // jazyk
  if (/cz.*dab|dab.*cz|czdabing/.test(t)) score += 1200
  else if (/sk.*dab|dab.*sk/.test(t)) score += 1000
  else if (/titulky|cz.*tit|cz.*sub/.test(t)) score += 600

  // kvalita
  const q = parseQuality(t)
  score += qualityRank(q) * 1000

  // zdroj
  if (t.includes("hdr")) score += 700
  if (t.includes("bluray") || t.includes("bdrip") || t.includes("bdremux")) score += 550
  else if (t.includes("web-dl") || t.includes("webdl")) score += 450
  else if (t.includes("webrip")) score += 350

  // veľkosť len jemne (aby 4K menšie neprepadlo pod 1080)
  if (typeof sizeBytes === "number") score += Math.min(400, Math.floor(sizeBytes / (1024 * 1024 * 1024)) * 25)

  return score
}

function parseSizeToBytes(text) {
  // napr: "7.26 GB" / "850 MB"
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

    // tagy (prehrajto má často viac tagov – size/time/quality...)
    const tags = []
    $(el)
      .find(".video__tag")
      .each((__, tagEl) => {
        const t = $(tagEl).text().trim()
        if (t) tags.push(t)
      })

    if (!href || !title) return
    if (title.toLowerCase().includes("trailer")) return

    // pokus o size/time z tagov
    const tagText = tags.join(" · ")
    const sizeMatch = tags.find((x) => /(\d+[.,]?\d*)\s*(GB|MB|TB)/i.test(x)) || ""
    const timeMatch =
      tags.find((x) => /(\d+h)?\s*\d+m/i.test(x)) || tags.find((x) => /:\d\d:\d\d/.test(x)) || ""

    results.push({
      page: "https://prehrajto.cz" + href,
      rawTitle: title,
      normTitle: normalize(title),
      tags,
      tagText,
      sizeText: sizeMatch,
      timeText: timeMatch,
      sizeBytes: parseSizeToBytes(sizeMatch),
    })
  })

  setCache(cacheSearch, query, results)
  return results
}

async function extractStream(pageUrl) {
  const cached = getCache(cacheStream, pageUrl)
  if (cached) return cached

  const { data } = await http.get(pageUrl)

  // najčastejšie: file: "https://....mp4"
  const m = data.match(/file:\s*"(https:[^"]+)"/)
  const video = m ? m[1] : null

  if (video) setCache(cacheStream, pageUrl, video)
  return video
}

/* ================= CINEMETA META ================= */

async function getCinemetaMeta(type, imdb, fullId) {
  const key = `${type}:${imdb}:${fullId || ""}`
  const cached = getCache(cacheMeta, key)
  if (cached) return cached

  // IMPORTANT: pri series epizóde musíme ťahať meta seriálu cez imdb bez :S:E
  const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`
  const res = await axios.get(metaUrl, { timeout: 15000 })
  const meta = res.data && res.data.meta ? res.data.meta : null

  setCache(cacheMeta, key, meta)
  return meta
}

/* ================= STREAM HANDLER ================= */

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const { imdb, season, episode, fullId } = parseStremioId(type, id)

    console.log("STREAM REQ:", { type, id, imdb, season, episode })

    const meta = await getCinemetaMeta(type, imdb, fullId)
    if (!meta) return { streams: [] }

    const name = meta.name
    const year = meta.year

    // pri seriáloch skúsime nájsť epizódu v meta.videos podľa fullId
    let s = season
    let e = episode

    if (type === "series" && Array.isArray(meta.videos)) {
      const ep = meta.videos.find((v) => v.id === fullId)
      if (ep) {
        s = pad2(ep.season)
        e = pad2(ep.episode)
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

        // jemnejšie párovanie názvu (pri seriáloch môžu byť rôzne varianty)
        const okName =
          r.normTitle.includes(normName) ||
          normName.includes(r.normTitle) ||
          r.normTitle.includes(normalize(name.split(" ")[0]))

        if (!okName) continue
        if (type === "series" && !isEpisodeMatch(r.rawTitle, s, e)) continue

        const video = await extractStream(r.page)
        if (!video) continue

        seen.add(r.page)

        const quality = parseQuality(r.rawTitle)
        const srcFlags = parseSourceFlags(r.rawTitle).join(" ")
        const sizeLine = r.sizeText ? `💾 ${r.sizeText}` : ""
        const timeLine = r.timeText ? `⏱️ ${r.timeText}` : ""

        // “Hellspy feeling” = viac riadkov v title (Stremio to často zobrazí pekne pod sebou)
        const line1 = `▶️ Prehraj.to (CZ/SK)`
        const line2 = `${streamIcons(r.rawTitle)} ${r.rawTitle}`
        const line3 = [
          `🖥️ ${quality}`,
          srcFlags ? `| ${srcFlags}` : "",
          sizeLine ? `| ${sizeLine}` : "",
          timeLine ? `| ${timeLine}` : "",
        ]
          .filter(Boolean)
          .join(" ")

        streams.push({
          title: `${line1}\n${line2}\n${line3}`,
          url: video,
          score: computeScore(r.rawTitle, r.sizeBytes),
          _qualityRank: qualityRank(quality),
          _sizeBytes: r.sizeBytes || 0,
        })
      }
    }

    // inteligentné radenie:
    // 1) score (kvalita+jazyk+HDR)
    // 2) kvalita
    // 3) veľkosť v rámci kvality
    streams.sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0)
      if ((b._qualityRank || 0) !== (a._qualityRank || 0)) return (b._qualityRank || 0) - (a._qualityRank || 0)
      return (b._sizeBytes || 0) - (a._sizeBytes || 0)
    })

    // odstránime interné polia
    const out = streams.map(({ _qualityRank, _sizeBytes, ...x }) => x)

    console.log(`✅ Found streams: ${out.length}`)
    return { streams: out }
  } catch (err) {
    console.log("❌ Stream handler error:", err?.message || err)
    return { streams: [] }
  }
})

/* ================= SERVER (Render friendly) ================= */

const PORT = Number(process.env.PORT || 7001)

serveHTTP(builder.getInterface(), {
  port: PORT,
  address: "0.0.0.0",
})

console.log(`🚀 Prehraj.to addon beží na porte ${PORT}`)
console.log(`📄 Manifest: /manifest.json`)
