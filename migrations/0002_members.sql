-- Membership pipeline. Two kinds of record in one table:
--   channel: organizations where likely members gather (readable in public view mode)
--   lead:    individual people the admin adds (admin only, never returned to public visitors)
-- No pipeline date/time columns by design.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'lead')),
  name TEXT NOT NULL CHECK (length(name) > 0),
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1
);
