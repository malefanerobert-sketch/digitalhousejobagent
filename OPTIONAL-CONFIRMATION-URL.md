# Optional admin confirmation URL

Review & apply no longer displays an employer/confirmation URL field. Saving a successful admin outcome sends a null URL and still requires the completion checkbox and a description of the actual employer confirmation. Non-success outcomes still require notes.

The user job viewer no longer shows an Open confirmation page link, including for older saved records. Application completed date, confirmation text, reference and answers remain at the bottom of View job. Existing URLs and history are not deleted.

Apply migration_optional_admin_confirmation_url.sql alongside the HTML update. The security-definer RPC still checks admin permission, updates completion and its log atomically, and prevents duplicate completion or overwriting completed jobs with failures. Optional URL validation remains for compatible older clients.

Tests: test-admin-workflow.js, test-merged-job-view.js, test-live-refresh.js passed; test_optional_confirmation_database.sql succeeded in a rolled-back transaction without changing real application outcomes.
