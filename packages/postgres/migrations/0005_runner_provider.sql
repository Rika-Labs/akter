ALTER TABLE deployment ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise'));
ALTER TABLE deployment ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE deployment ADD COLUMN IF NOT EXISTS environment_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE deployment ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deployment ADD COLUMN IF NOT EXISTS serving boolean NOT NULL DEFAULT true;
ALTER TABLE deployment_runner ADD COLUMN IF NOT EXISTS provider_id text;
