"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { getLead } = require("../lib/leads");

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY = 12;
const RESPONSE_MAX_TOKENS = 700;

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function bad(res, status, message) {
  applyCors(res);
  res.status(status).json({ ok: false, error: message });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) { req.destroy(); reject(new Error("payload too large")); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function buildSystemPrompt(lead) {
  const lines = [
    `Та "${lead.businessName}" бизнесийн онлайн туслах. Зөвхөн манай бизнесийн талаар Монгол хэлээр хариулна.`,
    "",
    "Бизнесийн мэдээлэл:",
    `- Нэр: ${lead.businessName}`,
    `- Чиглэл: ${lead.industry}`,
    `- Тайлбар: ${lead.description}`,
    `- Үйлчилгээ ба бүтээгдэхүүн: ${lead.services}`,
    `- Холбоо барих утас: ${lead.phone}`,
    `- Холбоо барих имэйл: ${lead.email}`,
    lead.references ? `- Лавлагаа: ${lead.references}` : null,
    "",
    "Зааварчилгаа:",
    "- Үргэлж Монгол кирилл үсгээр хариулна.",
    "- Богино, тодорхой, найрсаг хариулна (2-4 өгүүлбэр).",
    "- Үнэ, цаг, байршил, үйлчилгээний тухай асуувал бизнесийн мэдээллээс хариулна.",
    "- Хэрэв мэдээлэл байхгүй бол `Тодорхой мэдээгүй байна, утсаар холбогдоорой` гэж хариулж дээрх утсыг өгнө.",
    "- Гадны сэдэв (улс төр, өрсөлдөгч, бусад бизнес) рүү ороогүй, эелдгээр татгалзана.",
    "- Эмодзи хэт олон бүү ашигла.",
    "- Загвар, AI, систем, OpenAI, Claude гэж бүү дурд."
  ].filter(Boolean);
  return lines.join("\n");
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && typeof m === "object")
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, MAX_MESSAGE_LEN)
    }))
    .slice(-MAX_HISTORY);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(res);
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    applyCors(res);
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) return bad(res, 500, "Server misconfigured: ANTHROPIC_API_KEY missing");

  let body;
  try { body = await readJsonBody(req); }
  catch { return bad(res, 400, "Invalid JSON body"); }

  const businessId = String(body.businessId || "").trim();
  const userMessage = String(body.message || "").trim().slice(0, MAX_MESSAGE_LEN);
  if (!businessId) return bad(res, 400, "businessId is required");
  if (!userMessage) return bad(res, 400, "message is required");

  const lead = getLead(businessId);
  if (!lead) return bad(res, 404, "Business not found");

  const history = sanitizeHistory(body.history);
  const messages = [...history, { role: "user", content: userMessage }];

  console.log(`[chat] business=#${businessId} message="${userMessage.slice(0, 80)}"`);

  let reply;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: RESPONSE_MAX_TOKENS,
        system: buildSystemPrompt(lead),
        messages
      },
      { timeout: 30000 }
    );
    reply = (message.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    console.error(`[chat] claude error business=#${businessId}:`, err?.message || err);
    return bad(res, 502, "Уучлаарай, түр хариулт авч чадсангүй.");
  }

  if (!reply) {
    return bad(res, 502, "Хариулт хоосон ирлээ.");
  }

  applyCors(res);
  return res.status(200).json({ ok: true, reply });
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "64kb" }
  }
};
