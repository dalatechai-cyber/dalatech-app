"use strict";

const { Resend } = require("resend");

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

function clientEmailHtml({ businessName, fullName, previewUrl }) {
  const safeBiz = escapeHtml(businessName);
  const safeName = escapeHtml(fullName);
  const safeUrl = escapeHtml(previewUrl);
  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DalaTech</title>
</head>
<body style="margin:0;padding:0;background:#050A18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#F0F4FF;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050A18;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0D1430;border:1px solid rgba(139,159,196,0.18);border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <div style="display:inline-flex;align-items:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#F0F4FF;">
                <span style="width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#2563EB,#38BDF8);display:inline-block;"></span>
                <span>DalaTech</span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <p style="margin:0 0 12px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#38BDF8;">Демо бэлэн боллоо</p>
              <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;letter-spacing:-0.015em;color:#F0F4FF;font-weight:700;">
                Таны ${safeBiz} вэбсайтын демо бэлэн боллоо
              </h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#8B9FC4;">
                Сайн байна уу ${safeName}. Танай бизнест зориулсан вэбсайтын демог AI-аар бүтээлээ. Доорх товчоо дарж шууд үзэж болно.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              <a href="${safeUrl}" style="display:inline-block;padding:14px 26px;background:#2563EB;color:#FFFFFF;border-radius:999px;font-weight:500;font-size:16px;text-decoration:none;">
                Вэбсайтаа үзэх →
              </a>
              <p style="margin:14px 0 0;font-size:13px;color:#8B9FC4;word-break:break-all;">
                ${safeUrl}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;">
              <hr style="border:0;border-top:1px solid rgba(139,159,196,0.18);margin:0 0 20px;">
              <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#F0F4FF;font-weight:500;">
                Энэ юу гэсэн үг вэ?
              </p>
              <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#8B9FC4;">
                Энэ нь танай бизнесийн анхны хувилбар, демо хувилбар. Жинхэнэ төсөлд бид өөрийн контент, зураг, хөдөлгөөн, домэйн холбоо, имэйл маркетинг, удирдах самбарыг бэлдэж өгнө.
              </p>
              <p style="margin:0;font-size:14px;line-height:1.65;color:#8B9FC4;">
                Жинхэнэ төсөл эхлүүлэхийг хүсвэл энэ имэйлд хариулна уу. Бид 24 цагийн дотор холбогдоно.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 28px 32px;background:#050A18;border-top:1px solid rgba(139,159,196,0.18);">
              <p style="margin:0;font-size:12px;color:#8B9FC4;text-align:center;">
                © DalaTech · dalatech.online
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function leadEmailHtml(brief, previewUrl) {
  const rows = [
    ["Бизнес",          brief.businessName],
    ["Чиглэл",          brief.industry],
    ["Тайлбар",         brief.description],
    ["Үйлчилгээ",       brief.services],
    ["Үндсэн өнгө",     brief.primaryColor],
    ["Хоёрдогч өнгө",   brief.secondaryColor],
    ["Хэв маяг",        brief.style],
    ["Reference",       brief.references || "—"],
    ["Sections",        Array.isArray(brief.sections) ? brief.sections.join(", ") : ""],
    ["Лого",            brief.logo ? `${brief.logo.name} (${brief.logo.type})` : "—"],
    ["Нэр",             brief.fullName],
    ["Имэйл",           brief.email],
    ["Утас",            brief.phone],
    ["Preview URL",     previewUrl]
  ];
  const tableRows = rows.map(([k, v]) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:13px;font-weight:600;width:32%;vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:13px;white-space:pre-wrap;">${escapeHtml(v)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr><td style="padding:20px 24px;background:#0D1430;color:#F0F4FF;">
      <strong style="font-size:14px;letter-spacing:0.04em;">DalaTech · New lead</strong>
    </td></tr>
    <tr><td style="padding:24px;">
      <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">${escapeHtml(brief.businessName || "Untitled")}</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#4b5563;">A new website demo has been generated and emailed to the client.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${tableRows}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendClientEmail({ to, businessName, fullName, previewUrl }) {
  const resend = getResend();
  return resend.emails.send({
    from: fromAddress(),
    to,
    subject: "Таны вэбсайтын демо бэлэн боллоо! 🎉",
    html: clientEmailHtml({ businessName, fullName, previewUrl })
  });
}

async function sendLeadNotification({ brief, previewUrl }) {
  const resend = getResend();
  const to = process.env.LEAD_NOTIFY_EMAIL || "dalatech.ai@gmail.com";
  return resend.emails.send({
    from: fromAddress(),
    to,
    subject: `New DalaTech lead: ${brief.businessName || "(no name)"}`,
    html: leadEmailHtml(brief, previewUrl)
  });
}

module.exports = { sendClientEmail, sendLeadNotification };
