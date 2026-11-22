const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "Costumer Data",
  connectionTimeoutMillis: 2000,
});
pool.on("error", (e) => console.error("pool error:", e.message));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const PRIORITIES = ["low", "medium", "high", "urgent"], TICKET_STATUS = ["open", "in_progress", "resolved", "closed"];

// ---- skill matching: who can handle a skill, best first -------------------
// Best = highest skill level, then fewest open tickets. People on leave are never offered.
const QUALIFIED = `SELECT es.skill_id, e.id, e.name, e.status, es.level,
    (SELECT count(*) FROM tickets t WHERE t.assignee_id = e.id AND t.status IN ('open','in_progress'))::int AS open_tickets
  FROM employee_skills es JOIN employees e ON e.id = es.employee_id WHERE e.status <> 'on_leave'`;
const RANK = "ORDER BY level DESC, open_tickets ASC, name ASC";
const bestMatch = async (skillId) => (await q(`SELECT * FROM (${QUALIFIED} AND es.skill_id = $1) m ${RANK} LIMIT 1`, [skillId]))[0];

// ---- database connection status -----------------------------------------
app.get("/api/health", async (req, res) => {
  const t0 = Date.now();
  try {
    const [r] = await q("SELECT current_database() AS db, version() AS version");
    res.json({ connected: true, database: r.db, version: r.version.split(" ").slice(0, 2).join(" "),
      latency_ms: Date.now() - t0, checked_at: new Date().toISOString() });
  } catch (e) {
    res.json({ connected: false, database: process.env.PGDATABASE || "Costumer Data", error: e.message, checked_at: new Date().toISOString() });
  }
});

// ---- overview -----------------------------------------------------------
app.get("/api/overview", wrap(async (req, res) => {
  const [k] = await q(`SELECT
    (SELECT count(*) FROM customers)::int AS customers,
    (SELECT count(*) FROM cloud_services)::int AS services,
    (SELECT count(*) FROM cloud_services WHERE status='degraded')::int AS degraded,
    (SELECT coalesce(sum(monthly_cost),0) FROM cloud_services WHERE status<>'stopped')::float AS monthly_cost,
    (SELECT count(*) FROM tickets WHERE status IN ('open','in_progress'))::int AS open_tickets,
    (SELECT count(*) FROM tickets WHERE assignee_id IS NULL AND status IN ('open','in_progress'))::int AS unassigned,
    (SELECT count(*) FROM employees)::int AS employees,
    (SELECT count(*) FROM employees WHERE status='on_leave')::int AS on_leave`);
  const customers = await q(`SELECT c.id, c.name, c.company, c.plan, c.country,
      (SELECT count(*) FROM cloud_services s WHERE s.customer_id=c.id)::int AS services,
      (SELECT coalesce(sum(monthly_cost),0) FROM cloud_services s WHERE s.customer_id=c.id AND s.status<>'stopped')::float AS monthly_cost,
      (SELECT count(*) FROM tickets t WHERE t.customer_id=c.id AND t.status IN ('open','in_progress'))::int AS open_tickets
    FROM customers c ORDER BY c.id`);
  res.json({ kpis: k, customers });
}));

// ---- cloud --------------------------------------------------------------
app.get("/api/cloud", wrap(async (req, res) => {
  const [k] = await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='running')::int AS running,
      count(*) FILTER (WHERE status='degraded')::int AS degraded,
      count(*) FILTER (WHERE status='stopped')::int AS stopped,
      coalesce(sum(monthly_cost) FILTER (WHERE status<>'stopped'),0)::float AS monthly_cost,
      coalesce(round(avg(cpu_pct) FILTER (WHERE service_type='Compute' AND status<>'stopped')),0)::int AS avg_cpu
    FROM cloud_services`);
  const services = await q(`SELECT s.id, s.name, s.provider, s.service_type, s.region, s.status, s.cpu_pct, s.monthly_cost::float, c.company
    FROM cloud_services s JOIN customers c ON c.id=s.customer_id ORDER BY s.status='degraded' DESC, s.monthly_cost DESC`);
  const cost_by_day = await q(`SELECT to_char(usage_date,'DD Mon') AS label, sum(cost_usd)::float AS value FROM cloud_usage GROUP BY usage_date ORDER BY usage_date`);
  const cost_by_provider = await q(`SELECT provider AS label, sum(monthly_cost)::float AS value FROM cloud_services WHERE status<>'stopped' GROUP BY provider ORDER BY value DESC`);
  res.json({ kpis: k, services, cost_by_day, cost_by_provider });
}));

app.patch("/api/cloud/:id", wrap(async (req, res) => {
  const { status } = req.body;
  if (!["running", "stopped"].includes(status)) return bad(res, "status must be running or stopped");
  const rows = await q(`UPDATE cloud_services SET status=$1, cpu_pct = CASE WHEN $1='stopped' THEN 0 ELSE GREATEST(cpu_pct, 20) END WHERE id=$2 RETURNING id, status`, [status, req.params.id]);
  rows.length ? res.json(rows[0]) : bad(res, "service not found", 404);
}));

// ---- skills and employees -------------------------------------------------
// every skill with the people qualified for it, best match first
app.get("/api/skills", wrap(async (req, res) => {
  const skills = await q("SELECT id, name FROM skills ORDER BY name");
  const people = await q(`SELECT * FROM (${QUALIFIED}) m ${RANK}`);
  res.json(skills.map((s) => ({ ...s, qualified: people.filter((p) => p.skill_id === s.id) })));
}));

app.get("/api/employees", wrap(async (req, res) => {
  const employees = await q(`SELECT e.id, e.name, e.email, e.role, e.location, e.years_experience, e.status,
      coalesce(json_agg(json_build_object('skill', s.name, 'level', es.level) ORDER BY es.level DESC, s.name) FILTER (WHERE s.id IS NOT NULL), '[]') AS skills,
      (SELECT count(*) FROM tickets t WHERE t.assignee_id=e.id AND t.status IN ('open','in_progress'))::int AS open_tickets,
      (SELECT count(*) FROM tickets t WHERE t.assignee_id=e.id AND t.status IN ('resolved','closed'))::int AS done_tickets
    FROM employees e LEFT JOIN employee_skills es ON es.employee_id=e.id LEFT JOIN skills s ON s.id=es.skill_id GROUP BY e.id ORDER BY e.id`);
  res.json({ employees, skills: await q("SELECT id, name FROM skills ORDER BY name") });
}));

app.post("/api/employees", wrap(async (req, res) => {
  const { name, email, role, location, years_experience, skills } = req.body;
  const list = (Array.isArray(skills) ? skills : []).filter((s) => [1, 2, 3].includes(+s.level));
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || "") || !role?.trim() || !location?.trim() || !(+years_experience >= 0))
    return bad(res, "name, a valid email, role, location and years of experience are required");
  if (!list.length) return bad(res, "choose at least one skill with a level");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(`INSERT INTO employees (name,email,role,location,years_experience) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name.trim(), email.trim(), role.trim(), location.trim(), +years_experience]);
    for (const s of list) await c.query("INSERT INTO employee_skills (employee_id, skill_id, level) VALUES ($1,$2,$3)", [rows[0].id, +s.skill_id, +s.level]);
    await c.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (e) {
    await c.query("ROLLBACK");
    e.code === "23505" ? bad(res, "an employee with this email already exists", 409) : bad(res, e.message, 500);
  } finally { c.release(); }
}));

app.patch("/api/employees/:id", wrap(async (req, res) => {
  const { status } = req.body;
  if (!["available", "busy", "on_leave"].includes(status)) return bad(res, "invalid status");
  const rows = await q("UPDATE employees SET status=$1 WHERE id=$2 RETURNING id, status", [status, req.params.id]);
  rows.length ? res.json(rows[0]) : bad(res, "employee not found", 404);
}));

// ---- tickets --------------------------------------------------------------
app.get("/api/tickets", wrap(async (req, res) => {
  const [k] = await q(`SELECT
      count(*) FILTER (WHERE status IN ('open','in_progress') AND assignee_id IS NULL)::int AS unassigned,
      count(*) FILTER (WHERE status='in_progress')::int AS in_progress,
      count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS done,
      count(*) FILTER (WHERE priority='urgent' AND status IN ('open','in_progress'))::int AS urgent,
      coalesce(round((avg(extract(epoch FROM resolved_at - created_at)/3600))::numeric,1),0)::float AS avg_hours
    FROM tickets`);
  const tickets = await q(`SELECT t.id, t.subject, t.skill_id, sk.name AS skill, t.priority, t.status, t.assignee_id, e.name AS assignee, t.created_at, c.company
    FROM tickets t JOIN customers c ON c.id=t.customer_id JOIN skills sk ON sk.id=t.skill_id LEFT JOIN employees e ON e.id=t.assignee_id
    ORDER BY (t.status IN ('resolved','closed')), array_position(ARRAY['urgent','high','medium','low'], t.priority), t.created_at DESC`);
  const by_skill = await q(`SELECT sk.name AS label, count(*)::int AS value FROM tickets t JOIN skills sk ON sk.id=t.skill_id GROUP BY sk.name ORDER BY value DESC, sk.name`);
  const by_status = await q(`SELECT status AS label, count(*)::int AS value FROM tickets GROUP BY status ORDER BY array_position(ARRAY['open','in_progress','resolved','closed'], status)`);
  const customers = await q(`SELECT id, company FROM customers ORDER BY company`);
  res.json({ kpis: k, tickets, by_skill, by_status, customers });
}));

app.post("/api/tickets", wrap(async (req, res) => {
  const { customer_id, subject, skill_id, priority, auto_assign } = req.body;
  if (!customer_id || !subject?.trim() || !skill_id || !PRIORITIES.includes(priority)) return bad(res, "customer, subject, skill needed and priority are required");
  const match = auto_assign ? await bestMatch(skill_id) : null;
  if (auto_assign && !match) return bad(res, "nobody available has this skill; create the ticket without auto-assign", 409);
  const [row] = await q(`INSERT INTO tickets (customer_id, subject, skill_id, priority, status, assignee_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [customer_id, subject.trim().slice(0, 200), skill_id, priority, match ? "in_progress" : "open", match?.id ?? null]);
  res.status(201).json({ id: row.id, assigned_to: match?.name ?? null });
}));

// change status and/or assignee. An assignee must have the ticket's skill and must not be on leave.
app.patch("/api/tickets/:id", wrap(async (req, res) => {
  const { status, assignee_id } = req.body;
  const [t] = await q("SELECT t.id, t.skill_id, sk.name AS skill FROM tickets t JOIN skills sk ON sk.id=t.skill_id WHERE t.id=$1", [req.params.id]);
  if (!t) return bad(res, "ticket not found", 404);
  if (status !== undefined && !TICKET_STATUS.includes(status)) return bad(res, "invalid status");
  if (assignee_id) {
    const [e] = await q(`SELECT e.name, e.status, es.level FROM employees e LEFT JOIN employee_skills es ON es.employee_id=e.id AND es.skill_id=$2 WHERE e.id=$1`, [assignee_id, t.skill_id]);
    if (!e) return bad(res, "employee not found", 404);
    if (e.status === "on_leave") return bad(res, `${e.name} is on leave`, 409);
    if (!e.level) return bad(res, `${e.name} does not have the ${t.skill} skill`, 409);
  }
  const assigning = assignee_id !== undefined;
  await q(`UPDATE tickets SET
      assignee_id = CASE WHEN $4 THEN $2::int ELSE assignee_id END,
      status = CASE WHEN $3::text IS NOT NULL THEN $3::text
                    WHEN $4 AND $2::int IS NOT NULL AND status='open' THEN 'in_progress'
                    WHEN $4 AND $2::int IS NULL AND status='in_progress' THEN 'open' ELSE status END
    WHERE id=$1`, [t.id, assigning ? assignee_id : null, status ?? null, assigning]);
  await q("UPDATE tickets SET resolved_at = CASE WHEN status IN ('resolved','closed') THEN coalesce(resolved_at, now()) ELSE NULL END WHERE id=$1", [t.id]);
  const [out] = await q("SELECT id, status, assignee_id FROM tickets WHERE id=$1", [t.id]);
  res.json(out);
}));

app.post("/api/tickets/:id/auto-assign", wrap(async (req, res) => {
  const [t] = await q("SELECT t.id, t.skill_id, sk.name AS skill, t.status FROM tickets t JOIN skills sk ON sk.id=t.skill_id WHERE t.id=$1", [req.params.id]);
  if (!t) return bad(res, "ticket not found", 404);
  const m = await bestMatch(t.skill_id);
  if (!m) return bad(res, `nobody available has the ${t.skill} skill`, 409);
  await q("UPDATE tickets SET assignee_id=$1, status=CASE WHEN status='open' THEN 'in_progress' ELSE status END WHERE id=$2", [m.id, t.id]);
  res.json({ id: t.id, assigned_to: m.name, level: m.level });
}));

app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ error: err.message }); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Customer portal on http://localhost:${port}  (database: ${process.env.PGDATABASE || "Costumer Data"})`));
