/**
 * BUYE-Online — theme toggle
 * ============================
 * Include on any page that has <link rel="stylesheet" href=".../theme.css">
 * and a <button id="theme-toggle"> somewhere in its header.
 *
 * Defaults to the visitor's OS light/dark preference when no saved preference
 * exists, then lets the visitor override it with the button.
 *
 * The selected theme is persisted in localStorage so it carries across
 * BUYE pages such as catalogue → Test 1 → Test 2 → Test 3.
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
      btn.textContent = theme === "dark" ? "\u2600" : "\u263D";
      btn.setAttribute(
        "aria-label",
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      );
    }
  }

  var current;

  try {
    var savedTheme = localStorage.getItem("buye_theme");
    current =
      savedTheme === "dark" || savedTheme === "light"
        ? savedTheme
        : (mql.matches ? "dark" : "light");
  } catch (e) {
    current = mql.matches ? "dark" : "light";
  }

  apply(current);

  if (btn) {
    btn.addEventListener("click", function () {
      manualOverride = true;
      current = current === "dark" ? "light" : "dark";
      apply(current);

      try {
        localStorage.setItem("buye_theme", current);
      } catch (e) {}
    });
  }

  mql.addEventListener("change", function (e) {
    if (manualOverride) return;
    current = e.matches ? "dark" : "light";
    apply(current);
  });
})();
