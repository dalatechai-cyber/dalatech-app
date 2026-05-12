"use strict";

// Telegram webhook for Bilguun's production conversation flow.
//
// Bilguun talks to the bot in three commands per lead:
//   `#NNN finish ...details...`   First production build. Body is free-form
//                                 notes (real copy, prices, addresses, photo
//                                 URLs). The webhook saves extras, sets the
//                                 lead to `ready_to_finish`, and sends an
//                                 immediate ack. The local PM2 watcher
//                                 (routines/watch.js) polls Upstash every
//                                 60 s, picks the lead up, runs the full
//                                 6-step build (plan → generate → review →
//                                 fix loop → deploy → notify) with no time
//                                 limit, then posts the preview URL.
//   `CHANGE #NNN ...feedback...`  Regenerate. Feedback is appended to
//                                 changeHistory and the lead is set back to
//                                 `ready_to_finish` so the watcher rebuilds
//                                 with the new feedback.
//   `APPROVE #NNN`                Final sign-off. Runs inline because it is
//                                 fast (just deletes the three Vercel demo
//                                 projects for the lead).
//
// Status machine (lib/leads.js):
//   ... -> ready_to_finish -> finishing -> awaiting_review
//          ^------- ready_to_finish <- changing <---------/
//                                                        -> approved
//
// The Vercel webhook has a sub-second response budget; production builds
// take 5-15 minutes (plan + multi-iteration generate/review + deploy) and
// must NOT run inside this lambda. The local watcher owns that work; the
// webhook only updates state and acknowledges.

const {
  deleteVercelProject,
  addDomainToVercelProject
} = require("../lib/deploy");
const {
  parseFinishCommand,
  parseApproveCommand,
  parseChangeCommand,
  parseDomainCommand,
  sendTelegramReply,
  buildPreviewReadyText,
  buildDomainPurchasedMessage,
  buildDomainTakenMessage,
  buildDomainPathBMessage,
  envState
} = require("../lib/telegram");
const {
  checkDomainAvailability,
  suggestAlternatives,
  purchaseDomain,
  setCustomNameservers
} = require("../lib/namecheap");
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

// A FINISHING / CHANGING / READY_TO_FINISH lead is "stale" if its
// updatedAt is more than STALE_BUILD_MS ago. The local watcher
// (routines/watch.js) has no time budget, so the threshold is generous:
// a healthy plan + 3 iterations + deploy on a busy machine can run 15-25
// minutes. Anything pinned in these states for 60 minutes is almost
// certainly a crashed watcher or an orphan from before the queue was
// drained, so subsequent commands are allowed to proceed.
const STALE_BUILD_MS = 60 * 60 * 1000;
function isStaleBuild(lead) {
  const s = lead?.status;
  if (s !== STATUS.FINISHING && s !== STATUS.CHANGING && s !== STATUS.READY_TO_FINISH) {
    return false;
  }
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

// buildPreviewReadyText is imported from lib/telegram.js so the cron prod
// stage (lib/process-lead.js) can render the same message. The build
// pipeline itself (runProductionBuild + briefForProduction) was moved to
// lib/process-lead.js — the webhook no longer runs generation inline.

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

  console.log(`[telegram-webhook] #${lead.id} finish: queueing for local watcher (photos=${extras.photos.length})`);

  // Save extras + reply context + status so the local PM2 watcher
  // (routines/watch.js) has everything it needs when it next polls.
  // lastUserMessageId is what the watcher will thread its preview-ready
  // reply to.
  await updateLead(lead.id, {
    status: STATUS.READY_TO_FINISH,
    extras,
    productionIteration: 1,
    finishingStartedAt: new Date().toISOString(),
    lastUserMessageId: replyId || null,
    lastError: null
  });

  // Single ack reply; the watcher takes over from here. Phrased to match
  // the spec exactly so Bilguun sees the same copy every time.
  await sendTelegramReply({
    chatId,
    text:
      `✅ Мэдээлэл хадгаллаа. Систем автоматаар барьж эхэлнэ. ` +
      `Бэлэн болмогц preview URL Telegram-д ирнэ.\n\n` +
      `${summarizeExtras(extras)}`,
    replyToMessageId: replyId
  }).catch(err => console.error("[telegram-webhook] ack reply failed:", err?.message || err));
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
  if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING || lead.status === STATUS.READY_TO_FINISH) && !isStaleBuild(lead)) {
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

  // Queue for the local PM2 watcher. The watcher reads productionIteration
  // to know whether this is an initial build (1) or a CHANGE round (>1).
  await updateLead(lead.id, {
    status: STATUS.READY_TO_FINISH,
    changeHistory: history,
    productionIteration: iteration,
    lastUserMessageId: replyId || null,
    lastError: null
  });

  await sendTelegramReply({
    chatId,
    text:
      `✅ Мэдээлэл хадгаллаа. Систем автоматаар барьж эхэлнэ. ` +
      `Бэлэн болмогц preview URL Telegram-д ирнэ.\n\n` +
      `📝 Засвар №${iteration}: ${parsed.feedback.slice(0, 220)}${parsed.feedback.length > 220 ? "..." : ""}`,
    replyToMessageId: replyId
  }).catch(err => console.error("[telegram-webhook] change ack failed:", err?.message || err));
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

  if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING || lead.status === STATUS.READY_TO_FINISH) && !isStaleBuild(lead)) {
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

// Path A (purchase) / Path B (existing) flow for `DOMAIN #NNN <new|existing>
// <domain>`. Both paths leave the lead in DOMAIN_PENDING so the hourly cron
// can sweep for DNS propagation.
//
// Idempotency: if the lead already has the same domain queued, we skip the
// destructive side-effects (no duplicate purchase, no duplicate attach
// attempt) and re-send the appropriate status message.
async function processDomain({ lead, message, parsed }) {
  const chatId = message?.chat?.id;
  const replyId = message?.message_id;
  const replySafe = (text) =>
    sendTelegramReply({ chatId, text, replyToMessageId: replyId }).catch(err =>
      console.error(`[telegram-webhook] #${lead.id} domain reply failed:`, err?.message || err)
    );

  // Need a deployed production project to attach the domain to.
  if (!lead.productionProjectName) {
    await replySafe(`⚠️ #${lead.id} эхлээд "#${lead.id} finish" гэж бичиж бүрэн хувилбарыг үүсгэнэ үү.`);
    return;
  }

  // Idempotent re-entry. Same domain, already in flight → re-send status.
  if (
    lead.domainConnect &&
    lead.domainConnect.domain === parsed.domain &&
    (lead.status === STATUS.DOMAIN_PENDING || lead.status === STATUS.DOMAIN_LIVE)
  ) {
    if (lead.status === STATUS.DOMAIN_LIVE) {
      await replySafe(`ℹ️ ${parsed.domain} аль хэдийн идэвхтэй: https://${parsed.domain}`);
    } else {
      await replySafe(`ℹ️ ${parsed.domain} аль хэдийн дараалалд орсон. DNS идэвхжихийг хүлээж байна (24-48 цаг).`);
    }
    return;
  }

  console.log(`[telegram-webhook] #${lead.id} domain ${parsed.path} ${parsed.domain} (project=${lead.productionProjectName})`);

  if (parsed.path === "new") {
    await processDomainNew({ lead, parsed, replySafe });
  } else {
    await processDomainExisting({ lead, parsed, replySafe });
  }
}

// PATH A: Check Namecheap availability → purchase → set Vercel nameservers
// → add to Vercel project → notify Bilguun. Any failure short-circuits with
// a Telegram error and leaves the lead's status untouched so the command
// can be retried cleanly.
async function processDomainNew({ lead, parsed, replySafe }) {
  const { id: leadId } = lead;
  const { domain } = parsed;

  // 1. availability check.
  let availability;
  try {
    availability = await checkDomainAvailability(domain);
  } catch (err) {
    await replySafe(`❌ Namecheap холбогдсонгүй: ${err?.message || err}`);
    return;
  }
  if (!availability.ok) {
    await replySafe(`❌ ${domain} шалгалт амжилтгүй: ${availability.error}`);
    return;
  }
  if (!availability.available) {
    // 1a. taken — suggest alternatives.
    let alts = [];
    try {
      const suggestion = await suggestAlternatives(domain);
      if (suggestion.ok) alts = suggestion.available;
    } catch (err) {
      console.warn(`[telegram-webhook] #${leadId} suggestAlternatives threw:`, err?.message || err);
    }
    await replySafe(buildDomainTakenMessage({ leadId, domain, alternatives: alts }));
    return;
  }

  // Premium domains carry a much higher price tag than the default checkout
  // amount; the user spec assumes standard pricing, so we refuse premium
  // purchases automatically and tell Bilguun to register them manually.
  if (availability.premium) {
    const price = availability.premiumPrice ? ` ($${availability.premiumPrice.toFixed(2)}/жил premium)` : "";
    await replySafe(`⚠️ ${domain}${price} — premium домэйн байна. Auto-purchase хийгдэхгүй. Namecheap дашбоардаас гар аргаар авна уу.`);
    return;
  }

  // 2. purchase.
  let purchase;
  try {
    purchase = await purchaseDomain(domain);
  } catch (err) {
    await replySafe(`❌ ${domain} худалдан авах амжилтгүй боллоо: ${err?.message || err}`);
    return;
  }
  if (!purchase.ok) {
    await replySafe(`❌ ${domain} худалдан авах амжилтгүй: ${purchase.error}`);
    return;
  }

  const now = new Date().toISOString();

  // 3. set Vercel nameservers. Continue even on failure: the purchase
  // succeeded, and Bilguun can flip nameservers manually if this step
  // fails. Single warning either way.
  let nsResult;
  try {
    nsResult = await setCustomNameservers(domain);
  } catch (err) {
    nsResult = { ok: false, error: err?.message || String(err) };
  }
  if (!nsResult.ok) {
    await replySafe(`⚠️ ${domain} nameserver тохиргоо амжилтгүй: ${nsResult.error}\nNamecheap дашбоардаас ns1/ns2.vercel-dns.com тавина уу.`);
  }

  // 4. attach to Vercel project.
  let attached;
  try {
    attached = await addDomainToVercelProject(lead.productionProjectName, domain);
  } catch (err) {
    await replySafe(`⚠️ ${domain} Vercel project-д нэмэх амжилтгүй: ${err?.message || err}`);
    attached = { ok: false, error: err?.message || String(err) };
  }
  if (!attached.ok) {
    await replySafe(`⚠️ ${domain} Vercel project-д нэмэх амжилтгүй: ${attached.error}`);
    // Still queue for monitoring — the domain exists at Namecheap. Bilguun
    // can attach manually and the cron will pick up the live state.
  }

  await updateLead(leadId, {
    status: STATUS.DOMAIN_PENDING,
    domainConnect: {
      domain,
      path: "new",
      projectName: lead.productionProjectName,
      purchased: true,
      purchaseTransactionId: purchase.transactionId,
      purchaseOrderId: purchase.orderId,
      purchaseChargedAmount: purchase.chargedAmount,
      nameserversSetAt: nsResult?.ok ? now : null,
      attachedAt: attached?.ok ? now : null,
      queuedAt: now,
      liveAt: null,
      lastCheckedAt: null,
      lastWarningAt: null
    },
    lastError: null
  });

  await replySafe(buildDomainPurchasedMessage({ domain }));
}

// PATH B: Attach existing domain to Vercel project, fetch DNS config, send
// instructions Bilguun forwards to the client.
async function processDomainExisting({ lead, parsed, replySafe }) {
  const { id: leadId, businessName } = lead;
  const { domain } = parsed;

  let attached;
  try {
    attached = await addDomainToVercelProject(lead.productionProjectName, domain);
  } catch (err) {
    await replySafe(`❌ ${domain} Vercel project-д нэмэх амжилтгүй: ${err?.message || err}`);
    return;
  }
  if (!attached.ok) {
    await replySafe(`❌ ${domain} Vercel project-д нэмэх амжилтгүй: ${attached.error}`);
    return;
  }

  const now = new Date().toISOString();

  await updateLead(leadId, {
    status: STATUS.DOMAIN_PENDING,
    domainConnect: {
      domain,
      path: "existing",
      projectName: lead.productionProjectName,
      purchased: false,
      attachedAt: now,
      instructionsSentAt: now,
      queuedAt: now,
      liveAt: null,
      lastCheckedAt: null,
      lastWarningAt: null
    },
    lastError: null
  });

  await replySafe(buildDomainPathBMessage({ leadId, businessName, domain }));
}

// Help text shown when the bot receives a message it can't classify, so
// Bilguun always knows the bot is alive and how to talk to it.
const HELP_TEXT = [
  "🤖 Мессеж хүлээн авлаа, гэхдээ команд таниагүй.",
  "",
  "Боломжит командууд:",
  "   #001 finish [нэмэлт мэдээлэл]   — бүрэн хувилбар үүсгэх",
  "   CHANGE #001 [юу засах вэ]       — засвар оруулах",
  "   APPROVE #001                    — сайтыг батлах",
  "   DOMAIN #001 new gsauto.mn       — шинэ домэйн авах",
  "   DOMAIN #001 existing gsauto.mn  — клиентийн домэйн холбох"
].join("\n");

async function handler(req, res) {
  // Token visibility check at every entrypoint. If Vercel's runtime ever
  // strips TELEGRAM_BOT_TOKEN for this function (wrong env scope, missing on
  // a new deployment, etc.) the bot goes silent — and the only way to know
  // from logs is to look at the per-invocation preview here.
  const bootEnv = envState();
  console.log(`[telegram-webhook] BOOT method=${req.method} url=${req.url || "?"} token=${bootEnv.tokenPreview} chatIdConfigured=${bootEnv.chatIdPreview}`);

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "dalatech-telegram-webhook" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let update;
  try { update = await readJsonBody(req); }
  catch (err) {
    console.error("[telegram-webhook] readJsonBody failed:", err?.message || err);
    return res.status(200).json({ ok: true });
  }

  console.log(`[telegram-webhook] update_id=${update?.update_id ?? "?"} keys=[${Object.keys(update || {}).join(",")}]`);

  // Tested empirically against Vercel's Node runtime: once res.end / res.json
  // has been called, the Lambda is dropped into a suspended state where
  // outbound fetches and setTimeout callbacks don't fire until something
  // wakes the runtime (167 s observed for a single GET to Upstash in that
  // mode, even with a 6 s Promise.race timeout). The cron lambdas don't
  // hit this because they never respond early. So we mirror them: do
  // every Upstash/Telegram round-trip BEFORE the response, and only emit
  // res.json from a finally block at the very end.
  const message = update?.message || update?.edited_message || update?.channel_post;
  if (!message) {
    console.log("[telegram-webhook] update has no message/edited_message/channel_post, ignoring");
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat?.id;
  const fromId = message.from?.id;
  const replyId = message.message_id;
  const text = message.text || "";
  console.log(`[telegram-webhook] inbound chatId=${chatId} fromId=${fromId} messageId=${replyId} text="${text.replace(/\s+/g, " ").slice(0, 200)}"`);

  // Best-effort reply helper that never throws. Used on every return path so
  // Bilguun always sees that the bot received and classified his message —
  // the previous handler had three silent-drop paths (unauthorized sender,
  // unrecognized command, outer catch) that made the bot look dead.
  // Logs entry + outcome so a "no reply" failure tells us whether replySafe
  // was reached and whether the underlying fetch succeeded or threw.
  const replySafe = async (textBody) => {
    const preview = String(textBody || "").replace(/\s+/g, " ").slice(0, 120);
    if (!chatId) {
      console.warn(`[telegram-webhook] replySafe skipped (no chatId) preview="${preview}"`);
      return;
    }
    console.log(`[telegram-webhook] replySafe -> chatId=${chatId} replyTo=${replyId} preview="${preview}"`);
    try {
      const out = await sendTelegramReply({ chatId, text: textBody, replyToMessageId: replyId });
      console.log(`[telegram-webhook] replySafe ok messageId=${out?.result?.message_id ?? "?"}`);
    } catch (err) {
      console.error(`[telegram-webhook] replySafe failed: ${err?.message || err}`, err?.responseBody || "");
    }
  };

  try {
    const env = envState();
    console.log(`[telegram-webhook] env hasToken=${env.hasToken} hasChatId=${env.hasChatId} expectedChat=${env.chatIdPreview}`);
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

    console.log(`[telegram-webhook] authorized OK chatId=${chatId} fromId=${fromId}`);

    if (!text.trim()) {
      console.log("[telegram-webhook] message has empty text, replying with help");
      await replySafe("🤖 Текст агуулаагүй мессеж хүлээн авлаа.\n\n" + HELP_TEXT);
      return;
    }

    // Parse in priority order: APPROVE first (shortest, most specific),
    // then CHANGE, then DOMAIN, then FINISH (which greedily slurps
    // free-form text after the keyword).
    const approve = parseApproveCommand(text);
    const change  = !approve ? parseChangeCommand(text) : null;
    const domain  = (!approve && !change) ? parseDomainCommand(text) : null;
    const finish  = (!approve && !change && !domain) ? parseFinishCommand(text) : null;
    console.log(`[telegram-webhook] parse approve=${approve ? approve.id : "no"} change=${change ? `${change.id}:${(change.feedback || "").slice(0, 40)}` : "no"} domain=${domain ? `${domain.id}:${domain.path}:${domain.domain}` : "no"} finish=${finish ? `${finish.id} notes=${finish.extras.notes.length}ch photos=${finish.extras.photos.length}` : "no"}`);

    const cmd = approve || change || domain || finish;
    if (!cmd) {
      console.log("[telegram-webhook] no recognised command in message, replying with help");
      await replySafe(HELP_TEXT);
      return;
    }

    console.log(`[telegram-webhook] looking up lead #${cmd.id}`);
    const lead = await getLead(cmd.id);
    if (!lead) {
      console.warn(`[telegram-webhook] lead #${cmd.id} not found`);
      await replySafe(`⚠️ #${cmd.id} олдсонгүй. Захиалгын дугаараа шалгана уу.`);
      return;
    }
    console.log(`[telegram-webhook] lead #${lead.id} status=${lead.status} productionUrl=${lead.productionUrl || "none"} iter=${lead.productionIteration || 0}`);

    if (approve) {
      console.log(`[telegram-webhook] dispatching processApprove for #${lead.id}`);
      await processApprove({ lead, message });
      console.log(`[telegram-webhook] processApprove returned for #${lead.id}`);
      return;
    }
    if (change) {
      console.log(`[telegram-webhook] dispatching processChange for #${lead.id}`);
      await processChange({ lead, message, parsed: change });
      console.log(`[telegram-webhook] processChange returned for #${lead.id}`);
      return;
    }
    if (domain) {
      console.log(`[telegram-webhook] dispatching processDomain for #${lead.id} ${domain.path} ${domain.domain}`);
      await processDomain({ lead, message, parsed: domain });
      console.log(`[telegram-webhook] processDomain returned for #${lead.id}`);
      return;
    }

    // Finish flow.
    if (lead.status === STATUS.APPROVED) {
      console.log(`[telegram-webhook] finish on APPROVED lead #${lead.id}, sending already-approved reply`);
      await replySafe(`ℹ️ #${lead.id} аль хэдийн зөвшөөрөгдсөн: ${lead.productionUrl || lead.finalUrl || "—"}`);
      return;
    }
    if (lead.status === STATUS.AWAITING_REVIEW && !finish.extras?.notes && !finish.extras?.photos?.length) {
      // Bilguun re-sent a bare `#NNN finish` after the preview was already
      // delivered. Surface the existing URL + APPROVE/CHANGE menu instead
      // of regenerating with no new information.
      console.log(`[telegram-webhook] bare finish on AWAITING_REVIEW lead #${lead.id}, resending preview menu`);
      await replySafe(buildPreviewReadyText({
        leadId: lead.id,
        businessName: lead.businessName,
        previewUrl: lead.productionUrl,
        iteration: Number(lead.productionIteration) || 1
      }));
      return;
    }
    if ((lead.status === STATUS.FINISHING || lead.status === STATUS.CHANGING || lead.status === STATUS.READY_TO_FINISH) && !isStaleBuild(lead)) {
      console.log(`[telegram-webhook] finish while #${lead.id} is ${lead.status} (not stale), telling user to wait`);
      await replySafe(`⏳ #${lead.id} одоо бүтэж байна, түр хүлээнэ үү.`);
      return;
    }

    console.log(`[telegram-webhook] dispatching processFinish for #${lead.id}`);
    await processFinish({ lead, message, parsed: finish });
    console.log(`[telegram-webhook] processFinish returned for #${lead.id}`);
  } catch (err) {
    console.error("[telegram-webhook] handler error:", err?.message || err, err?.stack || "");
    await replySafe(`❌ Дотоод алдаа: ${err?.message || err}`);
  } finally {
    console.log("[telegram-webhook] handler invocation complete");
    // Single source of truth for the webhook ack — fired after all the
    // async work so the Lambda stays in normal (non-suspended) mode for
    // every Upstash and Telegram round-trip above.
    if (!res.headersSent) {
      res.status(200).json({ ok: true });
    }
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "1mb" }
  }
};
