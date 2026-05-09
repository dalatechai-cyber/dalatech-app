(() => {
  "use strict";

  const form = document.getElementById("brief");
  const submit = document.getElementById("submit");
  const loading = document.getElementById("loading");
  const success = document.getElementById("success");
  const restart = document.getElementById("restart");
  const successClose = document.getElementById("successClose");
  const errorBanner = document.getElementById("errorBanner");
  const errorBannerText = document.getElementById("errorBannerText");
  const errorBannerClose = document.getElementById("errorBannerClose");
  const logoInput = document.getElementById("logo");
  const logoHint = document.getElementById("logoHint");
  const attachmentsInput = document.getElementById("attachments");
  const attachmentList = document.getElementById("attachmentList");
  const footerYear = document.getElementById("footerYear");

  const primaryColor = document.getElementById("primaryColor");
  const secondaryColor = document.getElementById("secondaryColor");
  const primaryColorValue = document.getElementById("primaryColorValue");
  const secondaryColorValue = document.getElementById("secondaryColorValue");

  const MAX_LOGO_BYTES = 5 * 1024 * 1024;
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  const REQUIRED_FIELDS = [
    { name: "businessName", label: "Бизнесийн нэр" },
    { name: "industry",     label: "Чиглэл" },
    { name: "description",  label: "Тайлбар" },
    { name: "services",     label: "Үйлчилгээ" },
    { name: "style",        label: "Хэв маяг" },
    { name: "fullName",     label: "Нэр" },
    { name: "email",        label: "Имэйл" },
    { name: "phone",        label: "Утас" }
  ];

  if (footerYear) footerYear.textContent = String(new Date().getFullYear());

  function setError(name, msg) {
    const el = form.querySelector(`[data-error-for="${name}"]`);
    const field = form.querySelector(`[name="${name}"]`)?.closest(".field");
    if (el) el.textContent = msg || "";
    if (field) field.classList.toggle("invalid", Boolean(msg));
  }

  function clearAllErrors() {
    form.querySelectorAll(".error").forEach(el => (el.textContent = ""));
    form.querySelectorAll(".field.invalid").forEach(el => el.classList.remove("invalid"));
  }

  function validate(data) {
    let firstInvalid = null;
    for (const { name, label } of REQUIRED_FIELDS) {
      if (!data[name] || String(data[name]).trim() === "") {
        setError(name, `${label} шаардлагатай`);
        firstInvalid = firstInvalid || name;
      } else {
        setError(name, "");
      }
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      setError("email", "Имэйл хаяг буруу байна");
      firstInvalid = firstInvalid || "email";
    }
    if (data.phone && data.phone.replace(/\D/g, "").length < 6) {
      setError("phone", "Утасны дугаар богино байна");
      firstInvalid = firstInvalid || "phone";
    }
    if (!Array.isArray(data.sections) || data.sections.length === 0) {
      setError("sections", "Дор хаяж нэг хэсэг сонгоно уу");
      firstInvalid = firstInvalid || "sections";
    }
    return firstInvalid;
  }

  function readForm() {
    const fd = new FormData(form);
    const sections = fd.getAll("sections").map(String);
    return {
      businessName:   (fd.get("businessName") || "").toString().trim(),
      industry:       (fd.get("industry") || "").toString(),
      description:    (fd.get("description") || "").toString().trim(),
      services:       (fd.get("services") || "").toString().trim(),
      primaryColor:   (fd.get("primaryColor") || "#2563EB").toString(),
      secondaryColor: (fd.get("secondaryColor") || "#38BDF8").toString(),
      style:          (fd.get("style") || "").toString(),
      references:     (fd.get("references") || "").toString().trim(),
      sections,
      fullName:       (fd.get("fullName") || "").toString().trim(),
      email:          (fd.get("email") || "").toString().trim(),
      phone:          (fd.get("phone") || "").toString().trim(),
      notes:          (fd.get("notes") || "").toString().trim()
    };
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: String(reader.result)
      });
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function showError(message) {
    errorBannerText.textContent = message;
    errorBanner.hidden = false;
  }
  function hideError() {
    errorBanner.hidden = true;
  }
  errorBannerClose.addEventListener("click", hideError);

  function syncColor(input, output) {
    output.textContent = input.value.toUpperCase();
    input.addEventListener("input", () => {
      output.textContent = input.value.toUpperCase();
    });
  }
  syncColor(primaryColor, primaryColorValue);
  syncColor(secondaryColor, secondaryColorValue);

  form.querySelectorAll("input, select, textarea").forEach(el => {
    el.addEventListener("blur", () => {
      if (el.name && REQUIRED_FIELDS.find(f => f.name === el.name)) {
        const data = readForm();
        const labels = Object.fromEntries(REQUIRED_FIELDS.map(f => [f.name, f.label]));
        if (!data[el.name] || String(data[el.name]).trim() === "") {
          setError(el.name, `${labels[el.name]} шаардлагатай`);
        } else {
          setError(el.name, "");
        }
      }
    });
  });

  form.querySelectorAll('input[name="sections"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const any = Array.from(form.querySelectorAll('input[name="sections"]'))
        .some(b => b.checked);
      if (any) setError("sections", "");
    });
  });

  logoInput.addEventListener("change", () => {
    const file = logoInput.files?.[0];
    if (!file) {
      logoHint.textContent = "5 MB-аас бага зураг.";
      logoHint.style.color = "";
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      logoInput.value = "";
      logoHint.textContent = "Файл хэт том байна (5 MB-аас бага байх ёстой).";
      logoHint.style.color = "var(--danger)";
    } else {
      logoHint.textContent = `Сонгосон: ${file.name}`;
      logoHint.style.color = "";
    }
  });

  document.querySelectorAll(".file-drop").forEach(drop => {
    ["dragenter", "dragover"].forEach(evt => {
      drop.addEventListener(evt, e => {
        e.preventDefault();
        drop.classList.add("is-dragging");
      });
    });
    ["dragleave", "drop"].forEach(evt => {
      drop.addEventListener(evt, e => {
        if (evt === "dragleave" && drop.contains(e.relatedTarget)) return;
        drop.classList.remove("is-dragging");
      });
    });
  });

  let attachmentFiles = [];

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileIconSvg(file) {
    const isImage = file.type?.startsWith("image/");
    if (isImage) {
      return '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="6" cy="7" r="1.2"/><path d="m2.5 12 3.5-3.5 4 4 1.5-1.5 2 2"/></svg>';
    }
    return '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z"/><path d="M9 2v4h4"/></svg>';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderAttachments() {
    attachmentList.innerHTML = "";
    attachmentFiles.forEach((file, idx) => {
      const li = document.createElement("li");
      li.className = "file-chip";
      li.innerHTML = `
        <span class="file-chip-icon" aria-hidden="true">${fileIconSvg(file)}</span>
        <span class="file-chip-name">${escapeHtml(file.name)}</span>
        <span class="file-chip-size">${formatBytes(file.size)}</span>
        <button type="button" class="file-chip-remove" aria-label="Файл хасах" data-idx="${idx}">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      `;
      attachmentList.appendChild(li);
    });
  }

  attachmentsInput.addEventListener("change", () => {
    const incoming = Array.from(attachmentsInput.files || []);
    for (const file of incoming) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showError(`"${file.name}" хэт том байна (10 MB-аас бага байх ёстой).`);
        continue;
      }
      const isDup = attachmentFiles.some(
        f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
      );
      if (!isDup) attachmentFiles.push(file);
    }
    attachmentsInput.value = "";
    renderAttachments();
  });

  attachmentList.addEventListener("click", (event) => {
    const btn = event.target.closest(".file-chip-remove");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (!Number.isNaN(idx)) {
      attachmentFiles.splice(idx, 1);
      renderAttachments();
    }
  });

  function closeSuccess() {
    success.hidden = true;
  }

  successClose.addEventListener("click", closeSuccess);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !success.hidden) closeSuccess();
  });

  restart.addEventListener("click", () => {
    success.hidden = true;
    form.reset();
    attachmentFiles = [];
    renderAttachments();
    primaryColorValue.textContent = primaryColor.value.toUpperCase();
    secondaryColorValue.textContent = secondaryColor.value.toUpperCase();
    logoHint.textContent = "5 MB-аас бага зураг.";
    logoHint.style.color = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError();
    clearAllErrors();

    const data = readForm();
    const firstInvalid = validate(data);
    if (firstInvalid) {
      const el = form.querySelector(`[name="${firstInvalid}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      }
      return;
    }

    let logo = null;
    const logoFile = logoInput.files?.[0];
    if (logoFile) {
      if (logoFile.size > MAX_LOGO_BYTES) {
        showError("Лого хэт том байна.");
        return;
      }
      try { logo = await readFileAsDataUrl(logoFile); }
      catch { showError("Логог уншиж чадсангүй."); return; }
    }

    const totalAttachmentBytes = attachmentFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      showError("Нийт хавсралт 25 MB-аас бага байх ёстой.");
      return;
    }

    let attachments = [];
    if (attachmentFiles.length > 0) {
      try {
        attachments = await Promise.all(attachmentFiles.map(readFileAsDataUrl));
      } catch {
        showError("Хавсралт уншиж чадсангүй.");
        return;
      }
    }

    submit.disabled = true;
    loading.hidden = false;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, logo, attachments })
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok || !payload?.ok) {
        const msg = payload?.error || `Алдаа гарлаа (${res.status}). Дахин оролдоно уу.`;
        throw new Error(msg);
      }

      loading.hidden = true;
      success.hidden = false;
      try { successClose.focus(); } catch {}
    } catch (err) {
      loading.hidden = true;
      showError(err.message || "Сүлжээний алдаа. Дахин оролдоно уу.");
    } finally {
      submit.disabled = false;
    }
  });
})();
