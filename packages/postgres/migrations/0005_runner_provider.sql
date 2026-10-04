ALTER TABLE deployment ADD COLUMN tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise'));
ALTER TABLE deployment ADD COLUMN image text;
ALTER TABLE deployment ADD COLUMN environment_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE deployment ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deployment ADD COLUMN serving boolean NOT NULL DEFAULT true;
ALTER TABLE deployment_runner ADD COLUMN provider_id text;
