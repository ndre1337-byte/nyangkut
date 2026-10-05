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

    // Avatar inisial (presentation only).
    var avEl = document.querySelector("[data-avatar]");
    if (avEl) {
      avEl.textContent = (String(debt.person_name || "?").trim().charAt(0) || "?").toUpperCase();
      avEl.classList.toggle("av-receivable", debt.direction === "receivable");
      avEl.classList.toggle("av-payable", debt.direction !== "receivable");
    }

    var dirChip = document.querySelector('[data-d="dir_chip"]');
    var dirSub = document.querySelector('[data-d="dir_sub"]');
    if (debt.direction === "receivable") {
      dirChip.textContent = "Nyangkut";
      dirChip.className = "chip chip-dir-receivable";
      dirSub.textContent = "Uang gue masih di orang lain.";
      setText('[data-d="sisa_sub"]', "Uang yang harus balik ke kamu");
    } else {
      dirChip.textContent = "Utang kamu";
      dirChip.className = "chip chip-dir-payable";
      dirSub.textContent = "Gue masih punya utang.";
      setText('[data-d="sisa_sub"]', "Uang yang harus kamu bayar");
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

    // Badge jika debt dibuat otomatis dari catatan setiap bulan.
    var recurBadge = document.querySelector("[data-recur-badge]");
    if (recurBadge) recurBadge.hidden = !debt.recurring_rule_id;

    // CTA hanya kalau belum lunas
    document.querySelector("[data-cta-wrap]").hidden = isPaid;
    // Tombol WA hanya untuk receivable yang belum lunas (bukan payable, bukan paid)
    var waBtn = document.querySelector("[data-wa-remind]");
    if (waBtn) {
      waBtn.hidden = !(debt.direction === "receivable" && !isPaid && remaining() > 0);
    }
    // Hapus catatan hanya untuk yang sudah lunas
    document.querySelector("[data-danger-wrap]").hidden = !isPaid;

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
        .select("id, direction, person_name, amount, paid_amount, status, note, due_date, recurring_rule_id")
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

  function lockScroll(lock) {
    document.body.style.overflow = lock ? "hidden" : "";
  }

  // Helper buka/tutup modal dengan animasi (presentation only).
  function showModal(el) {
    el.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add("show"); });
    });
  }
  function hideModal(el) {
    el.classList.remove("show");
    setTimeout(function () {
      if (!el.classList.contains("show")) el.hidden = true;
    }, 200);
  }

  function openPayModal() {
    if (!debt || debt.status === "paid") return;
    payForm.reset();
    payDate.value = todayStr();
    payDate.max = todayStr(); // tanggal pembayaran tidak boleh di masa depan
    payError.hidden = true;
    payAmountError.hidden = true;
    var ctx = document.querySelector("[data-pay-context]");
    if (ctx) ctx.textContent = "Sisa " + rupiah(remaining()) + " dari " + debt.person_name + ".";
    showModal(payModal);
    lockScroll(true);
    setTimeout(function () { payAmount.focus(); }, 50);
  }
  function closePayModal() {
    hideModal(payModal);
    lockScroll(false);
    setPayBusy(false);
  }
  function setPayBusy(b) {
    busy = b;
    paySubmit.disabled = b;
    payLabel.textContent = b ? "Menyimpan…" : "Simpan Pembayaran";
  }

  // ---------- WA Tagih rate limit (abuse prevention) ----------
  // Maksimal 10 penggunaan per akun per hari (WIB).
  // Yang dicatat: user_id + waktu. Nomor tujuan TIDAK PERNAH dicatat.
  var WA_DAILY_LIMIT = 10;

  // Awal hari ini dalam WIB sebagai ISO string (untuk filter used_at).
  function jakartaDayStartISO() {
    try {
      var fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric", month: "2-digit", day: "2-digit",
      });
      var parts = fmt.formatToParts(new Date());
      var get = function (t) {
        var p = parts.find(function (x) { return x.type === t; });
        return p ? p.value : "01";
      };
      // 00:00 WIB = 17:00 UTC hari sebelumnya (WIB = UTC+7).
      var midnight = Date.UTC(+get("year"), +get("month") - 1, +get("day")) - 7 * 3600 * 1000;
      return new Date(midnight).toISOString();
    } catch (e) {
      // Fallback: 24 jam terakhir.
      return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    }
  }

  async function getWaUsageToday() {
    try {
      var c = await waitForClient();
      if (!c) return 0;
      var res = await c.from("wa_reminder_usage")
        .select("id", { count: "exact", head: true })
        .gte("used_at", jakartaDayStartISO());
      if (res.error) throw res.error;
      return res.count || 0;
    } catch (e) {
      // Tabel belum ada atau network gagal -> izinkan (soft control).
      console.warn("[Nyangkut] WA rate limit check gagal:", e);
      return 0;
    }
  }

  async function logWaUsage() {
    try {
      var c = await waitForClient();
      if (!c) return;
      var session = await c.auth.getSession();
      var uid = session && session.data && session.data.session
        ? session.data.session.user.id : null;
      if (!uid) return;
      await c.from("wa_reminder_usage").insert({ user_id: uid });
    } catch (e) {
      // Gagal log -> tetap izinkan (fail open, soft control).
      console.warn("[Nyangkut] WA usage log gagal:", e);
    }
  }

  // ---------- Ingatkan via WhatsApp ----------
  // 100% client-side. Nomor tidak disimpan, tidak dikirim ke server.
  var waModal = document.querySelector("[data-wa-modal]");
  var waForm = document.querySelector("[data-wa-form]");
  var waPhone = document.getElementById("wa-phone");
  var waError = document.querySelector("[data-wa-error]");

  // Normalisasi nomor Indonesia ke format internasional untuk wa.me.
  // 0812... -> 62812..., +62812... -> 62812..., 62812... -> 62812...
  function normalizeWaNumber(input) {
    var digits = String(input || "").replace(/\D/g, "");
    if (digits.startsWith("62")) {
      // sudah format internasional
    } else if (digits.startsWith("0")) {
      digits = "62" + digits.slice(1);
    } else if (digits.startsWith("8")) {
      digits = "62" + digits;
    } else {
      return null;
    }
    // Nomor HP Indonesia: 628 + 8-11 digit
    if (!/^628\d{8,11}$/.test(digits)) return null;
    return digits;
  }

  // Template pesan natural (bukan bahasa debt collector).
  function buildWaMessage() {
    var name = debt.person_name;
    var rem = remaining();
    var amountStr = rupiah(rem);
    var isPartial = debt.status === "partial" && Number(debt.paid_amount) > 0;
    var amountWord = isPartial ? "sisa " + amountStr : "uang " + amountStr;

    var body;
    if (debt.due_date) {
      body = "mau ingetin soal " + amountWord + " yang jatuh tempo " + fmtDateLong(debt.due_date) + " ya.";
    } else {
      body = "mau ingetin soal " + amountWord + " yang kemarin ya.";
    }
    return "Hai " + name + ", " + body + " Kalau sudah sempat, boleh dibalikin. Makasih 🙏";
  }

  function openWaModal() {
    if (!debt || debt.direction !== "receivable" || debt.status === "paid") return;
    waForm.reset();
    waError.hidden = true;
    var previewWrap = document.querySelector("[data-wa-preview-wrap]");
    var preview = document.querySelector("[data-wa-preview]");
    if (previewWrap && preview) {
      preview.textContent = buildWaMessage();
      previewWrap.hidden = false;
    }
    showModal(waModal);
    lockScroll(true);
    setTimeout(function () { waPhone.focus(); }, 50);
  }
  function closeWaModal() {
    hideModal(waModal);
    lockScroll(false);
  }

  document.querySelectorAll("[data-wa-remind]").forEach(function (b) {
    b.addEventListener("click", openWaModal);
  });
  document.querySelectorAll("[data-wa-close]").forEach(function (b) {
    b.addEventListener("click", closeWaModal);
  });
  if (waModal) {
    waModal.addEventListener("click", function (e) {
      if (e.target === waModal) closeWaModal();
    });
  }

  if (waForm) {
    waForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var normalized = normalizeWaNumber(waPhone.value);
      if (!normalized) {
        waError.textContent = "Nomor WhatsApp belum valid.";
        waError.hidden = false;
        waPhone.focus();
        return;
      }
      waError.hidden = true;

      // Rate limit: maksimal 10x per hari per akun (soft control).
      var used = await getWaUsageToday();
      if (used >= WA_DAILY_LIMIT) {
        waError.textContent = "Kamu sudah mencapai batas 10 pengingat WhatsApp hari ini. Coba lagi besok ya.";
        waError.hidden = false;
        return;
      }

      // Catat penggunaan (hanya user_id + waktu, tanpa nomor).
      // Tidak await agar tidak menghambat UX; gagal log = tetap lanjut.
      logWaUsage();

      // Buka WhatsApp dengan pesan terisi. User yang tekan Send.
      // Nomor hanya dipakai di sini untuk membentuk URL — tidak disimpan.
      var url = "https://wa.me/" + normalized + "?text=" + encodeURIComponent(buildWaMessage());
      closeWaModal();
      window.open(url, "_blank", "noopener");
    });
    // Sembunyikan error saat user mengetik ulang
    waPhone.addEventListener("input", function () {
      waError.hidden = true;
    });
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
      var wasActive = debt.status !== "paid";
      var finalAmount = amount;
      return load().then(function () {
        // Celebration hanya jika ini transisi ACTIVE -> PAID yang baru terjadi.
        if (wasActive && debt && debt.status === "paid") {
          showLunasCelebration(finalAmount);
        } else {
          toast("Pembayaran tercatat.");
        }
      });
    }).catch(function (err) {
      console.error("[Nyangkut] insert payment gagal:", err);
      var msg = String((err && err.message) || "").toLowerCase();
      payError.textContent =
        (msg.includes("check") || msg.includes("23514"))
          ? "Nominal melebihi sisa. Coba jumlah yang lebih kecil."
          : "Gagal menyimpan. Periksa koneksi kamu lalu coba lagi.";
      payError.hidden = false;
      setPayBusy(false);
    });
  });

  // ---------- modal konfirmasi tandai lunas ----------
  var paidModal = document.querySelector("[data-paid-modal]");
  var paidConfirm = document.querySelector("[data-paid-confirm]");

  function askMarkPaid() {
    if (!debt || debt.status === "paid" || busy) return;
    var txt = document.querySelector("[data-paid-text]");
    if (txt) txt.textContent = "Catat pelunasan " + rupiah(remaining()) + " dari " + debt.person_name + "?";
    showModal(paidModal);
    lockScroll(true);
  }
  function closePaidModal() {
    hideModal(paidModal);
    lockScroll(false);
    paidConfirm.disabled = false;
  }
  document.querySelectorAll("[data-mark-paid]").forEach(function (b) {
    b.addEventListener("click", askMarkPaid);
  });
  document.querySelectorAll("[data-paid-close]").forEach(function (b) {
    b.addEventListener("click", closePaidModal);
  });
  paidModal.addEventListener("click", function (e) {
    if (e.target === paidModal) closePaidModal();
  });

  paidConfirm.addEventListener("click", function () {
    if (!debt || debt.status === "paid" || busy) return;
    busy = true;
    paidConfirm.disabled = true;
    // Tandai lunas = catat pembayaran sebesar sisa. Trigger DB yang set status paid.
    client.from("payments").insert({
      debt_id: debt.id,
      amount: remaining(),
      paid_at: todayStr(),
      note: null,
    }).then(function (res) {
      if (res.error) throw res.error;
      busy = false;
      closePaidModal();
      var wasActive = debt.status !== "paid";
      var finalAmount = remaining();
      return load().then(function () {
        if (wasActive && debt && debt.status === "paid") {
          showLunasCelebration(finalAmount);
        } else {
          toast("Lunas! Catatan selesai. 🎉");
        }
      });
    }).catch(function (err) {
      console.error("[Nyangkut] tandai lunas gagal:", err);
      busy = false;
      closePaidModal();
      toast("Gagal menyimpan. Coba lagi ya.");
    });
  });

  // ---------- Lunas Experience ----------
  // Celebration HANYA untuk transisi ACTIVE -> PAID yang baru saja terjadi
  // lewat payment insert yang sukses. Status diambil dari DB setelah
  // load() (trigger recalc), bukan dari kalkulasi frontend.
  var lunasModal = document.querySelector("[data-lunas-modal]");
  var lunasAmount = 0; // nominal pembayaran terakhir yang membuat lunas

  function showLunasCelebration(finalAmount) {
    if (!lunasModal || !debt) return;
    lunasAmount = Number(finalAmount) || 0;
    var isRecv = debt.direction === "receivable";
    var name = debt.person_name || "";
    var line1 = document.querySelector("[data-lunas-line1]");
    var sub = document.querySelector("[data-lunas-sub]");
    if (line1) {
      line1.textContent = isRecv
        ? name + " sudah melunasi"
        : "Utang kamu ke " + name + " sudah lunas";
    }
    if (sub) {
      sub.textContent = isRecv
        ? "1 uang yang nyangkut berhasil dibereskan."
        : "1 catatan berhasil dibereskan.";
    }
    var amtEl = document.querySelector("[data-lunas-amount]");
    if (amtEl) amtEl.textContent = rupiah(lunasAmount);
    showModal(lunasModal);
    lockScroll(true);
    // Putar ulang animasi pop setiap kali muncul.
    var icon = lunasModal.querySelector(".lunas-icon");
    if (icon) {
      icon.style.animation = "none";
      void icon.offsetWidth;
      icon.style.animation = "";
    }
    setTimeout(function () {
      var btn = lunasModal.querySelector("[data-lunas-done]");
      if (btn) btn.focus();
    }, 50);
  }

  function closeLunasModal() {
    if (!lunasModal) return;
    hideModal(lunasModal);
    lockScroll(false);
  }

  function shareLunas() {
    if (!debt) return;
    var amt = rupiah(lunasAmount);
    var msg = debt.direction === "receivable"
      ? "🎉 Beres! Catatan " + amt + " dengan " + debt.person_name + " sudah lunas di Nyangkut. 🙌"
      : "🎉 Beres! Catatan utang " + amt + " ke " + debt.person_name + " sudah lunas di Nyangkut. 🙌";
    // Celebration share: client-side, tanpa nomor tersimpan,
    // tanpa quota WA Tagih. User yang tekan Send sendiri.
    window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank", "noopener");
  }

  document.querySelectorAll("[data-lunas-done]").forEach(function (b) {
    b.addEventListener("click", function () {
      closeLunasModal();
      window.location.href = "/dashboard/";
    });
  });
  document.querySelectorAll("[data-lunas-share]").forEach(function (b) {
    b.addEventListener("click", shareLunas);
  });
  if (lunasModal) {
    lunasModal.addEventListener("click", function (e) {
      if (e.target === lunasModal) closeLunasModal();
    });
  }

  // ---------- modal konfirmasi hapus catatan ----------
  var debtDelModal = document.querySelector("[data-debt-del-modal]");
  var debtDelConfirm = document.querySelector("[data-debt-del-confirm]");

  function askDeleteDebt() {
    if (!debt || debt.status !== "paid" || busy) return;
    var txt = document.querySelector("[data-debt-del-text]");
    if (txt) txt.textContent = "Hapus catatan ini? Riwayat pembayaran dan detail transaksi akan ikut dihapus.";
    showModal(debtDelModal);
    lockScroll(true);
  }
  function closeDebtDelModal() {
    hideModal(debtDelModal);
    lockScroll(false);
    debtDelConfirm.disabled = false;
  }
  document.querySelectorAll("[data-delete-debt]").forEach(function (b) {
    b.addEventListener("click", askDeleteDebt);
  });
  document.querySelectorAll("[data-debt-del-close]").forEach(function (b) {
    b.addEventListener("click", closeDebtDelModal);
  });
  debtDelModal.addEventListener("click", function (e) {
    if (e.target === debtDelModal) closeDebtDelModal();
  });

  debtDelConfirm.addEventListener("click", function () {
    if (!debt || debt.status !== "paid" || busy) return;
    busy = true;
    debtDelConfirm.disabled = true;
    // RLS: hanya debt milik user ini. Cascade hapus payments + reminders.
    client.from("debts").delete().eq("id", debt.id).then(function (res) {
      if (res.error) throw res.error;
      window.location.assign("/dashboard/");
    }).catch(function (err) {
      console.error("[Nyangkut] hapus catatan gagal:", err);
      busy = false;
      closeDebtDelModal();
      toast("Gagal menghapus. Coba lagi ya.");
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
    showModal(delModal);
    lockScroll(true);
  }
  function closeDelModal() {
    hideModal(delModal);
    lockScroll(false);
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
      if (!paidModal.hidden) closePaidModal();
      if (!debtDelModal.hidden) closeDebtDelModal();
      if (waModal && !waModal.hidden) closeWaModal();
      if (lunasModal && !lunasModal.hidden) closeLunasModal();
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

  // Kalau halaman dikembalikan dari bfcache (mis. tombol back setelah logout),
  // validasi ulang session supaya data private tidak tampil basi.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) load();
  });

  load();
})();
