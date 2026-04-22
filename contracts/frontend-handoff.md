\# Frontend Handoff Checklist



\## Backend Base URL (Local)

http://localhost:3001



\---



\## Authentication

\- None (v1)

\- All endpoints are unsecured and internal



\---



\## WRITE ENDPOINT



\### Save Visit

POST /visits/record



Payload:

\- See `recordVisit.json`

\- Date format: dd/mm/yy

\- Backend converts to ISO



Behavior:

\- Creates or updates CRM intelligence

\- Increments discussion history

\- Invalidates cached customer data



Response:

{ "success": true }



\---



\## READ ENDPOINTS



\### Customer Dashboard Summary

GET /customers/:customerCode/dashboard



Used for:

\- KPI cards

\- Overview



\---



\### Customer Readiness Score

GET /customers/:customerCode/readiness



Used for:

\- Readiness indicator

\- Priority highlighting



\---



\### Top Categories (Top 3)

GET /customers/:customerCode/top-categories



Used for:

\- Dashboard insights

\- “What we talk about most”



\---



\### Neglected Categories

GET /customers/:customerCode/neglected-categories



Used for:

\- Visit preparation

\- Prompts \& nudges



\---



\### Full Category Intelligence

GET /customers/:customerCode/crm



Used for:

\- Detailed category \& subcategory view

\- Lazy loaded on demand



\---



\## Caching Rules



\- Cache dashboard + readiness in memory per session

\- Lazy-load non-critical endpoints

\- After saving a visit:

&#x20; - Clear all customer-related caches



\---



\## Error Handling



\- All endpoints return:

&#x20; - success: true OR

&#x20; - { error: "message" }



Frontend should:

\- Show non-blocking error UI

\- Allow retry



\---



\## Guaranteed Backend Contracts



\- Response field names are stable

\- Endpoint URLs are final for v1

\- No breaking changes without version bump

