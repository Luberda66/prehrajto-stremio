"use strict";

// Load .env locally (TMDB_KEY, PORT, ...). Safe on production too (it just does nothing if .env is missing).
try { try { require("dotenv").config(); } catch (_) {} } catch (e) { /* dotenv is optional */ }

const axios = require("axios");
const cheerio = require("cheerio");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const http = require("http");
const fs = require("fs");
const path = require("path");

// =========================
// CONFIG
// =========================
const PORT = parseInt(process.env.PORT || "7001", 10);
const ADDRESS = process.env.ADDRESS || "0.0.0.0";

const TMDB_KEY = (process.env.TMDB_KEY || "").trim();
const TMDB_BASE = "https://api.themoviedb.org/3";

const PREHRAJ_BASE = "https://prehrajto.cz";
const PREHRAJ_SEARCH = (q) => `${PREHRAJ_BASE}/hledej/${encodeURIComponent(q)}`;

// prehraj.to občas vráti "promo" stránky, report, google play, stopped, atď.
const JUNK_URL_PARTS = [
  "play.google.com",
  "/video-stopped",
  "/videoReport",
  "/video-report",
  "nahlasit",
  "vyzkousejte",
  "zkousejte",
  "stahnete-si-novou",
  "download-app",
];

// Tento regex chytá priame mp4 linky, ktoré sú reálne prehrateľné v Stremiu
// (v praxi často premiumcdn / storage)
const REGEX_STREAM_URL =
  /https?:\/\/[a-z0-9.-]+(?:premiumcdn|storage)[a-z0-9.-]*\.(?:net|com)\/[^\s"'<>]+?\.(?:mp4|mkv|webm)(?:\?[^\s"'<>]+)?/gi;

// =========================
// LOG HELPERS
// =========================
function log(...args) {
  console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function err(...args) {
  console.error(...args);
}

// =========================
// TEXT HELPERS
// =========================
function normalizeText(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function formatSxxExx(season, episode) {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  return `S${s}E${e}`;
}

function matchesSeriesEpisode(title, season, episode) {
  const t = normalizeText(title);
  const s = String(season);
  const e = String(episode);

  // S01E01 / s1e1 / S1E01 etc.
  const sxx = String(season).padStart(2, "0");
  const exx = String(episode).padStart(2, "0");
  if (t.includes(`s${sxx}e${exx}`)) return true;
  if (t.includes(`s${s}e${e}`)) return true;
  if (t.includes(`s${s}e${exx}`)) return true;
  if (t.includes(`s${sxx}e${e}`)) return true;

  // 1x01 / 01x01 / 1x1
  if (t.includes(`${s}x${e}`)) return true;
  if (t.includes(`${sxx}x${exx}`)) return true;
  if (t.includes(`${s}x${exx}`)) return true;
  if (t.includes(`${sxx}x${e}`)) return true;

  return false;
}

// =========================
// QUALITY HELPERS
// =========================
function qualityFromTitle(title) {
  const t = normalizeText(title);

  if (t.includes("2160p") || t.includes("4k")) return 2160;
  if (t.includes("1440p") || t.includes("2k")) return 1440;
  if (t.includes("1080p") || t.includes("fullhd")) return 1080;
  if (t.includes("720p") || t.includes(" hd ")) return 720;
  if (t.includes("480p")) return 480;
  if (t.includes("360p")) return 360;

  return NaN;
}

function qualityLabel(q) {
  if (!Number.isFinite(q)) return "";
  if (q >= 2160) return "4K";
  if (q >= 1080) return "FullHD";
  if (q >= 720) return "HD";
  if (q >= 480) return "SD";
  return `${q}p`;
}

function hasHDR(title) {
  const t = normalizeText(title);
  return t.includes("hdr") || t.includes("dolby vision") || t.includes("dv");
}

function detectLang(title) {
  const t = normalizeText(title);
  // CZ priority
  if (t.includes("cz") || t.includes("czech") || t.includes("dabing") || t.includes("dubbing")) return "CZ";
  if (t.includes("sk") || t.includes("slovak")) return "SK";
  return "";
}

function parseSizeFromTitle(title) {
  // často v tile býva "4.88 GB", "700 MB", atď.
  const m = (title || "").match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (!m) return { sizeText: "", sizeGB: NaN };
  const val = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (!Number.isFinite(val)) return { sizeText: "", sizeGB: NaN };

  const sizeGB = unit === "MB" ? val / 1024 : val;
  return { sizeText: `${val} ${unit}`, sizeGB };
}

function estimateBitrateMbps(sizeGB, durationMin) {
  if (!Number.isFinite(sizeGB) || !Number.isFinite(durationMin) || durationMin <= 0) return NaN;
  // GB -> bits: GB * 1024^3 bytes * 8
  const bits = sizeGB * 1024 * 1024 * 1024 * 8;
  const seconds = durationMin * 60;
  const bps = bits / seconds;
  return bps / 1_000_000;
}

function isJunkStreamUrl(url) {
  const u = (url || "").toLowerCase();
  return JUNK_URL_PARTS.some((p) => u.includes(p));
}

function isJunkResult(item) {
  const t = normalizeText(item.title);
  const u = (item.url || "").toLowerCase();

  // výsledky typu: app promo, report, stopped
  if (isJunkStreamUrl(u)) return true;
  if (t.includes("stahnete si novou") || t.includes("nahlasit") || t.includes("vyzkousejte")) return true;

  return false;
}

// =========================
// TMDB HELPERS
// =========================
async function tmdbFetchJson(url) {
  if (!TMDB_KEY) return null;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    return res.data;
  } catch (e) {
    warn("TMDB fetch failed:", e.message);
    return null;
  }
}

async function tmdbFindByImdb(imdbId) {
  if (!TMDB_KEY) return null;
  const url = `${TMDB_BASE}/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_KEY}&external_source=imdb_id`;
  const data = await tmdbFetchJson(url);
  if (!data) return null;

  // môžu byť aj movie_results aj tv_results
  const movie = data.movie_results && data.movie_results[0] ? data.movie_results[0] : null;
  const tv = data.tv_results && data.tv_results[0] ? data.tv_results[0] : null;

  return { movie, tv };
}

async function tmdbGetTvDetails(tvId, lang) {
  if (!tvId) return null;
  const url = `${TMDB_BASE}/tv/${tvId}?api_key=${TMDB_KEY}` + (lang ? `&language=${encodeURIComponent(lang)}` : "");
  return tmdbFetchJson(url);
}

async function tmdbGetMovieDetails(movieId, lang) {
  if (!movieId) return null;
  const url = `${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_KEY}` + (lang ? `&language=${encodeURIComponent(lang)}` : "");
  return tmdbFetchJson(url);
}

function uniqTitles(arr) {
  const out = [];
  const seen = new Set();
  for (const t of arr || []) {
    const s = (t || "").trim();
    if (!s) continue;
    const k = normalizeText(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// =========================
// PREHRAJ SEARCH + PARSE
// =========================
async function searchPrehraj(query) {
  const url = PREHRAJ_SEARCH(query);
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "cs-CZ,sk-SK;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    const $ = cheerio.load(res.data);
    const items = [];

    // karty v searchi: <a href="/nejaky-nazov/abcdef...">
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // detail stránky sú typicky /slug/hash
      if (!/^\/[^\/]+\/[a-f0-9]{8,}/i.test(href)) return;

      const full = PREHRAJ_BASE + href;
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!text) return;

      items.push({ title: text, url: full });
    });

    // vyčisti dup
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = it.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }

    return out;
  } catch (e) {
    warn("searchPrehraj failed:", query, e.message);
    return [];
  }
}

async function parseDetailPage(detailUrl) {
  try {
    const res = await axios.get(detailUrl, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "cs-CZ,sk-SK;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: PREHRAJ_BASE,
      },
    });

    const html = res.data || "";
    const urls = new Set();

    // 1) priame mp4 z JS/HTML
    const found = html.match(REGEX_STREAM_URL) || [];
    for (const u of found) urls.add(u);

    // 2) fallback: ak nič, aspoň player link (niekedy funguje, ale je to posledná záchrana)
    if (urls.size === 0) {
      urls.add(detailUrl);
    }

    return [...urls];
  } catch (e) {
    warn("parseDetailPage failed:", detailUrl, e.message);
    return [];
  }
}

// =========================
// UI BLOCK (Variant B style)
// =========================
function buildUiBlock(meta, opts) {
  const title = meta.title || "Stream";
  const raw = (meta.rawTitle || "").toString();

  const PH = "⠀"; // U+2800

  const tNorm = normalizeText(raw);

  // audio/sub tagy (voliteľné)
  const hasDubbing = tNorm.includes("dabing") || tNorm.includes("dubbing");
  const hasSubs = tNorm.includes("titulky") || tNorm.includes("subs") || tNorm.includes("subtitles") || /sub/.test(tNorm);

  // zdroj tagy (voliteľné)
  const tags = [];
  if (tNorm.includes("remux")) tags.push("REMUX");
  if (tNorm.includes("bluray") || tNorm.includes("blu-ray") || tNorm.includes("brrip") || tNorm.includes("bd")) tags.push("BluRay");
  if (tNorm.includes("web-dl") || tNorm.includes("webdl")) tags.push("WEB-DL");
  if (tNorm.includes("webrip")) tags.push("WEBRip");

  // 1) názov
  const line1 = title || PH;

  // 2) jazyk + (voliteľne) 🎙️ / 💬
  const lang = meta.lang ? `🌐 ${meta.lang}` : "";
  const l2parts = [lang];
  if (hasDubbing) l2parts.push("🎙️");
  if (hasSubs) l2parts.push("💬");
  const line2 = l2parts.filter(Boolean).join("  ") || PH;

  // 3) kvalita + HDR + source tagy + veľkosť
  const q = meta.qLabel ? `📺 ${meta.qLabel}` : "";
  const hdr = meta.hdr ? "🌈 HDR" : "";
  const size = meta.sizeText ? `💾 ${meta.sizeText}` : "";
  const l3parts = [q, hdr, ...tags, size].filter(Boolean);
  const line3 = l3parts.join("  ") || PH;

  // 4) Mbps + čas
  const bitrate = opts && Number.isFinite(opts.bitrateMbps) ? `⚡ ${opts.bitrateMbps.toFixed(1)} Mbps` : "⚡ -";
  const dur = opts && Number.isFinite(opts.durationMin) ? `🕒 ${opts.durationMin}m` : "🕒 -";
  const line4 = [bitrate, dur].filter(Boolean).join("  ") || PH;

  return [line1, line2, line3, line4].join("\n");
}

// =========================
// CORE: BUILD STREAMS
// =========================
async function getStreams(type, id) {
  const isSeries = type === "series";
  const imdbId = (id || "").split(":")[0];

  let season = NaN;
  let episode = NaN;
  let episodeName = "";

  if (isSeries) {
    const parts = (id || "").split(":");
    season = safeNumber(parts[1]);
    episode = safeNumber(parts[2]);

    try {
      const epName = parts[3] || "";
      episodeName = epName; log("Episode name:", epName);
    } catch (_) {}
  }

  if (isSeries && (!Number.isFinite(season) || !Number.isFinite(episode))) {
    return [];
  }

  // title z TMDB
  let title = imdbId;
  let originalTitle = "";
  let year = "";
  let runtimeMin = NaN;

  const found = await tmdbFindByImdb(imdbId);
  if (found) {
    if (!isSeries && found.movie) {
      title = found.movie.title || imdbId;
      originalTitle = found.movie.original_title || "";
      year = (found.movie.release_date || "").slice(0, 4);
    }
    if (isSeries && found.tv) {
      title = found.tv.name || imdbId;
      originalTitle = found.tv.original_name || "";
      year = (found.tv.first_air_date || "").slice(0, 4);
    }
  }

  title = title || originalTitle || imdbId;

  const titleCandidates = uniqTitles([ title, originalTitle ]);

  try {
    if (TMDB_KEY && found) {
      if (found.tv && found.tv.id) {
        const [cs, sk, en] = await Promise.allSettled([
          tmdbGetTvDetails(found.tv.id, "cs-CZ"),
          tmdbGetTvDetails(found.tv.id, "sk-SK"),
          tmdbGetTvDetails(found.tv.id, "en-US"),
        ]);
        for (const r of [cs, sk, en]) {
          if (r.status === "fulfilled" && r.value) {
            titleCandidates.push(r.value.name, r.value.original_name);
          }
        }
      } else if (found.movie && found.movie.id) {
        const [cs, sk, en] = await Promise.allSettled([
          tmdbGetMovieDetails(found.movie.id, "cs-CZ"),
          tmdbGetMovieDetails(found.movie.id, "sk-SK"),
          tmdbGetMovieDetails(found.movie.id, "en-US"),
        ]);
        for (const r of [cs, sk, en]) {
          if (r.status === "fulfilled" && r.value) {
            titleCandidates.push(r.value.title, r.value.original_title);
            if (!Number.isFinite(runtimeMin) && Number.isFinite(r.value.runtime)) runtimeMin = r.value.runtime;
          }
        }
      }
    }
  } catch (_) {}

  const titles = uniqTitles(titleCandidates);

  const queries = [];
  for (const t of titles) queries.push(t);

  if (!isSeries && year) {
    for (const t of titles) queries.push(`${t} ${year}`);
  }

  if (isSeries) {
    const se = formatSxxExx(season, episode);

    for (const t of titles) {
      queries.push(`${t} ${se}`);
      queries.push(`${t} s${season}e${episode}`);
      queries.push(`${t} ${season}x${episode}`);
      queries.push(`${t} ${String(season).padStart(2, "0")}x${String(episode).padStart(2, "0")}`);
      if (episodeName) {
        queries.push(`${t} ${se} ${episodeName}`);
        queries.push(`${t} ${episodeName}`);
      }
    }
  }

  const qSeen = new Set();
  const qUniq = [];
  for (const q of queries) {
    const k = normalizeText(q);
    if (!k) continue;
    if (qSeen.has(k)) continue;
    qSeen.add(k);
    qUniq.push(q);
  }

  const candidates = [];
  for (const q of qUniq) {
    const items = await searchPrehraj(q);
    for (const it of items) {
      if (!it || !it.url || !it.title) continue;
      if (isJunkResult(it)) continue;
      if (isSeries && Number.isFinite(season) && Number.isFinite(episode)) {
        if (!matchesSeriesEpisode(it.title, season, episode)) continue;
      }
      candidates.push(it);
    }
  }

  const cSeen = new Set();
  const cUniq = [];
  for (const c of candidates) {
    if (cSeen.has(c.url)) continue;
    cSeen.add(c.url);
    cUniq.push(c);
  }

  let streams = [];
  for (const item of cUniq) {
    const urls = await parseDetailPage(item.url);
    if (!urls || urls.length === 0) continue;

    const lang = detectLang(item.title);
    const q = qualityFromTitle(item.title);
    const qLabel = qualityLabel(q);
    const hdr = hasHDR(item.title);
    const { sizeText, sizeGB } = parseSizeFromTitle(item.title);

    const durationMin = isSeries ? 42 : (Number.isFinite(runtimeMin) ? runtimeMin : 120);
    const bitrateMbps = estimateBitrateMbps(sizeGB, durationMin);

    for (const u of urls) {
      streams.push({
        title: buildUiBlock(
          { title, lang, qLabel, hdr, sizeText, rawTitle: item.title },
          { durationMin, bitrateMbps }
        ),
        url: u,
        _meta: {
          baseTitle: title,
          lang,
          q,
          qLabel,
          hdr,
          sizeGB,
          sizeText,
          durationMin,
          bitrateMbps,
        },
      });
    }
  }

  streams = streams.filter((s) => s && s.url && !isJunkStreamUrl(s.url));

  const seen = new Set();
  const uniq = [];
  for (const s of streams) {
    if (!s || !s.url) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    uniq.push(s);
  }
  streams = uniq;

  // SORT: CZ hore, potom kvalita (4K->...), HDR, potom veľkosť, potom bitrate
  streams.sort((a, b) => {
    const A = a._meta || {};
    const B = b._meta || {};

    const aCz = A.lang === "CZ" ? 1 : 0;
    const bCz = B.lang === "CZ" ? 1 : 0;
    if (aCz !== bCz) return bCz - aCz;

    const aq = Number.isFinite(A.q) ? A.q : 0;
    const bq = Number.isFinite(B.q) ? B.q : 0;
    if (aq !== bq) return bq - aq;

    const aHdr = A.hdr ? 1 : 0;
    const bHdr = B.hdr ? 1 : 0;
    if (aHdr !== bHdr) return bHdr - aHdr;

    const asz = Number.isFinite(A.sizeGB) ? A.sizeGB : 0;
    const bsz = Number.isFinite(B.sizeGB) ? B.sizeGB : 0;
    if (asz !== bsz) return bsz - asz;

    const ab = Number.isFinite(A.bitrateMbps) ? A.bitrateMbps : 0;
    const bb = Number.isFinite(B.bitrateMbps) ? B.bitrateMbps : 0;
    if (ab !== bb) return bb - ab;

    return 0;
  });

  // dodatočná deduplikácia
  const seenKeys = new Set();
  const uniq2 = [];
  for (const s of streams) {
    const m = s._meta || {};
    const br = Number.isFinite(m.bitrateMbps) ? Math.round(m.bitrateMbps * 10) / 10 : 0;
    const key = [
      m.lang || "",
      m.qLabel || "",
      m.hdr ? "1" : "0",
      m.sizeText || "",
      String(m.durationMin || ""),
      String(br),
      (s.title || "").trim()
    ].join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniq2.push(s);
  }
  streams = uniq2;

  return streams.map((s) => ({ title: s.title, url: s.url }));
}

// =========================
// MANIFEST (base bez logo; logo doplníme dynamicky pri /manifest.json)
// =========================
const manifestBase = {
  id: "community.prehrajto.czsk",
  version: "2.4.2",
  name: "Prehraj.to (CZ/SK)",
  description: "Filmy a seriály z Prehraj.to – CZ/SK",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  // logo sa doplní dynamicky podľa hostu
};

// =========================
// ADDON
// =========================
const builder = new addonBuilder(manifestBase);

builder.defineStreamHandler(async (args) => {
  try {
    const { type, id } = args || {};
    log("Stream request:", type, id);

    const streams = await getStreams(type, id);
    log("Found streams:", streams.length);

    return { streams };
  } catch (e) {
    err("route error:", e);
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

// =========================
// RUN SERVER + ICON + DYNAMIC MANIFEST
// =========================
function getAddonHandler(addonInterface) {
  if (typeof addonInterface === "function") return addonInterface;
  if (addonInterface && typeof addonInterface.getRouter === "function") return addonInterface.getRouter();
  if (addonInterface && typeof addonInterface.router === "function") return addonInterface.router;
  return null;
}

function getBaseUrlFromReq(req) {
  const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
  const xfHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();

  const host = xfHost || req.headers.host;
  const proto = xfProto || (req.socket && req.socket.encrypted ? "https" : "http");

  if (!host) return `http://127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

const iconPath = path.join(__dirname, "icon.png");
const addonHandler = getAddonHandler(addonInterface);

if (addonHandler) {
  const server = http.createServer((req, res) => {
    try {
      const url = (req.url || "").split("?")[0];

      // Dynamický manifest, aby logo vždy sedelo na tú istú adresu ako manifest
      if (url === "/manifest.json") {
        const base = getBaseUrlFromReq(req);
        const manifest = { ...manifestBase, logo: `${base}/icon.png` };
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(manifest));
        return;
      }

      // Icon route
      if (url === "/icon.png") {
        fs.stat(iconPath, (stErr, st) => {
          if (stErr || !st || !st.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("icon.png not found");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          });
          fs.createReadStream(iconPath).pipe(res);
        });
        return;
      }

      // fall back to addon routes
      addonHandler(req, res);
    } catch (e) {
      err("HTTP server error:", e);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    }
  });

  server.listen(PORT, ADDRESS, () => {
    log(`🚀 Prehraj.to addon beží (lokálne): http://127.0.0.1:${PORT}/manifest.json`);
    log(`🖼️  Icon: http://127.0.0.1:${PORT}/icon.png`);
    log(`📺 LAN manifest (Android/TV v rovnakej sieti): http://192.168.0.175:${PORT}/manifest.json`);
  });
} else {
  serveHTTP(addonInterface, { port: PORT, address: ADDRESS })
    .then(() => {
      log(`🚀 Prehraj.to addon beží (lokálne): http://127.0.0.1:${PORT}/manifest.json`);
      log(`📺 LAN manifest (Android/TV v rovnakej sieti): http://192.168.0.175:${PORT}/manifest.json`);
    })
    .catch((e) => {
      err("Failed to start server:", e);
    });
}
