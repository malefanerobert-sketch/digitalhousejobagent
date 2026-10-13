# Job-details capture and source privacy

- Discovery tries the actual advert instead of accepting a feed snippet because it exceeds 300 characters.
- Structured job text and scoped page sections are copied without AI rewriting or a character cutoff. Embedded vacancy frames and read-more controls are supported. Adzuna’s `.adp-body`, split PNet-style advert sections, and separate JobPosting requirements/skills/salary fields are recognised. Source attribution, navigation and application-contact clutter are omitted from the applicant view; duties, qualifications, personal attributes and required supporting documents remain.
- Actual vacancy links can be followed privately (up to three pages), with title/employer checks on subsequent pages. No application forms are submitted.
- If full extraction fails, an available feed/page summary remains visible, explicitly labelled Available job summary. This never changes eligibility or application queue gates.
- Known sourcing platform names, URLs, domains and aggregation fingerprints are filtered from displayed job text, including legacy descriptions. Hiring employers remain visible.
- Source URLs and routing fields remain in backend/admin records; this is applicant-facing display filtering, not a new column-level authorization policy.
- Saved records receive a bounded retry pass (8 per discovery run, unsuccessful retries no sooner than 6 hours). Tracking-only URL parameters do not create duplicate extraction work. The retry pass selects up to eight distinct advert URLs and refreshes saved copies sharing the exact source URL, instead of spending the entire pass on eight applicants’ copies of one advert. Only description and description-check metadata are updated; discovery dates, status and counts are preserved.
- Retrieval may still fail for expired adverts, sign-in walls, inaccessible pages or source snippets with no original link. No missing content is invented.
- captured means the available posting text was retrieved from its scoped advert container, not an independent guarantee that the publisher provided every requirement.

Run node test-job-details.js for long-text, original-link, privacy, summary fallback, safe rendering and existing-record repair regressions.

The viewer recognises Purpose, Key Performance Areas, Desired Experience & Qualification, and Job Related Personal Attributes. It retains role overview, employment type and closing date when supplied. When an advert has no section headings, the complete available text is displayed as Job details, not cut to a preview. Short summaries remain available when retrieval genuinely fails.

Also run node test-job-detail-containers.js and node test-scoped-details.js.
