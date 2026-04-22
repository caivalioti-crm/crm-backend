\# Frontend Loading Strategy



\## On Customer Open (Immediate)

\- GET /customers/:customerCode/dashboard

\- GET /customers/:customerCode/readiness



Purpose:

\- KPI cards

\- Readiness indicator

\- Must be fast, above-the-fold



Cache:

\- In-memory (per session)



\---



\## On Customer Detail Scroll / Tab Open (Lazy)

\- GET /customers/:customerCode/top-categories

\- GET /customers/:customerCode/neglected-categories



Purpose:

\- Insights \& visit preparation

\- Not required immediately



Cache:

\- In-memory (per session)



\---



\## On Category Intelligence Tab Open (Lazy)

\- GET /customers/:customerCode/crm



Purpose:

\- Full category \& subcategory breakdown

\- Used only when user explicitly opens section



Cache:

\- No cache (always fresh)



\---



\## On Save Visit (Write)

\- POST /visits/record



Purpose:

\- Persist visit intelligence

\- Triggers backend aggregation



Cache impact:

\- Invalidate all cached customer data for that customer

