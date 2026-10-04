/* Nyangkut — Supabase auth provider (REAL, bukan preview).
 *
 * File ini menggantikan preview provider dari auth-provider.js dengan
 * implementasi Supabase Auth yang sesungguhnya, lewat kontrak yang sama:
 *   NyangkutAuth.configure({ signIn, signUp, getSession, signOut })
 *
 * Keamanan:
 * - Password tidak pernah disimpan di mana pun oleh frontend; hanya dikirim
 *   via HTTPS ke Supabase Auth saat signIn/signUp.
 * - Session (access/refresh token) dikelola resmi oleh supabase-js dan
 *   disimpan di localStorage — ini pola standar SPA Supabase, BUKAN
 *   credential. Password tidak pernah masuk storage.
 * - ANON_KEY di bawah adalah "publishable key": dirancang untuk publik.
 *   Proteksi data dipegang Row Level Security di database, bukan key ini.
 *   Jangan pernah menaruh service_role key di frontend.
 */
(() => {
  "use strict";

  var SUPABASE_URL = "https://adpteropqkbbdtpfwkhh.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_4W4F4TZjbv6a02UlS9nnbw_0guo0a2t";

  function sdkMissing() {
    var err = new Error("Supabase SDK gagal dimuat. Periksa koneksi lalu muat ulang halaman.");
    return {
      signIn: function () { return Promise.reject(err); },
      signUp: function () { return Promise.reject(err); },
      getSession: function () { return Promise.reject(err); },
      signOut: function () { return Promise.reject(err); },
    };
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("[Nyangkut] Supabase SDK tidak tersedia; auth dinonaktifkan.");
    window.NyangkutAuth.configure(sdkMissing());
    window.NyangkutAuth.mode = "real-unavailable";
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  function toUser(supaUser) {
    if (!supaUser) return null;
    var meta = supaUser.user_metadata || {};
    var fallbackName = (supaUser.email || "").split("@")[0].replace(/[._-]+/g, " ").trim();
    return {
      id: supaUser.id,
      email: supaUser.email,
      name: meta.name || fallbackName || "Teman",
    };
  }

  window.NyangkutAuth.configure({
    signIn: function (credentials) {
      return client.auth
        .signInWithPassword({ email: credentials.email, password: credentials.password })
        .then(function (res) {
          if (res.error) throw res.error;
          return { user: toUser(res.data.user) };
        });
    },
    signUp: function (details) {
      return client.auth
        .signUp({
          email: details.email,
          password: details.password,
          options: { data: { name: details.name } },
        })
        .then(function (res) {
          if (res.error) throw res.error;
          // Kalau "Confirm email" aktif di Supabase, tidak ada session:
          // user harus verifikasi email dulu sebelum bisa masuk.
          if (!res.data.session) return { requiresEmailConfirmation: true };
          return { user: toUser(res.data.user) };
        });
    },
    getSession: function () {
      return client.auth.getSession().then(function (res) {
        if (res.error) throw res.error;
        var u = res.data.session && res.data.session.user;
        return u ? { user: toUser(u) } : null;
      });
    },
    signOut: function () {
      return client.auth.signOut().then(function (res) {
        if (res.error) throw res.error;
      });
    },
  });

  window.NyangkutAuth.mode = "real";
})();
