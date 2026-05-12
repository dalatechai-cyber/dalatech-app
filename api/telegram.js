"use strict";

// Telegram webhook for Bilguun's production conversation flow.
//
// Bilguun talks to the bot in three commands per lead:
//   `#NNN finish ...details...`   First production build. Body is free-form
//                                 notes (real copy, prices, addresses, photo
//                                 URLs). Bot acknowledges, builds, replies
//                                 with a preview URL.
//   `CHANGE #NNN ...feedback...`  Regenerate. Feedback accumulates across
//                                 calls so each new build incorporates every
//                                 prior request. Bot replies with a fresh
//                                 preview URL.
//   `APPROVE #NNN`                Final sign-off. Bot acknowledges, deletes
//                                 the three Vercel demo projects for this
//                                 lead, and tells Bilguun to wire up the
//                                 client's domain manually.
//
// Status machine (lib/leads.js):
//   ... -> finishing -> awaiting_review <-> changing -> awaiting_review -> approved
//
// All long-running work happens inline because Vercel's per-invocation
// budget for this function is 300s (vercel.json) which fits comfortably:
// ~90s sonnet generation + ~30s haiku review + ~5s deploy + ~3s telegram.

const { generateHtml, decorateHtml } = require("../lib/pipeline");
const { deployToVercel, deleteVercelProject } = require("../lib/deploy");
const { reviewAndFixHtml } = require("../lib/quality-review");
const {
  parseFinishCommand,
  parseApproveCommand,
  parseChangeCommand,
  sendTelegramReply,
  envState
} = require("../lib/telegram");
const { getLead, updateLead, STATUS } = require("../lib/leads");

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

// A FINISHING / CHANGING lead is considered "stale" if its updatedAt is more
// than STALE_BUILD_MS ago. Vercel kills this function at 300s; anything still
// pinned in those statuses 10 minutes later is the result of a hard crash,
// not active work, so subsequent commands should be allowed to proceed
// instead of being told "wait".
const STALE_BUILD_MS = 10 * 60 * 1000;
function isStaleBuild(lead) {
  if (lead?.status !== STATUS.FINISHING && lead?.status !== STATUS.CHANGING) return false;
  const ts = Date.parse(lead.updatedAt || lead.finishingStartedAt || "");
  if (!Number.isFinite(ts)) return true;
  return (Date.now() - ts) > STALE_BUILD_MS;
}

// Build a Mongolian summary of what Bilguun included in the finish command,
// so the acknowledgement reply confirms the bot understood his message.
// Keep it terse: counts + first ~220 chars of notes.
function summarizeExtras(extras) {
  const photos = Array.isArray(extras?.photos) ? extras.photos : [];
  const notes = (extras?.notes || extras?.raw || "").trim();
  const lines = [];
  if (photos.length > 0) {
    lines.push(`📷 Зураг: ${photos.length} ширхэг`);
  }
  if (notes) {
    const oneLine = notes.replace(/\s+/g, " ").trim();
    const preview = oneLine.length > 220 ? oneLine.slice(0, 217) + "..." : oneLine;
    lines.push(`📝 Тэмдэглэл: ${preview}`);
  }
  if (lines.length === 0) {
    lines.push("ℹ️ Нэмэлт мэдээлэл алга. Анхны брифээр үргэлжлүүлж байна.");
  }
  return lines.join("\n");
}

// Render the message Bilguun receives once a production preview is live.
// Spells out APPROVE / CHANGE so he never has to remember the syntax.
function buildPreviewReadyText({ leadId, businessName, previewUrl, iteration }) {
  const lines = [
    `✅ #${leadId} (${businessName}) урьдчилсан хувилбар бэлэн боллоо.`,
    "",
    `🌐 ${previewUrl}`,
    ""
  ];
  if (iteration > 1) {
    lines.push(`🔁 Засвар №${iteration} оруулсан.`);
    lines.push("");
  }
  lines.push(
    "Дараагийн алхам:",
    "",
    `   ✅ APPROVE #${leadId}`,
    "      Сайт бэлэн, домэйн холболт эхлэх.",
    "",
    `   ✏️ CHANGE #${leadId} [юу засах вэ]`,
    `      Жишээ: CHANGE #${leadId} hero-г илүү тод болго, FAQ хэсгийг хас.`,
    "      Хэдэн ч удаа явуулж болно. Засвар бүрд өмнөх бүх засварууд хэвээр үлдэнэ."
  );
  return lines.join("\n");
}

// Map a lead record into the brief shape that lib/prompt.js expects. Adds
// the new optional `extras`, `photoUrls`, and `changeHistory` keys.
function briefForProduction(lead) {
  const extras = lead.extras || null;
  const photoUrls = (extras?.photos || []).slice();
  const changeHistory = Array.isArray(lead.changeHistory) ? lead.changeHistory : [];
  return {
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
    quality:        "production",
    extras,
    photoUrls,
    changeHistory
  };
}

// Generate -> haiku review -> decorate -> deploy. Returns
// `{ html, previewUrl, projectName }` or throws on the first stage that
// fails. The caller logs and updates the lead's status accordingly.
//
// `iteration` lets us namespace each Vercel project (1 = initial finish, 2+
// = each CHANGE) so successive iterations land in distinct projects rather
// than overwriting each other.
async function runProductionBuild({ lead, iteration }) {
  const brief = briefForProduction(lead);

  console.log(`[telegram-webhook] #${lead.id} prod build iter=${iteration} photos=${brief.photoUrls.length} revisions=${brief.changeHistory.length}`);

  const generated = await generateHtml(brief);

  // Quality review pass. Haiku rewrites violations of the impeccable + emil
  // rules. On any failure (timeout, malformed output) we keep the original
  // HTML so the build still ships.
  let reviewed = generated;
  try {
    const review = await reviewAndFixHtml({ html: generated, brief });
    if (review?.html && /<html/i.test(review.html)) {
      reviewed = review.html;
      console.log(`[telegram-webhook] #${lead.id} review applied=${!!review.reviewed} length ${generated.length} -> ${reviewed.length}`);
    }
  } catch (err) {
    console.warn(`[telegram-webhook] #${lead.id} review threw, using original:`, err?.message || err);
  }

  // Production sites do NOT get the chooser bar (only the 3 demos do). The
  // chatbot widget stays so the business has a working AI assistant on the
  // final site.
  const decorated = decorateHtml(reviewed, {
    brief,
    leadId: lead.id,
    designNumber: 1,
    skipChooser: true
  });

  const projectLabel = iteration > 1
    ? `${lead.businessName} prod v${iteration}`
    : `${lead.businessName} prod`;

  const deployment = await deployToVercel({
    projectName: projectLabel,
    html: decorated
  });

  return {
    html: reviewed,
    previewUrl: deployment.url,
    projectName: deployment.projectName
  };
}

// Delete the 3 Vercel demo projects associated with this lead. Idempotent:
// missing projects (404) count as success. Returns
// `{ attempted, deleted, alreadyGone, failed: [{ slot, name, error }] }`.
async function deleteDemoProjects(lead) {
  const map = lead?.demoProjectNames || {};
  const slots = Object.keys(map).sort();
  const result = { attempted: 0, deleted: 0, alreadyGone: 0, failed: [] };
  for (const slot of slots) {
    const name = map[slot];
    if (!name) continue;
    result.attempted += 1;
    try {
      const out = await deleteVercelProject(name);
      if (out.ok && out.alreadyGone) {
        result.alreadyGone += 1;
        console.log(`[telegram-webhook] #${lead.id} demo project ${name} (slot ${slot}) already gone`);
      } else if (out.ok) {
        result.deleted += 1;
        console.log(`[telegram-webhook] #${lead.id} demo project ${name} (slot ${slot}) deleted (${out.status})`);
      } else {
        result.failed.push({ slot, name, error: out.error || `HTTP ${out.status}` });
        console.warn(`[telegram-webhook] #${lead.id} demo project ${name} (slot ${slot}) delete failed:`, out.error);
      }
    } catch (err) {
      result.failed.push({ slot, name, error: err?.message || String(err) });
      console.error(`[telegram-webhook] #${lead.id} demo project ${name} delete threw:`, err?.message || err);
    }
  }
  return result;
}

async function processFinish({ lead, message, parsed }) {
  const chatId = message?.chat?.id;
  const replyId = message?.message_id;
  const extras = parsed.extras || { raw: "", notes: "", photos: [] };

  console.log(`[telegram-webhook] #${lead.id} finish: starting production pipeline (photos=${extras.photos.length})`);

  await updateLead(lead.id, {
    status: STATUS.FINISHING,
    extras,
    finishingStartedAt: new Date().toISOString(),
    lastError: null
  });

  await sendTelegramReply({
    chatId,
    text:
      `⏳ #${lead.id} (${lead.businessName}) бүрэн хувилбарыг бэлдэж байна... 2-5 минут болно.\n\n` +
      `${summarizeExtras(extras)}`,
    replyToMessageId: replyId
  }).catch(err => console.error("[telegram-webhook] ack reply failed:", err?.message || err));

  // Re-read so runProductionBuild sees the freshly persisted extras.
  const refreshed = (await getLead(lead.id)) || lead;

  let result;
  try {
    result = await runProductionBuild({ lead: refreshed, iteration: 1 });
  } catch (err) {
    console.error(`[telegram-webhook] #${lead.id} pipeline failed:`, err?.message || err);
    await updateLead(lead.id, { status: STATUS.FAILED, lastError: err?.message || String(err) });
    await sendTelegramReply({
      chatId,
      text: `❌ #${lead.id} амжилтгүй боллоо: ${err?.message || err}`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  const now = new Date().toISOString();
  await updateLead(lead.id, {
    status: STATUS.AWAITING_REVIEW,
    productionUrl: result.previewUrl,
    productionUrls: [result.previewUrl],
    productionProjectName: result.projectName,
    productionIteration: 1,
    finalUrl: result.previewUrl,             // back-compat alias
    finalProjectName: result.projectName,    // back-compat alias
    finishedAt: now,
    lastError: null
  });

  await sendTelegramReply({
    chatId,
    text: buildPreviewReadyText({
      leadId: lead.id,
      businessName: lead.businessName,
      previewUrl: result.previewUrl,
      iteration: 1
    }),
    replyToMessageId: replyId
  }).catch(err => console.error(`[telegram-webhook] #${lead.id} preview reply failed:`, err?.message || err));

  console.log(`[telegram-webhook] #${lead.id} preview ready: ${result.previewUrl}`);
}

async function processChange({ lead, message, parsed }) {
  const chatId = message?.chat?.id;
  const replyId = message?.message_id;

  if (!parsed.feedback) {
    await sendTelegramReply({
      chatId,
      text:
        `ℹ️ #${lead.id} CHANGE командын ард засах зүйлээ бичнэ үү.\n` +
        `Жишээ: CHANGE #${lead.id} hero-г илүү тод болго, FAQ хэсгийг хас.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  if (lead.status === STATUS.APPROVED) {
    await sendTelegramReply({
      chatId,
      text: `⚠️ #${lead.id} аль хэдийн зөвшөөрөгдсөн. Засвар хийхийг хүсвэл шинэ захиалга үүсгэнэ үү.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }
  if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING) && !isStaleBuild(lead)) {
    await sendTelegramReply({
      chatId,
      text: `⏳ #${lead.id} одоогоор бүтэж байна. Дуустал хүлээнэ үү.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }
  if (!lead.productionUrl) {
    await sendTelegramReply({
      chatId,
      text: `⚠️ #${lead.id} эхлээд "#${lead.id} finish" гэж бичиж бүрэн хувилбарыг үүсгэнэ үү.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  const now = new Date().toISOString();
  const history = Array.isArray(lead.changeHistory) ? lead.changeHistory.slice() : [];
  history.push({
    at: now,
    request: parsed.feedback,
    previousUrl: lead.productionUrl
  });
  const iteration = (Number(lead.productionIteration) || 1) + 1;

  await updateLead(lead.id, {
    status: STATUS.CHANGING,
    changeHistory: history,
    lastError: null
  });

  await sendTelegramReply({
    chatId,
    text:
      `🔁 #${lead.id} засвар №${iteration} бэлдэж байна... 2-5 минут болно.\n\n` +
      `📝 Засвар: ${parsed.feedback.slice(0, 220)}${parsed.feedback.length > 220 ? "..." : ""}`,
    replyToMessageId: replyId
  }).catch(err => console.error("[telegram-webhook] change ack failed:", err?.message || err));

  const refreshed = (await getLead(lead.id)) || lead;

  let result;
  try {
    result = await runProductionBuild({ lead: refreshed, iteration });
  } catch (err) {
    console.error(`[telegram-webhook] #${lead.id} change build failed:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.AWAITING_REVIEW,
      lastError: `change:${iteration}: ${err?.message || String(err)}`
    });
    await sendTelegramReply({
      chatId,
      text: `❌ #${lead.id} засвар амжилтгүй боллоо: ${err?.message || err}\nӨмнөх хувилбар хэвээрээ үлдсэн: ${lead.productionUrl}`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  // Annotate the just-pushed change-history entry with the resulting URL so
  // future sweeps and audits can trace which preview each request produced.
  const completedHistory = history.slice();
  completedHistory[completedHistory.length - 1] = {
    ...completedHistory[completedHistory.length - 1],
    previewUrl: result.previewUrl,
    projectName: result.projectName,
    completedAt: new Date().toISOString()
  };
  const previewUrls = Array.isArray(lead.productionUrls) ? lead.productionUrls.slice() : [];
  previewUrls.push(result.previewUrl);

  await updateLead(lead.id, {
    status: STATUS.AWAITING_REVIEW,
    productionUrl: result.previewUrl,
    productionUrls: previewUrls,
    productionProjectName: result.projectName,
    productionIteration: iteration,
    finalUrl: result.previewUrl,
    finalProjectName: result.projectName,
    changeHistory: completedHistory,
    lastError: null
  });

  await sendTelegramReply({
    chatId,
    text: buildPreviewReadyText({
      leadId: lead.id,
      businessName: lead.businessName,
      previewUrl: result.previewUrl,
      iteration
    }),
    replyToMessageId: replyId
  }).catch(err => console.error(`[telegram-webhook] #${lead.id} change preview reply failed:`, err?.message || err));

  console.log(`[telegram-webhook] #${lead.id} change ready iter=${iteration}: ${result.previewUrl}`);
}

async function processApprove({ lead, message }) {
  const chatId = message?.chat?.id;
  const replyId = message?.message_id;

  if (!lead.productionUrl) {
    await sendTelegramReply({
      chatId,
      text: `⚠️ #${lead.id} эхлээд "#${lead.id} finish" гэж бичиж бүрэн хувилбарыг үүсгэнэ үү.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING) && !isStaleBuild(lead)) {
    await sendTelegramReply({
      chatId,
      text: `⏳ #${lead.id} одоогоор бүтэж байна. Дуустал хүлээнэ үү, дараа нь APPROVE хийнэ үү.`,
      replyToMessageId: replyId
    }).catch(() => {});
    return;
  }

  // Idempotency: re-approval just confirms.
  const alreadyApproved = lead.status === STATUS.APPROVED;
  if (!alreadyApproved) {
    await updateLead(lead.id, {
      status: STATUS.APPROVED,
      approvedAt: new Date().toISOString(),
      lastError: null
    });
  }

  // Delete the 3 demo Vercel projects. We do this inline so the Telegram
  // confirmation can report the actual outcome. Failure modes are surfaced
  // but never block approval.
  const refreshed = (await getLead(lead.id)) || lead;
  let cleanup = { attempted: 0, deleted: 0, alreadyGone: 0, failed: [] };
  if (!refreshed.demoDeleted) {
    cleanup = await deleteDemoProjects(refreshed);
    const fullySucceeded = cleanup.failed.length === 0 && cleanup.attempted > 0;
    await updateLead(lead.id, {
      demoDeleted: fullySucceeded,
      demoCleanupAt: new Date().toISOString(),
      demoCleanupSummary: cleanup
    });
  }

  const lines = [
    `✅ #${lead.id} (${lead.businessName}) зөвшөөрөгдлөө. Домэйн холболт эхлэх бэлэн.`,
    `🌐 Сайт: ${lead.productionUrl}`,
    "",
    "Клиентийн домэйн: [та оруулна уу]"
  ];
  if (cleanup.attempted > 0) {
    const ok = cleanup.deleted + cleanup.alreadyGone;
    lines.push("");
    if (cleanup.failed.length === 0) {
      lines.push(`🗑️ Демо төслүүд устгагдлаа (${ok}/${cleanup.attempted}).`);
    } else {
      lines.push(`🗑️ Демо устгалт: ${ok}/${cleanup.attempted} амжилттай. ${cleanup.failed.length} ширхэг гар аргаар устгана уу.`);
      for (const f of cleanup.failed.slice(0, 3)) {
        lines.push(`   • ${f.name}: ${String(f.error).slice(0, 100)}`);
      }
    }
  } else if (refreshed.demoDeleted) {
    lines.push("", "🗑️ Демо төслүүд өмнө нь устгагдсан байсан.");
  }
  if (alreadyApproved) {
    lines.unshift(`ℹ️ #${lead.id} өмнө нь зөвшөөрөгдсөн.`);
  }

  await sendTelegramReply({
    chatId,
    text: lines.join("\n"),
    replyToMessageId: replyId
  }).catch(err => console.error(`[telegram-webhook] #${lead.id} approve reply failed:`, err?.message || err));

  console.log(`[telegram-webhook] #${lead.id} approved (cleanup attempted=${cleanup.attempted} deleted=${cleanup.deleted} failed=${cleanup.failed.length})`);
}

// Help text shown when the bot receives a message it can't classify, so
// Bilguun always knows the bot is alive and how to talk to it.
const HELP_TEXT = [
  "🤖 Мессеж хүлээн авлаа, гэхдээ команд таниагүй.",
  "",
  "Боломжит командууд:",
  "   #001 finish [нэмэлт мэдээлэл]   — бүрэн хувилбар үүсгэх",
  "   CHANGE #001 [юу засах вэ]       — засвар оруулах",
  "   APPROVE #001                    — сайтыг батлах"
].join("\n");

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

  const message = update?.message || update?.edited_message || update?.channel_post;
  if (!message) {
    console.log("[telegram-webhook] update has no message, ignoring");
    return;
  }

  const chatId = message.chat?.id;
  const fromId = message.from?.id;
  const replyId = message.message_id;
  const text = message.text || "";
  console.log(`[telegram-webhook] inbound text="${text.replace(/\s+/g, " ").slice(0, 200)}" chatId=${chatId} fromId=${fromId}`);

  // Best-effort reply helper that never throws. Used on every return path so
  // Bilguun always sees that the bot received and classified his message —
  // the previous handler had three silent-drop paths (unauthorized sender,
  // unrecognized command, outer catch) that made the bot look dead.
  const replySafe = (textBody) => {
    if (!chatId) return Promise.resolve();
    return sendTelegramReply({ chatId, text: textBody, replyToMessageId: replyId })
      .catch(err => console.error("[telegram-webhook] reply failed:", err?.message || err));
  };

  try {
    const env = envState();
    if (!isAuthorizedSender(env, chatId, fromId)) {
      // TELEGRAM_CHAT_ID doubles as the auth whitelist, so any DM whose
      // chat.id/from.id doesn't match the configured notification chat
      // (typically a group) was previously dropped without trace. Surfacing
      // the mismatch in-chat means future "the bot is dead" reports are
      // self-diagnosing.
      console.warn(`[telegram-webhook] unauthorized sender chatId=${chatId} fromId=${fromId} expected=${env.chatIdPreview}`);
      await replySafe(
        `🤖 Бот ажиллаж байна, гэхдээ энэ chat/user-г зөвшөөрөөгүй.\n` +
        `chatId=${chatId} fromId=${fromId}\n` +
        `Засах: Vercel дээр TELEGRAM_CHAT_ID env-д энэ ID-уудаас аль нэгийг тавина уу.`
      );
      return;
    }

    if (!text.trim()) {
      console.log("[telegram-webhook] message has no text");
      await replySafe("🤖 Текст агуулаагүй мессеж хүлээн авлаа.\n\n" + HELP_TEXT);
      return;
    }

    // Parse in priority order: APPROVE first (shortest, most specific),
    // then CHANGE (anchored on the change keyword), then FINISH (which
    // greedily slurps free-form text after the keyword).
    const approve = parseApproveCommand(text);
    const change  = !approve ? parseChangeCommand(text) : null;
    const finish  = (!approve && !change) ? parseFinishCommand(text) : null;

    const cmd = approve || change || finish;
    if (!cmd) {
      console.log("[telegram-webhook] no recognised command in message");
      await replySafe(HELP_TEXT);
      return;
    }

    const lead = await getLead(cmd.id);
    if (!lead) {
      await replySafe(`⚠️ #${cmd.id} олдсонгүй. Захиалгын дугаараа шалгана уу.`);
      return;
    }

    if (approve) {
      await processApprove({ lead, message });
      return;
    }
    if (change) {
      await processChange({ lead, message, parsed: change });
      return;
    }

    // Finish flow.
    if (lead.status === STATUS.APPROVED) {
      await replySafe(`ℹ️ #${lead.id} аль хэдийн зөвшөөрөгдсөн: ${lead.productionUrl || lead.finalUrl || "—"}`);
      return;
    }
    if (lead.status === STATUS.AWAITING_REVIEW && !finish.extras?.notes && !finish.extras?.photos?.length) {
      // Bilguun re-sent a bare `#NNN finish` after the preview was already
      // delivered. Surface the existing URL + APPROVE/CHANGE menu instead
      // of regenerating with no new information.
      await replySafe(buildPreviewReadyText({
        leadId: lead.id,
        businessName: lead.businessName,
        previewUrl: lead.productionUrl,
        iteration: Number(lead.productionIteration) || 1
      }));
      return;
    }
    if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING) && !isStaleBuild(lead)) {
      await replySafe(`⏳ #${lead.id} одоо бүтэж байна, түр хүлээнэ үү.`);
      return;
    }

    await processFinish({ lead, message, parsed: finish });
  } catch (err) {
    console.error("[telegram-webhook] handler error:", err?.message || err, err?.stack || "");
    await replySafe(`❌ Дотоод алдаа: ${err?.message || err}`);
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "1mb" }
  }
};
