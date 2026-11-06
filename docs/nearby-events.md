# Nearby event discovery

Task: omevision/task-1793912900189-zv4rpa-nearby (api, landing, dashboard).

Events now store an organizer-selected `eventLocation: { lat, lng }` or no point.
The event venue text is unchanged; venue trading accounts remain a separate
concept and are not assigned inferred coordinates. No geocoding API, backfill,
compatibility aliases or index/data migration is introduced.

The dashboard event create/edit forms and website self-listing modal accept
coordinates chosen in the existing keyless Google Maps provider and preview the
point. Both coordinates must be provided and within valid ranges. Empty inputs
mean location unavailable, and update null explicitly clears a point. Coordinates
are core event information: existing draft-owner/live-admin edit gates apply.
Existing events require a deliberate authorized edit to acquire coordinates.

`GET /api/public/events/nearby?lat=&lng=&radiusKm=` is public with optional buyer
marks, defaults to 25 km (range 1–200), and rejects missing/invalid coordinates.
It selects published events that have not ended, computes great-circle distance
from stored points, filters before limiting, sorts nearest first, and returns up
to 50 event cards with distanceKm. Missing points are excluded. Dependencies fail
through the API error channel. The current implementation reads eligible points
before calculating distances; for a substantially larger catalog a separately
reviewed geo index/query migration would reduce that scan.

Calendar has Calendar / Nearby / Saved. Nearby reuses browser permission handling
without saving the viewer's location or opting them into people discovery.
Sidebar and mobile More call the existing /nearby screen Meetups; that screen
retains People and buyer Meetups and has no Events tab or all-events substitution.
Event directions use the selected coordinates and show location unavailable when
none were selected.

Delivery gate: independent review of all three task branches, then API production
release before both web clients, exact serving-source verification and existing
client review. No production merge, deployment, payment, or client approval is
performed by the implementation stage.
