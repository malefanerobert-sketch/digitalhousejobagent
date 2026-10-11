# Separate discovered and skipped views

All saved records remain in the underlying match archive until deleted by the user.

- Discovered matches excludes jobs currently classified as skipped.
- Skipped by agent contains those skipped records, including skipped jobs queued for admin handling.
- Sidebar/mobile badges and dashboard counts use the same classification. Search and location filters apply within each view.
- A completed application leaves the skipped classification and remains available in Applied matches and the saved discovery archive.
- This is a display/classification change only: no original discovery timestamps, stored matches or application outcomes are removed.

Run node test-separated-matches.js and node test-admin-workflow.js.
