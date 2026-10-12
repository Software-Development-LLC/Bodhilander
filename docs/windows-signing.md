# Windows code signing (Azure Artifact Signing)

Unsigned Windows builds are blocked by **Smart App Control** (a Windows 11
clean-install feature) and warned on by **SmartScreen** — and unlike the older
SmartScreen prompt, Smart App Control has **no "run anyway"** button. So a beta
that isn't signed can't be installed by testers on a fresh Windows 11 machine.

We sign with **Azure Artifact Signing**: ~$10/month, cloud-based (no hardware
token), it plugs into the existing GitHub Actions release, and it carries good
Smart App Control / SmartScreen standing because Microsoft runs the service.

The build is wired so signing is **optional and automatic**: `release.yml` signs
the Windows build only when the credentials below are present, and otherwise
produces the same unsigned build as before. Nothing here affects a local
`bun run pack` or a dev run.

---

## One-time setup (you do this in Azure + GitHub)

> **Naming — "Trusted Signing" is now "Artifact Signing."** Azure renamed the
> service in 2026: the portal shows **Artifact Signing accounts**, and the roles
> read **Artifact Signing …**. The underlying resource provider is still
> **`Microsoft.CodeSigning`** and the endpoint domain is still
> `*.codesigning.azure.net`, so electron-builder's Azure support and every value
> below are unchanged — only the display names moved. The steps below use the
> new names.

### 1. Create the Artifact Signing account
1. **Register the provider first**, or the service won't appear in search:
   Subscriptions → your subscription → **Settings → Resource providers** → filter
   `CodeSigning` → select **Microsoft.CodeSigning** → **Register** (~1–2 min).
2. Top search → **Artifact Signing accounts** → **Create**: pick the subscription
   + a resource group, a memorable **account name** (→ `AZURE_CODE_SIGNING_ACCOUNT`),
   region **East US** (or nearest), tier **Basic** (~$10/mo).
3. On the account **Overview**, read the **Account URI** — the endpoint, e.g.
   `https://eus.codesigning.azure.net/` (→ `AZURE_CODE_SIGNING_ENDPOINT`).

### 2. Verify your identity (the gate on everything else)
Nothing else works until an identity validation shows **Completed**.
1. **Grant yourself the verifier role first** — even the subscription Owner does
   not get it automatically: account → **Access control (IAM)** → **Add role
   assignment** → role **Artifact Signing Identity Verifier** → assign to your own
   user → **wait ~5 min** to propagate. Without it the validation form is blocked.
2. Account → **Identity validations** → **+ New**:
   - **Organization (Public Trust)** — publisher = your company's legal name; most
     professional; needs a registered business; minutes to ~5 business days.
   - **Individual (Public Trust)** — publisher = your personal legal name; faster;
     use if there's no registered entity yet.
3. **Individual gotcha (address match):** Azure cross-checks your government ID
   against the billing account's **"Sold to"** address — they must match. That
   "Sold to" field (Cost Management + Billing → billing account → **Properties**,
   or account.microsoft.com) is *separate* from the "billing"/"shipping" addresses,
   and a change to it takes **several hours** to propagate to the validation form.
   If the New-validation dropdown keeps auto-filling a stale/wrong address after
   you fix the Sold-to field, wait a few hours and retry — or switch to
   Organization, which validates the company and sidesteps the personal-ID match.

### 3. Create a certificate profile
Once identity validation is **Completed**: account → **Certificate profiles** →
**Create** → type **Public Trust**, linked to the completed validation. Note:
   - the **profile name** → `AZURE_CODE_SIGNING_PROFILE`
   - the **validated name** on it (the cert `CN`) → `AZURE_PUBLISHER_NAME`

### 4. Create a service principal CI can sign with
1. Create an **App registration** (Microsoft Entra ID) → add a **client secret**.
2. On the Artifact Signing account (or certificate profile), assign that app the
   **Artifact Signing Certificate Profile Signer** role (Access control / IAM →
   Add role assignment).
3. Note the **Tenant ID**, **Client ID**, and the **client secret value** — these
   ARE secret.

### 5. Add them to the GitHub repo
Repo → Settings → Secrets and variables → Actions.

**Secrets** (masked):
| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | the app's directory (tenant) id |
| `AZURE_CLIENT_ID` | the app registration's client id |
| `AZURE_CLIENT_SECRET` | the client secret value |

**Variables** (not secret — the identifiers from steps 1 and 3):
| Variable | Value |
|---|---|
| `AZURE_CODE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_CODE_SIGNING_PROFILE` | certificate profile name |
| `AZURE_PUBLISHER_NAME` | the verified org / cert subject name (optional) |

That's it. The next release build signs the Windows installer automatically.
`release.yml` gates on `AZURE_CLIENT_ID` + the three identifiers being present;
if any is missing it logs a warning and builds unsigned (no failed release).

---

## How it works in the build

`electron-builder.yml` declares **no** signing — signing is injected only at
release time. `release.yml`'s "Build distributables (Windows)" step passes the
identifiers as `-c.win.azureSignOptions.*` overrides and the credentials as the
standard `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` env vars
(electron-builder 26's native Azure Artifact Signing support reads those). It
downloads Microsoft's signing client itself; RFC3161 timestamping is on by
default, so signatures stay valid after the certificate rotates.

## Testing it end to end

Use the workflow's **dry run** (Actions → Build and Release → Run workflow →
`dry_run: true`). It exercises the whole pipeline and publishes a **draft**
release (no git tag, invisible to auto-updaters) so you can download the `.exe`,
check its Digital Signatures tab (Properties → Digital Signatures shows your
signing certificate, its subject being your publisher name), and confirm a fresh
Windows 11 install is no longer blocked. Delete the draft afterwards.

## Notes
- **Reputation:** Artifact Signing carries Microsoft-run standing, so Smart App
  Control acceptance is far better than a fresh OV certificate (which has to earn
  reputation over many installs). If a brand-new signed build is still briefly
  warned on, that clears as installs accumulate.
- **macOS** is already signed + notarized via the `MAC_CERTS` / `APPLE_*`
  secrets; this is the Windows equivalent and is independent of it.
- **Local builds** (`bun run pack`, `bun run dist:win` on a dev machine) stay
  unsigned — signing runs only in the release workflow.
