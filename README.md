# buye-ielts

One VS Code workspace, two independently-deployed pieces:

```
buye-ielts/
├── backend/                          Apps Script project — clasp rootDir
│   ├── Code.gs                       API: auth, accounts, subscriptions,
│   │                                  test catalogue, attempts, analytics
│   ├── Admin.html                    Admin dashboard (served by Apps Script)
│   └── appsscript.json               Web app + OAuth scope manifest
│
├── frontend/                         Static files → hosted on ielts.buye.online
│   ├── catalogue/
│   │   └── index.html                Module picker (?module=Listening, etc.)
│   ├── engines/
│   │   └── listening/                One engine per module — Reading,
│   │       ├── engine/                Writing, Speaking each get their own
│   │       │   ├── exam-engine.js     engine/ folder alongside this one when
│   │       │   └── exam-theme.css     you're ready to build them
│   │       └── tests/
│   │           └── test-1/
│   │               ├── index.html    Question markup + this test's
│   │               │                  TEST_DATA (answer key, audio path)
│   │               └── audio.mp3
│   ├── assets/
│   │   └── buye-logo.jpg             Shared across every module/engine
│   └── shared/
│       ├── api.js                    Client for calling the backend
│       ├── otp-signup-widget.html    Drop-in signup form
│       └── lead-form-widget.html     Drop-in inquiry/callback form
│
├── docs/
│   └── README-SETUP.md               Full backend setup + deployment guide
│
├── .github/workflows/deploy.yml      CI: auto clasp-push+deploy on changes
│                                      under backend/
├── .clasp.json.example               Copy to .clasp.json, add your script ID
└── .gitignore
```

## Why backend/ and frontend/ are split

They deploy completely differently:
- **`backend/`** is pushed to Google Apps Script via `clasp` — see
  `docs/README-SETUP.md` for the full walkthrough (this is the piece
  `.github/workflows/deploy.yml` automates).
- **`frontend/`** is plain HTML/CSS/JS — deploy it however
  `ielts.buye.online` is already hosted. Nothing here is
  Apps-Script-specific; it just calls the backend's `/exec` URL over
  HTTPS from `frontend/shared/api.js`.

`clasp`'s `rootDir: "backend"` setting (in `.clasp.json`) is what makes
`clasp push` only ever touch the `backend/` folder — the frontend files
sitting alongside it are invisible to clasp entirely.

## Why `engines/listening/` and not just `engines/`

Each IELTS module (Listening, Reading, Writing, Speaking) needs a
different interaction model — audio + timer for Listening, a passage +
questions for Reading, an essay editor for Writing, and so on. Giving
each module its own `engine/` folder keeps them independent: styling or
logic changes to the Listening engine can't accidentally break Reading
once it exists. `catalogue/index.html` is the one page that knows about
all of them and routes `?module=Listening` → `engines/listening/...`.

## Quickstart

```bash
git clone <this-repo>
cd buye-ielts

npm install -g @google/clasp
clasp login

cp .clasp.json.example .clasp.json
# edit .clasp.json — paste in your Apps Script project's script ID
# (create one first with: clasp create --type webapp --title "BUYE IELTS Backend" --rootDir backend)

clasp push
```

Then follow `docs/README-SETUP.md` from **step 2 (First run)** onward —
running `bootstrapNewDatabase()`, setting Script Properties, deploying
the web app, and adding your first admin account.

For the frontend, open `frontend/catalogue/index.html` directly in a
browser (or serve the folder locally, e.g. `python3 -m http.server` from
inside `frontend/`) to check it renders before deploying it anywhere.
