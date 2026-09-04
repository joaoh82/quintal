-- Let the agents that already exist be messaged directly.
--
-- `dm` is a new scope: whether an agent may be in a direct message at all.
-- New agents get it by default. Existing ones have their scopes stored as a
-- JSON array written before the scope existed, and an owner should not have
-- to re-create their agent to be able to talk to it in private.
--
-- Appends `dm` to every agent whose scopes do not already hold it, and only
-- to well-formed arrays: a row with a malformed column is left alone rather
-- than turned into something else. Safe to run twice — the NOT EXISTS makes
-- the second run a no-op.
UPDATE agents
SET scopes = json_insert(scopes, '$[#]', 'dm')
WHERE json_valid(scopes)
  AND json_type(scopes) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agents.scopes) WHERE json_each.value = 'dm'
  );
