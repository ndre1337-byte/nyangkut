/* Nyangkut theme manager — global light/dark mode.
   - Manual choice stored in localStorage ("nyangkut-theme": "light"|"dark")
   - No manual choice → follows system prefers-color-scheme
   - Early init runs inline in <head> to prevent flash
*/
(function () {
  var KEY = "nyangkut-theme";

  function getStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function getSystem() {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) { return "light"; }
  }

  function getTheme() {
    var stored = getStored();
    if (stored === "dark" || stored === "light") return stored;
    return getSystem();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  function setTheme(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    applyTheme(theme);
    // Notify UI (e.g. segmented control state).
    try {
      document.dispatchEvent(new CustomEvent("nyangkut:theme", { detail: { theme: theme } }));
    } catch (e) {}
  }

  // Public API.
  window.NyangkutTheme = {
    get: getTheme,
    set: setTheme,
    system: getSystem,
    isManual: function () {
      var s = getStored();
      return s === "dark" || s === "light";
    }
  };

  // Follow system changes only when user hasn't chosen manually.
  try {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      if (!window.NyangkutTheme.isManual()) applyTheme(getSystem());
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}
})();
