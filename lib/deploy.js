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

// Delete a Vercel project (and all its deployments) by project name.
// Returns { ok, status, alreadyGone } so the caller can log per-project
// outcomes without inspecting HTTP status codes itself. A 404 is treated as
// success (alreadyGone=true) because the desired end state — "the project
// does not exist" — is already true.
async function deleteVercelProject(projectName) {
  if (!projectName || typeof projectName !== "string") {
    return { ok: false, status: 0, error: "projectName required" };
  }
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: false, status: 0, error: "VERCEL_TOKEN not set" };

  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  const base = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`;
  const endpoint = teamId
    ? `${base}?teamId=${encodeURIComponent(teamId)}`
    : base;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }

  if (res.status === 204 || res.status === 200) {
    return { ok: true, status: res.status, alreadyGone: false };
  }
  if (res.status === 404) {
    return { ok: true, status: 404, alreadyGone: true };
  }
  let bodyText = "";
  try { bodyText = await res.text(); } catch {}
  return {
    ok: false,
    status: res.status,
    error: bodyText.slice(0, 240) || `HTTP ${res.status}`
  };
}

module.exports = { deployToVercel, deleteVercelProject, slugify };
