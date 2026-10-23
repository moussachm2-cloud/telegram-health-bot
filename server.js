// Telegram health-info bot — webhook server for Render (free web service).
// Env: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, [GEMINI_MODEL], [WEBHOOK_SECRET]
// Booking (optional): GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID, GOOGLE_SHEET_ID + see booking.js
// Render sets RENDER_EXTERNAL_URL automatically; webhook is registered on boot.
const http = require("http");
const crypto = require("crypto");
const google = require("./google");
const { makeHandlers } = require("./booking");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Try the configured model first, then fall back (models get retired or overloaded).
const MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  "gemini-3.8-flash",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash",
  "gemini-flash-latest",
].filter(Boolean))];
// Telegram only allows A-Z a-z 0-9 _ - in secret_token; hash whatever we got into hex.
const RAW_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(16).toString("hex");
const SECRET = crypto.createHash("sha256").update(RAW_SECRET).digest("hex");
const BASE_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

if (!TOKEN || !GEMINI_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY");
  process.exit(1);
}

const SYSTEM_PROMPT = `أنت مساعد معلومات صحية عامة على Telegram.
القواعد:
- رد بنفس لغة ولهجة السائل، باختصار ووضوح (عادة أقل من 120 كلمة).
- قدّم معلومات صحية عامة فقط: تغذية، نوم، رياضة، نظافة، ونصائح عامة لأعراض خفيفة.
- لا تشخّص أي مرض، ولا تصف أدوية أو جرعات علاجية مخصصة.
- عند أي علامة خطر (ألم في الصدر، صعوبة تنفس، نزيف شديد، فقدان وعي، شلل أو تنميل مفاجئ، حرارة عالية جدًا عند رضيع، أفكار انتحارية أو إيذاء النفس): اطلب التوجه للطوارئ فورًا قبل أي شيء آخر.
- انصح بمراجعة الطبيب إذا استمرت الأعراض أو ساءت أو عند الشك.
- إذا كان السؤال خارج الصحة، اعتذر بلطف وذكّر بأنك للأسئلة الصحية البسيطة.
- البوت يدعم حجز المواعيد: إذا سأل المستخدم عن الحجز أو موعد، لا تقل إنك لا تستطيع الحجز؛ قل له أن يكتب كلمة "حجز" أو يضغط /book ليبدأ الحجز خطوة بخطوة.
- اختم بتذكير قصير: معلوماتي عامة ولا تغني عن الطبيب.`;

const history = new Map(); // chatId -> [{role, text}] (in-memory, resets on restart)
const seen = new Set();    // processed update_ids (avoid duplicates on retries)

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(j));
  return j;
}

async function askGemini(chatId, userText) {
  const h = history.get(chatId) || [];
  const contents = [...h, { role: "user", text: userText }].map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
  });
  let text = null;
  let lastErr = "";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body }
        );
        const j = await r.json();
        text = j?.candidates?.[0]?.content?.parts
          ?.filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join("")
          .trim() || null;
        if (!text) {
          lastErr = `${model} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
          console.error("Gemini failed:", lastErr);
          if ([400, 403, 404, 429].includes(r.status)) break; // quota/unavailable: go to next model now
          await new Promise((s) => setTimeout(s, 1500));
        }
      } catch (e) {
        lastErr = `${model}: ${e.message}`;
        console.error("Gemini fetch error:", lastErr);
      }
    }
    if (text) break;
  }
  if (!text) throw new Error("All Gemini models failed. Last: " + lastErr);
  h.push({ role: "user", text: userText }, { role: "model", text });
  history.set(chatId, h.slice(-10));
  return text;
}

const booking = makeHandlers(tg);

async function handleUpdate(update) {
  if (seen.has(update.update_id)) return;
  seen.add(update.update_id);
  if (seen.size > 1000) seen.clear();

  if (update.callback_query) return booking.onCallback(update.callback_query);

  const msg = update.message;
  if (!msg || (!msg.text && !msg.contact)) return;
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "أهلاً! 👋 أنا بوت للأسئلة الصحية البسيطة: التغذية، النوم، الرياضة، والأعراض الخفيفة.\nاكتب سؤالك، أو اضغط الزر لحجز موعد.\n⚠️ معلوماتي عامة ولا تغني عن الطبيب. في الحالات الطارئة اتصل بالإسعاف فورًا.",
      reply_markup: { inline_keyboard: [[{ text: "📅 احجز موعد", callback_data: "book" }]] },
    });
    return;
  }

  // booking flow first (names/phones never go to Gemini)
  if (await booking.onMessage(msg)) return;
  if (!msg.text) return;

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  let reply;
  try {
    reply = await askGemini(chatId, msg.text);
  } catch (e) {
    console.error(e.message);
    reply = "عذرًا، حدث خطأ مؤقت. حاول مرة أخرى بعد قليل 🙏";
  }
  await tg("sendMessage", { chat_id: chatId, text: reply.slice(0, 4000), reply_to_message_id: msg.message_id });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/telegram") {
    if (req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200).end("ok"); // ack fast, process after
      try {
        handleUpdate(JSON.parse(body)).catch((e) => console.error(e));
      } catch (e) {
        console.error("Bad update", e.message);
      }
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" }).end("Health bot is running");
});

server.listen(PORT, async () => {
  console.log(`Listening on ${PORT}`);
  console.log(google.enabled
    ? `Booking enabled (service account ${google.serviceAccountEmail})`
    : "Booking disabled: set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID, GOOGLE_SHEET_ID");
  if (BASE_URL) {
    const r = await tg("setWebhook", {
      url: `${BASE_URL}/telegram`,
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    console.log("setWebhook:", JSON.stringify(r));
    await tg("setMyCommands", { commands: [
      { command: "start", description: "البداية" },
      { command: "book", description: "حجز موعد" },
      { command: "cancel", description: "إلغاء الحجز الجاري" },
    ] });
    // Keep-alive: ping our own public URL so the free instance doesn't sleep after 15 min idle.
    if (process.env.KEEP_ALIVE !== "0") {
      setInterval(() => fetch(`${BASE_URL}/health`).catch(() => {}), 10 * 60 * 1000);
    }
  } else {
    console.warn("RENDER_EXTERNAL_URL not set; webhook not registered");
  }
});
