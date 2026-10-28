# The iPhone page

A read-only page for checking stock from home. Saved to the home screen it looks and opens like an
app, with no Apple Developer account, no App Store, and no yearly fee.

It answers the two questions that prompted it: **is there stock**, and **did today get entered**.

---

## What it shows

**Three tabs**, each with the accent colour the same view carries in the app, plus a bar pinned to
the bottom holding **Refresh** and when it last checked. It used to be one column with everything
stacked in it — so answering "is there stock" meant scrolling past a month of entries, and Refresh
sat underneath all of them.

Warnings sit above the tabs, visible from every one of them. The staleness warning in particular is
**above the numbers, not below them**: a stock count read at home while the clinic phone is behind is
wrong and reads as fact.

| Tab | Shows |
| --- | --- |
| **Today** (blue) | Doses given today and how long ago the last entry was · how many vaccines are low or out · **Needs attention**, only what is `CHECK`, `OUT` or `LOW`, most urgent first · **Devices**: last entry, last contact with the server, `UP TO DATE` or `BEHIND` |
| **Stock** (teal) | Every vaccine as a tile in a grid, alphabetical, doses on hand. The tab carries a count of what needs attention, so the reason to open it is visible from Today |
| **Entries** (slate) | The last 30 days grouped by day, or one picked day |

The grid **adds columns** as the screen widens — two on a phone, four or five on a laptop — rather
than stretching or shrinking the tiles. Same rule as the app: bound the text, not the grid.

Every figure comes from a Postgres view. **Nothing is calculated in the page**, including whether a
vaccine counts as low — that would be a second definition of "low", and the one that drifts would
still look authoritative.

## What it cannot do

Write anything. There is no write path in the code. Doses and deliveries are recorded only in the
app on the clinic devices.

---

## Deploying it

### 1. Config

Nothing to fill in by hand. `scripts/deploy-web.sh` generates `web/config.js` (project URL,
`sb_publishable_…` key, clinic email; **no password**, the page asks for that) from the EAS
environment variables, deploys, and deletes the file again.

`web/config.js` is **not** gitignored: a gitignore line changes the OTA fingerprint, so it was
removed. If you ever create it by hand (`cp web/config.example.js web/config.js`), never commit it
and delete it when you are done. The publishable key is safe in a web page, since `anon` is
`REVOKE`d from every table and view, so the key alone returns 401 for everything. But the repo is
public, and CLAUDE.md section 13 forbids committing anything that identifies the clinic.

### 2. Deploy it

**Live at https://clinic-stock.expo.app**

```sh
scripts/deploy-web.sh prod      # or `preview` to rehearse; it runs this command:
npx --yes eas-cli@23.2.0 deploy --export-dir web --prod --non-interactive --dev-domain clinic-stock
```

EAS Hosting, on the Expo account this project already uses — so there is **no new account to
create**. Cloudflare Pages, Netlify and Vercel all work too (it is plain HTML and JavaScript with no
build step), but Cloudflare needs a fresh email-and-password signup, and one fewer credential to
look after is worth more here than any difference between the hosts.

Re-run that same command after any change to `web/`. It is not covered by `eas update`, which ships
the phone app; this is a separate deployment.

### 3. Add it to the home screen

On the iPhone, open **https://clinic-stock.expo.app** in **Safari** → **Share** → **Add to Home
Screen**.

Safari specifically: Chrome on iOS cannot add a web app to the home screen.

### 4. Sign in once

Email is pre-filled; type the password. The session refreshes itself, so this is a one-time step
that survives for months.

---

## Notes worth keeping

**"Today" is the phone's own date**, matching how `local_date` is stamped when a dose is recorded.
Not the server's, which runs in UTC — a dose given at 8am IST would otherwise land on the wrong day.

**It needs internet**, unlike the app. That is fine: it exists for checking from outside the clinic.
The app itself never depends on this page or on the network.

**If it says the server is out of date**, re-run `supabase/schema.sql`. The page checks for the
`level` column and refuses to render rather than mark every vaccine as needing attention.

**Anyone with the URL still needs the password.** Row-level security scopes every row to the signed-in
clinic account, and that isolation is verified: a second account cannot see this clinic's rows,
through the tables or through the views.
