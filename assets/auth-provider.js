(() => {
  const PREVIEW_SESSION_KEY = "nyangkut.preview.session";
  const pause = (duration = 650) => new Promise((resolve) => window.setTimeout(resolve, duration));

  // Demo only: keeps an identity for this browser tab, never credentials.
  const previewProvider = {
    async signIn({ email }) {
      await pause();
      const name = email.split("@")[0].replace(/[._-]+/g, " ").trim();
      const user = { id: `preview-${Date.now()}`, email, name: name || "Teman" };
      sessionStorage.setItem(PREVIEW_SESSION_KEY, JSON.stringify(user));
      return { user };
    },
    async signUp({ name, email }) {
      await pause();
      const user = { id: `preview-${Date.now()}`, email, name };
      sessionStorage.setItem(PREVIEW_SESSION_KEY, JSON.stringify(user));
      return { user };
    },
    async getSession() {
      try {
        const user = JSON.parse(sessionStorage.getItem(PREVIEW_SESSION_KEY) || "null");
        return user ? { user } : null;
      } catch {
        return null;
      }
    },
    async signOut() {
      sessionStorage.removeItem(PREVIEW_SESSION_KEY);
    },
  };

  let provider = previewProvider;

  function configure(nextProvider) {
    const requiredMethods = ["signIn", "signUp", "getSession", "signOut"];
    const missing = requiredMethods.filter((method) => typeof nextProvider?.[method] !== "function");
    if (missing.length) {
      throw new Error(`Auth provider belum lengkap: ${missing.join(", ")}`);
    }
    provider = nextProvider;
  }

  window.NyangkutAuth = {
    mode: "preview",
    configure,
    signIn: (credentials) => provider.signIn(credentials),
    signUp: (details) => provider.signUp(details),
    getSession: () => provider.getSession(),
    signOut: () => provider.signOut(),
    resetPasswordForEmail: (email, redirectTo) => {
      if (typeof provider.resetPasswordForEmail !== "function") {
        return Promise.reject(new Error("Reset password belum didukung."));
      }
      return provider.resetPasswordForEmail(email, redirectTo);
    },
    updateUser: (attributes) => {
      if (typeof provider.updateUser !== "function") {
        return Promise.reject(new Error("Ubah password belum didukung."));
      }
      return provider.updateUser(attributes);
    },
    onAuthStateChange: (callback) => {
      if (typeof provider.onAuthStateChange !== "function") {
        return { data: { subscription: { unsubscribe() {} } } };
      }
      return provider.onAuthStateChange(callback);
    },
  };
})();
