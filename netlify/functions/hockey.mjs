// Radar Hockey (NHL y ligas del mundo) — función de Netlify que lee AnnaBet.com y devuelve JSON.
// Sin dependencias externas: usa fetch nativo (Node 18+) y un lector de tablas HTML propio.
//   /api/hockey?league=serie_6_NHL        posiciones (general / casa / fuera) + partidos
//   /api/hockey?league=serie_6_NHL&part=standings   solo posiciones (se usa para la temporada anterior)
//   /api/hockey?part=leagues              lista de ligas de hockey de AnnaBet
//   /api/hockey?debug=1&league=...        diagnóstico: cómo viene la página

// ======================= CONFIGURACIÓN =======================
const SITE = "https://annabet.com/en/hockeystats/"; // versión en inglés: fechas "Monday 15. June 2026"
const DEFAULT_LEAGUE = "serie_6_NHL";
// Lista de respaldo por si no se puede leer el menú de ligas (el menú real trae más)
const FALLBACK_LEAGUES = [
  ["serie_6_NHL", "NHL (EE.UU./Canadá)"], ["serie_11_AHL", "AHL"], ["serie_239_ECHL", "ECHL"],
  ["serie_13_KHL", "KHL (Rusia)"], ["serie_1_Finnish_SM-liiga", "Finlandia Liiga"],
  ["serie_2_SHL", "Suecia SHL"], ["serie_14_Swedish_Allsvenskan", "Suecia Allsvenskan"],
  ["serie_9_German_DEL", "Alemania DEL"], ["serie_16_Czech_Extraliga", "Rep. Checa Extraliga"],
  ["serie_8_Swiss_NLA", "Suiza National League"], ["serie_15_Champions_HL", "Champions Hockey League"],
  ["serie_223_OHL", "OHL (Canadá)"], ["serie_284_PWHL", "PWHL (femenina)"],
];
const MENU_PAGE = DEFAULT_LEAGUE; // página de la que se lee el menú completo de ligas
// Partidos con pocas fechas jugadas: los cálculos usan la temporada anterior
const MIN_GP = 5;
const UPCOMING_PAGES = ["https://annabet.com/en/hockeystats/"];
// =============================================================

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tkey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(",", ".").replace(/[^\d.\-+]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
// Lee la página por partes y se detiene al llegar al tiempo límite: si AnnaBet es lento,
// se trabaja con lo que alcanzó a llegar (las tablas de posiciones y partidos están arriba)
// en lugar de fallar todo. Netlify corta las funciones a los 10 s.
async function getHtmlPartial(url, maxMs = 8000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const deadline = Date.now() + maxMs;
  const timer = setTimeout(() => ctrl.abort(), maxMs + 500);
  try {
    // si AnnaBet corta la conexión ("fetch failed") se reintenta mientras quede tiempo
    let r;
    for (let k = 0; ; k++) {
      try { r = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: ctrl.signal, redirect: "follow" }); break; }
      catch (e) { if (e.name === "AbortError" || k >= 2 || deadline - Date.now() < 2500) throw e; await sleep(400); }
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body || !r.body.getReader) return { html: await r.text(), partial: false, finalUrl: r.url, redirected: r.redirected };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let html = "", partial = false;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) { partial = true; break; }
      const res = await Promise.race([reader.read(), sleep(left).then(() => ({ timeout: true }))]);
      if (res.timeout) { partial = true; break; }
      if (res.done) break;
      html += dec.decode(res.value, { stream: true });
    }
    if (partial) { try { reader.cancel(); } catch {} }
    if (!/<table/i.test(html)) throw new Error(partial ? "AnnaBet tardó demasiado en responder" : "la página no trae tablas (posible bloqueo o liga sin datos)");
    return { html, partial, finalUrl: r.url, redirected: r.redirected };
  } catch (e) {
    throw e.name === "AbortError" ? new Error("AnnaBet tardó demasiado en responder") : e;
  } finally {
    clearTimeout(timer);
  }
}

async function getHtml(url, tries = 2, timeoutMs = 4500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (!/<table/i.test(html)) throw new Error("la página no trae tablas (posible bloqueo o liga sin datos)");
      return html;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
      if (i < tries - 1) await sleep(400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : "error desconocido");
}

// ---------- lector de tablas HTML ----------
function decode(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z])(acute|grave|tilde|uml|circ|cedil|ring|slash|caron);/gi, (_, c, t) =>
      (c + ({ acute: "́", grave: "̀", tilde: "̃", uml: "̈", circ: "̂", cedil: "̧", ring: "̊", slash: "", caron: "̌" }[t.toLowerCase()] || "")).normalize("NFC"))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const out = [];
  const reTable = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = reTable.exec(html))) {
    const rows = [];
    const reRow = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = reRow.exec(m[0]))) {
      const cells = [];
      const reCell = /<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi;
      let c;
      while ((c = reCell.exec(r[0]))) cells.push(decode(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ index: m.index, end: m.index + m[0].length, rows });
  }
  return out;
}

// ---------- posiciones: General / Casa / Fuera ----------
// Cabecera de AnnaBet hockey:
// "# | Team | GP | W | OTW | OTL | L | GF | GA | Diff | Pts | Pts/G | W% | ØGF | ØGA"
//   W = ganados en tiempo regular, OTW = ganados en prórroga/penales, OTL = perdidos en prórroga/penales,
//   L = perdidos en tiempo regular. Algunas ligas traen además T/D (empates).
const H = {
  team: /^(team|equipo|club)$/i,
  gp: /^(gp|pj|mp|games|played|p)$/i,
  w: /^(w|pg|g|won|wins|v)$/i,
  otw: /^(otw|ot\s*w|w\s*ot|wot|sow|otw\/sow|pw|gp?ot)$/i,
  otl: /^(otl|ot\s*l|l\s*ot|lot|sol|otl\/sol|pl|pp?ot)$/i,
  d: /^(d|t|ties?|draws?|empates?|e|x)$/i,
  l: /^(l|pp|lost|losses|defeats?|derrotas?)$/i,
  goals: /^(goals|goles|g\s*:\s*g|gf\s*:\s*ga|score)$/i,
  gf: /^(gf|goals?\s*for|goles\s*a\s*favor|gs|scored)$/i,
  ga: /^(ga|goals?\s*against|goles\s*en\s*contra|gc|conceded)$/i,
  agf: /^ø\s*gf$/i,
  aga: /^ø\s*ga$/i,
  pts: /^(pts|points|puntos)$/i,
  ptsg: /^(pts\s*\/\s*g|ppg|pts\/gp)$/i,
};

function isStandingsHdr(r) {
  return r.some((c) => H.team.test(c)) && r.some((c) => H.w.test(c)) && r.some((c) => H.l.test(c));
}
// Tabla de posiciones válida = además trae goles (descarta tablas de apuestas / forma)
function isFullStandingsHdr(r) {
  return isStandingsHdr(r) &&
    (r.some((c) => H.goals.test(c)) || (r.some((c) => H.gf.test(c) || H.agf.test(c)) && r.some((c) => H.ga.test(c) || H.aga.test(c))));
}

function parseStandingsTable(t) {
  const hi = t.rows.findIndex(isStandingsHdr);
  const hdr = t.rows[hi];
  const ix = (re, not = []) => hdr.findIndex((c, i) => re.test(c) && !not.includes(i));
  const iT = ix(H.team), iW = ix(H.w), iOW = ix(H.otw), iOL = ix(H.otl), iD = ix(H.d, [iW]), iL = ix(H.l, [iW, iD]);
  const iGP = ix(H.gp, [iW, iD, iL]), iGoals = ix(H.goals);
  const iGF = ix(H.gf), iGA = ix(H.ga, [iGF]), iAGF = ix(H.agf), iAGA = ix(H.aga);
  const iPts = ix(H.pts), iPtsG = ix(H.ptsg);
  const map = {};
  let pos = 0;
  for (const r of t.rows.slice(hi + 1)) {
    if (isStandingsHdr(r) || !r[iT]) continue;
    const W = num(r[iW]), L = num(r[iL]);
    if (W == null || L == null) continue;
    const OW = iOW >= 0 ? num(r[iOW]) || 0 : 0, OL = iOL >= 0 ? num(r[iOL]) || 0 : 0, D = iD >= 0 ? num(r[iD]) || 0 : 0;
    pos++;
    const pl = num(r[0]);
    const GP = iGP >= 0 && num(r[iGP]) != null ? num(r[iGP]) : W + OW + OL + D + L;
    let gf = null, ga = null;
    if (iGoals >= 0) {
      const m = /(\d+)\s*[:\-–]\s*(\d+)/.exec(r[iGoals] || "");
      if (m) { gf = +m[1]; ga = +m[2]; }
    } else if (iGF >= 0 && iGA >= 0) {
      gf = num(r[iGF]); ga = num(r[iGA]);
    } else if (iAGF >= 0 && iAGA >= 0 && num(r[iAGF]) != null) {
      gf = num(r[iAGF]) * GP; ga = num(r[iAGA]) * GP; // promedios → totales
    }
    const pts = iPts >= 0 ? num(r[iPts]) : null;
    map[tkey(r[iT])] = {
      team: r[iT], pos: pl && pl > 0 && pl < 500 ? pl : pos,
      gp: GP, w: W, otw: OW, otl: OL, d: D, l: L,
      pts,
      ppg: GP > 0 ? (iPtsG >= 0 && num(r[iPtsG]) != null ? num(r[iPtsG]) : pts != null ? pts / GP : null) : null,
      // promedios por partido (sin partidos jugados no hay datos reales)
      gf: GP > 0 && gf != null ? gf / GP : null,
      ga: GP > 0 && ga != null ? ga / GP : null,
    };
  }
  return map;
}

// Toma las tablas de posiciones en orden. Lo normal: 1ª = todos los juegos, 2ª = casa, 3ª = fuera.
// Si el texto previo a la tabla dice "home/casa" o "away/fuera", se usa eso.
function parseStandings(html, tables) {
  let st = tables.filter((t) => t.rows.some(isFullStandingsHdr));
  if (!st.length) st = tables.filter((t) => t.rows.some(isStandingsHdr));
  if (!st.length) throw new Error("tabla de posiciones no encontrada");
  // Solo cuentan las 3 primeras (la de "Forma"/últimos partidos viene después y se ignora)
  const out = { all: null, home: null, away: null, groups: 0 };
  // Por ORDEN: 1ª tabla = todos los juegos, 2ª = en casa, 3ª = fuera.
  // (Las pestañas "All games / At home / At away" se escriben todas antes de la 1ª tabla,
  //  así que el texto previo no sirve para saber cuál es cuál.)
  // Solo cuentan tablas con varios equipos (descarta tablitas de resumen con 1 fila)
  let maps = st.map((t) => parseStandingsTable(t)).filter((m) => Object.keys(m).length >= 3);
  const order = ["all", "home", "away"];
  // Si la 1ª tabla tiene la mitad de partidos que la 2ª + 3ª, el orden es el esperado
  maps.slice(0, 3).forEach((m, i) => { out[order[i]] = m; });
  // Tabla general armada desde casa + fuera (si la general no se pudo leer o está incompleta)
  const derive = (H, A) => {
    const all = {};
    for (const k of new Set([...Object.keys(H), ...Object.keys(A)])) {
      const z = { gp: 0, w: 0, otw: 0, otl: 0, d: 0, l: 0, pts: null };
      const h = H[k] || z, a = A[k] || z;
      const gp = h.gp + a.gp;
      const tot = (x, f) => (x[f] != null ? x[f] * x.gp : 0);
      const pts = h.pts != null || a.pts != null ? (h.pts || 0) + (a.pts || 0) : null;
      all[k] = { team: (H[k] || A[k]).team, gp, w: h.w + a.w, otw: h.otw + a.otw, otl: h.otl + a.otl, d: h.d + a.d, l: h.l + a.l,
        pts, ppg: gp && pts != null ? pts / gp : null,
        gf: gp ? (tot(h, "gf") + tot(a, "gf")) / gp : null, ga: gp ? (tot(h, "ga") + tot(a, "ga")) / gp : null };
    }
    Object.values(all).sort((x, y) => (y.pts ?? 0) - (x.pts ?? 0) || ((y.gf - y.ga) - (x.gf - x.ga)) || y.gf - x.gf)
      .forEach((x, i) => { x.pos = i + 1; });
    return all;
  };
  const size = (m) => (m ? Object.keys(m).length : 0);
  // Caso: solo se leyeron casa y fuera (la general falló) → las 2 tablas son casa/fuera
  // Dos tablas: solo son casa/fuera si tienen más o menos los mismos partidos (si no: general + forma)
  const medGp2 = (m) => { const a = Object.values(m).map((x) => x.gp).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  if (maps.length === 2 && Math.abs(medGp2(maps[0]) - medGp2(maps[1])) > 1) { out.all = medGp2(maps[0]) >= medGp2(maps[1]) ? maps[0] : maps[1]; out.home = null; out.away = null; }
  else if (maps.length === 2) { out.home = maps[0]; out.away = maps[1]; out.all = derive(out.home, out.away); out.derived = true; }
  else if (out.home && out.away && size(out.all) < size(out.home)) { out.all = derive(out.home, out.away); out.derived = true; }
  // Coherencia: en casa + fuera no puede tener más partidos que la general; si pasa, se descartan
  if (out.all && out.home && out.away) {
    const bad = Object.keys(out.all).filter((k) => out.home[k] && out.away[k] && out.home[k].gp + out.away[k].gp > out.all[k].gp + 0.5).length;
    if (bad > Object.keys(out.all).length / 2) { out.home = null; out.away = null; out.mismatch = true; }
  }
  if (!out.all) out.all = {};
  return out;
}

// ---------- partidos ----------
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Reconoce "Thursday 24. September 2026", "24. September 2026", "24.9.2026", "24.09.26", "24.9."
// Fecha de hoy/mañana/ayer según la hora de Europa central (AnnaBet es un sitio europeo)
function relDay(offset) {
  const now = new Date(Date.now() + offset * 86400000); // AnnaBet escribe las fechas en hora UTC
  return iso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

function nearest(d, mo) {
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
  const now = new Date(), y = now.getUTCFullYear();
  return [y - 1, y, y + 1].map((yy) => iso(yy, mo, d)).sort((a, b) => Math.abs(new Date(a) - now) - Math.abs(new Date(b) - now))[0];
}

function findDate(text) {
  const t = String(text || "");
  // AnnaBet puede escribir "Today" / "Hoy" en lugar de la fecha para los partidos del día
  if (/\b(today|hoy|tänään|heute|oggi|aujourd'hui)\b/i.test(t)) return relDay(0);
  if (/\b(tomorrow|mañana|huomenna|morgen|domani|demain)\b/i.test(t)) return relDay(1);
  if (/\b(yesterday|ayer|eilen|gestern|ieri|hier)\b/i.test(t)) return relDay(-1);
  let m = /\b(\d{1,2})\.?\s+([A-Za-zé]+)\s+(\d{4})\b/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[2], +m[1]); }
  // "26. September" / "26 Sep" sin año → el año más cercano a hoy
  m = /\b(\d{1,2})\.?\s+([A-Za-zé]{3,10})\b/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return nearest(+m[1], MONTHS[m[2].toLowerCase()]);
  m = /\b([A-Za-z]{3,10})\.?\s+(\d{1,2})\b(?!\s*[:.]\d)/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return nearest(+m[2], MONTHS[m[1].toLowerCase()]);
  // "26/09" o "26/09/2026"
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] <= 31) { if (m[3]) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[2], +m[1]); } return nearest(+m[1], +m[2]); }
  // "26.9." (con punto final; sin él se confundiría con cuotas como 2.10)
  m = /(?:^|\s)(\d{1,2})\.(\d{1,2})\.(?=\s|$)/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    // sin año: el más cercano a hoy
    const now = new Date(), y = now.getUTCFullYear();
    const cands = [y - 1, y, y + 1].map((yy) => iso(yy, +m[2], +m[1]));
    return cands.sort((a, b) => Math.abs(new Date(a) - now) - Math.abs(new Date(b) - now))[0];
  }
  return null;
}

// Un partido = una fila de tabla que contiene DOS equipos conocidos (de las posiciones).
// Si trae marcador "98 - 97" es un resultado; si no, es un partido por jugar.
function parseGames(tables, knownKeys, nameOf) {
  const games = [];
  const seen = new Set();
  let curDate = null;
  const teamIn = (cell) => {
    const k = tkey(cell);
    if (knownKeys.has(k)) return k;
    // celda "Equipo A - Equipo B"
    return null;
  };
  for (const t of tables) {
    curDate = null; // la fecha de un encabezado vale solo dentro de su tabla
    for (const r of t.rows) {
      const rowText = r.join(" | ");
      const d = findDate(rowText);
      // fila solo de fecha (cabecera de día)
      const teamsInRow = [];
      for (const c of r) {
        const k = teamIn(c);
        if (k) teamsInRow.push(k);
        else if (/\s[-–]\s/.test(c)) {
          const parts = c.split(/\s[-–]\s/).map((p) => p.trim());
          if (parts.length === 2 && knownKeys.has(tkey(parts[0])) && knownKeys.has(tkey(parts[1]))) teamsInRow.push(tkey(parts[0]), tkey(parts[1]));
        }
      }
      if (d && teamsInRow.length < 2) { curDate = d; continue; }
      if (teamsInRow.length < 2) continue;
      const [hk, ak] = teamsInRow;
      if (hk === ak) continue;
      const date = d || curDate;
      // Marcador: celda "4 - 3", "5 - 4 ot", "3 - 2 so" (no confundir con la hora "18:00")
      let score = null, extra = "";
      for (const c of r) {
        const m = /^\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(ot|so|pen|ps|ap|et|shootout|overtime)?\.?\s*(?:\(.*\))?\s*$/i.exec(c);
        if (m) { score = m; extra = (m[3] || "").toLowerCase(); break; }
      }
      // prórroga en una celda aparte ("ot" / "so")
      if (score && !extra) { const oc = r.find((c) => /^\s*(ot|so|pen|ap)\.?\s*$/i.test(c)); if (oc) extra = oc.trim().toLowerCase().replace(".", ""); }
      const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(rowText);
      let odds = r.map((c) => c.trim()).filter((c) => /^\d{1,3}\.\d{2}$/.test(c)).map(Number);
      if (odds.length < 2) { // cuotas en una sola celda "2.56 / 4.10 / 2.37"
        const oc = r.find((c) => /^\s*\d{1,2}\.\d{2}(\s*[\/|]\s*\d{1,2}\.\d{2}){1,2}\s*$/.test(c));
        if (oc) odds = oc.split(/[\/|]/).map((x) => Number(x.trim()));
      }
      // Hándicap de la casa de apuestas (columna HC: "0", "+19.5", "-29.5")
      const hcCell = odds.length >= 2 ? r.map((c) => c.trim()).find((c) => /^([+-]\d{1,2}(\.\d{1,2})?|0)$/.test(c)) : null;
      const id = `${date}|${hk}|${ak}`;
      if (seen.has(id)) continue;
      seen.add(id);
      games.push({
        date, time: time ? time[0] : "",
        home: nameOf(hk), away: nameOf(ak), homeKey: hk, awayKey: ak,
        score: score ? [+score[1], +score[2]] : null,
        ...(score && extra ? { ot: extra === "so" || extra === "pen" || extra === "ps" || extra === "shootout" ? "SO" : "OT" } : {}),
        odds: odds.length >= 2 ? odds.slice(0, 3) : null,
        hc: hcCell ? Number(hcCell) : null,
        ...(date ? {} : { raw: rowText.slice(0, 160) }),
      });
    }
  }
  return games;
}

// ---------- ligas ----------
// País de cada liga: 1) el título de país del menú de AnnaBet ("Germany", "Soccer England"),
// 2) si no, el gentilicio del enlace ("serie_253_German_Regionalliga_West" → Alemania).
const COUNTRY_ES = {
  england: "Inglaterra", scotland: "Escocia", wales: "Gales", "northern ireland": "Irlanda del Norte", ireland: "Irlanda",
  germany: "Alemania", spain: "España", italy: "Italia", france: "Francia", netherlands: "Países Bajos", holland: "Países Bajos",
  belgium: "Bélgica", portugal: "Portugal", turkey: "Turquía", "türkiye": "Turquía", greece: "Grecia", russia: "Rusia",
  ukraine: "Ucrania", poland: "Polonia", "czech republic": "Rep. Checa", czechia: "Rep. Checa", slovakia: "Eslovaquia",
  austria: "Austria", switzerland: "Suiza", denmark: "Dinamarca", sweden: "Suecia", norway: "Noruega", finland: "Finlandia",
  iceland: "Islandia", croatia: "Croacia", serbia: "Serbia", slovenia: "Eslovenia", bosnia: "Bosnia", "bosnia and herzegovina": "Bosnia",
  romania: "Rumania", bulgaria: "Bulgaria", hungary: "Hungría", cyprus: "Chipre", israel: "Israel", latvia: "Letonia",
  lithuania: "Lituania", estonia: "Estonia", belarus: "Bielorrusia", albania: "Albania", montenegro: "Montenegro",
  "north macedonia": "Macedonia del Norte", macedonia: "Macedonia del Norte", georgia: "Georgia", armenia: "Armenia",
  azerbaijan: "Azerbaiyán", kazakhstan: "Kazajistán", moldova: "Moldavia", malta: "Malta", luxembourg: "Luxemburgo",
  "faroe islands": "Islas Feroe", andorra: "Andorra", "san marino": "San Marino", gibraltar: "Gibraltar",
  brazil: "Brasil", argentina: "Argentina", chile: "Chile", colombia: "Colombia", mexico: "México", uruguay: "Uruguay",
  paraguay: "Paraguay", peru: "Perú", ecuador: "Ecuador", bolivia: "Bolivia", venezuela: "Venezuela", usa: "EE.UU.",
  "united states": "EE.UU.", canada: "Canadá", "costa rica": "Costa Rica", honduras: "Honduras", guatemala: "Guatemala",
  "el salvador": "El Salvador", panama: "Panamá", nicaragua: "Nicaragua", jamaica: "Jamaica",
  japan: "Japón", "south korea": "Corea del Sur", korea: "Corea del Sur", china: "China", australia: "Australia",
  "saudi arabia": "Arabia Saudita", qatar: "Catar", "united arab emirates": "Emiratos Árabes", uae: "Emiratos Árabes",
  iran: "Irán", india: "India", thailand: "Tailandia", vietnam: "Vietnam", indonesia: "Indonesia", malaysia: "Malasia",
  singapore: "Singapur", egypt: "Egipto", morocco: "Marruecos", algeria: "Argelia", tunisia: "Túnez",
  "south africa": "Sudáfrica", nigeria: "Nigeria", ghana: "Ghana", "new zealand": "Nueva Zelanda",
  europe: "Europa", "north america": "Norteamérica", asia: "Asia", africa: "África", oceania: "Oceanía",
  philippines: "Filipinas", taiwan: "Taiwán", lebanon: "Líbano", jordan: "Jordania", "puerto rico": "Puerto Rico",
  "dominican republic": "Rep. Dominicana", cuba: "Cuba", international: "Internacional", world: "Mundial", "south america": "Sudamérica",
};
const DEMONYM_ES = {
  english: "Inglaterra", scottish: "Escocia", welsh: "Gales", northern: "Irlanda del Norte", irish: "Irlanda",
  german: "Alemania", spanish: "España", italian: "Italia", french: "Francia", dutch: "Países Bajos", belgian: "Bélgica",
  portuguese: "Portugal", turkish: "Turquía", greek: "Grecia", russian: "Rusia", ukrainian: "Ucrania", polish: "Polonia",
  czech: "Rep. Checa", slovak: "Eslovaquia", slovakian: "Eslovaquia", austrian: "Austria", swiss: "Suiza", danish: "Dinamarca",
  swedish: "Suecia", norwegian: "Noruega", finnish: "Finlandia", icelandic: "Islandia", croatian: "Croacia", serbian: "Serbia",
  slovenian: "Eslovenia", bosnian: "Bosnia", romanian: "Rumania", bulgarian: "Bulgaria", hungarian: "Hungría",
  cypriot: "Chipre", cyprus: "Chipre", israeli: "Israel", latvian: "Letonia", lithuanian: "Lituania", estonian: "Estonia",
  belarusian: "Bielorrusia", albanian: "Albania", montenegrin: "Montenegro", macedonian: "Macedonia del Norte",
  georgian: "Georgia", armenian: "Armenia", azerbaijani: "Azerbaiyán", kazakh: "Kazajistán", moldovan: "Moldavia",
  maltese: "Malta", luxembourg: "Luxemburgo", faroese: "Islas Feroe", brazilian: "Brasil", argentinian: "Argentina",
  argentine: "Argentina", argentina: "Argentina", chilean: "Chile", colombian: "Colombia", mexican: "México",
  uruguayan: "Uruguay", paraguayan: "Paraguay", peruvian: "Perú", ecuadorian: "Ecuador", bolivian: "Bolivia",
  venezuelan: "Venezuela", american: "EE.UU.", us: "EE.UU.", usa: "EE.UU.", canadian: "Canadá", japanese: "Japón",
  korean: "Corea del Sur", chinese: "China", australian: "Australia", saudi: "Arabia Saudita", qatari: "Catar",
  egyptian: "Egipto", moroccan: "Marruecos", algerian: "Argelia", tunisian: "Túnez", "south": null,
};
function countryOfHeading(t) {
  const k = String(t || "").replace(/^(soccer|football|basketball|ice hockey|hockey)\s+/i, "").trim().toLowerCase();
  return COUNTRY_ES[k] || null;
}
function countryOfSlug(slug) {
  const w = String(slug || "").split("_");
  return DEMONYM_ES[(w[0] || "").toLowerCase()] || null;
}
function parseLeagues(html) {
  // Solo enlaces <a> reales (no <link hreflang> de la cabecera), con texto corto
  const re = /<a\b[^>]*?href="([^"]*?)(serie_(\d+)_([^"\/]+?))\.html"[^>]*>((?:(?!<\/a>)[\s\S]){0,300}?)<\/a>/gi;
  const out = new Map();
  let m, last = 0, heading = null;
  while ((m = re.exec(html))) {
    // texto entre el enlace anterior y este = posible título de país del menú
    const aStart = Math.max(last, html.lastIndexOf("<a", m.index));
    const between = decode(html.slice(last, aStart).replace(/<a\b[\s\S]*?<\/a>/gi, " "));
    last = m.index + m[0].length;
    if (between) heading = between.length <= 40 && !/\d/.test(between) ? between : null;
    if (/,/.test(m[2])) continue;
    // selector de idioma: el mismo enlace en /es/, /fi/, /de/... → se ignora (solo /en/ o /us/)
    const lang = (/\/([a-z]{2})\/[a-z]+stats\//i.exec(m[1]) || [])[1];
    if (lang && !/^(en|us)$/i.test(lang)) continue; // enlaces de temporadas anteriores
    let id = decode(m[2]);
    try { id = decodeURIComponent(id); } catch {}
    let txt = decode(m[5]);
    if (!txt || txt.length > 60 || /[#{};"<>]|^languages?\b|^(english|español|suomi|svenska|deutsch|français|italiano)$/i.test(txt)) txt = m[4].replace(/_/g, " ");
    // país: título del menú → gentilicio del enlace → gentilicio o país al inicio del nombre ("Brazilian Serie B")
    const country = countryOfHeading(heading) || countryOfSlug(m[4]) || countryOfSlug(txt.replace(/\s+/g, "_")) || countryOfHeading(txt.split(/\s+/)[0]);
    // "Alemania: Regionalliga West" (sin repetir el país si el nombre ya lo trae)
    const label = country && !tkey(txt).includes(tkey(country)) ? `${country}: ${txt.replace(/^(English|German|Spanish|Italian|French|Finnish|Swedish|Norwegian|Danish|Dutch|Belgian|Portuguese|Turkish|Greek|Russian|Polish|Czech|Swiss|Austrian|Scottish|Irish|Brazilian|Argentinian|Mexican|American|Japanese|Korean|Chinese|Australian|Colombian|Chilean|Peruvian|Ecuadorian|Uruguayan|Paraguayan|Bolivian|Venezuelan|Ukrainian|Romanian|Bulgarian|Hungarian|Croatian|Serbian|Slovenian|Slovak|Israeli|Cypriot|Icelandic|Welsh|Argentine|Belarusian|Latvian|Lithuanian|Estonian|Egyptian|Moroccan|Saudi|Canadian)\s+/i, "")}` : txt;
    if (!out.has(id)) out.set(id, label);
  }
  // Orden alfabético por país: en la lista se escribe "Ale…" y salta a Alemania
  return [...out.entries()].sort((x, y) => x[1].localeCompare(y[1], "es"));
}

// Temporadas anteriores de la misma liga: "serie_6_NHL,175,season_2024-2025" (más reciente primero)
function parseSeasons(html, league) {
  const sid = (/^serie_(\d+)_/.exec(league) || [])[1];
  const re = /href="[^"]*?(serie_(\d+)_[^"\/,]+,\d+,season_(\d{4})-(\d{2,4}))\.html"/gi;
  const out = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (m[2] !== sid) continue;
    let id = decode(m[1]);
    try { id = decodeURIComponent(id); } catch {}
    if (!out.has(id)) out.set(id, { id, start: +m[3], label: `${m[3]}-${m[4]}` });
  }
  return [...out.values()].sort((a, b) => b.start - a.start);
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

// Acepta cualquier nombre de liga del menú (con acentos, &, etc.), sin barras ni saltos
const cleanLeague = (s) => (s && /^serie_\d+_[^\/?#\s"<>]+$/.test(s) ? s : null);

async function leaguesResponse() {
  try {
    // el menú está al principio de la página: se lee por partes, hasta 8 s, con reintentos
    const { html } = await getHtmlPartial(`${SITE}${MENU_PAGE}.html`, 8000);
    const list = parseLeagues(html);
    if (list.length < 5) throw new Error("menú de ligas no encontrado");
    return json({ ok: true, leagues: list, source: "annabet" }, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
      "Netlify-Vary": "query=part",
    });
  } catch (e) {
    return json({ ok: true, leagues: FALLBACK_LEAGUES, source: "respaldo", warning: e.message }, 200, { "Cache-Control": "no-store" });
  }
}

async function debugUpcoming() {
  const out = [];
  for (const u of UPCOMING_PAGES) {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const html = await r.text();
      const tables = parseTables(html);
      out.push({ url: u, status: r.status, final: r.url, bytes: html.length, tablas: tables.length,
        muestra: tables.slice(0, 6).map((t, i) => ({ n: i, filas: t.rows.length, primeras: t.rows.slice(0, 5) })) });
    } catch (e) { out.push({ url: u, error: e.message }); }
  }
  return out;
}

async function debugResponse(league) {
  const u = `${SITE}${encodeURI(league)}.html`;
  try {
    // hasta 3 intentos: AnnaBet a veces corta la conexión ("fetch failed")
    let r, html, lastErr;
    for (let k = 0; k < 3 && !html; k++) {
      try { r = await fetch(u, { headers: HEADERS }); html = await r.text(); }
      catch (e) { lastErr = e; await sleep(700); }
    }
    if (!html) throw lastErr || new Error("sin respuesta");
    const tables = parseTables(html);
    return json({
      url: u, status: r.status, bytes: html.length, tablas: tables.length,
      muestra: tables.slice(0, 30).map((t, i) => ({
        n: i, filas: t.rows.length,
        antes: decode(html.slice(Math.max(0, t.index - 300), t.index)).slice(-120),
        primeras: t.rows.slice(0, 4),
      })),
      fechasEncontradas: [...new Set((decode(html).match(/\b\d{1,2}\.\s+[A-Z][a-z]+\s+\d{4}\b/g) || []))].slice(0, 10),
      ligasEnMenu: parseLeagues(html).length,
      partidos: (() => {
        try {
          const stn = parseStandings(html, tables);
          const nm = {}; for (const m of [stn.all, stn.home, stn.away]) for (const [k, v] of Object.entries(m || {})) nm[k] ||= v.team;
          const g = parseGames(tables, new Set(Object.keys(nm)), (k) => nm[k]);
          return { total: g.length, porFecha: g.reduce((a, x) => ((a[x.date || "SIN FECHA"] = (a[x.date || "SIN FECHA"] || 0) + 1), a), {}),
            sinFecha: g.filter((x) => !x.date).slice(0, 8).map((x) => x.raw) };
        } catch (e) { return { error: e.message }; }
      })(),
      pestanaProximos: probeUpcoming(html),
      candidatosProximos: upcomingCandidates(html, league),
    }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ url: u, error: e.message }, 200, { "Cache-Control": "no-store" });
  }
}


// ---------- partidos próximos ----------
// La página de la liga de AnnaBet trae resultados, pero la pestaña "Upcoming Games" se carga aparte.
// 1) Se buscan en el HTML de la liga los enlaces/direcciones que parezcan de próximos partidos.
// 2) Además se usa la página del día de AnnaBet (results_0 = hoy, results_1 = mañana si existe).
// La página pide cada fuente con ?part=rows&path=... y une los partidos de sus equipos.
const ORIGIN = "https://annabet.com";
function upcomingCandidates(html, league) {
  const sid = (/^serie_(\d+)_/.exec(league) || [])[1] || "";
  const found = new Set();
  const re = /["'(=\s]((?:https?:\/\/(?:www\.)?annabet\.com)?\/?[\w\/.\-]*?(?:upcoming|coming|next_?games?|fixtures?|schedule|program)[\w\/.\-]*(?:\.php|\.html|\/)?(?:\?[\w=&%.,\-]*)?)["')\s]/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/&amp;/g, "&").replace(/^https?:\/\/(?:www\.)?annabet\.com/i, "");
    if (u.length < 6 || /\.(js|css|png|jpg|gif|svg)(\?|$)/i.test(u)) continue;
    if (!/\.(php|html?)\b|\?/i.test(u)) continue; // solo páginas reales (no nombres de pestañas)
    if (!u.startsWith("/")) u = new URL(u, SITE).pathname + (u.includes("?") ? u.slice(u.indexOf("?")) : "");
    // de otra liga: "serie=12" no es la liga 1 (también "serie=i%3A1%3B" = i:1;)
    const dec = decodeURIComponent(u);
    if (sid && /serie=|serie_|id=/.test(dec) && !new RegExp(`(serie[=_](?:i:)?|id=)${sid}(\\D|$)`).test(dec)) continue;
    found.add(u);
  }
  const base = new URL(SITE).pathname; // "/en/soccerstats/"
  // La pestaña de AnnaBet (ajax_upcoming) es la fuente buena. La página del día (results_0) trae TODAS las
  // ligas y podría mezclar copas o equipos femeninos/filiales: solo se usa si no hay pestaña.
  const list = [...found].slice(0, 3);
  return list.length ? list : [`${base}results_0.html`];
}
const cleanPath = (p) => (p && /^\/[\w\/.,?=&%\-]+$/.test(p) && !p.includes("..") ? p : null);

// Filas genéricas de partido: dos equipos (texto) + hora o marcador
function genericRows(html, dayOffset) {
  const rows = [];
  const tables = parseTables(html);
  const baseDate = dayOffset != null ? relDay(dayOffset) : null;
  for (const t of tables) {
    let curDate = null, league = "";
    for (const r of t.rows) {
      const rowText = r.join(" | ");
      if (/odds:|cuotas:|season|relegation|promotion|average|total|%/i.test(rowText) && !/\b\d{1,2}:\d{2}\b/.test(rowText)) continue;
      const d = findDate(rowText);
      const time = r.map((c) => /(?:^|\D)(([01]?\d|2[0-3]):[0-5]\d)(?!\d)/.exec(c)).find(Boolean);
      // "04.10. 13:30" / "Sat 04.10 13:30" (día.mes junto a la hora)
      let dm = null;
      for (const c of r) { const x = /(\d{1,2})\.(\d{1,2})\.?\s+\d{1,2}:\d{2}/.exec(c); if (x) { dm = nearest(+x[1], +x[2]); break; } }
      let score = null, ot = "";
      for (const c of r) {
        const sm = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(ot|so|pen|ps|ap|et|aet)?\.?\s*(?:\(.*\))?\s*$/i.exec(c);
        if (sm) { score = [+sm[1], +sm[2]]; ot = (sm[3] || "").toLowerCase(); break; }
      }
      const texts = r.map((c) => c.trim()).filter((c) => c.length >= 2 && c.length <= 45 && /[A-Za-zÀ-ÿ]{2}/.test(c) &&
        !findDate(c) && !/\d{1,2}:\d{2}/.test(c) && !/^(ot|so|pen|ap|et|aet|ft|fin|final|live|postp\.?|canc\.?|\d+\.\s*|mon|tue|wed|thu|fri|sat|sun|today|tomorrow)$/i.test(c));
      let a = null, b = null;
      if (texts.length >= 2) { [a, b] = texts; }
      else if (texts.length === 1 && /\s[-–]\s/.test(texts[0])) { const p = texts[0].split(/\s[-–]\s/); if (p.length === 2) { a = p[0].trim(); b = p[1].trim(); } }
      if (!a || !b) {
        if (d) curDate = d;
        else if (texts.length === 1 && !time && !score) league = texts[0];
        continue;
      }
      let odds = r.map((c) => c.trim()).filter((c) => /^\d{1,3}\.\d{2}$/.test(c)).map(Number);
      if (odds.length < 2) {
        const oc = r.find((c) => /^\s*\d{1,2}\.\d{2}(\s*[\/|]\s*\d{1,2}\.\d{2}){1,2}\s*$/.test(c));
        odds = oc ? oc.split(/[\/|]/).map((x) => Number(x.trim())) : [];
      }
      if (!time && !score && odds.length < 2) continue;
      rows.push({
        date: dm || d || curDate || baseDate, time: time ? time[1] : "", a, b, score,
        ...(ot ? { ot: /so|pen|ps/.test(ot) ? "SO" : "OT" } : {}),
        odds: odds.length >= 2 ? odds.slice(0, 3) : null, league,
      });
    }
  }
  return rows;
}

async function rowsResponse(path) {
  const p = cleanPath(path);
  if (!p) return json({ ok: false, error: "ruta no válida" }, 400, { "Cache-Control": "no-store" });
  const off = /results_(-?\d+)\.html/.exec(p);
  try {
    // las direcciones ajax_ de AnnaBet se piden como lo hace su página (jQuery .load)
    const ajax = /ajax_/i.test(p) ? { "X-Requested-With": "XMLHttpRequest", Referer: SITE, Accept: "text/html, */*; q=0.01" } : {};
    // igual que la página de AnnaBet: dirección + "&" + número al azar (evita respuestas viejas)
    const r = await getHtmlPartial(ORIGIN + p + (/ajax_/i.test(p) ? `&${Math.random()}` : ""), 8500, ajax);
    // si AnnaBet nos manda a otra página (portada, aviso de límite), esas filas no son de la liga
    const fin = r.finalUrl ? new URL(r.finalUrl).pathname : "";
    if (r.redirected && fin && !p.startsWith(fin))
      return json({ ok: false, path: p, error: `AnnaBet redirigió a ${fin} (posible límite de visitas, reintenta en unos minutos)`, rows: [] }, 200, { "Cache-Control": "no-store" });
    const rows = genericRows(r.html, off ? +off[1] : null);
    // sin filas reconocidas: se devuelve una muestra de cómo viene la página para corregir el lector
    const sample = rows.length ? undefined : parseTables(r.html).filter((t) => t.rows.length > 1).slice(0, 2)
      .map((t) => t.rows.slice(0, 5).map((x) => x.join(" | ").slice(0, 160)));
    return json({ ok: true, path: p, rows, partial: r.partial, bytes: r.html.length, sample }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ ok: false, path: p, error: e.message, rows: [] }, 200, { "Cache-Control": "no-store" });
  }
}

// Diagnóstico de la pestaña "Upcoming Games": scripts y textos que la cargan
function probeUpcoming(html) {
  const out = { scripts: [], snippets: [], ids: [] };
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)) out.scripts.push(m[1]);
  const au = html.indexOf("ajax_upcoming");
  if (au >= 0) out.ajax = html.slice(au, au + 500).replace(/\s+/g, " ");
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const s = m[1];
    for (const k of s.matchAll(/(upcoming|ajax|\.php|load\(|fetch\(|XMLHttp|\$\.get|\$\.post|getJSON)/gi)) {
      out.snippets.push(s.slice(Math.max(0, k.index - 150), k.index + 200).replace(/\s+/g, " "));
      if (out.snippets.length >= 12) break;
    }
    if (out.snippets.length >= 12) break;
  }
  for (const m of html.matchAll(/<[^>]+(?:upcoming|coming|next)[^>]*>/gi)) { out.ids.push(m[0].slice(0, 250)); if (out.ids.length >= 12) break; }
  return out;
}

export default async (req) => {
  const T0 = Date.now();
  const url = new URL(req.url);
  if (url.searchParams.get("part") === "rows") return rowsResponse(url.searchParams.get("path"));
  const part = url.searchParams.get("part");
  if (part === "leagues") return leaguesResponse();
  const askedLeague = url.searchParams.get("league");
  const league = cleanLeague(askedLeague) || DEFAULT_LEAGUE;
  if (askedLeague && !cleanLeague(askedLeague))
    return json({ ok: false, error: `Nombre de liga no válido: ${askedLeague}`, league: askedLeague }, 400, { "Cache-Control": "no-store" });
  if (url.searchParams.get("debug")) return debugResponse(league);

  let html, partialPage = false;
  try {
    const r = await getHtmlPartial(`${SITE}${encodeURI(league)}.html`, 8000);
    html = r.html; partialPage = r.partial;
  } catch (e) {
    return json({ ok: false, error: `No se pudo leer la liga en AnnaBet (${e.message}). Pulsa Actualizar para reintentar.`, league }, 502, { "Cache-Control": "no-store" });
  }

  const warnings = [];
  if (partialPage) warnings.push("AnnaBet respondió lento: se usó la parte de la página que alcanzó a llegar (posiciones y partidos más recientes).");
  const tables = parseTables(html);
  let standings, standingsFromPrev = null;
  try {
    standings = parseStandings(html, tables);
  } catch (e) {
    // Temporada recién empezada sin tabla todavía: se usa la tabla de la temporada anterior
    const nowY = new Date(), startNow = nowY.getUTCMonth() >= 6 ? nowY.getUTCFullYear() : nowY.getUTCFullYear() - 1;
    const prevS = part === "standings" ? null : parseSeasons(html, league).find((x) => x.start < startNow);
    const left = 9300 - (Date.now() - T0);
    if (prevS && left > 1500) {
      try {
        const r2 = await getHtmlPartial(`${SITE}${encodeURI(prevS.id)}.html`, left - 300);
        standings = parseStandings(r2.html, parseTables(r2.html));
        standingsFromPrev = prevS.label;
      } catch {}
    }
    if (!standings)
      return json({ ok: false, error: `La liga no tiene tabla de posiciones en AnnaBet (${e.message}).`, league }, 502, { "Cache-Control": "no-store" });
  }
  const title = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || "") || league.replace(/^serie_\d+_/, "").replace(/_/g, " ").replace(/,.*$/, "");
  const cacheHdr = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${part === "standings" ? 21600 : 900}, stale-while-revalidate=3600`,
    "Netlify-Vary": "query=league|part",
  };
  // Solo posiciones (temporada anterior, para el inicio de temporada)
  if (part === "standings") return json({ ok: true, league, title, standings }, 200, cacheHdr);

  if (standings.derived) warnings.push("La tabla general se calculó sumando las tablas de casa y fuera.");
  if (standings.mismatch) warnings.push("Las tablas de casa/fuera no cuadran con la general: se usa la general para todo.");
  else if (!standings.home || !standings.away) warnings.push("Esta liga no trae tablas de casa y fuera: se usa la general para todo.");

  const names = {};
  for (const m of [standings.all, standings.home, standings.away]) for (const [k, v] of Object.entries(m || {})) names[k] ||= v.team;
  const known = new Set(Object.keys(names));
  const nameOf = (k) => names[k];

  const games = parseGames(tables, known, nameOf);
  if (!games.length) warnings.push("No se encontraron partidos de esta liga (ni resultados ni próximos).");
  const noDate = games.filter((g) => !g.date).length;
  if (noDate) warnings.push(`${noDate} partido(s) sin fecha reconocida (no se muestran). Ejemplo: ${games.filter((g) => !g.date).slice(0, 2).map((g) => `"${g.raw}"`).join(" / ")}`);
  for (let i = games.length - 1; i >= 0; i--) if (!games[i].date) games.splice(i, 1);

  // Inicio de temporada: con menos de MIN_GP partidos por equipo los números no dicen nada;
  // la página pedirá la tabla de la temporada anterior (?part=standings&league=<temporada>)
  const gps = Object.values(standings.all || {}).map((x) => x.gp);
  const early = !standingsFromPrev && (!gps.length || median(gps) < MIN_GP);
  if (standingsFromPrev) warnings.push(`AnnaBet aún no trae la tabla de esta temporada: todos los cálculos usan la temporada ${standingsFromPrev}.`);
  const seasons = parseSeasons(html, league);
  // Año de inicio de la temporada actual: del título ("NHL 2025-2026") o, si no lo trae ("German DEL"),
  // por la fecha: de julio a diciembre empieza este año, de enero a junio empezó el año pasado.
  const now = new Date();
  const curStart = +((/(\d{4})\s*[-\/]\s*\d{2,4}/.exec(title) || [])[1] || 0) ||
    (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
  const prev = seasons.find((s) => s.start < curStart) || null;
  if (early && prev) warnings.push(`Inicio de temporada: los equipos con menos de ${MIN_GP} partidos se calculan con la temporada ${prev.label}.`);
  else if (early) warnings.push(`Inicio de temporada: pocos partidos jugados y no se encontró la temporada anterior; los cálculos son poco fiables.`);

  return json(
    { ok: true, league, title, updated: new Date().toISOString(), standings, games, warnings, minGp: MIN_GP,
      upcomingUrls: upcomingCandidates(html, league), upcomingProbe: probeUpcoming(html),
      prevSeason: prev ? { id: prev.id, label: prev.label } : null, early },
    200,
    cacheHdr
  );
};

export const config = { path: "/api/hockey" };
