// Minimal Google APIs client (Service Account, no npm deps): Calendar + Sheets.
// Env: GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it), GOOGLE_CALENDAR_ID, GOOGLE_SHEET_ID
const crypto = require("crypto");

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const txt = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const sa = JSON.parse(txt);
    if (!sa.client_email || !sa.private_key) throw new Error("missing client_email/private_key");
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    return sa;
  } catch (e) {
    console.error("GOOGLE_SERVICE_ACCOUNT_JSON invalid:", e.message);
    return null;
  }
}

const SA = loadServiceAccount();
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const enabled = Boolean(SA && CALENDAR_ID && SHEET_ID);

let cachedToken = null; // { token, exp }

const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(SA.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google token error: " + JSON.stringify(j).slice(0, 300));
  cachedToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cachedToken.token;
}

async function gapi(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  return { status: r.status, ok: r.ok, data: j };
}

// ---------- Calendar ----------
const calBase = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}`;

async function busyIntervals(timeMinIso, timeMaxIso) {
  const r = await gapi("POST", "https://www.googleapis.com/calendar/v3/freeBusy", {
    timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: CALENDAR_ID }],
  });
  if (!r.ok) throw new Error(`freeBusy ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const cal = r.data.calendars?.[CALENDAR_ID];
  if (cal?.errors?.length) throw new Error("freeBusy calendar error: " + JSON.stringify(cal.errors));
  return (cal?.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
}

// Creates the event with a deterministic id. Returns {created:true} or {created:false, existed:true}.
async function createEvent(eventId, event) {
  const r = await gapi("POST", `${calBase()}/events`, { id: eventId, ...event });
  if (r.ok) return { created: true, id: r.data.id, link: r.data.htmlLink };
  if (r.status === 409) return { created: false, existed: true, id: eventId };
  throw new Error(`Calendar insert ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
}

async function getEvent(eventId) {
  const r = await gapi("GET", `${calBase()}/events/${eventId}`);
  if (r.status === 404 || r.status === 410) return null;
  if (!r.ok) throw new Error(`Calendar get ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

// Re-activate a previously deleted event that reuses the same deterministic id.
async function reviveEvent(eventId, event) {
  const r = await gapi("PUT", `${calBase()}/events/${eventId}`, { ...event, status: "confirmed" });
  if (!r.ok) throw new Error(`Calendar update ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return { created: true, id: r.data.id };
}

// ---------- Sheets ----------
const sheetBase = () => `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const BOOKINGS = "Bookings";
const STATE = "State";
const BOOKING_HEADERS = ["Booking ID", "Created at", "Name", "Phone", "Date", "Time", "Duration (min)", "Telegram chat", "Telegram username", "Status", "Calendar event"];
let tabsReady = false;

async function ensureTabs() {
  if (tabsReady) return;
  const meta = await gapi("GET", `${sheetBase()}?fields=sheets.properties.title`);
  if (!meta.ok) throw new Error(`Sheet meta ${meta.status}: ${JSON.stringify(meta.data).slice(0, 300)}`);
  const titles = (meta.data.sheets || []).map((s) => s.properties.title);
  const add = [BOOKINGS, STATE].filter((t) => !titles.includes(t));
  if (add.length) {
    const r = await gapi("POST", `${sheetBase()}:batchUpdate`, {
      requests: add.map((title) => ({ addSheet: { properties: { title, hidden: title === STATE } } })),
    });
    if (!r.ok) throw new Error(`addSheet ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  if (add.includes(BOOKINGS)) await putRange(`${BOOKINGS}!A1:K1`, [BOOKING_HEADERS]);
  if (add.includes(STATE)) await putRange(`${STATE}!A1:C1`, [["chat_id", "state_json", "updated_at"]]);
  tabsReady = true;
}

async function getRange(range) {
  const r = await gapi("GET", `${sheetBase()}/values/${encodeURIComponent(range)}`);
  if (!r.ok) throw new Error(`Sheet get ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data.values || [];
}

async function putRange(range, values) {
  const r = await gapi("PUT", `${sheetBase()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values });
  if (!r.ok) throw new Error(`Sheet put ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
}

async function appendRow(tab, row) {
  const r = await gapi("POST",
    `${sheetBase()}/values/${encodeURIComponent(tab + "!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [row] });
  if (!r.ok) throw new Error(`Sheet append ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const m = /!A(\d+)/.exec(r.data.updates?.updatedRange || "");
  return m ? Number(m[1]) : null;
}

async function bookingExists(bookingId) {
  await ensureTabs();
  const rows = await getRange(`${BOOKINGS}!A:A`);
  return rows.some((r) => r[0] === bookingId);
}

async function addBooking(row) {
  await ensureTabs();
  return appendRow(BOOKINGS, row);
}

// ---- conversation state persistence (survives Render restarts) ----
const stateRowIndex = new Map(); // chatId -> sheet row number

async function loadState(chatId) {
  await ensureTabs();
  const rows = await getRange(`${STATE}!A:B`);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === String(chatId)) {
      stateRowIndex.set(String(chatId), i + 1);
      try { return rows[i][1] ? JSON.parse(rows[i][1]) : null; } catch { return null; }
    }
  }
  return null;
}

async function saveState(chatId, state) {
  await ensureTabs();
  const key = String(chatId);
  const row = [key, state ? JSON.stringify(state) : "", new Date().toISOString()];
  if (!stateRowIndex.has(key)) await loadState(key); // discover existing row
  const idx = stateRowIndex.get(key);
  if (idx) await putRange(`${STATE}!A${idx}:C${idx}`, [row]);
  else {
    const n = await appendRow(STATE, row);
    if (n) stateRowIndex.set(key, n);
  }
}

module.exports = {
  enabled, serviceAccountEmail: SA?.client_email || null,
  busyIntervals, createEvent, getEvent, reviveEvent, bookingExists, addBooking, loadState, saveState, ensureTabs,
};
