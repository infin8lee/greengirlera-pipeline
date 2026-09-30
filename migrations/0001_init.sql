-- Private CRM storage. No pipeline date/time columns by design.
CREATE TABLE IF NOT EXISTS sponsors (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL CHECK (length(company) > 0),
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);
