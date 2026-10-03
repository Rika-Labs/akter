CREATE TABLE feature_flag_override (
  key text PRIMARY KEY,
  rule jsonb NOT NULL CHECK (jsonb_typeof(rule) = 'object')
);
