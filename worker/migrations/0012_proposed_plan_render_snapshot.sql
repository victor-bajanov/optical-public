-- 0012_proposed_plan_render_snapshot.sql — store the renderable ReplanEmailModel
-- alongside each proposed plan so the accept page can render the latest plan's
-- before→after visual without a fresh calendar fetch. Stored OUTSIDE `body` so
-- computePlanHash(body) is unaffected — presentation must not change plan identity.
ALTER TABLE proposed_plans ADD COLUMN render_snapshot TEXT;
