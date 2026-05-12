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

  // Vercel teams default new projects to Standard Deployment Protection,
  // which intercepts visitors with an "Authentication Required" page on the
  // public domain — the visitor never reaches our HTML, so the chooser bar
  // and the rest of the site look "missing" (lead #001 demos, 2026-05-12,
  // where the auth wall was 14,621 bytes of Vercel HTML). Demo + production
  // deployments are intentionally public, so disable both SSO and password
  // protection on the freshly-created project. Best-effort: if the team
  // plan forbids per-project overrides we log and continue rather than
  // failing the deploy.
  try {
    const dp = await disableProjectProtection(finalName);
    if (dp.ok) {
      console.log(`[deploy] protection disabled project=${finalName} status=${dp.status}`);
    } else {
      console.warn(`[deploy] protection disable failed project=${finalName} status=${dp.status || 0} error=${(dp.error || "").slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[deploy] protection disable threw project=${finalName}:`, err?.message || err);
  }

  return {
    url: url.startsWith("http") ? url : `https://${url}`,
    deploymentId: payload.id || null,
    projectName: finalName
  };
}

// Disable Vercel Deployment Protection (SSO + password) on a project so
// the public domain serves the deployed HTML directly instead of Vercel's
// auth wall. Idempotent: clearing already-null fields is a no-op for the
// API. Returns { ok, status, error? }.
async function disableProjectProtection(projectName) {
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
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ssoProtection: null,
        passwordProtection: null
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }

  if (res.ok) return { ok: true, status: res.status };
  let bodyText = "";
  try { bodyText = await res.text(); } catch {}
  return {
    ok: false,
    status: res.status,
    error: bodyText.slice(0, 240) || `HTTP ${res.status}`
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

// Attach a custom domain (`domain`) to an existing Vercel project. The
// project must already be deployed (we use the production project name
// recorded on the lead — lead.productionProjectName). Returns
//   { ok: true, alreadyAttached: bool, data }   on success
//   { ok: false, status, error }                on failure
async function addDomainToVercelProject(projectName, domain) {
  if (!projectName) return { ok: false, status: 0, error: "projectName required" };
  if (!domain)      return { ok: false, status: 0, error: "domain required" };
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: false, status: 0, error: "VERCEL_TOKEN not set" };

  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  const base = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectName)}/domains`;
  const endpoint = teamId ? `${base}?teamId=${encodeURIComponent(teamId)}` : base;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: domain }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }

  let payload = null;
  try { payload = await res.json(); } catch {}

  if (res.ok) {
    return { ok: true, status: res.status, alreadyAttached: false, data: payload };
  }

  // Vercel returns `domain_already_in_use` (409) when the domain is already
  // attached — on this same project or another. If it is on this project we
  // treat it as success so the command is idempotent; otherwise we surface
  // the conflict so Bilguun can resolve it.
  const code = payload?.error?.code || "";
  if (code === "domain_already_in_use" || res.status === 409) {
    const probe = await getProjectDomain(projectName, domain).catch(() => null);
    if (probe?.ok) {
      return { ok: true, status: res.status, alreadyAttached: true, data: probe.data };
    }
    return {
      ok: false,
      status: res.status,
      error: payload?.error?.message || `domain ${domain} already in use on another project`
    };
  }

  return {
    ok: false,
    status: res.status,
    error: payload?.error?.message || `Vercel HTTP ${res.status}`
  };
}

// Check whether a domain is attached to a specific Vercel project. Used by
// addDomainToVercelProject to distinguish "already attached here" from
// "attached elsewhere".
async function getProjectDomain(projectName, domain) {
  if (!projectName) return { ok: false, status: 0, error: "projectName required" };
  if (!domain)      return { ok: false, status: 0, error: "domain required" };
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: false, status: 0, error: "VERCEL_TOKEN not set" };

  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  const base = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(domain)}`;
  const endpoint = teamId ? `${base}?teamId=${encodeURIComponent(teamId)}` : base;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (res.ok) return { ok: true, status: res.status, data: payload };
  return {
    ok: false,
    status: res.status,
    error: payload?.error?.message || `HTTP ${res.status}`
  };
}

// Fetch the DNS configuration Vercel expects for a domain. `misconfigured`
// is true while DNS isn't pointing at Vercel; once it flips false the
// domain is live. Used by Path B to render the visitor instructions and by
// the hourly cron to detect propagation.
async function getVercelDomainConfig(domain) {
  if (!domain) return { ok: false, status: 0, error: "domain required" };
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: false, status: 0, error: "VERCEL_TOKEN not set" };

  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  const base = `https://api.vercel.com/v6/domains/${encodeURIComponent(domain)}/config`;
  const endpoint = teamId ? `${base}?teamId=${encodeURIComponent(teamId)}` : base;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: payload?.error?.message || `HTTP ${res.status}`
    };
  }
  return {
    ok: true,
    status: res.status,
    misconfigured: payload?.misconfigured === true,
    nameservers: Array.isArray(payload?.nameservers) ? payload.nameservers : [],
    data: payload
  };
}

module.exports = {
  deployToVercel,
  deleteVercelProject,
  disableProjectProtection,
  addDomainToVercelProject,
  getProjectDomain,
  getVercelDomainConfig,
  slugify
};
