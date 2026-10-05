(() => {
  const auth = window.NyangkutAuth;
  const page = document.body.dataset.page;
  const form = document.querySelector("[data-auth-form]");
  const notice = document.querySelector("[data-notice]");
  const submit = document.querySelector("[data-submit]");

  const validators = {
    name(value) {
      if (!value.trim()) return "Nama perlu diisi dulu.";
      if (value.trim().length < 2) return "Nama minimal 2 karakter.";
      return "";
    },
    email(value) {
      if (!value.trim()) return "Email perlu diisi dulu.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())) return "Format emailnya belum benar.";
      return "";
    },
    password(value) {
      if (!value) return "Password perlu diisi dulu.";
      if (value.length < 8) return "Gunakan minimal 8 karakter.";
      return "";
    },
    confirmPassword(value) {
      if (!value) return "Ulangi password kamu dulu.";
      if (value !== document.querySelector('[name="password"]').value) return "Password belum sama.";
      return "";
    },
  };

  function showNotice(message, type = "error") {
    if (!notice) return;
    notice.textContent = message;
    notice.dataset.type = type;
    notice.hidden = !message;
  }

  function validateField(input) {
    const validator = validators[input.name];
    if (!validator) return true;
    const message = validator(input.value);
    const error = document.querySelector(`[data-error-for="${input.name}"]`);
    input.setAttribute("aria-invalid", String(Boolean(message)));
    if (error) error.textContent = message;
    return !message;
  }

  function setBusy(busy) {
    if (!submit) return;
    submit.disabled = busy;
    submit.setAttribute("aria-busy", String(busy));
    const label = submit.querySelector("[data-button-label]");
    const spinner = submit.querySelector("[data-spinner]");
    if (label) label.textContent = busy ? (page === "register" ? "Menyiapkan akun…" : "Memeriksa…") : submit.dataset.idleLabel;
    if (spinner) spinner.hidden = !busy;
  }

  function friendlyError(error) {
    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.error_code || error?.code || "").toLowerCase();
    if (message.includes("rate limit") || message.includes("429") || message.includes("security purposes")
        || code.includes("over_email_send_rate_limit") || code.includes("over_request_rate_limit")) {
      return "Lagi rame di server email. Tunggu beberapa menit, lalu coba lagi ya.";
    }
    if (message.includes("already") || message.includes("registered") || message.includes("exists")) {
      return "Email ini sudah terdaftar. Coba masuk saja, ya.";
    }
    if (message.includes("not confirmed") || message.includes("not verified")) {
      return "Email kamu belum diverifikasi. Cek inbox kamu dulu, ya.";
    }
    if (message.includes("should be different")) {
      return "Password baru harus beda dari password lama.";
    }
    if (message.includes("invalid") || message.includes("credential") || message.includes("password")) {
      return "Email atau password belum cocok. Coba periksa lagi.";
    }
    return "Ada kendala sebentar. Coba lagi, ya.";
  }

  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.getAttribute("aria-controls"));
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-label", reveal ? "Sembunyikan password" : "Tampilkan password");
      button.setAttribute("aria-pressed", String(reveal));
    });
  });

  if (form) {
    form.querySelectorAll("input").forEach((input) => {
      input.addEventListener("blur", () => validateField(input));
      input.addEventListener("input", () => {
        if (input.getAttribute("aria-invalid") === "true") validateField(input);
        if (input.name === "password" && page === "register") {
          const confirm = form.querySelector('[name="confirmPassword"]');
          if (confirm.value) validateField(confirm);
        }
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showNotice("");
      const inputs = [...form.querySelectorAll("input")];
      const valid = inputs.map(validateField).every(Boolean);
      if (!valid) {
        form.querySelector('[aria-invalid="true"]')?.focus();
        return;
      }

      setBusy(true);
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        if (page === "register") {
          const result = await auth.signUp({ name: data.name.trim(), email: data.email.trim(), password: data.password });
          if (result?.requiresEmailConfirmation) {
            showNotice("Akun berhasil dibuat. Cek email kamu untuk konfirmasi, lalu masuk ya.", "success");
            setBusy(false);
            return;
          }
        } else {
          await auth.signIn({ email: data.email.trim(), password: data.password });
        }
        window.location.assign("/dashboard/");
      } catch (error) {
        showNotice(friendlyError(error));
        setBusy(false);
      }
    });
  }

  if (page === "login" || page === "register") {
    auth.getSession()
      .then((session) => {
        if (session && session.user) window.location.replace("/dashboard/");
      })
      .catch(() => {});
  }

  if (page === "dashboard") {
    const name = document.querySelector("[data-user-name]");
    auth.getSession()
      .then((session) => {
        if (!session?.user) {
          window.location.replace("/login/");
          return;
        }
        name.textContent = session.user.name || session.user.email || "Teman";
      })
      .catch(() => window.location.replace("/login/"));

    document.querySelectorAll("[data-sign-out]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await auth.signOut();
      } finally {
        window.location.assign("/login/");
      }
    }));
  }

  if (page === "forgot-password") {
    const fpForm = document.querySelector("[data-fp-form]");
    const setFpState = (name) => {
      document.querySelectorAll("[data-fp-state]").forEach((el) => {
        el.hidden = el.dataset.fpState !== name;
      });
    };
    if (fpForm) {
      const emailInput = fpForm.querySelector('[name="email"]');
      ["input", "blur"].forEach((evt) => emailInput.addEventListener(evt, () => validateField(emailInput, fpForm)));
      let busy = false;
      fpForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) return;
        showNotice("");
        if (!validateField(emailInput, fpForm)) {
          emailInput.focus();
          return;
        }
        busy = true;
        setBusy(true);
        try {
          const email = emailInput.value.trim();
          await auth.resetPasswordForEmail(email, window.location.origin + "/reset-password");
          setFpState("sent");
        } catch (error) {
          showNotice(friendlyError(error));
          busy = false;
          setBusy(false);
        }
      });
    }
  }

  if (page === "reset-password") {
    const pageTitle = document.getElementById("page-title");
    const rpTitles = {
      loading: "Buat password baru",
      form: "Buat password baru",
      success: "Password berhasil diubah",
      invalid: "Buat password baru",
    };
    const setRpState = (name) => {
      document.querySelectorAll("[data-rp-state]").forEach((el) => {
        el.hidden = el.dataset.rpState !== name;
      });
      const title = rpTitles[name] || rpTitles.form;
      if (pageTitle) pageTitle.textContent = title;
      document.title = title + " — Nyangkut";
    };
    const cleanUrl = () => {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        // abaikan: membersihkan token di URL itu opsional
      }
    };
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) cleanUrl();
      setRpState(ok ? "form" : "invalid");
    };
    const confirmSession = () => {
      auth.getSession()
        .then((session) => {
          if (session && session.user) settle(true);
        })
        .catch(() => {});
    };
    auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") confirmSession();
    });
    auth.getSession()
      .then((session) => {
        if (session && session.user) {
          settle(true);
        } else {
          window.setTimeout(() => settle(false), 2500);
        }
      })
      .catch(() => settle(false));

    const rpForm = document.querySelector("[data-rp-form]");
    if (rpForm) {
      const inputs = [...rpForm.querySelectorAll("input")];
      inputs.forEach((input) => {
        ["input", "blur"].forEach((evt) => input.addEventListener(evt, () => {
          validateField(input, rpForm);
          if (input.name === "password") {
            const confirm = rpForm.querySelector('[name="confirmPassword"]');
            if (confirm.value) validateField(confirm, rpForm);
          }
        }));
      });
      let busy = false;
      rpForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) return;
        showNotice("");
        const valid = inputs.map((input) => validateField(input, rpForm)).every(Boolean);
        if (!valid) {
          rpForm.querySelector('[aria-invalid="true"]')?.focus();
          return;
        }
        busy = true;
        setBusy(true);
        try {
          const password = rpForm.querySelector('[name="password"]').value;
          await auth.updateUser({ password });
          try {
            await auth.signOut();
          } catch {
            // abaikan: yang penting password sudah terganti
          }
          inputs.forEach((input) => { input.value = ""; });
          setRpState("success");
        } catch (error) {
          showNotice(friendlyError(error));
          busy = false;
          setBusy(false);
        }
      });
    }
  }
})();
