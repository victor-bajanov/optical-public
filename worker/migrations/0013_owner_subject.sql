-- Per-user ownership for the three owned tables. NULL = legacy / unassigned;
-- the owner-scoped repository (db/d1.ts) never matches NULL against a real
-- subject, so legacy rows are invisible until the cutover backfill (Task 7)
-- assigns them. Single-org model: owner_subject is the user's email (spec Q5).
ALTER TABLE tasks          ADD COLUMN owner_subject TEXT;
ALTER TABLE task_templates ADD COLUMN owner_subject TEXT;
ALTER TABLE projects       ADD COLUMN owner_subject TEXT;

CREATE INDEX tasks_owner          ON tasks(owner_subject);
CREATE INDEX task_templates_owner ON task_templates(owner_subject);
CREATE INDEX projects_owner       ON projects(owner_subject);
