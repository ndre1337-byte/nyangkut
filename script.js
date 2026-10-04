/* Nyangkut landing — interaksi ringan: menu mobile, reveal on scroll, counter. */
(function () {
  "use strict";

  /* ---- Mobile menu ---- */
  var toggle = document.getElementById("navToggle");
  var menu = document.getElementById("mobileMenu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      toggle.setAttribute("aria-label", open ? "Buka menu" : "Tutup menu");
      menu.hidden = open;
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Buka menu");
        menu.hidden = true;
      });
    });
  }

  /* ---- Reveal on scroll ---- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("visible"); });
  }

  /* ---- Counter: Rp2.450.000 ---- */
  function formatIDR(n) {
    return "Rp" + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  var counter = document.querySelector("[data-count]");
  if (counter && "IntersectionObserver" in window) {
    var target = parseInt(counter.getAttribute("data-count"), 10);
    var done = false;
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && !done) {
          done = true;
          var start = null;
          var dur = 1200;
          function tick(ts) {
            if (!start) start = ts;
            var p = Math.min((ts - start) / dur, 1);
            var eased = 1 - Math.pow(1 - p, 3);
            counter.textContent = formatIDR(Math.round(target * eased));
            if (p < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
          cio.disconnect();
        }
      });
    }, { threshold: 0.4 });
    cio.observe(counter);
  }
})();
