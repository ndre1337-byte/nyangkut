/* Nyangkut — shared header theme toggle.
 * Single ☀️/🌙 button. Uses window.NyangkutTheme as the single source of truth.
 * Load AFTER /assets/theme.js (both deferred, order preserved).
 */
(function () {
  "use strict";

  function sync() {
    if (!window.NyangkutTheme) return;
    var cur = window.NyangkutTheme.get();
    var toDark = cur !== "dark";
    var icon = toDark ? "\u2600\uFE0F" : "\uD83C\uDF19";
    var label = toDark ? "Gunakan mode gelap" : "Gunakan mode terang";
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var ic = btn.querySelector(".tt-icon");
      if (ic) ic.textContent = icon;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  function init() {
    if (!window.NyangkutTheme) return;
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          window.NyangkutTheme.set(window.NyangkutTheme.get() === "dark" ? "light" : "dark");
        });
      })(btns[i]);
    }
    // Manual changes dispatch nyangkut:theme.
    document.addEventListener("nyangkut:theme", sync);
    // System changes (no manual choice): theme.js applies silently, re-sync icon.
    try {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (!window.NyangkutTheme.isManual()) sync();
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
    sync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-sync if called before theme.js finished (defensive).
  window.addEventListener("load", sync);
})();
