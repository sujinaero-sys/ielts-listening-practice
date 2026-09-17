# BUYE-Online IELTS backend — setup & deployment

**New BUYE IELTS plan:** a fresh database (new Drive folder + new Sheet,
independent of whatever Apps Script/Sheet is already attached to
`ielts.buye.online`) that handles OTP account creation with admin
approval, a paid test catalogue, attempt recording, and performance
analytics — all through Google Sheets + Apps Script. No separate
server, hosting, or database engine.

This is a **new, standalone Apps Script project**. It does not touch
your existing script or spreadsheet — see "Two Apps Script projects"
below for why, and how they'll eventually need to talk to each other.

---

## 0. What's in this folder

```
Code.gs                        the entire backend (API + business logic)
Admin.html                     admin dashboard UI (served by Apps Script)
appsscript.json                project manifest (web app + OAuth scopes)
.clasp.json.example            template — copy to .clasp.json with your script ID
.github/workflows/deploy.yml   optional CI: auto-push to Apps Script on git push
frontend-snippets/
  api.js                       drop-in client for ielts.buye.online
  otp-signup-widget.html       example signup form using api.js
  lead-form-widget.html        example inquiry/callback form using api.js
```

## 1. Two Apps Script projects — why, and what that means

You told me `ielts.buye.online`'s Google Sheet already has an Apps
Script project attached to it. Apps Script only allows **one**
`doGet`/`doPost` per project, so merging this in blind risks breaking
whatever's already live. Rather than guess, this backend stands up its
**own** Drive folder + Spreadsheet + Apps Script project, fully
independent.

That means, for now, you'll have two separate systems:
- **Existing project** — whatever `ielts.buye.online` already runs on.
- **This project** — accounts, subscriptions, test catalogue, attempts,
  analytics.

Once you're ready, the two can be merged (or the old one retired) —
just share the old project's code with me first so I can fold it in
without collisions. Until then, this one works standalone.

## 2. First run — creates the database for you

Unlike a typical Apps Script setup, you don't need to manually create a
Sheet first.

1. In the Apps Script editor (a **new, empty project** — see step 6 for
   how to create one), paste in `Code.gs`, `Admin.html`, and
   `appsscript.json`.
2. Select `bootstrapNewDatabase` from the function dropdown and click
   **Run**. Approve the permission prompts (Sheets, Drive, Gmail send).

   This creates:
   - A new Drive folder called **"BUYE IELTS Database"**
   - A new Spreadsheet called **"BUYE IELTS — Database"**, moved into
     that folder, with all ten tabs below already built with headers
   - One seeded plan (`plan_monthly`, 30 days, ₹99 — matches the
     current course price; edit the `Plans` sheet any time this
     changes)
   - The new Spreadsheet's ID is saved into this project's Script
     Properties automatically

3. Check **View → Logs** (or **Executions**) for the Spreadsheet URL
   and Drive folder URL it just created. Open the Spreadsheet and
   bookmark it — this is your new database.

You do NOT need to run `setupDatabase()` separately — `bootstrapNewDatabase()`
does everything `setupDatabase()` does, plus creates the folder/sheet
themselves. (`setupDatabase()` is still there and still safe to re-run
any time — e.g. if you ever add a new sheet to `SHEETS_SCHEMA` later
and need existing spreadsheets to pick it up.)

## 3. Database schema (created automatically)

| Sheet | Purpose | Key columns |
|---|---|---|
| `Accounts` | students + admins | AccountId, Email, Role, Status (`pending_approval`/`approved`/`rejected`/`suspended`) |
| `OTP` | one-time codes | Identifier, Purpose, OtpHash (never plaintext), ExpiresAt |
| `Sessions` | login tokens | Token, AccountId, ExpiresAt |
| `Leads` | inquiries/callbacks | Name, Phone, Status (`new`/`contacted`/`converted`/`closed`) |
| `AuditLog` | who-did-what | Actor, Action, TargetId, Details |
| `Plans` | subscription plans | PlanId, DurationDays, Price (informational — see section 5) |
| `Subscriptions` | who has paid access, until when | AccountId, PlanId, Status (`active`/`pending_payment`/`expired`), EndDate |
| `Tests` | the catalogue — one row per test | TestId, Module, AccessTier (`free`/`premium`), AnswerKeyJson, PartBoundariesJson |
| `Attempts` | every attempt, ever | AccountId, TestId, RawScore, BandScore, ResponsesJson |
| `QuestionStats` | per-question miss-rates | TestId, QuestionNumber, TimesAnswered, TimesCorrect |

**Important — where question content lives:** `Tests` stores only
*metadata* (title, access tier, answer key, audio URL) — not the actual
question markup/HTML for all 198 tests. That's far too much to put in a
spreadsheet cell sensibly, and it's also where your existing
`catalogue`/`engines` frontend project comes in: the frontend renders
the questions (same as the `tests/test-1/index.html` template built
earlier), and this backend only needs to know the answer key (to grade
attempts) and a few catalogue fields (to list/gate tests). See section 7
— this is the piece I still need your frontend project's code for.

## 4. Script Properties

**Project Settings → Script Properties.** `bootstrapNewDatabase()` sets
`SPREADSHEET_ID` for you automatically. You still need to set:

| Key | Value | Required? |
|---|---|---|
| `ADMIN_NOTIFY_EMAIL` | e.g. `you@buye.online` | Yes — without it, admins won't get new-account/lead email alerts |
| `CONTACT_PHONE` | `+919995863184` | Optional (already the built-in fallback) |
| `PAYMENT_LINK_URL` | your course checkout URL | Optional (see section 5 — has a fallback, but the link/price will change, so update it here rather than in code) |

## 5. How payment/subscriptions work right now

**No payment gateway is wired in.** Per your instruction, this does
NOT use Razorpay or any other API. Instead:

1. A locked (premium) test's response includes an `upgradeUrl` —
   currently your Tutor LMS course-checkout link
   (`buye.online/courses/894052`). The frontend shows this as an
   "Unlock all tests — Rs. 99" button/link.
2. The student pays there, on your existing WordPress/Tutor LMS site —
   entirely outside this backend.
3. **You (admin) manually grant access** from the Admin dashboard (or
   by calling `adminGrantSubscription_`) once you see the payment come
   through on the WordPress side. This flips their `Subscriptions` row
   to `active` for the plan's duration (30 days by default).

This is deliberately simple and manual for now. If/when you want it
automated (e.g. a WordPress webhook that calls this backend the moment
a course purchase completes), that's a clean addition later — the
`adminGrantSubscription_` function is exactly what an automated hook
would call too, it just wouldn't need a human in the loop anymore.

**When the price or link changes** ("later we have to change this link
also with new price tag"): update the `PAYMENT_LINK_URL` Script
Property — no code change, no redeploy needed. Update the `Price`
column in the `Plans` sheet too, for your own records (it's not used to
charge anyone automatically).

## 6. Local development (VS Code) + GitHub

```bash
npm install -g @google/clasp
clasp login

# brand-new Apps Script project for this new database:
clasp create --type webapp --title "BUYE-Online IELTS Backend (New Plan)" --rootDir .

git init && git add . && git commit -m "New BUYE IELTS plan backend"
git remote add origin <your-github-repo-url>
git push -u origin main
```

`clasp push` after edits; `.github/workflows/deploy.yml` can automate
that plus `clasp deploy` on every push to `main` (see comments in that
file for the two required repo secrets).

## 7. What I still need from you to finish this

1. **Your existing `catalogue`/`engines` frontend code** (the
   `localhost:5500` project) — so the "add a test" workflow matches
   what your frontend actually expects, and so I know exactly what
   `getTestCatalogue_`/`startAttempt_`/`submitAttempt_` need to return.
2. **The 198 test source sets** — same shape as Test 1 originally was
   (scraped page + audio), or already normalized? This determines
   whether each test needs the same manual conversion done for Test 1,
   or can be scripted.
3. **Confirmation this new, separate database is the right call** — or
   whether you'd rather everything folded into your existing
   spreadsheet/script instead (requires seeing that existing code
   first, per section 1).

## 8. API surface added for the New BUYE IELTS plan

Student-facing (all require a valid session token from OTP login):
- `getTestCatalogue` — list published tests + per-test `unlocked` flag + `upgradeUrl`
- `getMyEntitlement` — current subscription status + `upgradeUrl`
- `startAttempt` `{testId}` — entitlement check, opens an attempt
- `submitAttempt` `{attemptId, responses, durationSeconds}` — grades
  server-side against the stored answer key (not trusting whatever the
  client computed) and records the result
- `getMyAttempts` — a student's own attempt history
- `getUpgradeInfo` — just the payment link

Admin-facing (all require an admin session token):
- `adminListTests` / `adminUpsertTest` — catalogue + answer-key management
- `adminListPlans` / `adminUpsertPlan`
- `adminGrantSubscription` `{accountId, planId}` — the manual unlock
- `adminListSubscriptions`
- `adminListAttempts` `{testId}`
- `adminBuildQuestionStats` `{testId}` — rebuilds per-question miss-rate stats on demand

Everything from the original plan (OTP signup/login, account approval,
lead capture) is unchanged and still present.

## 9. Security checklist (carried over + extended)

- [x] No passwords stored anywhere — OTP-over-email only
- [x] OTP hashed before storage; rate-limited; attempt-capped
- [x] Session tokens opaque + server-validated, not JWTs
- [x] Formula-injection guard on every sheet write
- [x] `LockService` guards concurrent writes
- [x] Full audit log, now also covering subscriptions, tests, and attempts
- [x] Scores are graded server-side on submit, using the answer key
      stored in `Tests` — a student can't fake their band score by
      tampering with client-side JavaScript
- [x] Premium-test access is re-checked server-side on every
      `startAttempt` call, not just hidden in the frontend UI
