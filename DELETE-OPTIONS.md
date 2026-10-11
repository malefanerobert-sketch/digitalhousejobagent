# Delete options

These controls remove selected entries from a view, rather than destroying original jobs or employer receipts.

- Admin queue: Delete calls admin_delete_queue_match for one match ID and sets admin_queue_deleted_at. All admin queue filters omit removed work. Other applicants and the applicant archive are unaffected. An explicit later Request Apply reopens eligible removed work; completed jobs still cannot be requeued.
- Applied matches: Delete calls user_delete_applied_match and sets user_applied_deleted_at for one completed job owned by the signed-in applicant. All displayed duplicate logs for that job disappear from the user’s applied list and its count. Actual receipts, completed status and Discovered records remain to prevent unintended duplicate applications.
- Both controls ask for confirmation and require server-confirmed success. Permission failures leave rows visible. Direct applicant changes to the admin-removal flag are blocked.
- The retained application runner excludes admin-removed work; automatic applications remain disabled.

Tests: node test-delete-options.js; node test-admin-workflow.js; rollback-only test_delete_options_database.sql. The current workspace has one authenticated account; SQL tests simulate its non-admin role only inside a rolled-back transaction. Four-user row isolation is tested with local mocked data. No live jobs, application receipts or admin memberships are removed during tests.
