/**
 * BUYE-Online — IELTS Listening Portal backend
 * ==============================================
 * Google Apps Script backend for ielts.buye.online.
 * Database: Google Sheet (see SPREADSHEET_ID below / Script Properties).
 *
 * Stack: Google Sheets (DB) + Apps Script (API + Admin dashboard) + Drive
 * (project storage) + GitHub (version control via clasp). No external
 * server required.
 *
 * FIRST-TIME SETUP
 * -----------------
 * 1. Open Project Settings (gear icon) in the Apps Script editor and add
 *    these Script Properties (File > Project Settings > Script Properties):
 *
 *      SPREADSHEET_ID       the Google Sheet ID used as the database
 *      ADMIN_NOTIFY_EMAIL   email address that receives new-account and
 *                           new-lead notifications
 *      CONTACT_PHONE        e.g. +919995863184   (optional — has a
 *                           built-in fallback, see CONTACT_PHONE_FALLBACK)
 *
 * 2. Run setupDatabase() once from the editor (select it in the function
 *    dropdown and click Run). It creates every sheet/tab and header row
 *    it needs, and is safe to re-run any time — it never deletes data.
 *
 * 3. Deploy > New deployment > Web app
 *      Execute as:  Me
 *      Who has access: Anyone
 *    Copy the resulting /exec URL into frontend-snippets/api.js as
 *    WEBAPP_URL, and use that same URL for Admin.html (?page=admin).
 *
 * 4. Manually add yourself as the first admin: open the Accounts sheet
 *    and add a row with Role = admin and Status = approved for your own
 *    email (see README-SETUP.md for the exact column order). Every admin
 *    after that can be added the same way, or promoted from the sheet.
 *
 * SECURITY NOTES (read before going live)
 * -----------------------------------------
 * - No passwords are ever stored. Auth is OTP-over-email only.
 * - OTP codes are hashed (SHA-256) before being written to the sheet;
 *   the raw code only ever exists in the email sent to the user.
 * - OTP requests are rate-limited per email (see RATE_LIMIT_* below) and
 *   verification attempts are capped (OTP_MAX_ATTEMPTS).
 * - Session tokens are opaque random values checked against the
 *   Sessions sheet on every request (not JWTs) — revoking a session is
 *   just deleting its row.
 * - All values written to the sheet are passed through sanitizeForSheet_
 *   to neutralise spreadsheet formula-injection (values starting with
 *   = + - @ are treated as text).
 * - Do NOT share the underlying Google Sheet with "Anyone with the
 *   link" — it should only be accessible to you/admins. The Web App is
 *   the only thing the public site talks to.
 */

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

var CONTACT_PHONE_FALLBACK = '+919995863184';
var SPREADSHEET_ID_FALLBACK = '1u-WVtpNtIXuNGxbHYUTQiRazo7tZraeOF8_WPqmQg';

var SHEET_ACCOUNTS = 'Accounts';
var SHEET_OTP = 'OTP';
var SHEET_SESSIONS = 'Sessions';
var SHEET_LEADS = 'Leads';
var SHEET_AUDIT = 'AuditLog';
var SHEET_PLANS = 'Plans';
var SHEET_SUBSCRIPTIONS = 'Subscriptions';
var SHEET_TESTS = 'Tests';
var SHEET_ATTEMPTS = 'Attempts';
var SHEET_QUESTION_STATS = 'QuestionStats';

var OTP_TTL_MINUTES = 5;
var OTP_MAX_ATTEMPTS = 5;
var SESSION_TTL_HOURS = 72;
var RATE_LIMIT_MAX_OTP_REQUESTS = 5;   // per identifier
var RATE_LIMIT_WINDOW_SECONDS = 900;    // 15 minutes

var DB_FOLDER_NAME = 'BUYE IELTS Database';
var DB_FILE_NAME = 'BUYE IELTS — Database';

// Where students go to pay right now. This is a placeholder Tutor LMS
// course-checkout link, not a payment API integration — no Razorpay or
// other gateway is wired in. The price/link on that page can change any
// time without touching this code: override it via the PAYMENT_LINK_URL
// Script Property (Project Settings > Script Properties) instead of
// editing the fallback below.
var PAYMENT_LINK_FALLBACK =
  'https://www.buye.online/courses/894052?utm_source=app&utm_medium=ielts-portal&utm_campaign=upgrade-prompt';

var SHEETS_SCHEMA = {
  Accounts: ['AccountId', 'Name', 'Email', 'Phone', 'Role', 'Status',
             'CreatedAt', 'ApprovedAt', 'ApprovedBy', 'LastLoginAt', 'Notes'],
  OTP: ['OtpId', 'Identifier', 'Purpose', 'OtpHash', 'ExpiresAt',
        'Attempts', 'Verified', 'CreatedAt'],
  Sessions: ['Token', 'AccountId', 'Role', 'CreatedAt', 'ExpiresAt'],
  Leads: ['LeadId', 'Name', 'Phone', 'Email', 'Source', 'Message',
          'Status', 'AssignedTo', 'CreatedAt', 'UpdatedAt', 'Notes'],
  AuditLog: ['Timestamp', 'Actor', 'Action', 'TargetType', 'TargetId', 'Details'],

  // --- New BUYE IELTS plan additions ---
  Plans: ['PlanId', 'Name', 'DurationDays', 'Price', 'Currency', 'Active', 'CreatedAt'],
  Subscriptions: ['SubscriptionId', 'AccountId', 'PlanId', 'Status', 'StartDate', 'EndDate',
                   'Source', 'PaymentRef', 'Amount', 'GrantedBy', 'CreatedAt'],
  Tests: ['TestId', 'Module', 'Title', 'AccessTier', 'Status', 'QuestionCount',
          'PartBoundariesJson', 'AnswerKeyJson', 'ExcludedQuestionsJson', 'AudioUrl', 'Tags', 'CreatedAt', 'UpdatedAt'],
  Attempts: ['AttemptId', 'AccountId', 'TestId', 'Status', 'StartedAt', 'SubmittedAt',
             'DurationSeconds', 'RawScore', 'BandScore', 'PartScoresJson', 'ResponsesJson', 'CreatedAt'],
  QuestionStats: ['TestId', 'QuestionNumber', 'TimesAnswered', 'TimesCorrect', 'ComputedAt']
};

// ---------------------------------------------------------------------
// ONE-TIME / MAINTENANCE
// ---------------------------------------------------------------------

/**
 * Creates every sheet/tab this backend needs, with headers, if they
 * don't already exist. Safe to run repeatedly — never deletes data.
 * Run this once from the Apps Script editor before first use.
 */
function setupDatabase() {
  var ss = getSpreadsheet_();
  Object.keys(SHEETS_SCHEMA).forEach(function (name) {
    var headers = SHEETS_SCHEMA[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#161E2B')
        .setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, headers.length);
    }
  });
  // Remove the default "Sheet1" if it's empty and unused.
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }
  Logger.log('Database setup complete.');
}

/**
 * Creates a brand-new Drive folder + a brand-new Spreadsheet inside it,
 * builds every sheet/tab this backend needs, and logs both URLs.
 *
 * Run this ONCE, from a fresh Apps Script project, to stand up the New
 * BUYE IELTS plan database independently of any existing script/sheet.
 * It never touches your existing ielts.buye.online spreadsheet.
 *
 * After running: open View > Logs (or Executions) to get the new
 * Spreadsheet ID, then paste it into this project's Script Properties
 * as SPREADSHEET_ID (Project Settings > Script Properties).
 */
function bootstrapNewDatabase() {
  var folder = DriveApp.createFolder(DB_FOLDER_NAME);
  var ss = SpreadsheetApp.create(DB_FILE_NAME);
  var file = DriveApp.getFileById(ss.getId());

  // Move the new spreadsheet into the new folder (out of the root "My Drive").
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  // Build every sheet using the same logic as setupDatabase(), against
  // this brand-new spreadsheet.
  Object.keys(SHEETS_SCHEMA).forEach(function (name) {
    var headers = SHEETS_SCHEMA[name];
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold').setBackground('#161E2B').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, headers.length);
    }
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) ss.deleteSheet(def);

  // Seed one sensible default plan so Subscriptions has something to point at.
  var plansSheet = ss.getSheetByName('Plans');
  if (plansSheet.getLastRow() < 2) {
    plansSheet.appendRow(['plan_monthly', 'Monthly access', 30, 99, 'INR', true, new Date().toISOString()]);
  }

  Logger.log('New database created.');
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
  Logger.log('Spreadsheet ID (already saved to SPREADSHEET_ID): ' + ss.getId());
  Logger.log('Drive folder URL: ' + folder.getUrl());
  Logger.log('Next: add your own Accounts row with Role=admin, Status=approved, then deploy the Web App.');

  return { spreadsheetUrl: ss.getUrl(), spreadsheetId: ss.getId(), folderUrl: folder.getUrl() };
}

// ---------------------------------------------------------------------
// WEB APP ENTRY POINTS
// ---------------------------------------------------------------------

function doGet(e) {
  var params = (e && e.parameter) || {};

  if (params.page === 'admin') {
    return HtmlService.createTemplateFromFile('Admin')
      .evaluate()
      .setTitle('BUYE-Online — Admin Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (params.action === 'getPublicContact') {
    return jsonResponse_(getPublicContact_());
  }

  return jsonResponse_({ status: 'ok', service: 'BUYE-Online IELTS backend' });
}

/**
 * All state-changing calls go through POST as a single JSON body:
 *   { "action": "requestOtp", ...fields }
 *
 * IMPORTANT (frontend integration): send the request with
 * Content-Type: text/plain;charset=utf-8 (NOT application/json).
 * Apps Script Web Apps cannot respond to CORS preflight (OPTIONS)
 * requests, so a JSON content-type from the browser will fail. Sending
 * as text/plain keeps it a browser "simple request" (no preflight)
 * while the body is still parsed as JSON server-side below. See
 * frontend-snippets/api.js for the exact pattern.
 */
function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseErr) {
    return jsonResponse_({ success: false, message: 'Invalid request body.' });
  }
  return jsonResponse_(routeAction_(body.action, body));
}

/**
 * Shared dispatcher used by both the public Web App (doPost, over HTTP)
 * and the Admin.html dashboard (via google.script.run, same-project —
 * no HTTP/CORS involved at all for the admin UI).
 */
function routeAction_(action, body) {
  try {
    switch (action) {
      case 'requestOtp':
        return requestOtp_(body);
      case 'verifyOtp':
        return verifyOtpAndProceed_(body);
      case 'createLead':
        return createLead_(body);
      case 'getPublicContact':
        return getPublicContact_();
      case 'adminListPendingAccounts':
        return adminListPendingAccounts_(body);
      case 'adminListAccounts':
        return adminListAccounts_(body);
      case 'adminSetAccountStatus':
        return adminSetAccountStatus_(body);
      case 'adminListLeads':
        return adminListLeads_(body);
      case 'adminUpdateLead':
        return adminUpdateLead_(body);
      case 'logout':
        return logout_(body);

      // --- New BUYE IELTS plan: catalogue, entitlement, attempts ---
      case 'getTestCatalogue':
        return getTestCatalogue_(body);
      case 'getMyEntitlement':
        return getMyEntitlement_(body);
      case 'startAttempt':
        return startAttempt_(body);
      case 'submitAttempt':
        return submitAttempt_(body);
      case 'getMyAttempts':
        return getMyAttempts_(body);
      case 'getUpgradeInfo':
        return getUpgradeInfo_(body);

      // --- New BUYE IELTS plan: admin ---
      case 'adminListTests':
        return adminListTests_(body);
      case 'adminUpsertTest':
        return adminUpsertTest_(body);
      case 'adminListPlans':
        return adminListPlans_(body);
      case 'adminUpsertPlan':
        return adminUpsertPlan_(body);
      case 'adminGrantSubscription':
        return adminGrantSubscription_(body);
      case 'adminListSubscriptions':
        return adminListSubscriptions_(body);
      case 'adminListAttempts':
        return adminListAttempts_(body);
      case 'adminBuildQuestionStats':
        return adminBuildQuestionStats_(body);

      default:
        return { success: false, message: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { success: false, message: err && err.message ? err.message : String(err) };
  }
}

/** Entry point called from Admin.html via google.script.run.apiCallFromAdmin(action, payload). */
function apiCallFromAdmin(action, payload) {
  return routeAction_(action, payload || {});
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------------
// AUTH: OTP REQUEST + VERIFY
// ---------------------------------------------------------------------

/**
 * body: { email, purpose: 'signup' | 'login' }
 */
function requestOtp_(body) {
  var email = normalizeEmail_(body.email);
  var purpose = body.purpose === 'login' ? 'login' : 'signup';

  if (!isValidEmail_(email)) {
    return { success: false, message: 'Please enter a valid email address.' };
  }

  assertRateLimitOk_('otpreq_' + email);

  var accounts = getSheet_(SHEET_ACCOUNTS);
  var existing = findRowByValue_(accounts, 'Email', email);

  if (purpose === 'signup') {
    if (existing) {
      var status = existing.data.Status;
      if (status === 'approved') {
        return { success: false, message: 'An account with this email already exists. Please log in instead.' };
      }
      if (status === 'pending_approval') {
        return { success: false, message: 'This email already has an account awaiting admin approval.' };
      }
    }
  } else { // login
    if (!existing) {
      return { success: false, message: 'No account found for this email. Please sign up first.' };
    }
    if (existing.data.Status === 'pending_approval') {
      return { success: false, message: 'Your account is still awaiting admin approval.' };
    }
    if (existing.data.Status === 'rejected' || existing.data.Status === 'suspended') {
      return { success: false, message: 'This account is not active. Contact support: ' + getContactPhone_() };
    }
  }

  var otp = generateOtp_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_OTP);
    sheet.appendRow([
      newId_('otp'),
      email,
      purpose,
      hashString_(otp),
      nowPlusMinutes_(OTP_TTL_MINUTES).toISOString(),
      0,
      false,
      new Date().toISOString()
    ]);
  } finally {
    lock.releaseLock();
  }

  sendOtpEmail_(email, otp, purpose);
  logAudit_(email, 'otp_requested', 'account', email, 'purpose=' + purpose);

  return { success: true, message: 'A verification code has been sent to ' + email + '.' };
}

/**
 * body: { email, otp, purpose, name, phone }
 * name/phone are required (and used) only when purpose === 'signup'.
 */
function verifyOtpAndProceed_(body) {
  var email = normalizeEmail_(body.email);
  var otp = String(body.otp || '').trim();
  var purpose = body.purpose === 'login' ? 'login' : 'signup';

  if (!isValidEmail_(email) || !otp) {
    return { success: false, message: 'Email and code are required.' };
  }

  var otpSheet = getSheet_(SHEET_OTP);
  var rows = getRowsAsObjects_(otpSheet);

  // latest matching, unverified, unexpired OTP for this email+purpose
  var match = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (r.data.Identifier === email && r.data.Purpose === purpose && r.data.Verified !== true && r.data.Verified !== 'TRUE') {
      match = r;
      break;
    }
  }

  if (!match) {
    return { success: false, message: 'No pending code found. Please request a new one.' };
  }

  var expiresAt = new Date(match.data.ExpiresAt);
  if (isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return { success: false, message: 'This code has expired. Please request a new one.' };
  }

  var attempts = Number(match.data.Attempts) || 0;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return { success: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  if (hashString_(otp) !== match.data.OtpHash) {
    otpSheet.getRange(match.rowIndex, SHEETS_SCHEMA.OTP.indexOf('Attempts') + 1).setValue(attempts + 1);
    var remaining = OTP_MAX_ATTEMPTS - (attempts + 1);
    return { success: false, message: 'Incorrect code. ' + remaining + ' attempt(s) remaining.' };
  }

  otpSheet.getRange(match.rowIndex, SHEETS_SCHEMA.OTP.indexOf('Verified') + 1).setValue(true);

  var accountsSheet = getSheet_(SHEET_ACCOUNTS);
  var existing = findRowByValue_(accountsSheet, 'Email', email);

  if (purpose === 'signup') {
    if (existing) {
      return { success: false, message: 'An account already exists for this email.' };
    }
    var name = sanitizeForSheet_(String(body.name || '').trim()) || 'Student';
    var phone = sanitizeForSheet_(String(body.phone || '').trim());
    var accountId = newId_('acc');

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      accountsSheet.appendRow([
        accountId, name, email, phone, 'student', 'pending_approval',
        new Date().toISOString(), '', '', '', ''
      ]);
    } finally {
      lock.releaseLock();
    }

    logAudit_(email, 'account_created', 'account', accountId, 'status=pending_approval');
    notifyAdminEmail_(
      'New IELTS account awaiting approval',
      'A new student account was created and needs your review.\n\n' +
      'Name: ' + name + '\nEmail: ' + email + '\nPhone: ' + phone + '\n\n' +
      'Approve or reject it from the admin dashboard.'
    );

    return {
      success: true,
      status: 'pending_approval',
      message: 'Your account has been created and is awaiting admin approval. ' +
        'You will be notified by email once it is reviewed. For urgent queries, ' +
        'call/WhatsApp ' + getContactPhone_() + '.'
    };
  }

  // purpose === 'login'
  if (!existing) {
    return { success: false, message: 'No account found for this email.' };
  }
  if (existing.data.Status !== 'approved') {
    return { success: false, message: 'Your account is not yet approved. Status: ' + existing.data.Status };
  }

  var token = createSession_(existing.data.AccountId, existing.data.Role);
  accountsSheet.getRange(existing.rowIndex, SHEETS_SCHEMA.Accounts.indexOf('LastLoginAt') + 1)
    .setValue(new Date().toISOString());
  logAudit_(email, 'login', 'account', existing.data.AccountId, 'role=' + existing.data.Role);

  return {
    success: true,
    token: token,
    name: existing.data.Name,
    role: existing.data.Role,
    accountId: existing.data.AccountId
  };
}

function logout_(body) {
  var token = String(body.token || '');
  if (!token) return { success: true };
  var sheet = getSheet_(SHEET_SESSIONS);
  var row = findRowByValue_(sheet, 'Token', token);
  if (row) sheet.deleteRow(row.rowIndex);
  return { success: true };
}

// ---------------------------------------------------------------------
// PUBLIC: LEAD GENERATION / INQUIRIES
// ---------------------------------------------------------------------

/**
 * body: { name, phone, email, message, source }
 * Public endpoint — no authentication required. Used by inquiry / lead
 * capture forms across ielts.buye.online.
 */
function createLead_(body) {
  var name = sanitizeForSheet_(String(body.name || '').trim());
  var phone = sanitizeForSheet_(String(body.phone || '').trim());
  var email = sanitizeForSheet_(normalizeEmail_(body.email || ''));
  var message = sanitizeForSheet_(String(body.message || '').trim());
  var source = sanitizeForSheet_(String(body.source || 'website').trim());

  if (!name || (!phone && !email)) {
    return { success: false, message: 'Please provide your name and a phone number or email.' };
  }

  assertRateLimitOk_('lead_' + (phone || email));

  var leadId = newId_('lead');
  var sheet = getSheet_(SHEET_LEADS);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow([
      leadId, name, phone, email, source, message,
      'new', '', new Date().toISOString(), '', ''
    ]);
  } finally {
    lock.releaseLock();
  }

  logAudit_(email || phone, 'lead_created', 'lead', leadId, 'source=' + source);
  notifyAdminEmail_(
    'New inquiry / lead — ' + source,
    'Name: ' + name + '\nPhone: ' + phone + '\nEmail: ' + email +
    '\nSource: ' + source + '\nMessage: ' + message
  );

  return {
    success: true,
    message: 'Thanks! Our team will contact you shortly.',
    contact: { phone: getContactPhone_(), whatsapp: getWhatsAppLink_() }
  };
}

function getPublicContact_() {
  return {
    success: true,
    phone: getContactPhone_(),
    whatsapp: getWhatsAppLink_()
  };
}

// ---------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------

function adminListPendingAccounts_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_ACCOUNTS));
  var out = rows
    .filter(function (r) { return r.data.Status === 'pending_approval'; })
    .map(function (r) { return r.data; });
  return { success: true, accounts: out };
}

function adminListAccounts_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_ACCOUNTS));
  var filterStatus = body.status;
  var out = rows
    .filter(function (r) { return !filterStatus || r.data.Status === filterStatus; })
    .map(function (r) { return r.data; });
  return { success: true, accounts: out };
}

/**
 * body: { token, accountId, decision: 'approve'|'reject'|'suspend', reason }
 */
function adminSetAccountStatus_(body) {
  var admin = requireAdmin_(body.token);
  var accountId = String(body.accountId || '');
  var decision = String(body.decision || '');
  var statusMap = { approve: 'approved', reject: 'rejected', suspend: 'suspended' };
  var newStatus = statusMap[decision];

  if (!accountId || !newStatus) {
    return { success: false, message: 'accountId and a valid decision are required.' };
  }

  var sheet = getSheet_(SHEET_ACCOUNTS);
  var row = findRowByValue_(sheet, 'AccountId', accountId);
  if (!row) return { success: false, message: 'Account not found.' };

  var cols = SHEETS_SCHEMA.Accounts;
  sheet.getRange(row.rowIndex, cols.indexOf('Status') + 1).setValue(newStatus);
  if (newStatus === 'approved') {
    sheet.getRange(row.rowIndex, cols.indexOf('ApprovedAt') + 1).setValue(new Date().toISOString());
    sheet.getRange(row.rowIndex, cols.indexOf('ApprovedBy') + 1).setValue(admin.email || admin.accountId);
  }
  if (body.reason) {
    sheet.getRange(row.rowIndex, cols.indexOf('Notes') + 1).setValue(sanitizeForSheet_(String(body.reason)));
  }

  logAudit_(admin.accountId, 'account_status_changed', 'account', accountId, 'status=' + newStatus);

  var email = row.data.Email;
  if (email) {
    if (newStatus === 'approved') {
      sendPlainEmail_(email, 'Your IELTS account has been approved',
        'Hi ' + row.data.Name + ',\n\nYour account has been approved. You can now log in at ' +
        'ielts.buye.online using your email — we will send you a one-time code each time you log in.\n\n' +
        'Questions? Call/WhatsApp ' + getContactPhone_() + '.\n\n— BUYE-Online');
    } else if (newStatus === 'rejected') {
      sendPlainEmail_(email, 'Update on your IELTS account request',
        'Hi ' + row.data.Name + ',\n\nWe were unable to approve your account at this time.' +
        (body.reason ? ('\nReason: ' + body.reason) : '') +
        '\n\nIf you have questions, call/WhatsApp ' + getContactPhone_() + '.\n\n— BUYE-Online');
    }
  }

  return { success: true, status: newStatus };
}

function adminListLeads_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_LEADS));
  var filterStatus = body.status;
  var out = rows
    .filter(function (r) { return !filterStatus || r.data.Status === filterStatus; })
    .map(function (r) { return r.data; })
    .reverse(); // newest first
  return { success: true, leads: out };
}

/**
 * body: { token, leadId, status, notes, assignedTo }
 */
function adminUpdateLead_(body) {
  var admin = requireAdmin_(body.token);
  var leadId = String(body.leadId || '');
  if (!leadId) return { success: false, message: 'leadId is required.' };

  var sheet = getSheet_(SHEET_LEADS);
  var row = findRowByValue_(sheet, 'LeadId', leadId);
  if (!row) return { success: false, message: 'Lead not found.' };

  var cols = SHEETS_SCHEMA.Leads;
  if (body.status) sheet.getRange(row.rowIndex, cols.indexOf('Status') + 1).setValue(String(body.status));
  if (body.notes !== undefined) sheet.getRange(row.rowIndex, cols.indexOf('Notes') + 1).setValue(sanitizeForSheet_(String(body.notes)));
  if (body.assignedTo !== undefined) sheet.getRange(row.rowIndex, cols.indexOf('AssignedTo') + 1).setValue(sanitizeForSheet_(String(body.assignedTo)));
  sheet.getRange(row.rowIndex, cols.indexOf('UpdatedAt') + 1).setValue(new Date().toISOString());

  logAudit_(admin.accountId, 'lead_updated', 'lead', leadId, 'status=' + body.status);
  return { success: true };
}

// ---------------------------------------------------------------------
// NEW BUYE IELTS PLAN: TEST CATALOGUE + ENTITLEMENT + ATTEMPTS
// ---------------------------------------------------------------------

/**
 * Every test's own question markup lives in the frontend (the
 * catalogue/engines project), NOT in this sheet — Sheets isn't a good
 * place to store 198 tests' worth of HTML. This backend is the source
 * of truth for three things only: which tests exist and are published,
 * who's allowed to attempt which one, and what actually happened when
 * they did (for grading + analytics). AnswerKeyJson/PartBoundariesJson
 * mirror the TEST_DATA.key / TEST_DATA.partBoundaries shape already
 * used in the exam-engine template, so the same data can drive both.
 */

function requireSession_(token) {
  var session = validateSession_(token);
  if (!session) throw new Error('Session expired or invalid. Please log in again.');
  return session;
}

function hasActiveSubscription_(accountId) {
  var rows = getRowsAsObjects_(getSheet_(SHEET_SUBSCRIPTIONS));
  var now = Date.now();
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].data;
    if (s.AccountId === accountId && s.Status === 'active') {
      var end = new Date(s.EndDate);
      if (!isNaN(end.getTime()) && end.getTime() >= now) return true;
    }
  }
  return false;
}

/** body: { token } — list published tests with each one's access state for this student. */
function getTestCatalogue_(body) {
  var session = requireSession_(body.token);
  var active = hasActiveSubscription_(session.accountId);
  var rows = getRowsAsObjects_(getSheet_(SHEET_TESTS));
  var tests = rows
    .filter(function (r) { return r.data.Status === 'published'; })
    .map(function (r) {
      var t = r.data;
      var unlocked = t.AccessTier === 'free' || active;
      return {
        testId: t.TestId, module: t.Module, title: t.Title,
        accessTier: t.AccessTier, questionCount: t.QuestionCount,
        tags: t.Tags, unlocked: unlocked
      };
    });
  return { success: true, tests: tests, hasActiveSubscription: active, upgradeUrl: getPaymentLink_() };
}

function getMyEntitlement_(body) {
  var session = requireSession_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_SUBSCRIPTIONS));
  var now = Date.now();
  var best = null;
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].data;
    if (s.AccountId === session.accountId && s.Status === 'active') {
      var end = new Date(s.EndDate);
      if (!isNaN(end.getTime()) && end.getTime() >= now) {
        if (!best || end.getTime() > new Date(best.EndDate).getTime()) best = s;
      }
    }
  }
  return {
    success: true,
    hasActiveSubscription: !!best,
    expiresAt: best ? best.EndDate : null,
    planId: best ? best.PlanId : null,
    upgradeUrl: getPaymentLink_()
  };
}

/** body: { token, testId } — checks entitlement, opens an Attempts row. */
function startAttempt_(body) {
  var session = requireSession_(body.token);
  var testId = String(body.testId || '');
  var testRow = findRowByValue_(getSheet_(SHEET_TESTS), 'TestId', testId);
  if (!testRow || testRow.data.Status !== 'published') {
    return { success: false, message: 'Test not found.' };
  }
  var isFree = testRow.data.AccessTier === 'free';
  if (!isFree && !hasActiveSubscription_(session.accountId)) {
    return { success: false, message: 'This test requires an active subscription.', locked: true, upgradeUrl: getPaymentLink_() };
  }

  var attemptId = newId_('att');
  getSheet_(SHEET_ATTEMPTS).appendRow([
    attemptId, session.accountId, testId, 'in_progress',
    new Date().toISOString(), '', '', '', '', '', '', new Date().toISOString()
  ]);
  logAudit_(session.accountId, 'attempt_started', 'test', testId, 'attemptId=' + attemptId);

  return {
    success: true, attemptId: attemptId,
    partBoundaries: safeParseJson_(testRow.data.PartBoundariesJson, [10, 20, 30, 40]),
    questionCount: testRow.data.QuestionCount,
    audioUrl: testRow.data.AudioUrl
  };
}

/**
 * body: { token, attemptId, responses: {"1":"answer",...}, durationSeconds }
 * Grades server-side against the test's stored AnswerKeyJson — the
 * canonical score, independent of whatever the client-side UI computed.
 */
function submitAttempt_(body) {
  var session = requireSession_(body.token);
  var attemptId = String(body.attemptId || '');
  var responses = body.responses || {};

  var attemptsSheet = getSheet_(SHEET_ATTEMPTS);
  var attemptRow = findRowByValue_(attemptsSheet, 'AttemptId', attemptId);
  if (!attemptRow || attemptRow.data.AccountId !== session.accountId) {
    return { success: false, message: 'Attempt not found.' };
  }
  if (attemptRow.data.Status === 'completed') {
    return { success: false, message: 'This attempt was already submitted.' };
  }

  var testRow = findRowByValue_(getSheet_(SHEET_TESTS), 'TestId', attemptRow.data.TestId);
  if (!testRow) return { success: false, message: 'Test not found.' };

  var key = safeParseJson_(testRow.data.AnswerKeyJson, {});
  var boundaries = safeParseJson_(testRow.data.PartBoundariesJson, [10, 20, 30, 40]);
  var totalQ = Number(testRow.data.QuestionCount) || 40;
  var excluded = safeParseJson_(testRow.data.ExcludedQuestionsJson, []);
  var excludedSet = {};
  excluded.forEach(function (n) { excludedSet[n] = true; });

  function partOf(n) {
    for (var i = 0; i < boundaries.length; i++) { if (n <= boundaries[i]) return i + 1; }
    return boundaries.length;
  }
  function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;]+$/, ''); }

  var raw = 0;
  var partCorrect = {};
  var partTotals = {};
  var graded = {};
  for (var q = 1; q <= totalQ; q++) {
    var p = partOf(q);
    if (excludedSet[q]) {
      // Not yet gradable (e.g. a map-labeling question whose source
      // image isn't available yet) — shown to the student, but doesn't
      // count for or against their score.
      graded[q] = { given: responses[q] || responses[String(q)] || '', correct: null, correctAnswer: '', excluded: true };
      continue;
    }
    partTotals[p] = (partTotals[p] || 0) + 1;
    var accepted = key[q] || [];
    var given = responses[q] || responses[String(q)] || '';
    var correct = false;
    for (var i = 0; i < accepted.length; i++) {
      if (norm(accepted[i]) === norm(given)) { correct = true; break; }
    }
    if (correct) {
      raw++;
      partCorrect[p] = (partCorrect[p] || 0) + 1;
    }
    graded[q] = { given: given, correct: correct, correctAnswer: accepted[0] || '' };
  }
  var gradedTotal = totalQ - excluded.length;

  var band = bandForListening_(raw, gradedTotal);
  var cols = SHEETS_SCHEMA.Attempts;
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('Status') + 1).setValue('completed');
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('SubmittedAt') + 1).setValue(new Date().toISOString());
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('DurationSeconds') + 1).setValue(Number(body.durationSeconds) || '');
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('RawScore') + 1).setValue(raw);
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('BandScore') + 1).setValue(band);
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('PartScoresJson') + 1).setValue(JSON.stringify(partCorrect));
  attemptsSheet.getRange(attemptRow.rowIndex, cols.indexOf('ResponsesJson') + 1).setValue(JSON.stringify(graded));

  logAudit_(session.accountId, 'attempt_submitted', 'test', attemptRow.data.TestId,
    'attemptId=' + attemptId + ' raw=' + raw + '/' + totalQ);

  return { success: true, rawScore: raw, totalQuestions: gradedTotal, bandScore: band, partScores: partCorrect, partTotals: partTotals, review: graded };
}

function getMyAttempts_(body) {
  var session = requireSession_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_ATTEMPTS));
  var out = rows
    .filter(function (r) { return r.data.AccountId === session.accountId; })
    .map(function (r) {
      var d = r.data;
      return {
        attemptId: d.AttemptId, testId: d.TestId, status: d.Status,
        rawScore: d.RawScore, bandScore: d.BandScore,
        startedAt: d.StartedAt, submittedAt: d.SubmittedAt
      };
    })
    .reverse();
  return { success: true, attempts: out };
}

function bandForListening_(raw, totalQ) {
  var table = [[39,40,9],[37,38,8.5],[35,36,8],[32,34,7.5],[30,31,7],[26,29,6.5],
               [23,25,6],[18,22,5.5],[16,17,5],[13,15,4.5],[10,12,4],[8,9,3.5],
               [6,7,3],[4,5,2.5],[2,3,2],[0,1,1]];
  var scale = totalQ / 40;
  for (var i = 0; i < table.length; i++) {
    var lo = Math.round(table[i][0] * scale), hi = Math.round(table[i][1] * scale);
    if (raw >= lo && raw <= hi) return table[i][2];
  }
  return 1;
}

function safeParseJson_(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// ---------------------------------------------------------------------
// NEW BUYE IELTS PLAN: PAYMENTS (external checkout link — no gateway wired in)
// ---------------------------------------------------------------------

function getPaymentLink_() {
  return getScriptProperty_('PAYMENT_LINK_URL') || PAYMENT_LINK_FALLBACK;
}

function getUpgradeInfo_(body) {
  requireSession_(body.token); // must be logged in, but any account is fine
  return { success: true, paymentLink: getPaymentLink_() };
}

// ---------------------------------------------------------------------
// NEW BUYE IELTS PLAN: ADMIN — TESTS, PLANS, SUBSCRIPTIONS, ANALYTICS
// ---------------------------------------------------------------------

function adminListTests_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_TESTS));
  return { success: true, tests: rows.map(function (r) { return r.data; }) };
}

/**
 * body: { token, testId, module, title, accessTier, status, questionCount,
 *         partBoundaries: [10,20,30,40], answerKey: {1:["300"],...}, audioUrl, tags }
 * Creates or updates one test's catalogue entry + answer key.
 */
function adminUpsertTest_(body) {
  var admin = requireAdmin_(body.token);
  var testId = String(body.testId || '').trim();
  if (!testId) return { success: false, message: 'testId is required.' };

  var sheet = getSheet_(SHEET_TESTS);
  var row = findRowByValue_(sheet, 'TestId', testId);
  var cols = SHEETS_SCHEMA.Tests;
  var now = new Date().toISOString();

  var values = [
    testId,
    sanitizeForSheet_(String(body.module || 'listening')),
    sanitizeForSheet_(String(body.title || '')),
    body.accessTier === 'premium' ? 'premium' : 'free',
    body.status === 'published' ? 'published' : 'draft',
    Number(body.questionCount) || 40,
    JSON.stringify(body.partBoundaries || [10, 20, 30, 40]),
    JSON.stringify(body.answerKey || {}),
    JSON.stringify(body.excludedQuestions || []),
    sanitizeForSheet_(String(body.audioUrl || '')),
    sanitizeForSheet_(String(body.tags || '')),
    row ? row.data.CreatedAt : now,
    now
  ];

  if (row) {
    sheet.getRange(row.rowIndex, 1, 1, cols.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  logAudit_(admin.accountId, 'test_upserted', 'test', testId, 'status=' + values[4]);
  return { success: true, testId: testId };
}

function adminListPlans_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_PLANS));
  return { success: true, plans: rows.map(function (r) { return r.data; }) };
}

/** body: { token, planId, name, durationDays, price, currency, active } */
function adminUpsertPlan_(body) {
  var admin = requireAdmin_(body.token);
  var planId = String(body.planId || '').trim();
  if (!planId) return { success: false, message: 'planId is required.' };

  var sheet = getSheet_(SHEET_PLANS);
  var row = findRowByValue_(sheet, 'PlanId', planId);
  var values = [
    planId, sanitizeForSheet_(String(body.name || '')), Number(body.durationDays) || 30,
    Number(body.price) || 0, sanitizeForSheet_(String(body.currency || 'INR')),
    body.active !== false, row ? row.data.CreatedAt : new Date().toISOString()
  ];
  if (row) {
    sheet.getRange(row.rowIndex, 1, 1, values.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  logAudit_(admin.accountId, 'plan_upserted', 'plan', planId, '');
  return { success: true, planId: planId };
}

/**
 * body: { token, accountId, planId, durationDaysOverride }
 * The manual "admin unlocks access" path — no payment involved. Use
 * this for comps, trials, or offline payments.
 */
function adminGrantSubscription_(body) {
  var admin = requireAdmin_(body.token);
  var accountId = String(body.accountId || '');
  var planRow = findRowByValue_(getSheet_(SHEET_PLANS), 'PlanId', String(body.planId || ''));
  if (!accountId || !planRow) return { success: false, message: 'accountId and a valid planId are required.' };

  var durationDays = Number(body.durationDaysOverride) || Number(planRow.data.DurationDays) || 30;
  var start = new Date();
  var end = new Date(start.getTime() + durationDays * 86400000);
  var subId = newId_('sub');

  getSheet_(SHEET_SUBSCRIPTIONS).appendRow([
    subId, accountId, planRow.data.PlanId, 'active', start.toISOString(), end.toISOString(),
    'admin_grant', '', planRow.data.Price, admin.email || admin.accountId, new Date().toISOString()
  ]);
  logAudit_(admin.accountId, 'subscription_granted', 'account', accountId,
    'plan=' + planRow.data.PlanId + ' until=' + end.toISOString());

  return { success: true, subscriptionId: subId, expiresAt: end.toISOString() };
}

function adminListSubscriptions_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_SUBSCRIPTIONS));
  var filterStatus = body.status;
  var out = rows
    .filter(function (r) { return !filterStatus || r.data.Status === filterStatus; })
    .map(function (r) { return r.data; })
    .reverse();
  return { success: true, subscriptions: out };
}

function adminListAttempts_(body) {
  requireAdmin_(body.token);
  var rows = getRowsAsObjects_(getSheet_(SHEET_ATTEMPTS));
  var filterTestId = body.testId;
  var out = rows
    .filter(function (r) { return !filterTestId || r.data.TestId === filterTestId; })
    .map(function (r) {
      var d = r.data;
      return {
        attemptId: d.AttemptId, accountId: d.AccountId, testId: d.TestId, status: d.Status,
        rawScore: d.RawScore, bandScore: d.BandScore, submittedAt: d.SubmittedAt
      };
    })
    .reverse();
  return { success: true, attempts: out };
}

/**
 * body: { token, testId }
 * Aggregates every completed attempt's ResponsesJson for one test into
 * per-question miss-rate stats. Run on demand from the admin dashboard
 * (not on every submission) to keep Attempts writes fast.
 */
function adminBuildQuestionStats_(body) {
  var admin = requireAdmin_(body.token);
  var testId = String(body.testId || '');
  if (!testId) return { success: false, message: 'testId is required.' };

  var attempts = getRowsAsObjects_(getSheet_(SHEET_ATTEMPTS))
    .filter(function (r) { return r.data.TestId === testId && r.data.Status === 'completed'; });

  var tally = {}; // { qNum: { answered: n, correct: n } }
  attempts.forEach(function (r) {
    var graded = safeParseJson_(r.data.ResponsesJson, {});
    Object.keys(graded).forEach(function (q) {
      if (!tally[q]) tally[q] = { answered: 0, correct: 0 };
      if (graded[q].given) tally[q].answered++;
      if (graded[q].correct) tally[q].correct++;
    });
  });

  // Replace any previous stats rows for this test, then write fresh ones.
  var statsSheet = getSheet_(SHEET_QUESTION_STATS);
  var existing = getRowsAsObjects_(statsSheet);
  for (var i = existing.length - 1; i >= 0; i--) {
    if (existing[i].data.TestId === testId) statsSheet.deleteRow(existing[i].rowIndex);
  }
  var now = new Date().toISOString();
  var out = [];
  Object.keys(tally).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (q) {
    var row = [testId, Number(q), tally[q].answered, tally[q].correct, now];
    statsSheet.appendRow(row);
    out.push({ questionNumber: Number(q), timesAnswered: tally[q].answered, timesCorrect: tally[q].correct });
  });

  logAudit_(admin.accountId, 'question_stats_rebuilt', 'test', testId, 'attempts=' + attempts.length);
  return { success: true, testId: testId, attemptsAnalyzed: attempts.length, stats: out };
}

// ---------------------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------------------

function createSession_(accountId, role) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var sheet = getSheet_(SHEET_SESSIONS);
  sheet.appendRow([
    token, accountId, role, new Date().toISOString(),
    nowPlusMinutes_(SESSION_TTL_HOURS * 60).toISOString()
  ]);
  return token;
}

function validateSession_(token) {
  if (!token) return null;
  var sheet = getSheet_(SHEET_SESSIONS);
  var row = findRowByValue_(sheet, 'Token', token);
  if (!row) return null;
  var expiresAt = new Date(row.data.ExpiresAt);
  if (isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    sheet.deleteRow(row.rowIndex);
    return null;
  }
  return { accountId: row.data.AccountId, role: row.data.Role };
}

function requireAdmin_(token) {
  var session = validateSession_(token);
  if (!session) throw new Error('Session expired or invalid. Please log in again.');
  if (session.role !== 'admin') throw new Error('Admin access required.');
  var accSheet = getSheet_(SHEET_ACCOUNTS);
  var row = findRowByValue_(accSheet, 'AccountId', session.accountId);
  session.email = row ? row.data.Email : '';
  return session;
}

// ---------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------

function sendOtpEmail_(email, otp, purpose) {
  var subject = purpose === 'login'
    ? 'Your BUYE-Online login code: ' + otp
    : 'Your BUYE-Online verification code: ' + otp;
  var body =
    'Your one-time code is: ' + otp + '\n\n' +
    'This code expires in ' + OTP_TTL_MINUTES + ' minutes. Do not share it with anyone.\n\n' +
    'Didn\'t request this? You can ignore this email.\n\n' +
    'Need help? Call/WhatsApp ' + getContactPhone_() + '.\n\n— BUYE-Online, ielts.buye.online';
  sendPlainEmail_(email, subject, body);
}

function notifyAdminEmail_(subject, body) {
  var admin = getScriptProperty_('ADMIN_NOTIFY_EMAIL');
  if (!admin) return; // no admin email configured — skip silently
  sendPlainEmail_(admin, '[BUYE-Online] ' + subject, body + '\n\nContact number on file: ' + getContactPhone_());
}

function sendPlainEmail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body });
  } catch (err) {
    Logger.log('Email send failed to ' + to + ': ' + err.message);
  }
}

// ---------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------

function getSpreadsheet_() {
  var id = getScriptProperty_('SPREADSHEET_ID') || SPREADSHEET_ID_FALLBACK;
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet "' + name + '" not found. Run setupDatabase() first.');
  }
  return sheet;
}

function getScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getContactPhone_() {
  return getScriptProperty_('CONTACT_PHONE') || CONTACT_PHONE_FALLBACK;
}

function getWhatsAppLink_() {
  var digits = getContactPhone_().replace(/[^\d]/g, '');
  return 'https://wa.me/' + digits;
}

/** Reads a sheet into [{ rowIndex, data:{col:val,...} }, ...], skipping the header row. */
function getRowsAsObjects_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(function (row, i) {
    var data = {};
    headers.forEach(function (h, j) { data[h] = row[j]; });
    return { rowIndex: i + 2, data: data };
  });
}

function findRowByValue_(sheet, column, value) {
  var rows = getRowsAsObjects_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].data[column]).toLowerCase() === String(value).toLowerCase()) {
      return rows[i];
    }
  }
  return null;
}

function newId_(prefix) {
  return prefix + '_' + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generateOtp_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashString_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function nowPlusMinutes_(minutes) {
  return new Date(Date.now() + minutes * 60000);
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Neutralises spreadsheet formula-injection: values starting with = + - @ become text. */
function sanitizeForSheet_(value) {
  if (typeof value !== 'string') return value;
  if (/^[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function assertRateLimitOk_(key) {
  var cache = CacheService.getScriptCache();
  var current = Number(cache.get(key)) || 0;
  if (current >= RATE_LIMIT_MAX_OTP_REQUESTS) {
    throw new Error('Too many requests. Please try again in a few minutes.');
  }
  cache.put(key, String(current + 1), RATE_LIMIT_WINDOW_SECONDS);
}

function logAudit_(actor, action, targetType, targetId, details) {
  try {
    getSheet_(SHEET_AUDIT).appendRow([
      new Date().toISOString(), actor || '', action, targetType, targetId, details || ''
    ]);
  } catch (err) {
    Logger.log('Audit log failed: ' + err.message);
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
