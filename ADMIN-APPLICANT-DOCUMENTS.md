# Admin applicant documents

Release: admin-documents-v1

## Usage
Application queue → choose account → Review / apply manually → Applicant documents.
The section lists the CV and supporting documents for that application’s applicant. Open and Download use refreshed, one-hour signed links for private Supabase files. Refresh links renews links without losing outcome form input. Legacy external HTTPS links are retained as Open / download links.

Only attach files requested by the employer. Signed links are bearer links: keep them private. Admin membership removal prevents new authorized signing but does not revoke links already issued before expiry.

## Security and performance
- Staff sign in with their own authorized admin account, without applicant passwords or impersonation.
- Document metadata and private-file signing occur only when opening a review, not in the account summary or account job-list load.
- Metadata is scoped to the opened applicant ID, with capped-page pagination.
- Supabase file locations must match the expected resumes/documents bucket and applicant auth-user folder. Wrong-owner paths, unsupported schemes, and traversal paths are rejected by the UI. Storage policies provide the actual authorization boundary.
- UI never adds write/delete access to files, exposes service keys, or makes buckets public.
- Detail/account mismatches, closed modals and switched accounts cannot display late document responses.
- Missing CVs, empty supporting files, metadata failures and individual signing failures have explicit states; valid CV links remain usable when supporting metadata fails.
- Sign-out clears the review and its document links.

## Database dependency
The project owner separately applied migration `admin_read_applicant_files_storage` version `20261016194402`. Its SELECT-only policy `dispatch admins can read applicant files` authorizes authenticated `dispatch_admins` members to read resumes/documents objects. Both buckets remain private. This release does not apply or duplicate that migration.

## Regression tests
Build the exact Pages allowlisted `_site` artifact, then run:

```sh
node validatePagesBuild.js _site
PUBLIC_SITE_DIR="$PWD/_site" node test-lazy-queue.js
PUBLIC_SITE_DIR="$PWD/_site" node test-application-documents.js
PUBLIC_SITE_DIR="$PWD/_site" node test-staff-support.js
PUBLIC_SITE_DIR="$PWD/_site" node test-application-credits.js
```

Tests use local browser fixtures and mock network responses, not real private files or live writes. Document tests exercise desktop/390px/320px layouts, scoped lazy reads, refreshed Open/Download links, expiry, path validation, filename escaping, errors/retries, empty states, capped pagination and stale responses. Existing credit/sparks and staff-support behavior is retained.

## Required live acceptance check
An authorized staff member should sign in, open an applicant review containing an uploaded CV and supporting file, and try Open / Download / Refresh links. Offline tests validate the UI signing integration, but do not call the live Storage signing API as a staff member. No signed URLs or private file contents should be copied into bug reports.

## Deployment
The public Pages artifact still contains only index.html, admin.html, supportAccess.js, .nojekyll and build.json. No private tests, backend files, credentials or this document are uploaded to the public site. User-app functional changes from application-credits-v7 are preserved; only its release identifiers/routes are updated.
