/**
 * PULSE Stock Server v3
 * - חדשות: Finviz + Yahoo Finance
 * - נתוני מחיר: Yahoo Finance API (1m, 5m, 1d intervals)
 * - התראות: אימייל על חדשות חזקות + MA Stack alignment
 *
 * הרצה:
 *   GMAIL_USER=x@gmail.com GMAIL_PASS=xxxx ALERT_TO=y@mail.com node server.js
 */

const http  = require("http");
const https = require("https");
const net   = require("net");
const tls   = require("tls");
const url   = require("url");

const PORT = process.env.PORT || 3001;

const CONFIG = {
  gmail:    { user: process.env.GMAIL_USER || "", pass: process.env.GMAIL_PASS || "" },
  alertTo:  process.env.ALERT_TO   || "",
  watchlist: (process.env.WATCHLIST || "NVDA,AAPL,TSLA").split(",").map(s => s.trim()),
  pollIntervalMs: 60 * 1000, // בדיקה כל דקה
  strongBull: /\b(surge|soar|skyrocket|smash|beat|record high|all[- ]time high|rally|upgrade|outperform|strong buy|blowout)\b/i,
  strongBear: /\b(crash|plunge|collapse|plummet|tank|miss|loss|layoff|recall|downgrade|investigation|lawsuit|bankrupt|halt|warning)\b/i,
  // MA stack alert configs per ticker: { periods:[5,9,20], lastFired: null }
  maConfigs: {},
  // יומן מעקב אחר מועמדות פריצה — לבדיקת ביצועים בפועל (paper tracking, לא מסחר אמיתי)
  journal: [], // { id, ticker, company, addedDate, addedPrice, distFromHighPct, volRatio, change,
               //   day1: {date, open, gapPct} | null,
               //   day3: {date, close, pct} | null,
               //   day5: {date, close, pct} | null,
               //   status: "open" | "tracking" | "complete" }
};

// ─── HTTPS HELPER ─────────────────────────────────────────────────────────────
function httpsGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ─── PRICE DATA — Yahoo Finance Chart API ─────────────────────────────────────
// interval: 1m | 5m | 1d
// range:    1d | 5d | 3mo | 6mo | 1y
async function fetchPriceData(ticker, interval, range) {
  const apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;

  const res = await httpsGet(apiUrl, {
    Accept: "application/json",
    Referer: "https://finance.yahoo.com/",
  });

  if (res.status !== 200) throw new Error(`Yahoo chart API ${res.status}`);

  let json;
  try { json = JSON.parse(res.body); } catch { throw new Error("Invalid JSON from Yahoo"); }

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data returned");

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens   = q.open   || [];
  const highs   = q.high   || [];
  const lows    = q.low    || [];
  const closes  = q.close  || [];
  const volumes = q.volume || [];

  // Filter nulls
  const candles = timestamps.map((t, i) => ({
    t: t * 1000,
    o: opens[i],
    h: highs[i],
    l: lows[i],
    c: closes[i],
    v: volumes[i],
  })).filter(c => c.o != null && c.h != null && c.l != null && c.c != null);

  const meta = result.meta || {};

  return {
    ticker,
    interval,
    range,
    currency: meta.currency || "USD",
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    candles,
  };
}

// ─── MA CALCULATOR ────────────────────────────────────────────────────────────
function calcMA(closes, period) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function checkMAStack(closes, periods) {
  // periods sorted ascending e.g. [5,9,20]
  // bullish stack: MA[0] > MA[1] > MA[2] (shortest on top)
  // bearish stack: MA[0] < MA[1] < MA[2]
  if (closes.length < Math.max(...periods)) return { bullish: false, bearish: false, values: {} };

  const values = {};
  for (const p of periods) {
    const ma = calcMA(closes, p);
    values[p] = ma[ma.length - 1];
  }

  const sorted = [...periods].sort((a, b) => a - b);
  let bullish = true, bearish = true;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (values[sorted[i]] <= values[sorted[i + 1]]) bullish = false;
    if (values[sorted[i]] >= values[sorted[i + 1]]) bearish = false;
  }

  return { bullish, bearish, values };
}

// ─── BREAKOUT JOURNAL (Paper Tracking) ────────────────────────────────────────
// עוקב אחרי ביצועים בפועל של מועמדות מהסורק — לא מסחר אמיתי, רק מדידה.
function addToJournal(candidate) {
  const today = new Date().toISOString().slice(0, 10);
  // אל תוסיף כפילות לאותו טיקר באותו יום
  if (CONFIG.journal.find(j => j.ticker === candidate.ticker && j.addedDate === today)) {
    return null;
  }
  const entry = {
    id: `${candidate.ticker}-${today}-${Date.now()}`,
    ticker: candidate.ticker,
    company: candidate.company || "",
    addedDate: today,
    addedPrice: candidate.price,
    distFromHighPct: candidate.distFromHighPct,
    volRatio: candidate.volRatio,
    change: candidate.change,
    day1: null,
    day3: null,
    day5: null,
    status: "open",
  };
  CONFIG.journal.unshift(entry);
  if (CONFIG.journal.length > 500) CONFIG.journal.length = 500; // hard cap
  return entry;
}

function tradingDaysBetween(dateStr) {
  // מספר ימי מסחר גס (לא כולל סופ"ש) מתאריך נתון עד היום
  const start = new Date(dateStr + "T00:00:00");
  const now = new Date();
  let count = 0;
  const d = new Date(start);
  while (d < now) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

async function updateJournalEntry(entry) {
  try {
    const data = await fetchPriceData(entry.ticker, "1d", "3mo");
    const candles = data.candles;
    if (!candles.length) return entry;

    // מצא את הנר של יום ההוספה (addedDate) כדי לחשב ימים יחסית אליו
    const addedIdx = candles.findIndex(c => {
      const d = new Date(c.t).toISOString().slice(0, 10);
      return d === entry.addedDate;
    });
    if (addedIdx === -1) return entry; // עדיין אין נתונים ליום הזה (למשל אם נוסף אחרי סגירה)

    const daysElapsed = tradingDaysBetween(entry.addedDate);

    // Day+1 — מחיר פתיחה למחרת (gap)
    if (!entry.day1 && candles[addedIdx + 1]) {
      const d1 = candles[addedIdx + 1];
      entry.day1 = {
        date: new Date(d1.t).toISOString().slice(0, 10),
        open: d1.o,
        close: d1.c,
        gapPct: entry.addedPrice ? Math.round(((d1.o - entry.addedPrice) / entry.addedPrice) * 1000) / 10 : null,
        dayPct: entry.addedPrice ? Math.round(((d1.c - entry.addedPrice) / entry.addedPrice) * 1000) / 10 : null,
      };
    }

    // Day+3 — סגירה אחרי 3 ימי מסחר
    if (!entry.day3 && candles[addedIdx + 3]) {
      const d3 = candles[addedIdx + 3];
      entry.day3 = {
        date: new Date(d3.t).toISOString().slice(0, 10),
        close: d3.c,
        pct: entry.addedPrice ? Math.round(((d3.c - entry.addedPrice) / entry.addedPrice) * 1000) / 10 : null,
      };
    }

    // Day+5 — סגירה אחרי 5 ימי מסחר, וסוגר את המעקב
    if (!entry.day5 && candles[addedIdx + 5]) {
      const d5 = candles[addedIdx + 5];
      entry.day5 = {
        date: new Date(d5.t).toISOString().slice(0, 10),
        close: d5.c,
        pct: entry.addedPrice ? Math.round(((d5.c - entry.addedPrice) / entry.addedPrice) * 1000) / 10 : null,
      };
      entry.status = "complete";
    } else if (entry.day1 && entry.status === "open") {
      entry.status = "tracking";
    }

    return entry;
  } catch (e) {
    return entry; // שמור מצב קודם אם הבקשה נכשלה
  }
}

async function refreshJournal() {
  const openEntries = CONFIG.journal.filter(j => j.status !== "complete");
  for (const entry of openEntries) {
    await updateJournalEntry(entry);
    await new Promise(r => setTimeout(r, 300)); // עדינות מול Yahoo
  }
}

function journalStats() {
  const complete = CONFIG.journal.filter(j => j.day1);
  if (complete.length === 0) {
    return { count: 0, withDay1: 0, withDay3: 0, withDay5: 0 };
  }
  const withDay1 = complete.filter(j => j.day1);
  const withDay3 = complete.filter(j => j.day3);
  const withDay5 = complete.filter(j => j.day5);

  const avg = (arr, getter) => arr.length ? Math.round((arr.reduce((s,x)=>s+getter(x),0) / arr.length) * 10) / 10 : null;
  const winRate = (arr, getter) => arr.length ? Math.round((arr.filter(x => getter(x) > 0).length / arr.length) * 1000) / 10 : null;

  return {
    count: CONFIG.journal.length,
    withDay1: withDay1.length,
    withDay3: withDay3.length,
    withDay5: withDay5.length,
    avgGapPct: avg(withDay1, j => j.day1.gapPct),
    avgDay1Pct: avg(withDay1, j => j.day1.dayPct),
    avgDay3Pct: avg(withDay3, j => j.day3.pct),
    avgDay5Pct: avg(withDay5, j => j.day5.pct),
    gapUpRate: winRate(withDay1, j => j.day1.gapPct),
    day3WinRate: winRate(withDay3, j => j.day3.pct),
    day5WinRate: winRate(withDay5, j => j.day5.pct),
  };
}

// ─── SCRAPERS ─────────────────────────────────────────────────────────────────
async function scrapeFinviz(ticker) {
  const res = await httpsGet(`https://finviz.com/quote.ashx?t=${ticker}&p=d`, { Referer: "https://finviz.com/" });
  if (res.status !== 200) throw new Error(`Finviz ${res.status}`);
  const news = [];
  const tableMatch = res.body.match(/id="news-table"[\s\S]*?<\/table>/);
  if (!tableMatch) return news;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m, currentDate = "";
  while ((m = rowRegex.exec(tableMatch[0])) !== null) {
    const row = m[1];
    const dateCell = row.match(/<td[^>]*align="right"[^>]*>([\s\S]*?)<\/td>/);
    if (dateCell) {
      const txt = dateCell[1].replace(/<[^>]+>/g, "").trim();
      if (txt.includes("-")) currentDate = txt.split(" ")[0];
      const timeMatch = txt.match(/\d+:\d+[AP]M/);
      const time = timeMatch ? timeMatch[0] : txt;
      const linkMatch = row.match(/href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      if (linkMatch) {
        const srcMatch = row.match(/class="news-link-right"[^>]*>([\s\S]*?)<\/span>/);
        news.push({
          headline: linkMatch[2].trim(),
          url: linkMatch[1],
          time: currentDate ? `${currentDate} ${time}` : time,
          source: srcMatch ? srcMatch[1].replace(/<[^>]+>/g, "").trim() : "Finviz",
          provider: "finviz",
        });
      }
    }
    if (news.length >= 15) break;
  }
  return news;
}

async function scrapeYahoo(ticker) {
  const res = await httpsGet(`https://finance.yahoo.com/quote/${ticker}/news/`, { Referer: "https://finance.yahoo.com/" });
  if (res.status !== 200) throw new Error(`Yahoo ${res.status}`);
  const news = [];
  const seen = new Set();
  const re = /<h3[^>]*>\s*<a\s+href="([^"]*)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(res.body)) !== null) {
    const headline = m[2].trim();
    if (!headline || seen.has(headline)) continue;
    seen.add(headline);
    const href = m[1];
    if (href.startsWith("/") || href.startsWith("https://finance.yahoo.com")) {
      news.push({
        headline,
        url: href.startsWith("/") ? `https://finance.yahoo.com${href}` : href,
        time: "Yahoo Finance",
        source: "Yahoo Finance",
        provider: "yahoo",
      });
    }
    if (news.length >= 15) break;
  }
  return news;
}

// ─── FINVIZ SCREENER ──────────────────────────────────────────────────────────
// משתמש ב-v=111 (טבלת Overview קומפקטית) — לא דורש API key
// פילטרים נפוצים: f=sh_float_u50 (float מתחת ל-50M), sigs: ta_unusualvolume, ta_topgainers
function parseScreenerNumber(str) {
  if (!str) return null;
  const s = str.trim().replace(/[%,]/g, "");
  if (s === "-" || s === "") return null;
  const mult = /B$/i.test(s) ? 1e9 : /M$/i.test(s) ? 1e6 : /K$/i.test(s) ? 1e3 : 1;
  const num = parseFloat(s.replace(/[BMK]$/i, ""));
  return isNaN(num) ? null : num * mult;
}

async function scrapeFinvizScreener(signal, filters = "", maxRows = 60) {
  const rows = [];
  let offset = 1; // finviz pagination: r=1, r=21, r=41...

  while (rows.length < maxRows) {
    const qs = [
      "v=111",
      signal ? `s=${signal}` : "",
      filters ? `f=${filters}` : "",
      `r=${offset}`,
    ].filter(Boolean).join("&");

    const res = await httpsGet(`https://finviz.com/screener.ashx?${qs}`, { Referer: "https://finviz.com/" });
    if (res.status !== 200) throw new Error(`Finviz screener ${res.status}`);

    const html = res.body;
    // Compact table (v=111) rows: ticker links inside table cells in document order.
    // Each result row contains: Ticker, Company, Sector, Industry, Country, Market Cap, P/E, Price, Change, Volume
    const rowRegex = /<tr[^>]*class="[^"]*table-light-row[^"]*"[^>]*>([\s\S]*?)<\/tr>|<tr[^>]*valign="top"[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    let foundInPage = 0;

    // Fallback approach: find all rows that contain a quote.ashx?t= link (ticker link)
    const genericRowRegex = /<tr[^>]*>((?:(?!<\/tr>)[\s\S])*?quote\.ashx\?t=[\s\S]*?)<\/tr>/g;
    while ((rm = genericRowRegex.exec(html)) !== null) {
      const row = rm[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, "").trim());
      if (cells.length < 9) continue;

      // v=111 compact column order: No., Ticker, Company, Sector, Industry, Country, Market Cap, P/E, Price, Change, Volume
      // Different finviz table variants shift columns slightly, so locate Ticker via the link itself
      const tickerMatch = row.match(/quote\.ashx\?t=([A-Z.\-]+)/);
      if (!tickerMatch) continue;
      const ticker = tickerMatch[1];

      // Find numeric-looking cells from the end: last cell = Volume, second-last = Change%, third-last = Price
      const volume = parseScreenerNumber(cells[cells.length - 1]);
      const changeStr = cells[cells.length - 2];
      const change = changeStr ? parseFloat(changeStr.replace("%", "")) : null;
      const price = parseScreenerNumber(cells[cells.length - 3]);
      const company = cells[2] || cells[1] || "";

      if (rows.find(r => r.ticker === ticker)) continue; // dedupe across pages
      rows.push({ ticker, company, price, change, volume });
      foundInPage++;
      if (rows.length >= maxRows) break;
    }

    if (foundInPage === 0) break; // no more pages
    offset += 20;
    if (offset > 200) break; // hard safety cap (10 pages)
  }

  return rows;
}

// ─── SENTIMENT ────────────────────────────────────────────────────────────────
function classify(headline) {
  if (CONFIG.strongBull.test(headline)) return "bullish";
  if (CONFIG.strongBear.test(headline)) return "bearish";
  if (/\b(gain|up|rise|high|beat|profit|growth|positive|launch|partnership)\b/i.test(headline)) return "weakBull";
  if (/\b(fall|drop|down|loss|risk|weak|cut|delay|concern|pressure)\b/i.test(headline)) return "weakBear";
  return "neutral";
}

// ─── EMAIL (raw SMTP/TLS, no npm) ─────────────────────────────────────────────
function b64(s) { return Buffer.from(s).toString("base64"); }

function sendGmail(to, subject, bodyHtml) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.gmail.user || !CONFIG.gmail.pass) return reject(new Error("Gmail not configured"));
    const socket = net.createConnection(587, "smtp.gmail.com");
    let state = "connect", buf = "";
    const send = cmd => socket.write(cmd);

    const msg = [`From: PULSE Alerts <${CONFIG.gmail.user}>`, `To: ${to}`,
      `Subject: ${subject}`, `MIME-Version: 1.0`, `Content-Type: text/html; charset=UTF-8`, ``, bodyHtml].join("\r\n");

    socket.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\r\n"); buf = lines.pop();
      for (const line of lines) {
        const code = parseInt(line);
        if (state === "connect" && code === 220) { state = "ehlo"; send("EHLO pulse\r\n"); }
        else if (state === "ehlo" && code === 250 && !line.includes("-")) { state = "starttls"; send("STARTTLS\r\n"); }
        else if (state === "starttls" && code === 220) {
          state = "tlsehlo";
          const tlsSock = tls.connect({ socket, servername: "smtp.gmail.com" }, () => send("EHLO pulse\r\n"));
          let tb = "";
          tlsSock.on("data", d => {
            tb += d.toString();
            const tls_lines = tb.split("\r\n"); tb = tls_lines.pop();
            for (const tl of tls_lines) {
              const tc = parseInt(tl);
              if (state === "tlsehlo" && tc === 250 && !tl.includes("-")) { state = "auth"; send("AUTH LOGIN\r\n"); }
              else if (state === "auth" && tc === 334) { state = "user"; send(b64(CONFIG.gmail.user) + "\r\n"); }
              else if (state === "user" && tc === 334) { state = "pass"; send(b64(CONFIG.gmail.pass) + "\r\n"); }
              else if (state === "pass" && tc === 235) { state = "from"; send(`MAIL FROM:<${CONFIG.gmail.user}>\r\n`); }
              else if (state === "from" && tc === 250) { state = "rcpt"; send(`RCPT TO:<${to}>\r\n`); }
              else if (state === "rcpt" && tc === 250) { state = "data"; send("DATA\r\n"); }
              else if (state === "data" && tc === 354) { state = "body"; send(msg + "\r\n.\r\n"); }
              else if (state === "body" && tc === 250) { state = "quit"; send("QUIT\r\n"); resolve(); tlsSock.destroy(); socket.destroy(); }
              else if (tc >= 400) { reject(new Error(`SMTP ${tc}: ${tl}`)); socket.destroy(); }
            }
          });
          socket.write = d => tlsSock.write(d);
        }
      }
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error("SMTP timeout")); });
  });
}

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────────
function buildNewsEmail(ticker, alerts) {
  const rows = alerts.map(a => {
    const isBull = classify(a.headline) === "bullish";
    return `<tr><td style="padding:12px 16px;border-bottom:1px solid #1a1a1a;">
      <div style="font-size:13px;color:#eee;margin-bottom:6px;font-family:Georgia,serif;">${a.headline}</div>
      <div><span style="font-size:11px;font-weight:800;color:${isBull ? "#00c864" : "#ff4444"};">${isBull ? "▲ BULLISH" : "▼ BEARISH"}</span>
      <span style="font-size:11px;color:#444;margin-left:10px;">${a.source} · ${a.time}</span>
      ${a.url ? `<a href="${a.url}" style="font-size:11px;color:#e8ff47;text-decoration:none;margin-left:10px;">קרא ↗</a>` : ""}</div>
    </td></tr>`;
  }).join("");
  return emailWrap(ticker, "Breaking Alert", `<table style="width:100%;border-collapse:collapse;background:#111;border-radius:10px;">${rows}</table>`);
}

function buildMAEmail(ticker, periods, values, direction) {
  const sorted = [...periods].sort((a, b) => a - b);
  const rows = sorted.map(p => `<tr><td style="padding:10px 16px;border-bottom:1px solid #1a1a1a;font-family:monospace;">
    <span style="color:#555;">MA${p}</span>
    <span style="color:#eee;float:right;font-weight:700;">$${values[p]?.toFixed(2)}</span>
  </td></tr>`).join("");
  const isBull = direction === "bullish";
  const desc = isBull
    ? `ממוצעים נעים מסודרים בסדר עולה — MA${sorted[0]} > MA${sorted[1]}${sorted[2] ? ` > MA${sorted[2]}` : ""}`
    : `ממוצעים נעים מסודרים בסדר יורד — MA${sorted[0]} < MA${sorted[1]}${sorted[2] ? ` < MA${sorted[2]}` : ""}`;
  return emailWrap(ticker, `MA Stack ${isBull ? "▲ Bullish" : "▼ Bearish"}`,
    `<div style="padding:14px 16px;background:${isBull ? "rgba(0,200,100,0.1)" : "rgba(255,60,60,0.1)"};border-radius:8px;margin-bottom:16px;font-size:13px;color:${isBull ? "#00c864" : "#ff4444"};">${desc}</div>
     <table style="width:100%;border-collapse:collapse;background:#111;border-radius:10px;">${rows}</table>`);
}

function emailWrap(ticker, label, content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#080808;margin:0;padding:20px;font-family:Inter,Arial,sans-serif;">
<div style="max-width:580px;margin:0 auto;">
  <div style="padding:16px 0;border-bottom:1px solid #1a1a1a;margin-bottom:20px;">
    <span style="font-size:13px;font-weight:900;color:#e8ff47;letter-spacing:0.2em;font-family:monospace;">PULSE</span>
    <span style="font-size:11px;color:#333;margin-left:10px;letter-spacing:0.1em;text-transform:uppercase;">${label}</span>
  </div>
  <div style="font-size:26px;font-weight:900;color:#eee;font-family:monospace;margin-bottom:4px;">${ticker}</div>
  <div style="font-size:11px;color:#444;margin-bottom:18px;">${new Date().toLocaleString("he-IL")}</div>
  ${content}
  <div style="padding:20px 0;font-size:10px;color:#222;text-align:center;">PULSE · אין לראות בהתראות אלו ייעוץ השקעות</div>
</div></body></html>`;
}

// ─── ALERT STATE ──────────────────────────────────────────────────────────────
const sentNewsAlerts = new Map();
const maStackState   = new Map(); // ticker -> last fired direction

function getNewStrongNews(ticker, items) {
  if (!sentNewsAlerts.has(ticker)) sentNewsAlerts.set(ticker, new Set());
  const seen = sentNewsAlerts.get(ticker);
  const strong = items.filter(n => {
    const s = classify(n.headline);
    return (s === "bullish" || s === "bearish") && !seen.has(n.headline);
  });
  strong.forEach(n => seen.add(n.headline));
  if (seen.size > 200) sentNewsAlerts.set(ticker, new Set([...seen].slice(-200)));
  return strong;
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
async function pollAndAlert() {
  if (!CONFIG.alertTo || !CONFIG.gmail.user || !CONFIG.gmail.pass) return;

  for (const ticker of CONFIG.watchlist) {
    try {
      // News alerts
      const [fv, yf] = await Promise.allSettled([scrapeFinviz(ticker), scrapeYahoo(ticker)]);
      const all = [...(fv.status === "fulfilled" ? fv.value : []), ...(yf.status === "fulfilled" ? yf.value : [])];
      const newsAlerts = getNewStrongNews(ticker, all);
      if (newsAlerts.length > 0) {
        const subj = `🚨 PULSE — ${ticker}: ${newsAlerts.length} חדשות חזקות`;
        await sendGmail(CONFIG.alertTo, subj, buildNewsEmail(ticker, newsAlerts));
        console.log(`[ALERT] News sent for ${ticker}`);
      }

      // MA Stack alerts
      const maConf = CONFIG.maConfigs[ticker];
      if (maConf && maConf.periods && maConf.periods.length >= 2) {
        try {
          const data = await fetchPriceData(ticker, "1d", "3mo");
          const closes = data.candles.map(c => c.c);
          const { bullish, bearish, values } = checkMAStack(closes, maConf.periods);
          const prevDir = maStackState.get(ticker);
          const direction = bullish ? "bullish" : bearish ? "bearish" : null;
          if (direction && direction !== prevDir) {
            maStackState.set(ticker, direction);
            const subj = `📊 PULSE MA Stack — ${ticker} ${direction === "bullish" ? "▲ Bullish" : "▼ Bearish"}`;
            await sendGmail(CONFIG.alertTo, subj, buildMAEmail(ticker, maConf.periods, values, direction));
            console.log(`[MA ALERT] ${ticker} ${direction} stack`);
          } else if (!direction && prevDir) {
            maStackState.set(ticker, null);
          }
        } catch (e) {
          console.error(`[MA] ${ticker}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[POLL] ${ticker}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const p = url.parse(req.url, true);
  res.setHeader("Content-Type", "application/json");

  // GET /news?ticker=NVDA
  if (p.pathname === "/news" && req.method === "GET") {
    const ticker = (p.query.ticker || "AAPL").toUpperCase();
    try {
      const [fv, yf] = await Promise.allSettled([scrapeFinviz(ticker), scrapeYahoo(ticker)]);
      const finviz = fv.status === "fulfilled" ? fv.value : [];
      const yahoo  = yf.status === "fulfilled" ? yf.value : [];
      const combined = [];
      for (let i = 0; i < Math.max(finviz.length, yahoo.length) && combined.length < 20; i++) {
        if (finviz[i]) combined.push({ ...finviz[i], sentiment: classify(finviz[i].headline) });
        if (yahoo[i])  combined.push({ ...yahoo[i],  sentiment: classify(yahoo[i].headline) });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ticker, count: combined.length, sources: { finviz: finviz.length, yahoo: yahoo.length }, news: combined }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /news/multi?tickers=NVDA,AAPL,TSLA
  // מושך חדשות לכמה מניות במקביל, מאחד לפיד אחד, מתייג כל פריט עם הטיקר שלו
  if (p.pathname === "/news/multi" && req.method === "GET") {
    const tickers = (p.query.tickers || "").split(",").map(s => s.toUpperCase().trim()).filter(Boolean);
    if (tickers.length === 0) {
      res.writeHead(400); res.end(JSON.stringify({ error: "No tickers provided" })); return;
    }
    try {
      const results = await Promise.allSettled(
        tickers.map(async (t) => {
          const [fv, yf] = await Promise.allSettled([scrapeFinviz(t), scrapeYahoo(t)]);
          const finviz = fv.status === "fulfilled" ? fv.value : [];
          const yahoo  = yf.status === "fulfilled" ? yf.value : [];
          const combined = [];
          for (let i = 0; i < Math.max(finviz.length, yahoo.length) && combined.length < 10; i++) {
            if (finviz[i]) combined.push({ ...finviz[i], ticker: t, sentiment: classify(finviz[i].headline) });
            if (yahoo[i])  combined.push({ ...yahoo[i],  ticker: t, sentiment: classify(yahoo[i].headline) });
          }
          return { ticker: t, news: combined, sources: { finviz: finviz.length, yahoo: yahoo.length } };
        })
      );

      const perTicker = {};
      let allNews = [];
      let totalFinviz = 0, totalYahoo = 0;

      results.forEach((r, i) => {
        const t = tickers[i];
        if (r.status === "fulfilled") {
          perTicker[t] = { count: r.value.news.length, sources: r.value.sources };
          allNews = allNews.concat(r.value.news);
          totalFinviz += r.value.sources.finviz;
          totalYahoo  += r.value.sources.yahoo;
        } else {
          perTicker[t] = { count: 0, sources: { finviz: 0, yahoo: 0 }, error: r.reason?.message };
        }
      });

      // אינטרליב — מערבב בין מניות במקום לקבץ לפי טיקר, כך שהפיד מרגיש "חי"
      const byTicker = {};
      allNews.forEach(n => { (byTicker[n.ticker] = byTicker[n.ticker] || []).push(n); });
      const interleaved = [];
      let more = true, idx = 0;
      while (more) {
        more = false;
        for (const t of tickers) {
          const arr = byTicker[t];
          if (arr && arr[idx]) { interleaved.push(arr[idx]); more = true; }
        }
        idx++;
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        tickers,
        count: interleaved.length,
        sources: { finviz: totalFinviz, yahoo: totalYahoo },
        perTicker,
        news: interleaved,
      }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /screener/breakout?float=u50&minPrice=1&minVolRatio=2&closeNearHighPct=10
  // מאתר מניות: Unusual Volume ∩ Top Gainers ∩ Float קטן, ואז בודק close-near-high על הנר היומי
  if (p.pathname === "/screener/breakout" && req.method === "GET") {
    const floatFilter   = `sh_float_${p.query.float || "u50"}`;     // u50 = under 50M
    const minPrice       = parseFloat(p.query.minPrice || "1");
    const closeNearHighPct = parseFloat(p.query.closeNearHighPct || "15"); // % מהטווח היומי

    try {
      const [volumeRes, gainersRes] = await Promise.allSettled([
        scrapeFinvizScreener("ta_unusualvolume", floatFilter, 60),
        scrapeFinvizScreener("ta_topgainers",    floatFilter, 60),
      ]);

      const volumeList   = volumeRes.status   === "fulfilled" ? volumeRes.value   : [];
      const gainersList  = gainersRes.status  === "fulfilled" ? gainersRes.value  : [];

      const gainersSet = new Set(gainersList.map(r => r.ticker));
      // Intersection — appears in BOTH unusual volume AND top gainers
      let candidates = volumeList.filter(r => gainersSet.has(r.ticker));

      // Merge in gainer data (change% sometimes more accurate there) + price filter
      candidates = candidates.map(c => {
        const g = gainersList.find(x => x.ticker === c.ticker);
        return { ...c, change: g?.change ?? c.change, price: c.price ?? g?.price };
      }).filter(c => c.price == null || c.price >= minPrice);

      if (candidates.length === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ count: 0, candidates: [], note: "No overlap between Unusual Volume and Top Gainers right now" }));
        return;
      }

      // For each candidate, pull today's daily candle to check close-near-high + volume ratio
      const enriched = await Promise.allSettled(candidates.map(async (c) => {
        const data = await fetchPriceData(c.ticker, "1d", "3mo");
        const candles = data.candles;
        if (!candles.length) throw new Error("no candle data");
        const today = candles[candles.length - 1];
        const range = today.h - today.l;
        const distFromHighPct = range > 0 ? ((today.h - today.c) / range) * 100 : 0;
        const closeNearHigh = distFromHighPct <= closeNearHighPct;

        // Volume ratio vs 20-day average (excluding today)
        const priorVolumes = candles.slice(-21, -1).map(x => x.v).filter(v => v != null);
        const avgVol = priorVolumes.length ? priorVolumes.reduce((a,b)=>a+b,0) / priorVolumes.length : null;
        const volRatio = avgVol ? today.v / avgVol : null;

        return {
          ticker: c.ticker,
          company: c.company,
          price: today.c,
          change: c.change,
          volume: today.v,
          avgVolume: avgVol,
          volRatio,
          dayHigh: today.h,
          dayLow: today.l,
          distFromHighPct: Math.round(distFromHighPct * 10) / 10,
          closeNearHigh,
        };
      }));

      const results = enriched
        .filter(r => r.status === "fulfilled")
        .map(r => r.value)
        .sort((a, b) => (b.volRatio || 0) - (a.volRatio || 0));

      res.writeHead(200);
      res.end(JSON.stringify({
        count: results.length,
        scanned: { unusualVolume: volumeList.length, topGainers: gainersList.length, overlap: candidates.length },
        candidates: results,
      }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /journal — רשימת מעקב + סטטיסטיקות מצטברות
  if (p.pathname === "/journal" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ entries: CONFIG.journal, stats: journalStats() }));
    return;
  }

  // POST /journal/add — { ticker, company, price, change, volRatio, distFromHighPct }
  if (p.pathname === "/journal/add" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.ticker) { res.writeHead(400); res.end(JSON.stringify({ error: "ticker required" })); return; }
    const entry = addToJournal(body);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, entry, duplicate: entry === null }));
    return;
  }

  // POST /journal/refresh — מעדכן ידנית את כל המועמדות הפתוחות (גם רץ אוטומטית כל פולינג)
  if (p.pathname === "/journal/refresh" && req.method === "POST") {
    try {
      await refreshJournal();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, entries: CONFIG.journal, stats: journalStats() }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /journal/remove — { id }
  if (p.pathname === "/journal/remove" && req.method === "POST") {
    const body = await readBody(req);
    CONFIG.journal = CONFIG.journal.filter(j => j.id !== body.id);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /chart?ticker=NVDA&interval=1m&range=1d
  if (p.pathname === "/chart" && req.method === "GET") {
    const ticker   = (p.query.ticker   || "AAPL").toUpperCase();
    const interval = p.query.interval  || "1d";
    const range    = p.query.range     || "3mo";
    try {
      const data = await fetchPriceData(ticker, interval, range);
      // Compute MAs if requested
      const maPeriods = (p.query.ma || "").split(",").map(Number).filter(n => n > 0);
      const mas = {};
      if (maPeriods.length && data.candles.length) {
        const closes = data.candles.map(c => c.c);
        for (const period of maPeriods) {
          mas[period] = calcMA(closes, period);
        }
      }
      // MA stack check
      let maStack = null;
      if (maPeriods.length >= 2) {
        const closes = data.candles.map(c => c.c);
        maStack = checkMAStack(closes, maPeriods);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ...data, mas, maStack }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /alerts/config
  if (p.pathname === "/alerts/config" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({
      configured: !!(CONFIG.gmail.user && CONFIG.gmail.pass && CONFIG.alertTo),
      alertTo: CONFIG.alertTo ? CONFIG.alertTo.replace(/(.{2}).*(@.*)/, "$1***$2") : "",
      watchlist: CONFIG.watchlist,
      maConfigs: CONFIG.maConfigs,
      pollIntervalMinutes: CONFIG.pollIntervalMs / 60000,
    }));
    return;
  }

  // POST /alerts/config
  if (p.pathname === "/alerts/config" && req.method === "POST") {
    const body = await readBody(req);
    if (body.gmail_user) CONFIG.gmail.user = body.gmail_user;
    if (body.gmail_pass) CONFIG.gmail.pass = body.gmail_pass;
    if (body.alert_to)   CONFIG.alertTo    = body.alert_to;
    if (Array.isArray(body.watchlist)) CONFIG.watchlist = body.watchlist.map(s => s.toUpperCase().trim());
    if (body.maConfigs) Object.assign(CONFIG.maConfigs, body.maConfigs);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /alerts/test
  if (p.pathname === "/alerts/test" && req.method === "POST") {
    const body = await readBody(req);
    const to = body.to || CONFIG.alertTo;
    if (!to || !CONFIG.gmail.user || !CONFIG.gmail.pass) {
      res.writeHead(400); res.end(JSON.stringify({ error: "Missing credentials" })); return;
    }
    try {
      await sendGmail(to, "🔔 PULSE — בדיקת התראה", buildNewsEmail("TEST", [{
        headline: "NVDA Surges to All-Time High After Record Earnings Beat",
        url: "https://finviz.com", time: new Date().toLocaleTimeString("en-US"), source: "PULSE Test", provider: "finviz",
      }]));
      res.writeHead(200); res.end(JSON.stringify({ ok: true, sent_to: to }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }));

}).listen(PORT, async () => {
  console.log(`\n✅  PULSE Server running on port ${PORT}`);
  console.log(`    (local: http://localhost:${PORT} | cloud: your Render URL)`);
  console.log(`    /news?ticker=NVDA`);
  console.log(`    /news/multi?tickers=NVDA,AAPL,TSLA`);
  console.log(`    /screener/breakout?float=u50&minPrice=1`);
  console.log(`    /journal  (GET) /journal/add /journal/refresh (POST)`);
  console.log(`    /chart?ticker=NVDA&interval=1m&range=1d&ma=5,9,20`);
  console.log(`    /alerts/config  /alerts/test\n`);
  if (CONFIG.gmail.user && CONFIG.alertTo) {
    console.log(`📧  Alerts → ${CONFIG.alertTo} | Watchlist: ${CONFIG.watchlist.join(", ")}`);
    await pollAndAlert();
    setInterval(pollAndAlert, CONFIG.pollIntervalMs);
  } else {
    console.log(`⚠️  Email alerts OFF — set GMAIL_USER / GMAIL_PASS / ALERT_TO`);
  }
  // יומן המעקב מתעדכן כל 30 דקות, ללא תלות בהגדרות אימייל
  const JOURNAL_REFRESH_MS = 30 * 60 * 1000;
  setInterval(()=>{ refreshJournal().catch(e=>console.error("[JOURNAL]", e.message)); }, JOURNAL_REFRESH_MS);
});
