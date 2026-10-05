/* Nyangkut — Share page logic (/s/<token>).
 * Read-only. Tidak ada login, tidak ada data lain yang di-fetch.
 * Hanya 6 field sanitized dari POST /api/share/get.
 */
(function () {
  "use strict";

  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

  function $(sel) { return document.querySelector(sel); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function rupiah(n) {
    var num = Number(n);
    if (!isFinite(num)) return "Rp0";
    return "Rp" + Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function formatDate(iso) {
    // iso: YYYY-MM-DD. Parse sebagai tanggal lokal (hindari geser timezone).
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "";
    try {
      return new Intl.DateTimeFormat("id-ID", {
        day: "numeric", month: "long", year: "numeric",
      }).format(new Date(+m[1], +m[2] - 1, +m[3]));
    } catch (e) { return ""; }
  }

  function showInvalid() {
    $("[data-share-loading]").hidden = true;
    $("[data-share-content]").hidden = true;
    $("[data-share-invalid]").hidden = false;
    $("[data-share-cta]").hidden = true;
    document.title = "Link tidak tersedia — Nyangkut";
  }

  function render(data) {
    $("[data-share-loading]").hidden = true;

    $("[data-share-bill]").textContent = data.bill_name || "Split Bill";
    $("[data-share-owner]").textContent = data.owner_name || "Teman";
    $("[data-share-amount]").textContent = rupiah(data.amount);

    var statusEl = $("[data-share-status]");
    var status = data.status || "unpaid";
    if (status === "paid") {
      statusEl.textContent = "Lunas ✓";
      statusEl.classList.add("is-paid");
    } else if (status === "partial") {
      statusEl.textContent = "Sebagian dibayar";
    } else {
      statusEl.textContent = "Belum dibayar";
    }

    var dueEl = $("[data-share-due]");
    var due = formatDate(data.due_date);
    if (due) {
      dueEl.textContent = "Jatuh tempo: " + due;
      dueEl.hidden = false;
    }

    $("[data-share-content]").hidden = false;
    $("[data-share-cta]").hidden = false;
    document.title = (data.bill_name || "Split Bill") + " — Nyangkut";
  }

  async function init() {
    // Token dari path: /s/<token>
    var parts = window.location.pathname.split("/").filter(Boolean);
    var token = parts.length >= 2 && parts[0] === "s" ? parts[1] : "";

    if (!TOKEN_RE.test(token)) {
      showInvalid();
      return;
    }

    try {
      var res = await fetch("/api/share/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token }),
      });
      if (!res.ok) {
        showInvalid();
        return;
      }
      var data = await res.json();
      if (!data || typeof data.amount === "undefined") {
        showInvalid();
        return;
      }
      render(data);
    } catch (e) {
      showInvalid();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
