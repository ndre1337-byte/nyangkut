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
      if (!value) return "Ulangi password lo dulu.";
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
    if (message.includes("rate limit") || message.includes("429")) {
      return "Lagi rame di server email. Tunggu beberapa menit, lalu coba lagi ya.";
    }
    if (message.includes("already") || message.includes("registered") || message.includes("exists")) {
      return "Email ini sudah terdaftar. Coba masuk saja, ya.";
    }
    if (message.includes("not confirmed") || message.includes("not verified")) {
      return "Email lo belum diverifikasi. Cek inbox lo dulu, ya.";
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
            showNotice("Akun berhasil dibuat. Cek email lo untuk konfirmasi, lalu masuk ya.", "success");
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
})();
