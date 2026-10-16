# Staff troubleshooting: Open user app

## Workflow

In Admin → Accounts, every account now has an **Open user app** link card. It opens `index.html?support=<seeker UUID>` in the same tab, retaining tab-only staff sessions as well as persistent sessions. The selected account opens on Matches, with existing dashboard, skipped/applied matches, profile, documents, block-list and contact-thread navigation. A persistent banner identifies the target and provides Return to admin.

This is **not impersonation**, a magic sign-in link or a password bypass. Staff remain authenticated as themselves. The target UUID is a selector, not a credential. No user password, service-role key or auth/session token is put in a link or returned by the support RPC.

Only users already present in `dispatch_admins` may open the support context. If a staff session has expired, the link returns them to admin sign-in and resumes the selected account after an explicit membership check. An ordinary applicant who can read their own profile is not thereby considered an admin.

## Read-only behavior

The support view disables profile saves, uploads/removals, application requests/deletions, block-list changes, contact sends/deletions and bulk actions. Function guards, capture-phase UI guards and a read-only client wrapper prevent the app's write paths. Viewing contact messages does not mark them read as the applicant; staff inspection also does not change the normal app's dismissed-card preferences. Job View, filtering, navigation, downloads and scoped match refresh remain available.

These app safeguards prevent accidental edits. They do **not** remove a staff member's existing administrative powers in the separate admin app, nor replace database authorization/RLS. All actual database reads still use the staff JWT and existing admin SELECT policies. A SELECT-only admin document policy supplies the previously owner-only document list; no new applicant-write policy or service credential is added.

## Server authorization and audit

Apply `migration_staff_support_access.sql` before publishing the HTML/helper. `admin_open_user_support` explicitly verifies `auth.uid()` against `dispatch_admins`, validates the account exists and logs staff ID, seeker ID, time and read-only mode in `admin_user_support_access_log`. It returns the target profile with `api_key`, `ai_api_key` and raw `resume_text` removed. The initial open and subsequent profile reloads are audited; periodic match refresh does not create repeated access entries.

Anonymous execution is revoked. Signed-in non-admins are rejected. Browsers cannot insert, update or delete audit entries directly. Only authorized admins can read them. The function neither creates nor changes an Auth session and cannot sign in as an applicant.

## Validation and deployment limits

`node test-staff-support.js` runs real applicant-page JavaScript offline in Chromium with fake Supabase. It covers persistent/tab-only staff sessions, unchanged staff identity, target isolation, real detail view, profile/documents/contact navigation, no contact read receipts, disabled controls, direct/delegated/client write blocking, live refresh, expired/no-session/non-admin/invalid-link denial, normal applicant flow and membership-gated admin return routing. It also checks the account link is scoped and token-free.

The existing lightweight queue regression suite passes against the updated admin HTML. Full job-detail rendering and existing match/application fetch code remain byte-for-byte unchanged.

Database tests ran in a rolled-back transaction: authorized admission, identity preservation, profile-secret redaction, audit creation, unknown-target rejection, anonymous/non-admin denial, audit immutability and real target match reads under the authenticated role all passed. No test access entries or user-record updates were retained.

Publishing the files does not by itself prove authenticated production navigation on a staff device. Validate the served page after GitHub Pages deployment. Staff must already have approved admin access; this update does not grant anyone a new role.
