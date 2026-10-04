/* Nyangkut — halaman detail catatan + catat pembayaran.
 * RLS membatasi semua query ke milik user yang login.
 * paid_amount/status TIDAK PERNAH ditulis frontend — trigger database yang urus.
 */
(() => {
  "use strict";

  var auth = window.NyangkutAuth;
  var MONTHS_FULL = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

  var states = {};
  document.querySelectorAll("[data-state]").forEach(function (el) {
    states[el.getAttribute("data-state")] = el;
  });

  var debtId = new URLSearchParams(window.location.search).get("id");
  var debt = null;      // row debts milik user
  var payments = [];    // rows payments milik debt ini
  var client = null;
  var busy = false;
  var delTarget = null; // payment yang dikonfirmasi hapus
  var toastTimer = null;

  function rupiah(n) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency", currency: "IDR", maximumFractionDigits: 0,
    }).format(Number(n) || 0).replace(/\s/g, "");
  }

  function fmtDateLong(iso) {
    if (!iso) return "Tanpa tempo";
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return String(iso);
    return parseInt(p[2], 10) + " " + MONTHS_FULL[parseInt(p[1], 10) - 1] + " " + p[0];
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showState(name) {
    Object.keys(states).forEach(function (k) { states[k].hidden = k !== name; });
  }

  function setText(sel, v) {
    var el = document.querySelector(sel);
    if (el) el.textContent = v;
  }

  function statusLabel(s) {
    if (s === "paid") return "Lunas";
    if (s === "partial") return "Partial";
    return "Belum bayar";
  }

  function toast(msg) {
    var el = document.querySelector("[data-toast]");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function remaining() {
    return Number(debt.amount) - Number(debt.paid_amount);
  }

  function render() {
    var rem = remaining();
    var isPaid = debt.status === "paid";

    setText('[data-d="person_name"]', debt.person_name);

    var dirChip = document.querySelector('[data-d="dir_chip"]');
    var dirSub = document.querySelector('[data-d="dir_sub"]');
    if (debt.direction === "receivable") {
      dirChip.textContent = "Nyangkut";
      dirChip.className = "chip chip-dir-receivable";
      dirSub.textContent = "Uang gue masih di orang lain.";
      setText('[data-d="sisa_sub"]', "Uang yang harus balik ke lo");
    } else {
      dirChip.textContent = "Utang lo";
      dirChip.className = "chip chip-dir-payable";
      dirSub.textContent = "Gue masih punya utang.";
      setText('[data-d="sisa_sub"]', "Uang yang harus lo bayar");
    }

    var stChip = document.querySelector('[data-d="status_chip"]');
    stChip.textContent = statusLabel(debt.status);
    stChip.className = "chip chip-status-" + debt.status;

    var sisaEl = document.querySelector('[data-d="remaining"]');
    sisaEl.textContent = rupiah(rem);
    sisaEl.classList.toggle("is-paid", isPaid);

    setText('[data-d="amount"]', rupiah(debt.amount));
    setText('[data-d="paid"]', rupiah(debt.paid_amount));
    setText('[data-d="due"]', fmtDateLong(debt.due_date));

    var noteWrap = document.querySelector("[data-note-wrap]");
    if (debt.note) {
      noteWrap.hidden = false;
      setText('[data-d="note"]', "“" + debt.note + "”");
    } else {
      noteWrap.hidden = true;
    }

    // CTA hanya kalau belum lunas
    document.querySelector("[data-cta-wrap]").hidden = isPaid;

    // Riwayat pembayaran
    var list = document.querySelector("[data-history-list]");
    var empty = document.querySelector("[data-history-empty]");
    list.innerHTML = "";
    empty.hidden = payments.length > 0;
    payments.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "history-item";
      var noteLine = p.note ? '<p class="history-note">“' + escapeHtml(p.note) + "”</p>" : "";
      li.innerHTML =
        '<div><p class="history-amount">' + rupiah(p.amount) + "</p>" +
        '<p class="history-meta">' + fmtDateLong(p.paid_at) + "</p>" + noteLine + "</div>" +
        '<button type="button" class="history-del" data-del-pay="' + p.id + '">Hapus</button>';
      list.appendChild(li);
    });
    list.querySelectorAll("[data-del-pay]").forEach(function (b) {
      b.addEventListener("click", function () { askDeletePayment(b.getAttribute("data-del-pay")); });
    });

    showState("detail");
  }

  function waitForClient(tries) {
    return new Promise(function (resolve) {
      (function poll(n) {
        if (window.NyangkutDB) return resolve(window.NyangkutDB);
        if (n <= 0) return resolve(null);
        setTimeout(function () { poll(n - 1); }, 100);
      })(tries == null ? 50 : tries);
    });
  }

  function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
  }

  async function load() {
    showState("loading");
    try {
      var session = await auth.getSession();
      if (!session || !session.user) { window.location.replace("/login/"); return; }
      client = await waitForClient();
      if (!client) throw new Error("no-client");
      if (!isUuid(debtId)) { showState("notfound"); return; }

      // RLS: hanya baris milik user ini yang kembali; milik orang lain -> 0 rows.
      var dRes = await client.from("debts")
        .select("id, direction, person_name, amount, paid_amount, status, note, due_date")
        .eq("id", debtId)
        .maybeSingle();
      if (dRes.error) throw dRes.error;
      if (!dRes.data) { showState("notfound"); return; }
      debt = dRes.data;

      var pRes = await client.from("payments")
        .select("id, amount, paid_at, note")
        .eq("debt_id", debtId)
        .order("paid_at", { ascending: false });
      if (pRes.error) throw pRes.error;
      payments = pRes.data || [];

      render();
    } catch (err) {
      console.error("[Nyangkut] detail gagal memuat:", err);
      showState("error");
    }
  }

  // ---------- modal catat pembayaran ----------
  var payModal = document.querySelector("[data-pay-modal]");
  var payForm = document.querySelector("[data-pay-form]");
  var payAmount = document.getElementById("p-amount");
  var payDate = document.getElementById("p-date");
  var paySubmit = document.querySelector("[data-pay-submit]");
  var payLabel = document.querySelector("[data-pay-label]");
  var payError = document.querySelector("[data-pay-error]");
  var payAmountError = document.querySelector("[data-pay-amount-error]");

  function openPayModal() {
    if (!debt || debt.status === "paid") return;
    payForm.reset();
    payDate.value = todayStr();
    payError.hidden = true;
    payAmountError.hidden = true;
    var ctx = document.querySelector("[data-pay-context]");
    if (ctx) ctx.textContent = "Sisa " + rupiah(remaining()) + " dari " + debt.person_name + ".";
    payModal.hidden = false;
    setTimeout(function () { payAmount.focus(); }, 50);
  }
  function closePayModal() {
    payModal.hidden = true;
    setPayBusy(false);
  }
  function setPayBusy(b) {
    busy = b;
    paySubmit.disabled = b;
    payLabel.textContent = b ? "Menyimpan…" : "Simpan Pembayaran";
  }

  document.querySelectorAll("[data-add-payment]").forEach(function (b) {
    b.addEventListener("click", openPayModal);
  });
  document.querySelectorAll("[data-pay-close]").forEach(function (b) {
    b.addEventListener("click", closePayModal);
  });
  payModal.addEventListener("click", function (e) {
    if (e.target === payModal) closePayModal();
  });

  payAmount.addEventListener("input", function () {
    var digits = payAmount.value.replace(/\D/g, "").slice(0, 15);
    payAmount.value = digits ? new Intl.NumberFormat("id-ID").format(Number(digits)) : "";
  });

  payForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return;
    payError.hidden = true;
    payAmountError.hidden = true;

    var digits = payAmount.value.replace(/\D/g, "");
    var amount = digits ? Number(digits) : 0;
    var rem = remaining();

    if (!(amount > 0)) {
      payAmountError.textContent = "Nominal harus lebih dari Rp0.";
      payAmountError.hidden = false;
      return;
    }
    if (amount > rem) {
      payAmountError.textContent = "Maksimal " + rupiah(rem) + " (sisa saat ini).";
      payAmountError.hidden = false;
      return;
    }

    setPayBusy(true);
    // Hanya 4 kolom ini. paid_amount/status dihitung trigger; user_id via RLS/debt.
    var payload = {
      debt_id: debt.id,
      amount: amount,
      paid_at: (document.getElementById("p-date").value || todayStr()),
      note: document.getElementById("p-note").value.trim() || null,
    };
    client.from("payments").insert(payload).then(function (res) {
      if (res.error) throw res.error;
      closePayModal();
      toast("Pembayaran tercatat.");
      return load(); // re-fetch: trigger sudah recalc di DB
    }).catch(function (err) {
      console.error("[Nyangkut] insert payment gagal:", err);
      var msg = String((err && err.message) || "").toLowerCase();
      payError.textContent =
        (msg.includes("check") || msg.includes("23514"))
          ? "Nominal melebihi sisa. Coba jumlah yang lebih kecil."
          : "Gagal menyimpan. Periksa koneksi lo lalu coba lagi.";
      payError.hidden = false;
      setPayBusy(false);
    });
  });

  // ---------- modal konfirmasi hapus ----------
  var delModal = document.querySelector("[data-del-modal]");
  var delConfirm = document.querySelector("[data-del-confirm]");

  function askDeletePayment(paymentId) {
    var p = payments.find(function (x) { return x.id === paymentId; });
    delTarget = paymentId;
    var txt = document.querySelector("[data-del-text]");
    if (txt && p) txt.textContent = "Yakin hapus pembayaran " + rupiah(p.amount) + " (" + fmtDateLong(p.paid_at) + ")?";
    delModal.hidden = false;
  }
  function closeDelModal() {
    delModal.hidden = true;
    delTarget = null;
    delConfirm.disabled = false;
  }
  document.querySelectorAll("[data-del-close]").forEach(function (b) {
    b.addEventListener("click", closeDelModal);
  });
  delModal.addEventListener("click", function (e) {
    if (e.target === delModal) closeDelModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!payModal.hidden) closePayModal();
      if (!delModal.hidden) closeDelModal();
    }
  });

  delConfirm.addEventListener("click", function () {
    if (!delTarget || busy) return;
    busy = true;
    delConfirm.disabled = true;
    // RLS: hanya payment milik debt user ini yang bisa dihapus.
    // Trigger database menghitung ulang paid_amount + status otomatis.
    client.from("payments").delete().eq("id", delTarget).then(function (res) {
      if (res.error) throw res.error;
      busy = false;
      closeDelModal();
      toast("Pembayaran dihapus.");
      return load();
    }).catch(function (err) {
      console.error("[Nyangkut] hapus payment gagal:", err);
      busy = false;
      closeDelModal();
      toast("Gagal menghapus. Coba lagi ya.");
    });
  });

  // ---------- sign out & retry ----------
  document.querySelectorAll("[data-sign-out]").forEach(function (b) {
    b.addEventListener("click", function () {
      b.disabled = true;
      auth.signOut().finally(function () { window.location.assign("/login/"); });
    });
  });
  var retry = document.querySelector("[data-retry]");
  if (retry) retry.addEventListener("click", load);

  load();
})();
