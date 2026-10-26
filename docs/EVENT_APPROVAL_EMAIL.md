Event approval emails use the existing Carrot YeboLink workspace credentials.
Submission recipients are active superadmin vendor accounts with email addresses.
Approval recipients are the event's organiser email address. Missing addresses
are surfaced as notification failures; the event transition is preserved.

Links use https://manage.carrottickets.com/events/:id. Non-production deployments
can set EVENT_APPROVAL_DASHBOARD_URL to their dashboard origin.

A conditional database update claims each status transition before sending.
Concurrent requests and retries cannot send the same transition again. Withdrawal
and resubmission create a new transition and notification. Delivery failures are
returned through the normal API error response, explicitly confirming that the
event was submitted/published while the email failed. Existing frontend error
toasts display that confirmation. Refresh to see the saved status.

Provider acceptance is not proof of inbox delivery. This flow reports immediate
provider errors/rejections; asynchronous bounces require provider delivery webhooks.
There is no automatic retry: a process crash after the status commit can leave
an unsent notification, avoiding a duplicate send after an ambiguous provider
response. Support should investigate delivery failures rather than resubmitting
the event.
