# Account Recovery — Design

**Date:** 2026-10-04
**Status:** Draft, awaiting user review
**Branch:** feat/account-recovery (independent of PR #27)

## Purpose

wekintech.com is open to the public, but it has no way to recover a forgotten password or change one, so a locked-out user is stuck. This design adds:
- a self-service **forgot password** flow, using an emailed one-time link
- **change password** in Settings
- **email ownership verification**, because the email becomes the account recovery credential

It incorporates an external security review (rev 2) and these user decisions:
- 15-character minimum for new passwords
- new and changed emails must be verified; emails already on file are trusted

## Decisions
- **Users:** public.
- **Email:** required at signup and verified before use. Existing emails are trusted; it's the same address alerts already reach.
- **Recovery:** a one-time emailed link; only the token's hash is stored.
- **Shared emails:** allowed. Accepted risk: whoever holds a mailbox can recover every account that uses it.
- **New passwords:** **15–64 characters and ≤ 72 bytes in UTF-8** (bcrypt's limit). Longer passwords are rejected, never silently truncated. This applies to register, reset and change. Login is unchanged, so existing shorter passwords keep working. bcrypt cost stays 10.

## Data (`initDb()` in `src/db.ts`, idempotent like today)
- **New columns on `users`:**
  - `email_verified_at TIMESTAMPTZ`: added with `DEFAULT now()` so **existing rows are grandfathered**, then `ALTER COLUMN … DROP DEFAULT` so new rows start unverified. Both statements are safe to re-run.
  - `session_version INTEGER NOT NULL DEFAULT 0`.
- **A verified email** means `notification_email IS NOT NULL AND email_verified_at IS NOT NULL`. Any change to `notification_email` sets `email_verified_at = NULL`, except when it's set through confirmation.
- **New table:**
  ```
  account_tokens(
    token_hash TEXT PRIMARY KEY,         -- sha256(token); token = randomBytes(32) base64url
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('reset','verify_email')),
    email      TEXT NOT NULL,            -- destination address (for verify: the address being verified)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,     -- reset: 30 min; verify_email: 24 h
    used_at    TIMESTAMPTZ               -- consumed OR invalidated
  )
  ```
  Rows stay for 24 hours, so the per-account and per-address throttles can count them. The startup cleanup deletes rows older than 24 hours, alongside the `login_attempts` cleanup.

## Concurrency rules
- **Claiming a token** is one atomic statement inside the transaction:
  `UPDATE account_tokens SET used_at = now() WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email`.
  Zero rows means expired or used. Two simultaneous submissions can't both succeed.
- **Reset:** in one transaction:
  1. claim the token
  2. `SELECT … FROM users WHERE id=$1 FOR UPDATE`
  3. update `password_hash`
  4. `session_version = session_version + 1`
  5. invalidate **all** of the user's other open `reset` tokens
  6. delete the user's session rows

  Any failure rolls everything back, and the token stays unused.
- **Issuing links:** in one transaction, take `SELECT … FOR UPDATE` on the user row, check the throttles, invalidate open tokens of the same purpose, then insert a new one. Two concurrent requests leave at most one valid link.
- **Change password:** in one transaction, take `FOR UPDATE` on the user, verify the current password against the locked row's hash, update the hash, bump `session_version`, and invalidate **all** open reset tokens. After the commit, regenerate the current session (new session ID, new version) so this browser stays logged in. Other sessions die through the version check.
- **Confirming an email change:** claim the `verify_email` token, set `notification_email = token.email` and `email_verified_at = now()`, and invalidate open reset tokens. The old address gets an "email changed" notice.

## Session revocation
- At login and registration, the session stores `sv = users.session_version`.
- The authenticated-route checks (`requireAuth`, `/api/auth/me` and `/api/settings/*`) load the user's `session_version`. A mismatch destroys the session and returns 401.
- This defeats the express-session race where an in-flight request re-saves a session row that was just deleted. Deleting rows is just cleanup.
- **Sessions created before this ships** have no `sv`; they are treated as version 0, matching every existing user's `session_version` of 0. So deploying doesn't log anyone out.

## Throttling
- **Per IP:** the existing `rateLimitAuth` (10 per 15 minutes) covers register, login, forgot, reset, resend-verification, change password, and change email. When exceeded, it returns **429**, the one documented exception to the generic response. On the password routes, the check runs before any bcrypt work.
- **Per account:** at most **3** reset emails per hour.
- **Per destination address:** at most **5** emails per hour, verify and reset combined.
- **A per-account or per-address throttle hit** returns the same generic 200, issues no token, sends no email, and doesn't invalidate earlier links.

## Endpoints (`src/server.ts`)
New auth and settings mutations require `Content-Type: application/json` (415 otherwise). Together with the existing `SameSite=Strict` session cookie, this is the CSRF protection, and the spec says so.
- `POST /api/auth/register {username, email, password}` creates the user with an unverified email and sends a verification link.
- `POST /api/auth/forgot {identifier}` matches username or *verified* email, case-insensitive. A username match sends only if that account has a verified email; otherwise nothing is sent. Each match gets its own link. It always returns 200 with "If an account matches, we've sent a reset link to its email."
- `POST /api/auth/reset {token, password}` returns 200, or 400 "This link has expired or was already used." After the commit it sends a "password changed" notice.
- `POST /api/auth/verify-email {token}` returns 200 or 400 (expired/used).
- `POST /api/settings/resend-verification` sends a new verification link (throttled).
- `PATCH /api/settings/password {currentPassword, newPassword}` returns 200, or 400 for a wrong current password or a rule failure. After the commit it sends a "password changed" notice.
- `PATCH /api/settings/email {email, currentPassword}` (changed: now requires the password) keeps the current email active and sends a verification link to the new address. Alerts and resets keep using the old verified address until the new one is confirmed.

## Service (`src/services/account-recovery.ts`, no Express)
- **Store and mailer are injected** (the `createMarketDirectionService` pattern).
- **Functions:**
  - `validateNewPassword()`
  - `requestReset()`
  - `resetPassword()`
  - `changePassword()`
  - `requestEmailVerification()`
  - `verifyEmail()`
- **Transactions:** the store interface exposes the transactional operations above, implemented in `src/db.ts`.

## Email (`src/services/email-sender.ts`, reusing `getTransporter()`, plain text)
- **Message types:** password-reset link, email-verification link, "your password was changed" (with "if this wasn't you, use Forgot password"), and "your account email was changed" (sent to the old address).
- **Links:** `APP_URL/#reset=<token>` and `APP_URL/#verify=<token>`. Tokens live in the URL **fragment**, which browsers never send to the server, so they can't reach Vercel request logs or the Referer header.
- **`APP_URL`:** required; the request Host header is never used.
- **Missing `APP_URL` or SMTP in production:** logs an error and sends nothing.
- **Local development:** printing links to the console needs **both** `NODE_ENV !== "production"` and `DEV_LOG_EMAIL_LINKS=1`.
- **Never logged:** tokens appear in no logs or errors.

## Alerts
`getEnabledAlerts()` returns the user's email only when it is verified (`email_verified_at IS NOT NULL`), otherwise null. So `notify()` skips email for that user and still sends SMS if it's configured. Existing users are unaffected, because they're grandfathered. New users get alert emails once they confirm, and the dashboard's email prompt says "Verify your email to receive alerts and password resets" with a resend button.

## Front end (`public/index.html`)
- **Order on page load:** handle `#reset=`/`#verify=` **before** the normal authentication check, so it works even if another account is logged in. Read the token into memory, then strip it with `history.replaceState`. Opening a link never uses it up; only submitting does, which protects against mail scanners that open links.
- **Reset form:** new password twice, with a live hint ("15+ characters; a passphrase works well").
  - **Refresh after stripping:** returns to the normal app; the link remains usable until it expires.
  - **Success:** shows the login screen with "Password updated, please log in."
- **Verify links:** the page's JavaScript posts the token automatically on load. Mail scanners that only fetch the page don't run that JavaScript, so they can't consume it. They're idempotent-safe; a used or expired link just shows a message.
- **Login screen:** a "Forgot password?" link that swaps in the forgot form.
- **Register form:** adds an Email field.
- **Settings:** the Change password card, plus email change with a current-password field and pending-verification status.
- Add `<meta name="referrer" content="no-referrer">` (defense in depth).

## Accepted, documented risks
- **Account enumeration by timing:** sending SMTP for real accounts makes those responses slower and more variable, especially with shared emails. Throttling slows probing but doesn't remove the difference.
- **Shared mailboxes:** whoever holds one can recover every account that uses it.

## Testing
- **Unit** (`tests/account-recovery.test.ts`, in-memory store and mailer):
  - password rules, including 15-character, 64-character and 72-byte multibyte edge cases
  - expiry and single use
  - only the hash stored
  - unknown or unverified identifier: nothing sent
  - shared email: one link per account
  - per-account and per-address throttles don't rotate tokens
  - wrong current password
  - notices sent only after success
  - change email keeps the old address until verified
- **Database integration** (`tests/account-recovery.db.test.ts`): opt-in through `TEST_DATABASE_URL`, refuses any non-localhost host, uses unique users with cleanup, and is not in the default `npm test`. Cases:
  - two simultaneous `resetPassword` calls with one token: exactly one succeeds
  - concurrent `requestReset`: exactly one valid token
  - an injected failure mid-reset rolls back and leaves the token unused
  - an old reset link fails after a Settings password change or an email confirmation
  - re-saving a stale session after revocation can't authenticate (version check)
  - `email_verified_at` grandfathering stays correct after re-running `initDb()`
- **Manual:** local server with `DEV_LOG_EMAIL_LINKS=1`, two browsers (one is logged out by a reset or change, the other keeps its session); then the Vercel preview with `APP_URL` set for Preview.
- **Docs:** `.env.example` (`APP_URL`, `DEV_LOG_EMAIL_LINKS`), and CLAUDE.md (auth section, new table and columns, endpoints, the verified-email rule for alerts).
