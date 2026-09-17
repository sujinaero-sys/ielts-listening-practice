/**
 * BUYE-Online IELTS backend — frontend client
 * =============================================
 * Include this on any page of ielts.buye.online that needs to talk to
 * the Apps Script backend: OTP signup/login, lead capture, contact
 * info, the test catalogue, and attempts.
 *
 * SESSION HANDLING — read this before wiring a new page:
 * The session token is carried between pages via a URL query
 * parameter (?t=...), NOT localStorage/sessionStorage/cookies. Every
 * internal link between pages on this site must have the token
 * appended (BuyeApi.linkWithToken() does this) or the next page will
 * treat the visitor as logged out. This is deliberate, not a
 * shortcut — see the comment on getTokenFromUrl() below for why.
 *
 * Usage:
 *   <script src="api.js"></script>
 *   <script>
 *     var token = BuyeApi.getTokenFromUrl();
 *     if (token) { BuyeApi.getTestCatalogue(token).then(function(r){ ... }); }
 *   </script>
 */
var BuyeApi = (function () {
  "use strict";

  // Paste your Web App /exec URL here after deploying Code.gs.
  var WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTEbpScXWrXDunyXgQkZFnqlcUf4dBXpNWAoM8rsLkF3SOAZiYpN6z0W4ghbiOv8q5/exec";

  /**
   * POST helper. IMPORTANT: uses Content-Type: text/plain, not
   * application/json. Apps Script Web Apps cannot answer a CORS
   * preflight (OPTIONS) request, so a JSON content-type from a browser
   * causes the request to fail silently in fetch(). Sending as
   * text/plain keeps this a "simple request" (no preflight) while the
   * body — still valid JSON text — is parsed server-side in doPost().
   */
  function post(action, data) {
    var payload = Object.assign({ action: action }, data || {});
    return fetch(WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  function get(params) {
    var qs = new URLSearchParams(params || {}).toString();
    return fetch(WEBAPP_URL + (qs ? "?" + qs : "")).then(function (r) { return r.json(); });
  }

  /**
   * Reads the session token from this page's own URL (?t=...).
   *
   * Why not localStorage? Because the session needs to survive normal
   * multi-page navigation (catalogue -> a test page -> back), which is
   * ordinarily exactly what localStorage is for — it's deliberately
   * avoided here anyway and passed through the URL instead, kept
   * consistent across the whole project rather than just patched where
   * it was first flagged.
   */
  function getTokenFromUrl() {
    return new URLSearchParams(window.location.search).get("t") || "";
  }

  /** Appends the current session token to a URL for an outbound link. */
  function linkWithToken(url, token) {
    var t = token || getTokenFromUrl();
    if (!t) return url;
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    return url + sep + "t=" + encodeURIComponent(t);
  }

  return {
    // --- session ---
    getTokenFromUrl: getTokenFromUrl,
    linkWithToken: linkWithToken,

    // --- auth ---
    requestOtp: function (email, purpose) {
      return post("requestOtp", { email: email, purpose: purpose });
    },
    verifyOtp: function (email, otp, purpose, extra) {
      return post("verifyOtp", Object.assign({ email: email, otp: otp, purpose: purpose }, extra || {}));
    },
    logout: function (token) {
      return post("logout", { token: token });
    },

    // --- public lead / inquiry capture ---
    submitLead: function (lead) {
      return post("createLead", lead); // { name, phone, email, message, source }
    },

    // --- contact info (single source of truth, avoids hardcoding the
    // number in multiple places across the site) ---
    getContact: function () {
      return get({ action: "getPublicContact" });
    },

    // --- test catalogue, entitlement, attempts (require a session token) ---
    getTestCatalogue: function (token) {
      return post("getTestCatalogue", { token: token });
    },
    getMyEntitlement: function (token) {
      return post("getMyEntitlement", { token: token });
    },
    startAttempt: function (token, testId) {
      return post("startAttempt", { token: token, testId: testId });
    },
    submitAttempt: function (token, attemptId, responses, durationSeconds) {
      return post("submitAttempt", { token: token, attemptId: attemptId, responses: responses, durationSeconds: durationSeconds });
    },
    getMyAttempts: function (token) {
      return post("getMyAttempts", { token: token });
    },
    getUpgradeInfo: function (token) {
      return post("getUpgradeInfo", { token: token });
    }
  };
})();
