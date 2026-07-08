# ChromaBay — Domain, Auth email, iOS deep-links, TestFlight

Concrete steps for the external config that can't be done from the repo. Known values:

| Thing | Value |
|---|---|
| GitHub repo | `hobzcalvin/chromabay` (Pages branch `gh-pages`, dir `docs/`) |
| Current web URL | `https://hobzcalvin.github.io/chromabay` |
| Custom domain | `chromabay.app` |
| Supabase project | ref `cwyypvhyrkaalagvjebp` → `https://cwyypvhyrkaalagvjebp.supabase.co` |
| Apple Team ID | `68683H96V7` |
| iOS bundle id | `com.revoltlabs.chromabay` |

---

## 1. Custom domain `chromabay.app` (Namecheap → GitHub Pages)

### 1a. Namecheap DNS
Namecheap → **Domain List** → `chromabay.app` → **Manage** → **Advanced DNS**. Delete the
default "parking"/CNAME records, then add **Host Records**:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `185.199.108.153` | Automatic |
| A Record | `@` | `185.199.109.153` | Automatic |
| A Record | `@` | `185.199.110.153` | Automatic |
| A Record | `@` | `185.199.111.153` | Automatic |
| CNAME Record | `www` | `hobzcalvin.github.io.` | Automatic |

(The four A records are GitHub Pages' apex IPs. `www` CNAMEs to the Pages host.)
Save. DNS can take 30 min–24 h to propagate; check with
`dig chromabay.app +short` (should list the four IPs).

**Goal: `chromabay.app` canonical, `www.chromabay.app` → redirects to it.** That's what
this setup produces. The `www` CNAME does **not** make `www` primary — it only makes `www`
*resolve* so GitHub can catch the request and 301-redirect it to the apex. The direction is
decided in §1b by which domain you enter as the Pages custom domain (enter the apex). Keep
the `www` record; without it, `www.chromabay.app` would fail to resolve instead of
redirecting.

### 1b. GitHub Pages
Repo → **Settings → Pages** → **Custom domain** → enter **`chromabay.app`** (the apex, NOT
`www.chromabay.app` — entering the apex is what makes it canonical and makes `www` redirect
*to* it) → **Save**. Wait for the green "DNS check successful", then tick **Enforce HTTPS**
(may take an hour for the cert; GitHub issues certs for both apex and `www`). GitHub writes
a `CNAME` file to `gh-pages`.

### 1c. Repo cutover (do this AFTER 1a/1b are green — I can apply it in one commit)
Two changes are needed so the site serves at the domain root instead of `/chromabay`:
- `svelte.config.js`: build the Pages bundle with **no base path** (`base: ''`).
- `.github/workflows/deploy.yml`: write `chromabay.app` into `docs/CNAME` on every deploy
  (otherwise the Pages deploy wipes the custom domain each run).

⚠️ Don't do 1c before DNS resolves — it makes the old `…github.io/chromabay` URL stop
working immediately. The **iOS app is unaffected** (it hot-updates from a separate
root-base bundle). Ping me and I'll apply 1c.

---

## 2. Supabase auth URLs (fixes the `localhost:3000` confirm link)

Supabase dashboard → project `chromabay` → **Authentication → URL Configuration**:
- **Site URL**: `https://chromabay.app`  *(use `https://hobzcalvin.github.io/chromabay`
  until the domain is live)*
- **Redirect URLs** (add all): 
  - `https://chromabay.app/account`
  - `https://chromabay.app/*`
  - `http://localhost:5173/account` (local dev)
  - `capacitor://localhost/*` and `chromabay://*` (native app — see §4)

The app already sends `emailRedirectTo` = current-origin `/account`; these must be
allowlisted or Supabase ignores them and falls back to Site URL.

---

## 3. Custom-branding the confirmation email

By default the email is from `noreply@mail.app.supabase.io` (rate-limited ~3–4/hr).

- **Wording/branding**: Dashboard → **Authentication → Email Templates → Confirm signup**.
  Edit subject/body HTML (add the ChromaBay name/logo). Keep the `{{ .ConfirmationURL }}`
  token.
- **Custom SMTP via Google Workspace SMTP relay** (chosen — uses the existing Workspace on
  `revoltlabs.co`, whose SPF/DKIM are already set, so no extra DNS; moves email off Supabase's
  shared pool → fixes the bounce warning + the ~4/hr rate limit). Steps:

  **A. Google Admin (admin.google.com):** Apps → Google Workspace → Gmail → **Routing** →
  **SMTP relay service** → Add:
    - Allowed senders: **Only addresses in my domains**
    - **Require SMTP Authentication** ✔ and **Require TLS encryption** ✔
      (don't use IP allowlisting — Supabase's sending IPs aren't fixed)
    - Save (can take minutes–hours to apply).
    - Add `noreply@revoltlabs.co` as an alias on an existing user (Directory → Users → user →
      Alternate emails) so the From address is a valid in-domain address.

  **B. App Password** (for the relay to authenticate): pick a Workspace user (yourself or a
  dedicated `relay@revoltlabs.co`), turn on **2-Step Verification**, then Google Account →
  Security → **App passwords** → create one ("Mail" / "Supabase") → copy the 16 chars.

  **C. Supabase → Authentication → SMTP Settings → enable custom SMTP:**
    - Host `smtp-relay.gmail.com`, Port `587`
    - Username: the authenticating Workspace email (e.g. `relay@revoltlabs.co`)
    - Password: the App Password
    - Sender email `noreply@revoltlabs.co`, Sender name `ChromaBay`
    - Save, send a test (or trigger a password reset to yourself).

  Later, to send from `@chromabay.app` instead, add it as a Workspace domain alias and set up
  its SPF/DKIM; until then `revoltlabs.co` sends immediately.

Immediate stopgap (before SMTP is live): **Authentication → Providers → Email** → toggle
**Confirm email OFF** so no emails send at all (zero bounces). Turn back on after SMTP works.

---

## 4. iOS deep-links (confirm link opens the app, not just the browser)

Universal Links let `https://chromabay.app/account…` open the installed app. The AASA file
is already in the repo (`static/.well-known/apple-app-site-association`, using Team ID
`68683H96V7`); it serves at `https://chromabay.app/.well-known/apple-app-site-association`
once §1 is live.

In Xcode (`ios/App/App.xcworkspace`):
1. Select the **App** target → **Signing & Capabilities** → **+ Capability** →
   **Associated Domains**.
2. Add: `applinks:chromabay.app`
3. (Optional custom scheme fallback) Add a URL Type with scheme `chromabay` under **Info →
   URL Types**.

Capacitor already forwards `appUrlOpen`; a small handler on the `/account` route can read
the confirmation tokens from the opened URL if needed, but Supabase's `detectSessionInUrl`
usually handles it when the app loads the redirected page.

After §1 + this, set Supabase **Site URL** to `https://chromabay.app` so confirm emails
deep-link into the app.

---

## 5. TestFlight / App Store

You already have a signing team (`68683H96V7`), bundle `com.revoltlabs.chromabay`, and app
icons — most of the hard setup is done.

### 5a. One-time, in App Store Connect (appstoreconnect.apple.com)
1. **My Apps → + → New App**: platform iOS, name **ChromaBay**, primary language, bundle id
   `com.revoltlabs.chromabay` (register it under Certificates/Identifiers first if the
   dropdown is empty), SKU `chromabay`.
2. Fill the minimum: category, privacy policy URL (host one at `chromabay.app/privacy`),
   and the **App Privacy** questionnaire (declare: BLE, and Sentry/analytics + Supabase
   account email → "Contact Info: Email", "Diagnostics").

### 5b. Build + upload (each release)
```bash
npm run build            # web assets
npx cap sync ios         # copy into the iOS project
npx cap open ios         # opens Xcode
```
In Xcode:
1. Bump **General → Identity → Version** (e.g. `1.0.0`) and **Build** (increment every
   upload — currently `1`).
2. Toolbar device selector → **Any iOS Device (arm64)**.
3. **Product → Archive**. When the Organizer opens → **Distribute App → App Store Connect →
   Upload**. Automatic signing with team `68683H96V7` handles certs/profiles.
4. Wait ~5–15 min for processing (you'll get an email), then App Store Connect →
   **TestFlight** → the build appears → add yourself/testers to **Internal Testing** → they
   install via the TestFlight app.

### 5c. Going to the App Store (later)
From TestFlight, **Submit for Review**: needs screenshots (6.7" + 6.1"), description,
keywords, support URL, and the privacy policy. BLE apps must explain in review notes what
the LEDs/Bluetooth do (mention it controls the user's own ESP32 LED controllers).

### Nice-to-have automation
`fastlane` can script 5b (`fastlane pilot upload`) once you create an
App-Store-Connect API key — worth it after the first manual upload works.

---

## Order of operations (recommended)
1. §2 (Supabase URLs) + §3 "Confirm email OFF" — makes login usable *today*.
2. §1a/§1b (DNS + Pages) → tell me → §1c (repo cutover).
3. §3 custom SMTP + §4 deep-links once the domain is live.
4. §5 TestFlight — can be done in parallel; doesn't depend on the domain.
