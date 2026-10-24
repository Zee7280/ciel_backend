# University SSO (students) — engineering notes

Module: `src/university-sso/`. Students of an approved university sign in with their university
account (OpenID Connect: Google Workspace, Microsoft 365, or any OIDC provider). V2.3 scope: no
SAML, no roster sync, no new roles; faculty and staff keep password sign-in.

## Switches

| Level | Where | Default |
| --- | --- | --- |
| Platform | Admin → Settings → `UNIVERSITY_SSO_ENABLED` | off |
| University | `PUT /admin/university-sso/:organizationId` then `POST …/activate` | no row = off |

Both must be on before `GET /auth/sso/universities` lists a university or `GET /auth/sso/start`
accepts it. Password login is never affected.

## Data

- `university_sso` (one row per university organization): provider, issuer / tenant, client id,
  client secret (AES-256-GCM at rest, `select: false`), allowed email domains, status
  (`draft` → `active` → `disabled`), activation and last-test metadata, sign-in counter.
- `sso_login_tickets`: hash of the one-time ticket the callback hands to the browser; 2-minute
  expiry, single use, swept on exchange.
- `users.ssoIssuer`, `users.ssoSubject` (nullable; unique together): the linked identity. A
  subject may belong to one account only, which is the duplicate-identity guard.

Core tables are created by TypeORM `synchronize` on deploy; take a database snapshot first.

## Flow

1. `GET /auth/sso/start?university=<orgId>[&next=/path][&mobile=1]` → 302 to the provider with
   PKCE (S256), a nonce and a sealed `state` (AES-GCM, 10 min) that carries the PKCE verifier.
2. Provider → `GET /auth/sso/callback?code&state` (API origin, see redirect URI below). The server
   exchanges the code (client secret + verifier), verifies the ID token against the provider's JWKS
   (RS256, issuer, audience, expiry, nonce), then applies the identity rules:
   - email present, in an approved domain; `email_verified` for Google / generic;
   - Google: `hd` must be an approved domain (Workspace account, not personal Gmail);
   - Microsoft: tenant pinned through the tenant-specific issuer; GUID tenant ids also checked
     against `tid`.
3. Account resolution, in order: existing `(issuer, subject)` → existing account by email (must be
   a student of this university by the shared affiliation rule; linked once) → no account: a sealed
   `signup` token (20 min) and the completion form.
4. Browser lands on `${FRONTEND_URL}/login/sso?ticket=…` (or `?signup=…`, `?test=ok`,
   `?error=<code>&message=…`). The frontend posts the ticket to `POST /auth/sso/exchange`, or the
   completion form to `POST /auth/sso/complete`, and receives the same `{ access_token, user }`
   as password login. Both paths run `AuthService.assertLoginAllowed` (suspended, pending,
   rejected and blocked accounts stay out) and `issueSession`.

Error codes on `/login/sso`: `invalid_state`, `idp_error`, `not_enabled`, `no_email`,
`domain_not_allowed`, `email_not_verified`, `not_workspace`, `wrong_tenant`, `not_student`,
`not_affiliated`, `identity_conflict`, `signup_closed`, `server_error`.

## Admin API (super admin, audited)

| Call | Purpose |
| --- | --- |
| `GET /admin/university-sso` | every configured university, platform switch, redirect URI |
| `GET /admin/university-sso/:orgId` | one university (or `sso: null`) |
| `PUT /admin/university-sso/:orgId` | create / update: `provider`, `issuer` (oidc), `tenantId` (microsoft required, google optional), `clientId`, `clientSecret` (omit to keep), `allowedDomains[]`. Reads the discovery document on save; changing provider, issuer, tenant or client id resets the test and drops an active row back to `draft` |
| `POST …/test-link` | 24-hour link the university's IT contact opens; a successful provider round trip records `lastTestOk` and issues no session |
| `POST …/activate` `{ skipTest?: boolean }` | requires a client secret and a passed test unless `skipTest` (audited) |
| `POST …/disable`, `DELETE …` | disable; remove a non-active configuration |

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `SSO_REDIRECT_BASE_URL` | recommended in production | API base the provider redirects to, e.g. `https://cielbackend-ecru.vercel.app/api/v1`; without it the request host is used (Vercel preview URLs vary, so register the stable one) |
| `SSO_SECRETS_KEY` | optional | 64-hex or passphrase for client secrets and sealed tokens; falls back to a key derived from `JWT_SECRET` |
| `FRONTEND_URL` | yes (already set) | where `/login/sso` lives |

Redirect URI to register at the provider: `<SSO_REDIRECT_BASE_URL>/auth/sso/callback`, shown on
every admin response as `redirectUri`.

## Provider setup (for the university's IT contact)

- Google Workspace: Google Cloud Console → OAuth client (Web application) → authorised redirect
  URI above. Provider `google`, optional `tenantId` = primary Workspace domain.
- Microsoft 365: Entra ID → App registration (single tenant) → Web redirect URI above → client
  secret. Provider `microsoft`, `tenantId` = directory (tenant) ID. `common` is refused.
- Other: provider `oidc`, `issuer` = the provider's issuer URL (its
  `/.well-known/openid-configuration` must resolve).

## Tests

- Unit: `src/university-sso/*.spec.ts` (ID-token verification, sealed tokens, domain rules).
- e2e: `test/university-sso.e2e-spec.ts` with `test/e2e/mock-oidc-provider.ts`, a local OpenID
  provider that enforces the client secret, PKCE and redirect URI.
