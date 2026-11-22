# New Portal

Website with an Overview, Cloud dashboard, Ticketing dashboard and Team page, all reading and writing a PostgreSQL
database named **"Costumer Data"** (spelled as requested). A toggle in the header switches between Cloud and Ticketing,
and a status pill shows the live database connection (click it for server version, latency and errors).

## Run it
1. Install PostgreSQL 14+ and Node.js 18+.
2. Create the database, tables and dummy data (run in `psql`, not a GUI query tool, because it uses `\connect`):
       psql -U postgres -f db/init.sql
3. `npm install` then `npm start`
4. Open http://localhost:3000

Password is not "postgres"? `PGPASSWORD=yourpassword npm start` (Windows PowerShell: `$env:PGPASSWORD="yourpassword"; npm start`).
Other variables: PGHOST, PGPORT, PGUSER, PGDATABASE ("Costumer Data"), PORT (3000).
Docker option for PostgreSQL (not tested in the build environment): `docker compose up -d`, then steps 3 and 4.

## Database
| Table | Rows | Purpose |
|---|---|---|
| customers | 2 | Companies that raise tickets and own cloud services |
| skills | 7 | GCP, AWS, Azure, Kubernetes, PostgreSQL, Networking, Security |
| employees | 6 | Name, email, role, location, experience, status (available / busy / on leave) |
| employee_skills | 17 | Which employee has which skill, level 1 Beginner to 3 Expert |
| cloud_services | 8 | Services with provider (GCP/AWS/Azure), type, status, CPU, monthly cost |
| cloud_usage | 112 | Daily cost per service, last 14 days |
| tickets | 12 | Subject, **skill needed** (replaces category), priority, status, assignee |

## How tickets are matched to skills
- Every ticket needs one skill. Only employees who have that skill can be assigned, and nobody on leave is offered.
- "Best match" = highest skill level, then fewest open tickets.
- Ticketing page: the "Who can handle each skill" table, the hint under New ticket, and each row's Assigned to dropdown all
  show the qualified people. Auto-assign picks the best match. The server rejects a wrong assignment with a clear message.
- Only the best 3 matches are offered in each ticket's Assigned to list and in the New ticket hint; choose "Show all N qualified" in the list to see everyone with the skill. Change `SHOW` in `public/tickets.html` to show more or fewer.
- New ticket has a checkbox to auto-assign on creation. Assigning moves a ticket to In progress; unassigning moves it back to Open.
- Team page: view employees and skills, change availability, add an employee with skill levels.

## API
GET /api/health, /api/overview, /api/cloud, /api/skills, /api/employees, /api/tickets.
POST /api/tickets, /api/tickets/:id/auto-assign, /api/employees. PATCH /api/tickets/:id, /api/cloud/:id, /api/employees/:id.

## Notes
All data is dummy data; re-run step 2 to reset. There is no login, so do not expose this to the internet as it is.
Fonts load from Google Fonts; offline, system fonts are used.
