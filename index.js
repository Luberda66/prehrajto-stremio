"use strict";

const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { URLSearchParams } = require("url");
const { JSDOM } = require("jsdom");
const cookieParser = require("cookie-parser");

// ====== CONFIG ======
const PORT = process.env.PORT || 7001;

// Prehraj.to base
const PREHRAJ_BASE = "https://prehraj.to";

// Timeout pre HTTP requesty (ms)
const HTTP_TIMEOUT = 15000;

// User-Agent (prehraj.to vie byť háklivé na default UA)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ====== MANIFEST ======
const manifest = {
  id: "community.prehrajto.czsk",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z Prehraj.to – CZ/SK",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  logo: "https://raw.githubusercontent.com/Luberda66/prehrajto-stremio/main/icon.png"
};

// ====== HELPERS ======
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("HTTP timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeGet(obj, path, fallback) {
  try {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return fallback;
      cur = cur[p];
    }
    return cur == null ? fallback : cur;
  } catch {
    return fallback;
  }
}

function isTmdbId(id) {
  return typeof id === "string" && id.startsWith("tmdb:");
}

function isImdbId(id) {
  return typeof id === "string" && id.startsWith("tt");
}

async function fetchJson(url) {
  const r = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*"
      }
    }),
    HTTP_TIMEOUT
  );
  if (!r.ok) throw new Error(`fetchJson HTTP ${r.status}`);
  return r.json();
}

async function fetchText(url, opts = {}) {
  const r = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(opts.headers || {})
      },
      method: opts.method || "GET"
    }),
    HTTP_TIMEOUT
  );
  if (!r.ok) throw new Error(`fetchText HTTP ${r.status} ${url}`);
  return r.text();
}

function makeSearchQuery(title, year) {
  const q = year ? `${title} ${year}` : title;
  return cleanText(q);
}

function normalizeTitleForMatch(s) {
  return cleanText(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreMatch(candidateTitle, targetTitle, targetYear, candidateYear) {
  const c = normalizeTitleForMatch(candidateTitle);
  const t = normalizeTitleForMatch(targetTitle);
  let score = 0;

  if (c === t) score += 100;
  if (c.includes(t)) score += 35;
  if (t.includes(c)) score += 25;

  if (targetYear && candidateYear) {
    if (String(targetYear) === String(candidateYear)) score += 30;
    else score -= 10;
  }

  return score;
}

// ====== PREHRAJ.TO SCRAPE ======

// 1) Search stránka
async function prehrajSearch(q) {
  const url = `${PREHRAJ_BASE}/hledej/${encodeURIComponent(q)}`;
  const html = await fetchText(url);

  const $ = cheerio.load(html);
  const items = [];

  // karty výsledkov môžu mať rôzne selektory, berieme robustne
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.includes("/video/")) return;

    const title = cleanText($(el).text());
    if (!title || title.length < 2) return;

    const full = href.startsWith("http") ? href : `${PREHRAJ_BASE}${href}`;
    items.push({ title, url: full });
  });

  // deduplikácia podľa url
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }

  return out.slice(0, 40);
}

// 2) Detail stránky – extrakcia streamov (odkazy na prehraj, kvalita, atď.)
async function extractStreamsFromDetail(detailUrl) {
  const html = await fetchText(detailUrl);

  // Niektoré veci sú aj v inline skriptoch – použijeme JSDOM pre prípad
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Základ: nájdi všetky odkazy na prehranie
  const links = Array.from(document.querySelectorAll("a"))
    .map((a) => ({
      href: a.getAttribute("href") || "",
      text: cleanText(a.textContent || "")
    }))
    .filter((x) => x.href && (x.href.includes("/video/") || x.href.includes("/prehraj/") || x.href.includes("/play/")));

  // Preferuj linky, ktoré vyzerajú ako play
  const playLinks = links.filter((x) => /prehraj|play|prehrat/i.test(x.text) || /prehraj|play|prehrat/i.test(x.href));

  const candidates = (playLinks.length ? playLinks : links)
    .map((x) => (x.href.startsWith("http") ? x.href : `${PREHRAJ_BASE}${x.href}`))
    .filter((u) => u.startsWith(PREHRAJ_BASE));

  // fallback: niekedy je priamo video src v <source> alebo <video>
  const video = document.querySelector("video");
  const sources = video ? Array.from(video.querySelectorAll("source")).map((s) => s.getAttribute("src")).filter(Boolean) : [];
  const direct = sources
    .map((u) => (u.startsWith("http") ? u : `${PREHRAJ_BASE}${u}`))
    .filter(Boolean);

  // dedupe
  const all = [...candidates, ...direct];
  const seen = new Set();
  const uniq = [];
  for (const u of all) {
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
  }

  // Ak máme priamo video src, vieme to rovno vrátiť
  const streams = [];

  for (const u of uniq) {
    // Skús získať finálny stream link (niekedy je to redirect alebo embed)
    try {
      // HEAD je rýchlejší, ale nie vždy povolený → nechaj GET
      const t = await fetchText(u);
      // hľadaj m3u8/mp4 v html
      const m3u8 = t.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/i);
      const mp4 = t.match(/https?:\/\/[^"' ]+\.mp4[^"' ]*/i);

      if (m3u8) {
        streams.push({
          title: "Prehraj.to (HLS)",
          url: m3u8[0]
        });
        continue;
      }
      if (mp4) {
        streams.push({
          title: "Prehraj.to (MP4)",
          url: mp4[0]
        });
        continue;
      }
    } catch (e) {
      // ignor
    }
  }

  // fallback: ak nič, aspoň vráť detail link (nie vždy prehrateľné)
  if (!streams.length) {
    streams.push({
      title: "Prehraj.to (detail)",
      url: detailUrl
    });
  }

  return streams;
}

// ====== METADATA HELPERS (Stremio id -> názov/rok) ======

// Stremio pre movie:tt0133093
// pre series:tt0903747:1:1 (S01E01)
function parseStremioId(type, id) {
  if (type === "movie") {
    // id je imdb tt...
    return { imdb: id, season: null, episode: null };
  }
  // series
  // môže byť tt... alebo tt...:S:E
  const parts = String(id || "").split(":");
  const imdb = parts[0];
  const season = parts.length >= 2 ? parseInt(parts[1], 10) : null;
  const episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
  return { imdb, season, episode };
}

async function getMetaFromCinemeta(type, id) {
  // Cinemeta metadáta
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
  const j = await fetchJson(url);
  const meta = j && j.meta ? j.meta : null;
  if (!meta) return null;

  const title = meta.name || meta.title;
  const year = meta.year;
  return { title, year, meta };
}

// ====== ADDON ======
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
  const { type, id } = args;

  // 1) získať title+year z Cinemeta
  let metaInfo = null;
  try {
    metaInfo = await getMetaFromCinemeta(type, id);
  } catch (e) {
    // ak Cinemeta padne, skončíme bez streamov
    return { streams: [] };
  }
  if (!metaInfo || !metaInfo.title) return { streams: [] };

  const { title, year } = metaInfo;
  const { imdb, season, episode } = parseStremioId(type, id);

  // 2) search na prehraj.to
  const query = makeSearchQuery(title, year);
  let results = [];
  try {
    results = await prehrajSearch(query);
  } catch (e) {
    return { streams: [] };
  }

  // 3) vyber najlepší match
  let best = null;
  let bestScore = -9999;

  for (const it of results) {
    // pokus nájsť rok z title "(2020)" atď
    const m = it.title.match(/\b(19\d{2}|20\d{2})\b/);
    const candYear = m ? m[1] : null;
    const s = scoreMatch(it.title, title, year, candYear);
    if (s > bestScore) {
      bestScore = s;
      best = it;
    }
  }

  if (!best) return { streams: [] };

  // 4) z detailu extrahuj streamy
  let extracted = [];
  try {
    extracted = await extractStreamsFromDetail(best.url);
  } catch (e) {
    return { streams: [] };
  }

  // 5) pre series zober titulky do názvu (len info)
  const prefix =
    type === "series" && season != null && episode != null
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} – `
      : "";

  // 6) mapni do Stremio formátu
  const streams = extracted.map((s) => ({
    title: prefix + (s.title || "Prehraj.to"),
    url: s.url
  }));

  return { streams };
});

// ====== EXPRESS SERVER (local) ======
const app = express();
app.use(cookieParser());

app.get("/manifest.json", (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(manifest));
});

app.get("/", (req, res) => {
  res.end("Prehraj.to Stremio addon is running. Open /manifest.json");
});

// Addon routes (stremio-addon-sdk)
serveHTTP(builder.getInterface(), { app });

app.listen(PORT, () => {
  console.log(`🚀 Prehraj.to addon beží na: http://127.0.0.1:${PORT}`);
  console.log(`📄 Manifest: /manifest.json`);
  console.log(`🌐 Otvor v prehliadači: http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
});

// ====== SAFETY: log unhandled errors ======
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
