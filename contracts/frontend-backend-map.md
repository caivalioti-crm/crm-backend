\# Frontend → Backend API Map



\## New Visit (Save)

POST /visits/record

\- Called when rep saves a visit

\- Payload: recordVisit.json



\---



\## Customer Detail – Category Intelligence

GET /customers/:customerCode/crm

\- Full category + subcategory discussion history



\---



\## Customer Dashboard – KPI Cards

GET /customers/:customerCode/dashboard

\- Categories discussed count

\- Subcategories discussed count

\- Last discussion date



\---



\## Customer Dashboard – Top Categories

GET /customers/:customerCode/top-categories

\- Top 3 most discussed categories



\---



\## Customer Dashboard – Neglected Categories

GET /customers/:customerCode/neglected-categories

\- Categories not discussed in >90 days



\---



\## Customer Dashboard – Readiness Score

GET /customers/:customerCode/readiness

\- Single numeric readiness signal

