(() => {
  "use strict";

  const form = document.getElementById("brief");
  const submit = document.getElementById("submit");
  const loading = document.getElementById("loading");
  const loadingStep = document.getElementById("loadingStep");
  const success = document.getElementById("success");
  const successLink = document.getElementById("successLink");
  const successTitle = document.getElementById("successTitle");
  const restart = document.getElementById("restart");
  const errorBanner = document.getElementById("errorBanner");
  const errorBannerText = document.getElementById("errorBannerText");
  const errorBannerClose = document.getElementById("errorBannerClose");
  const logoInput = document.getElementById("logo");
  const logoHint = document.getElementById("logoHint");

  const primaryColor = document.getElementById("primaryColor");
  const secondaryColor = document.getElementById("secondaryColor");
  const primaryColorValue = document.getElementById("primaryColorValue");
  const secondaryColorValue = document.getElementById("secondaryColorValue");

  const MAX_LOGO_BYTES = 5 * 1024 * 1024;

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

  const STEPS = [
    { at: 0,     text: "Таны мэдээллийг уншиж байна..." },
    { at: 4000,  text: "Вэбсайт бүтээж байна..." },
    { at: 30000, text: "Байршуулж байна..." },
    { at: 55000, text: "Имэйл илгээж байна..." }
  ];

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
      phone:          (fd.get("phone") || "").toString().trim()
    };
  }

  function readLogoAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name,
        type: file.type,
        dataUrl: String(reader.result)
      });
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  let stepTimers = [];
  function startProgress() {
    stepTimers.forEach(t => clearTimeout(t));
    stepTimers = [];
    setStep(STEPS[0].text);
    for (let i = 1; i < STEPS.length; i++) {
      stepTimers.push(setTimeout(() => setStep(STEPS[i].text), STEPS[i].at));
    }
  }
  function stopProgress() {
    stepTimers.forEach(t => clearTimeout(t));
    stepTimers = [];
  }
  function setStep(text) {
    loadingStep.classList.add("swap");
    setTimeout(() => {
      loadingStep.textContent = text;
      loadingStep.classList.remove("swap");
    }, 200);
  }

  function showError(message) {
    errorBannerText.textContent = message;
    errorBanner.hidden = false;
  }
  function hideError() {
    errorBanner.hidden = true;
  }

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

  errorBannerClose.addEventListener("click", hideError);

  restart.addEventListener("click", () => {
    success.hidden = true;
    form.reset();
    primaryColorValue.textContent = primaryColor.value.toUpperCase();
    secondaryColorValue.textContent = secondaryColor.value.toUpperCase();
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
    const file = logoInput.files?.[0];
    if (file) {
      if (file.size > MAX_LOGO_BYTES) {
        showError("Лого хэт том байна.");
        return;
      }
      try { logo = await readLogoAsDataUrl(file); }
      catch { showError("Логог уншиж чадсангүй."); return; }
    }

    submit.disabled = true;
    loading.hidden = false;
    startProgress();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, logo })
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok || !payload?.ok) {
        const msg = payload?.error || `Алдаа гарлаа (${res.status}). Дахин оролдоно уу.`;
        throw new Error(msg);
      }

      stopProgress();
      successTitle.textContent = `Таны ${data.businessName} вэбсайт бэлтгэгдлээ`;
      successLink.href = payload.previewUrl;
      loading.hidden = true;
      success.hidden = false;
    } catch (err) {
      stopProgress();
      loading.hidden = true;
      showError(err.message || "Сүлжээний алдаа. Дахин оролдоно уу.");
    } finally {
      submit.disabled = false;
    }
  });
})();
