/**
 * BUYE-Online — theme toggle
 * ============================
 * Include on any page that has <link rel="stylesheet" href=".../theme.css">
 * and a <button id="theme-toggle"> somewhere in its header.
 *
 * Defaults to the visitor's OS light/dark preference, then lets them
 * override it with the button for the rest of that page view.
 *
 * Note on persistence: this intentionally does NOT use localStorage,
 * so the choice doesn't carry over when navigating to a different page
 * (catalogue -> a test page, etc.) — it re-applies the OS preference on
 * each load instead. If you want the toggle to stick across page
 * navigation once this is live on your real domain, that's a small,
 * safe addition (a few lines wrapped in try/catch) — just ask and I'll
 * add it.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  var mql = window.matchMedia("(prefers-color-scheme: dark)");
  var manualOverride = false;

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    if (btn) {
      btn.textContent = theme === "dark" ? "\u2600" : "\u263D"; // sun / moon
      btn.setAttribute(
        "aria-label",
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      );
    }
  }

  var current = mql.matches ? "dark" : "light";
  apply(current);

  if (btn) {
    btn.addEventListener("click", function () {
      manualOverride = true;
      current = current === "dark" ? "light" : "dark";
      apply(current);
    });
  }

  // Follow OS changes live, unless the visitor already used the button
  // on this page view.
  mql.addEventListener("change", function (e) {
    if (manualOverride) return;
    current = e.matches ? "dark" : "light";
    apply(current);
  });
})();
