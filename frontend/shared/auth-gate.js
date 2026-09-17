/**
 * BUYE-Online — auth gate
 * =========================
 * Reusable "you must be logged in" screen. Any page can call
 * BuyeAuthGate.require(containerEl) and get a callback once a valid
 * session token exists — either because the page already had one in
 * its URL (?t=...) or because the visitor just completed an OTP login
 * right here.
 *
 * This does NOT verify the token is still valid server-side by itself
 * — the first real API call the page makes (e.g. getTestCatalogue)
 * will fail with a session error if it's expired, and onInvalidToken
 * lets the calling page drop back into the login form when that
 * happens.
 */
var BuyeAuthGate = (function () {
  "use strict";

  /**
   * @param {HTMLElement} container - where to render the login form if needed
   * @param {Object} opts
   *   opts.onReady(token)        - called once a token is available (from URL or fresh login)
   *   opts.subtitle              - optional copy shown above the email field
   */
  function require(container, opts) {
    opts = opts || {};
    var existing = BuyeApi.getTokenFromUrl();
    if (existing) {
      opts.onReady && opts.onReady(existing);
      return;
    }
    renderLoginForm(container, opts);
  }

  function renderLoginForm(container, opts) {
    container.innerHTML =
      '<div class="auth-gate-card">' +
      '<h3 style="margin:0 0 4px;font-size:16px;">Log in to continue</h3>' +
      '<p style="margin:0 0 14px;font-size:12.5px;color:var(--ink-soft, #5B6270);">' +
      (opts.subtitle || 'Enter your email — we\'ll send a one-time code.') +
      '</p>' +
      '<div id="ag-step-email">' +
      '<input id="ag-email" type="email" placeholder="you@example.com" style="width:100%;padding:9px;margin-bottom:10px;border:1px solid var(--line,#D7DAE0);border-radius:3px;">' +
      '<button id="ag-send" class="theme-toggle-btn" style="width:auto;border-radius:3px;padding:9px 16px;">Send code</button>' +
      '</div>' +
      '<div id="ag-step-otp" style="display:none;">' +
      '<input id="ag-otp" maxlength="6" placeholder="123456" style="width:100%;padding:9px;margin-bottom:10px;border:1px solid var(--line,#D7DAE0);border-radius:3px;">' +
      '<button id="ag-verify" class="theme-toggle-btn" style="width:auto;border-radius:3px;padding:9px 16px;">Verify &amp; continue</button>' +
      '</div>' +
      '<p id="ag-msg" style="font-size:12.5px;margin-top:10px;"></p>' +
      '</div>';

    var msg = container.querySelector('#ag-msg');
    function show(text, isErr) {
      msg.textContent = text;
      msg.style.color = isErr ? 'var(--red,#C0392B)' : 'var(--green,#2E7D32)';
    }

    var email = '';
    container.querySelector('#ag-send').addEventListener('click', function () {
      email = container.querySelector('#ag-email').value.trim();
      if (!email) { show('Enter your email first.', true); return; }
      show('Sending code…', false);
      BuyeApi.requestOtp(email, 'login').then(function (r) {
        show(r.message, !r.success);
        if (r.success) {
          container.querySelector('#ag-step-email').style.display = 'none';
          container.querySelector('#ag-step-otp').style.display = 'block';
        }
      });
    });

    container.querySelector('#ag-verify').addEventListener('click', function () {
      var otp = container.querySelector('#ag-otp').value.trim();
      BuyeApi.verifyOtp(email, otp, 'login').then(function (r) {
        if (!r.success) { show(r.message, true); return; }
        // Bake the new token into this page's own URL so every
        // subsequent BuyeApi.getTokenFromUrl() call on this page (and
        // any link the page builds from here on) picks it up.
        var url = new URL(window.location.href);
        url.searchParams.set('t', r.token);
        window.history.replaceState({}, '', url);
        show('Logged in.', false);
        opts.onReady && opts.onReady(r.token);
      });
    });
  }

  return { require: require };
})();
