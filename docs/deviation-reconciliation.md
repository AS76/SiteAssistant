# Deviation timeline reconciliation

Reconciliation lists anomalies without changing dates, statuses or records. It requires no migrations or new dependencies.

`GET /api/deviations/reconciliation?site_id=<uuid>` requires a site member
(owner, editor, verifier or viewer) with access to the `deviations` module.
It returns `counts` and `items`. Each item contains `kind`,
`id`, `deviation_no`, `title`, `official_status` and `disagreement_days`.
Counts measure findings. The list covers the entire site,
regardless of pagination or filters in the main view.

The two counts are `closed_without_date` (`closed` status without `closed_date`)
and `close_before_approval` (`closed_date` earlier than `approved_date`).
Equal dates are valid. A distance that cannot be calculated remains `null`.
Instants are compared preserving microseconds; no time zone is assigned to
timestamps that lack one. Distance is absolute, in 24-hour days.

Comparison with an internal status has been retired: deviations are an import projection.
There is no internal status-change path, either API or interface, so there is no internal status to compare.

The view shows a collapsible panel with two count filters and access to the
existing detail. If there are no findings, it states that the
timelines are aligned. The report exposes the same result in the `reconciliation` property;
print output shows the counts
and the first 10 findings, ordered by deviation number and ID, with the reason.
The read-only note and the scope of official dates also appear in print output.

No new services were activated or changes applied to operational databases.
