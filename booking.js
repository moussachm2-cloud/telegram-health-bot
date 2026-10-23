// Booking flow: buttons only (no AI), state persisted in the Google Sheet "State" tab.
// Config env (all optional): TIMEZONE, WORK_DAYS, WORK_START, WORK_END, SLOT_MINUTES,
// BOOKING_DAYS_AHEAD, MIN_LEAD_MINUTES
const crypto = require("crypto");
const g = require("./google");

const TZ = process.env.TIMEZONE || "Africa/Algiers";
// 0=Sunday ... 6=Saturday. Default Sun–Thu (Algerian work week).
const WORK_DAYS = (process.env.WORK_DAYS || "0,1,2,3,4").split(",").map((s) => Number(s.trim())).filter((n) => n >= 0 && n <= 6);
const WORK_START = process.env.WORK_START || "09:00";
const WORK_END = process.env.WORK_END || "17:00";
const SLOT = Number(process.env.SLOT_MINUTES || 30);
const DAYS_AHEAD = Number(process.env.BOOKING_DAYS_AHEAD || 7);
const MIN_LEAD = Number(process.env.MIN_LEAD_MINUTES || 60);

const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// ---------- time helpers (timezone-safe without libraries) ----------
function localParts(ms, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p;
}
function offsetMs(ms, tz = TZ) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
// "2026-10-25", "09:30" in TZ -> UTC ms
function localToUtc(date, time, tz = TZ) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMs(guess, tz);
  utc = guess - offsetMs(utc, tz); // second pass handles DST edges
  return utc;
}
const pad = (n) => String(n).padStart(2, "0");
function localDate(ms) { const p = localParts(ms); return `${p.year}-${p.month}-${p.day}`; }
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function weekday(date) { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fromMin(n) { return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; }
function dayLabel(date) { const [, m, d] = date.split("-"); return `${AR_DAYS[weekday(date)]} ${+d}/${+m}`; }
function isoWithOffset(date, time) {
  const utc = localToUtc(date, time);
  const off = offsetMs(utc) / 60000;
  const sign = off >= 0 ? "+" : "-";
  return `${date}T${time}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// ---------- availability ----------
async function freeSlots() {
  const now = Date.now();
  const today = localDate(now);
  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const date = addDays(today, i);
    if (WORK_DAYS.includes(weekday(date))) days.push(date);
  }
  if (!days.length) return {};
  const winStart = localToUtc(days[0], WORK_START);
  const winEnd = localToUtc(days[days.length - 1], WORK_END);
  const busy = await g.busyIntervals(new Date(winStart).toISOString(), new Date(winEnd).toISOString());
  const out = {};
  for (const date of days) {
    const times = [];
    for (let m = toMin(WORK_START); m + SLOT <= toMin(WORK_END); m += SLOT) {
      const t = fromMin(m);
      const s = localToUtc(date, t), e = s + SLOT * 60000;
      if (s < now + MIN_LEAD * 60000) continue;
      if (busy.some(([bs, be]) => s < be && e > bs)) continue;
      times.push(t);
    }
    if (times.length) out[date] = times;
  }
  return out;
}

// ---------- state (memory cache + Sheet persistence) ----------
const cache = new Map(); // chatId -> state|null (authoritative once loaded; single Render instance)
async function getState(chatId) {
  if (cache.has(chatId)) return cache.get(chatId);
  const s = await g.loadState(chatId);
  cache.set(chatId, s);
  return s;
}
async function setState(chatId, s) {
  cache.set(chatId, s);
  await g.saveState(chatId, s);
}

// serialize confirmations so two people can't grab the same slot at once
let chain = Promise.resolve();
function locked(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

const bookingIdFor = (chatId, date, time) =>
  crypto.createHash("sha1").update(`${chatId}|${date}T${time}`).digest("hex").slice(0, 32); // hex ⊂ Calendar id charset

// ---------- UI ----------
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
const CANCEL_BTN = { text: "❌ إلغاء", callback_data: "x" };

// Trigger words for the interactive booking flow. NOTE: JS \b does not work with Arabic letters,
// so we match short messages that contain a booking keyword instead.
const BOOK_WORDS = /(حجز|احجز|أحجز|نحجز|حجوزات|موعد|مواعيد|rendez[\s-]?vous|rdv|réserv|reserv|book|appointment)/i;
const BOOK_RE = { test: (t) => t.length <= 40 && !t.startsWith("/") && BOOK_WORDS.test(t) };

function makeHandlers(tg) {
  const say = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, ...extra });

  async function showDays(chatId, editMsgId) {
    const slots = await freeSlots();
    const dates = Object.keys(slots);
    if (!dates.length) {
      await setState(chatId, null);
      return say(chatId, "عذرًا، لا توجد مواعيد متاحة في الأيام القادمة. حاول لاحقًا 🙏");
    }
    const kb = chunk(dates.map((d) => ({ text: dayLabel(d), callback_data: `d:${d}` })), 2);
    kb.push([CANCEL_BTN]);
    await setState(chatId, { step: "day" });
    const body = { text: "📅 اختر اليوم المناسب:", reply_markup: { inline_keyboard: kb } };
    return editMsgId ? tg("editMessageText", { chat_id: chatId, message_id: editMsgId, ...body }) : say(chatId, body.text, { reply_markup: body.reply_markup });
  }

  async function start(chatId) {
    if (!g.enabled) return say(chatId, "خدمة الحجز ستُفعّل قريبًا 🙏 يمكنك الآن طرح أسئلتك الصحية.");
    try { return await showDays(chatId); }
    catch (e) { console.error("booking start:", e.message); return say(chatId, "تعذّر فتح المواعيد حاليًا، حاول بعد قليل 🙏"); }
  }

  async function askPhone(chatId) {
    return say(chatId, "📱 اضغط الزر لمشاركة رقم هاتفك، أو اكتبه.\n(يُستخدم رقمك فقط لتأكيد الموعد والتواصل معك.)", {
      reply_markup: { keyboard: [[{ text: "📱 مشاركة رقمي", request_contact: true }], [{ text: "إلغاء" }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }

  async function showSummary(chatId, s) {
    await say(chatId, "✅ تم استلام الرقم.", { reply_markup: { remove_keyboard: true } });
    return say(chatId,
      `راجع الحجز:\n👤 الاسم: ${s.name}\n📱 الهاتف: ${s.phone}\n📅 اليوم: ${dayLabel(s.date)}\n🕐 الساعة: ${s.time}\n⏱️ المدة: ${SLOT} دقيقة`,
      { reply_markup: { inline_keyboard: [[{ text: "✅ تأكيد الحجز", callback_data: "c" }, CANCEL_BTN]] } });
  }

  async function confirm(chatId, s, from) {
    const id = bookingIdFor(chatId, s.date, s.time);
    const startIso = `${s.date}T${s.time}:00`;
    const endIso = `${s.date}T${fromMin(toMin(s.time) + SLOT)}:00`;
    const event = {
      summary: `حجز: ${s.name}`,
      description: `الاسم: ${s.name}\nالهاتف: ${s.phone}\nTelegram: ${from.username ? "@" + from.username : chatId}\nBooking ID: ${id}`,
      start: { dateTime: startIso, timeZone: TZ },
      end: { dateTime: endIso, timeZone: TZ },
    };
    return locked(async () => {
      if (await g.bookingExists(id)) return "exists";
      const existing = await g.getEvent(id);
      if (!existing || existing.status === "cancelled") {
        const s0 = localToUtc(s.date, s.time);
        const busy = await g.busyIntervals(new Date(s0).toISOString(), new Date(s0 + SLOT * 60000).toISOString());
        if (busy.length) return "taken";
        if (existing) await g.reviveEvent(id, event);
        else await g.createEvent(id, event);
      }
      await g.addBooking([
        id, isoWithOffset(localDate(Date.now()), `${localParts(Date.now()).hour}:${localParts(Date.now()).minute}`),
        s.name, s.phone, s.date, s.time, SLOT, String(chatId), from.username || "", "confirmed", id,
      ]);
      return "ok";
    });
  }

  // returns true if the message was handled by the booking flow
  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    if (/^\/book(@\w+)?$/i.test(text) || BOOK_RE.test(text)) { await start(chatId); return true; }
    if (!g.enabled) return false;

    let s;
    try { s = await getState(chatId); } catch (e) { console.error("state load:", e.message); return false; }
    if (!s) return false;

    if (/^\/cancel\b/i.test(text) || text === "إلغاء") {
      await setState(chatId, null);
      await say(chatId, "تم إلغاء الحجز.", { reply_markup: { remove_keyboard: true } });
      return true;
    }
    if (s.step === "name") {
      if (!text || text.startsWith("/") || text.length < 2 || text.length > 60) { await say(chatId, "اكتب اسمك الكامل من فضلك (2–60 حرفًا)."); return true; }
      await setState(chatId, { ...s, step: "phone", name: text });
      await askPhone(chatId);
      return true;
    }
    if (s.step === "phone") {
      let phone = null;
      if (msg.contact) {
        if (msg.contact.user_id && msg.from && msg.contact.user_id !== msg.from.id) { await say(chatId, "شارك رقمك أنت من فضلك عبر الزر."); return true; }
        phone = msg.contact.phone_number.startsWith("+") ? msg.contact.phone_number : "+" + msg.contact.phone_number;
      } else if (/^\+?[0-9][0-9\s-]{7,15}$/.test(text)) {
        phone = text.replace(/[\s-]/g, "");
      }
      if (!phone) { await say(chatId, "الرقم غير صحيح. استعمل زر المشاركة أو اكتب رقمًا مثل 0555123456."); return true; }
      const ns = { ...s, step: "confirm", phone };
      await setState(chatId, ns);
      await showSummary(chatId, ns);
      return true;
    }
    // day/time/confirm steps expect buttons
    await say(chatId, "اختر من الأزرار أعلاه، أو اكتب /cancel لإلغاء الحجز.");
    return true;
  }

  async function onCallback(cq) {
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;
    const data = cq.data || "";
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    if (data === "book") return start(chatId);
    if (!g.enabled) return;
    try {
      const s = (await getState(chatId)) || {};
      if (data === "x") {
        await setState(chatId, null);
        return tg("editMessageText", { chat_id: chatId, message_id: msgId, text: "تم إلغاء الحجز." });
      }
      if (data === "back") return showDays(chatId, msgId);
      if (data.startsWith("d:") && s.step === "day") {
        const date = data.slice(2);
        const times = (await freeSlots())[date] || [];
        if (!times.length) return showDays(chatId, msgId);
        await setState(chatId, { step: "time", date });
        const kb = chunk(times.map((t) => ({ text: t, callback_data: `t:${t}` })), 4);
        kb.push([{ text: "⬅️ رجوع", callback_data: "back" }, CANCEL_BTN]);
        return tg("editMessageText", { chat_id: chatId, message_id: msgId, text: `🕐 اختر الساعة ليوم ${dayLabel(date)}:`, reply_markup: { inline_keyboard: kb } });
      }
      if (data.startsWith("t:") && s.step === "time") {
        const time = data.slice(2);
        await setState(chatId, { step: "name", date: s.date, time });
        await tg("editMessageText", { chat_id: chatId, message_id: msgId, text: `📅 ${dayLabel(s.date)} — 🕐 ${time}` });
        return say(chatId, "👤 اكتب اسمك الكامل:");
      }
      if (data === "c" && s.step === "confirm") {
        await tg("editMessageText", { chat_id: chatId, message_id: msgId, text: "⏳ جارٍ تأكيد الحجز..." });
        const result = await confirm(chatId, s, cq.from || {});
        if (result === "taken") {
          await say(chatId, "عذرًا، هذا الموعد حُجز للتو. اختر موعدًا آخر:");
          return showDays(chatId);
        }
        await setState(chatId, null);
        return tg("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: `✅ تم تأكيد حجزك!\n👤 ${s.name}\n📅 ${dayLabel(s.date)} — 🕐 ${s.time}\nنراك في الموعد.`,
        });
      }
      // stale/duplicate button press
    } catch (e) {
      console.error("booking callback:", e.message);
      return say(chatId, "حدث خطأ مؤقت أثناء الحجز. حاول مرة أخرى بعد قليل 🙏");
    }
  }

  return { start, onMessage, onCallback };
}

module.exports = { makeHandlers, _test: { localToUtc, isoWithOffset, dayLabel, addDays, weekday, freeSlots, bookingIdFor } };
