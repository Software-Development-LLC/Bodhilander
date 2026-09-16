# Windows code signing (Azure Trusted Signing)

Unsigned Windows builds are blocked by **Smart App Control** (a Windows 11
clean-install feature) and warned on by **SmartScreen** — and unlike the older
SmartScreen prompt, Smart App Control has **no "run anyway"** button. So a beta
that isn't signed can't be installed by testers on a fresh Windows 11 machine.

We sign with **Azure Trusted Signing**: ~$10/month, cloud-based (no hardware
token), it plugs into the existing GitHub Actions release, and it carries good
Smart App Control / SmartScreen standing because Microsoft runs the service.

The build is wired so signing is **optional and automatic**: `release.yml` signs
the Windows build only when the credentials below are present, and otherwise
produces the same unsigned build as before. Nothing here affects a local
`bun run pack` or a dev run.

---

## One-time setup (you do this in Azure + GitHub)

### 1. Create the Trusted Signing resources in Azure
1. In the Azure portal, create a **Trusted Signing account** (search "Trusted
   Signing"). Pick the region closest to CI (e.g. East US).
2. **Verify your organization identity** under the account. This is the gate:
   it's automatic if your public domain is 3+ years old; otherwise you submit
   business documents and it takes a few days.
3. Create a **Certificate Profile** of type **Public Trust** under the account.
4. Note these four values — they are NOT secret:
   - **Endpoint** — the account's URI, e.g. `https://eus.codesigning.azure.net/`
   - **Account name** — the Trusted Signing account name
   - **Certificate profile name**
   - **Publisher name** — the verified org name exactly as it appears on the
     certificate subject (`CN=...`)

### 2. Create a service principal CI can sign with
1. Create an **App registration** (Microsoft Entra ID) → add a **client secret**.
2. On the Trusted Signing account (or certificate profile), assign that app the
   **Trusted Signing Certificate Profile Signer** role (Access control / IAM →
   Add role assignment).
3. Note the **Tenant ID**, **Client ID**, and the **client secret value** — these
   ARE secret.

### 3. Add them to the GitHub repo
Repo → Settings → Secrets and variables → Actions.

**Secrets** (masked):
| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | the app's directory (tenant) id |
| `AZURE_CLIENT_ID` | the app registration's client id |
| `AZURE_CLIENT_SECRET` | the client secret value |

**Variables** (not secret — the four identifiers from step 1.4):
| Variable | Value |
|---|---|
| `AZURE_CODE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
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
(electron-builder 26's native Azure Trusted Signing support reads those). It
downloads Microsoft's signing client itself; RFC3161 timestamping is on by
default, so signatures stay valid after the certificate rotates.

## Testing it end to end

Use the workflow's **dry run** (Actions → Build and Release → Run workflow →
`dry_run: true`). It exercises the whole pipeline and publishes a **draft**
release (no git tag, invisible to auto-updaters) so you can download the `.exe`,
check its Digital Signatures tab (Properties → Digital Signatures shows the
Trusted Signing certificate), and confirm a fresh Windows 11 install is no longer
blocked. Delete the draft afterwards.

## Notes
- **Reputation:** Trusted Signing carries Microsoft-run standing, so Smart App
  Control acceptance is far better than a fresh OV certificate (which has to earn
  reputation over many installs). If a brand-new signed build is still briefly
  warned on, that clears as installs accumulate.
- **macOS** is already signed + notarized via the `MAC_CERTS` / `APPLE_*`
  secrets; this is the Windows equivalent and is independent of it.
- **Local builds** (`bun run pack`, `bun run dist:win` on a dev machine) stay
  unsigned — signing runs only in the release workflow.
