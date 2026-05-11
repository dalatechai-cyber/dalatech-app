"use strict";

const { Resend } = require("resend");

const LOGO_URL = "https://dalatech.online/Photos/dalatech_logo_v3.jpg";
const BG = "#050A18";
const SURFACE = "#0D1430";
const BORDER = "rgba(139,159,196,0.18)";
const TEXT = "#F0F4FF";
const MUTED = "#8B9FC4";
const ACCENT = "#38BDF8";
const PRIMARY = "#2563EB";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

function fromAddress() {
  return process.env.FROM_EMAIL || "DalaTech <hello@dalatech.online>";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shellHtml({ title, previewText, body }) {
  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(previewText)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:20px;overflow:hidden;">
          <tr>
            <td style="padding:18px 24px 16px 24px;background:${BG};border-bottom:1px solid ${BORDER};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <img src="${LOGO_URL}" alt="DalaTech" width="28" height="28" style="display:block;width:28px;height:28px;border-radius:7px;border:0;outline:none;object-fit:cover;">
                  </td>
                  <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:-0.01em;color:${TEXT};">
                    DalaTech
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${body}
          <tr>
            <td style="padding:20px 32px 28px 32px;background:${BG};border-top:1px solid ${BORDER};">
              <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${MUTED};text-align:center;">© DalaTech · dalatech.online</p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};text-align:center;">Улаанбаатар хот · dalatech.ai@gmail.com</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function clientEmailHtml({ businessName, fullName, previewUrl, mode }) {
  const safeBiz = escapeHtml(businessName);
  const safeName = escapeHtml(fullName);
  const safeUrl = escapeHtml(previewUrl);
  const isFinal = mode === "final";

  const eyebrow = isFinal ? "Бүрэн хувилбар бэлэн боллоо" : "Демо бэлэн боллоо";
  const heroLine = isFinal
    ? `Танай ${safeBiz} вэбсайт амьдарлаа.`
    : `Танай ${safeBiz} вэбсайтын демо бэлэн боллоо.`;
  const bodyCopy = isFinal
    ? `Сайн байна уу, ${safeName}. Бид танай вэбсайтын бүрэн хувилбарыг бэлдэж байршууллаа. Доорх товчоо дарж шууд үзнэ үү. Холбоо барих, шинэчлэх, домэйн холбох талаар бид удахгүй танд мэдэгдэнэ.`
    : `Сайн байна уу, ${safeName}. Танай бизнест зориулсан вэбсайтын демог бид бүтээж дууслаа. Доорх товчоо дарж шууд үзнэ үү. Энэ бол анхны хувилбар, бид хамтран сайжруулах боломжтой.`;
  const buttonText = isFinal ? "Вэбсайтаа нээх" : "Демогоо үзэх";
  const note = isFinal
    ? `Бид удахгүй танд домэйн холболт, шуудангийн хаяг, удирдах самбарын зааварчилгаа илгээнэ.`
    : `Жинхэнэ төсөл эхлүүлэхийг хүсвэл энэ имэйлд хариулна уу, бид 24 цагийн дотор холбогдоно. Жинхэнэ хувилбар нь танай контент, зураг, домэйн, имэйл маркетинг, удирдах самбарыг бүхэлд нь бэлдэж өгнө.`;

  const body = `
          <tr>
            <td style="padding:36px 32px 8px 32px;">
              <p style="margin:0 0 14px;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:${ACCENT};font-weight:600;">
                ${eyebrow}
              </p>
              <h1 style="margin:0 0 14px;font-size:30px;line-height:1.15;letter-spacing:-0.02em;color:${TEXT};font-weight:800;">
                ${safeBiz}
              </h1>
              <p style="margin:0 0 22px;font-size:16px;line-height:1.5;letter-spacing:-0.005em;color:${TEXT};font-weight:500;">
                ${heroLine}
              </p>
              <p style="margin:0 0 26px;font-size:15px;line-height:1.65;color:${MUTED};">
                ${bodyCopy}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:999px;background:${PRIMARY};">
                    <a href="${safeUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 30px;border-radius:999px;background:${PRIMARY};color:#FFFFFF;font-weight:600;font-size:15px;text-decoration:none;letter-spacing:-0.005em;">
                      ${buttonText} →
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">
                ${safeUrl}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px 32px;">
              <hr style="border:0;border-top:1px solid ${BORDER};margin:0 0 20px;">
              <p style="margin:0;font-size:14px;line-height:1.7;color:${MUTED};">
                ${note}
              </p>
            </td>
          </tr>`;

  return shellHtml({
    title: `${safeBiz} · DalaTech`,
    previewText: heroLine,
    body
  });
}

function leadEmailHtml(brief, previewUrl, leadId) {
  const safeId = leadId ? `#${escapeHtml(String(leadId))}` : "";
  const rows = [
    ["Бизнес",          brief.businessName],
    ["Чиглэл",          brief.industry],
    ["Тайлбар",         brief.description],
    ["Үйлчилгээ",       brief.services],
    ["Үндсэн өнгө",     brief.primaryColor],
    ["Хоёрдогч өнгө",   brief.secondaryColor],
    ["Хэв маяг",        brief.style],
    ["Лавлагаа",        brief.references || "—"],
    ["Хэсгүүд",         Array.isArray(brief.sections) ? brief.sections.join(", ") : ""],
    ["Лого",            brief.logo ? `${brief.logo.name || "logo"} (${brief.logo.type || "?"})` : "—"],
    ["Захиалагч",       brief.fullName],
    ["Имэйл",           brief.email],
    ["Утас",            brief.phone]
  ];

  const tableRows = rows.map(([k, v]) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid ${BORDER};color:${MUTED};font-size:13px;font-weight:500;width:34%;vertical-align:top;letter-spacing:0.01em;">${escapeHtml(k)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid ${BORDER};color:${TEXT};font-size:13px;white-space:pre-wrap;line-height:1.55;">${escapeHtml(v)}</td>
        </tr>`).join("");

  const safeUrl = escapeHtml(previewUrl || "");

  const body = `
          <tr>
            <td style="padding:32px 32px 6px 32px;">
              ${safeId ? `<p style="margin:0 0 8px;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Захиалга ${safeId}</p>` : ""}
              <h1 style="margin:0 0 8px;font-size:26px;line-height:1.2;letter-spacing:-0.015em;color:${TEXT};font-weight:800;">
                ${escapeHtml(brief.businessName || "Нэргүй захиалга")}
              </h1>
              <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:${MUTED};">
                Шинэ демо хүсэлт ирлээ. Доор бүх дэлгэрэнгүй мэдээлэл, демо холбоос болон Telegram-аас финиш хийх заавар бий.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 22px 32px;">
              <a href="${safeUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${PRIMARY};color:#FFFFFF;font-weight:600;font-size:14px;text-decoration:none;">
                Демо нээх →
              </a>
              <p style="margin:10px 0 0;font-size:12px;color:${MUTED};word-break:break-all;">${safeUrl}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${BG};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
                ${tableRows}
              </table>
            </td>
          </tr>
          ${leadId ? `
          <tr>
            <td style="padding:0 32px 28px 32px;">
              <p style="margin:0 0 6px;font-size:13px;color:${MUTED};">Telegram дээр финиш хийх:</p>
              <p style="margin:0;font-size:15px;color:${TEXT};font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-weight:600;">#${escapeHtml(String(leadId))} finish</p>
            </td>
          </tr>` : ""}`;

  return shellHtml({
    title: `${brief.businessName || "Lead"} · DalaTech lead`,
    previewText: `Шинэ захиалга ${safeId} ${brief.businessName || ""}`.trim(),
    body
  });
}

async function sendClientEmail({ to, businessName, fullName, previewUrl, mode }) {
  const resend = getResend();
  const isFinal = mode === "final";
  const subject = isFinal
    ? `Танай ${businessName} вэбсайт амьдарлаа 🎉`
    : `Танай ${businessName} вэбсайтын демо бэлэн боллоо 🎉`;
  console.log(`[email] sending client email to=${to} mode=${mode || "demo"}`);
  return resend.emails.send({
    from: fromAddress(),
    to,
    subject,
    html: clientEmailHtml({ businessName, fullName, previewUrl, mode })
  });
}

async function sendLeadNotification({ brief, previewUrl, leadId }) {
  const resend = getResend();
  const to = process.env.LEAD_NOTIFY_EMAIL || "dalatech.ai@gmail.com";
  const idPart = leadId ? `#${leadId} · ` : "";
  console.log(`[email] sending lead notification to=${to} leadId=${leadId || "none"}`);
  return resend.emails.send({
    from: fromAddress(),
    to,
    subject: `${idPart}New DalaTech lead: ${brief.businessName || "(no name)"}`,
    html: leadEmailHtml(brief, previewUrl, leadId)
  });
}

module.exports = { sendClientEmail, sendLeadNotification };
