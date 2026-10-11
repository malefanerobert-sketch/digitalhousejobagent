# Current scope: South Africa only
- Adzuna is forced to `/v1/api/jobs/za/search`; stale US configuration cannot switch it back. Nationwide discovery is not restricted to one city.
- New automatic and watched-page saves must pass the ZA country gate. US/foreign jobs are excluded; worldwide alone is not ZA evidence. Verified native ZA boards and the ZA Adzuna endpoint can provide country context for incomplete location labels.
- PNet, Careers24, CareerJunction, Executive Placements and Capitec Bank watched sources are reactivated in the database. Job Mail automatic discovery is restored. RemoteOK country metadata is ZA, with its previous disabled status preserved.
- The entire configured global/US ATS company pool is frozen: it is not appended to active sources, and the ATS dispatch branch also skips it. Board configuration is retained, not removed.
- Existing saved international discoveries/history are retained. No match deletion, application or automatic requeue is performed by this change.
- User discovery labels/options return to South African metros and nine provinces. Previously saved preferences and archive locations remain visible for review.
- Applications remain admin-only; Railway schedules only discovery.
- Run `node test-za-scope.js` and `node test-admin-workflow.js`. Tests use local fixtures/mocked requests, not real employer applications.
