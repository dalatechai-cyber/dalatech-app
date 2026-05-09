"use strict";

function slugify(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!base) return `dalatech-demo-${Date.now().toString(36)}`;
  return base;
}

async function deployToVercel({ projectName, html }) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set");

  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  const baseSlug = slugify(projectName);
  const uniqueSuffix = Date.now().toString(36).slice(-5);
  const finalName = `${baseSlug}-${uniqueSuffix}`;

  const endpoint = teamId
    ? `https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(teamId)}`
    : "https://api.vercel.com/v13/deployments";

  const body = {
    name: finalName,
    target: "production",
    projectSettings: { framework: null },
    files: [
      { file: "index.html", data: html, encoding: "utf-8" }
    ]
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload?.error?.message || `Vercel deploy failed (${res.status})`;
    throw new Error(message);
  }

  const url = payload?.url || payload?.alias?.[0];
  if (!url) throw new Error("Vercel response did not include a URL");

  return {
    url: url.startsWith("http") ? url : `https://${url}`,
    deploymentId: payload.id || null,
    projectName: finalName
  };
}

module.exports = { deployToVercel, slugify };
