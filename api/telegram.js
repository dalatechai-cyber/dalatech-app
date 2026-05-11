"use strict";

const { runPipeline } = require("../lib/pipeline");
const { sendClientEmail } = require("../lib/email");
const {
  parseFinishCommand,
  sendTelegramConfirmation,
  sendTelegramReply,
  envState
} = require("../lib/telegram");
const { getLead, updateLead } = require("../lib/leads");

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function isAuthorizedSender(env, chatIdFromMessage, fromId) {
  if (!env.hasChatId) return true;
  const allowed = String(env.chatId);
  return String(chatIdFromMessage) === allowed || String(fromId) === allowed;
}

async function processFinish({ lead, message }) {
  const chatId = message?.chat?.id;
  const replyId = message?.message_id;

  console.log(`[telegram-webhook] #${lead.id} finish: starting production pipeline`);

  updateLead(lead.id, { status: "finishing", startedAt: new Date().toISOString() });

  await sendTelegramReply({
    chatId,
    text: `⏳ #${lead.id} (${lead.businessName}) бүрэн хувилбарыг бэлдэж байна... 2-5 минут болно.`,
    replyToMessageId: replyId
  }).catch(err => console.error("[telegram-webhook] ack reply failed:", err?.message || err));

  const productionBrief = {
    businessName:   lead.businessName,
    industry:       lead.industry,
    description:    lead.description,
    services:       lead.services,
    primaryColor:   lead.primaryColor,
    secondaryColor: lead.secondaryColor,
    style:          lead.style,
    references:     lead.references,
    sections:       lead.sections,
    fullName:       lead.fullName,
    email:          lead.email,
    phone:          lead.phone,
    logo:           null,
    quality:        "production"
  };

  let result;
  try {
    result = await runPipeline({ brief: productionBrief });
  } catch (err) {
    console.error(`[telegram-webhook] #${lead.id} pipeline failed:`, err?.message || err);
    updateLead(lead.id, { status: "failed", lastError: err?.message || String(err) });
    await sendTelegramReply({
      chatId,
      text: `❌ #${lead.id} амжилтгүй боллоо: ${err?.message || err}`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  const finalUrl = result.previewUrl;
  updateLead(lead.id, {
    status: "finished",
    finalUrl,
    finalProjectName: result.deployment.projectName,
    finishedAt: new Date().toISOString()
  });

  await sendClientEmail({
    to: lead.email,
    businessName: lead.businessName,
    fullName: lead.fullName,
    previewUrl: finalUrl,
    mode: "final"
  }).then(() => console.log(`[telegram-webhook] #${lead.id} client final email sent`))
    .catch(err => console.error(`[telegram-webhook] #${lead.id} client final email failed:`, err?.message || err));

  await sendTelegramConfirmation({ leadId: lead.id, finalUrl })
    .catch(err => console.error(`[telegram-webhook] #${lead.id} confirmation failed:`, err?.message || err));

  console.log(`[telegram-webhook] #${lead.id} finished: ${finalUrl}`);
}

async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "dalatech-telegram-webhook" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let update;
  try { update = await readJsonBody(req); }
  catch { return res.status(200).json({ ok: true }); }

  // Acknowledge Telegram before doing slow work so it does not retry.
  res.status(200).json({ ok: true });

  try {
    const message = update?.message || update?.edited_message || update?.channel_post;
    if (!message) {
      console.log("[telegram-webhook] update has no message, ignoring");
      return;
    }

    const text = message.text || "";
    console.log(`[telegram-webhook] inbound text="${text}" chatId=${message.chat?.id} fromId=${message.from?.id}`);

    const env = envState();
    if (!isAuthorizedSender(env, message.chat?.id, message.from?.id)) {
      console.warn(`[telegram-webhook] unauthorized sender chatId=${message.chat?.id} fromId=${message.from?.id}`);
      return;
    }

    const cmd = parseFinishCommand(text);
    if (!cmd) {
      console.log("[telegram-webhook] no finish command in message");
      return;
    }

    const lead = getLead(cmd.id);
    if (!lead) {
      await sendTelegramReply({
        chatId: message.chat?.id,
        text: `⚠️ #${cmd.id} олдсонгүй. Захиалгын дугаараа шалгана уу.`,
        replyToMessageId: message.message_id
      }).catch(() => {});
      return;
    }

    if (lead.status === "finished" && lead.finalUrl) {
      await sendTelegramReply({
        chatId: message.chat?.id,
        text: `ℹ️ #${lead.id} аль хэдийн бэлэн болсон: ${lead.finalUrl}`,
        replyToMessageId: message.message_id
      }).catch(() => {});
      return;
    }

    if (lead.status === "finishing") {
      await sendTelegramReply({
        chatId: message.chat?.id,
        text: `⏳ #${lead.id} одоо бүтэж байна, түр хүлээнэ үү.`,
        replyToMessageId: message.message_id
      }).catch(() => {});
      return;
    }

    await processFinish({ lead, message });
  } catch (err) {
    console.error("[telegram-webhook] handler error:", err?.message || err);
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "1mb" }
  }
};
