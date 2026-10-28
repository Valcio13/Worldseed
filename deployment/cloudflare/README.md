# Cloudflare deployment files

The repository root keeps `wrangler.toml` as the default config for the existing static-assets frontend Worker (`worldseed`). This folder contains explicit configs for separate environments:

- `wrangler.v3-verifier.toml` — Hemi Sepolia verifier Worker and its D1 binding.
- `wrangler.v3-verifier.mainnet.toml` — Mainnet verifier Worker and its separate D1 binding.
- `wrangler.v3-verifier.mainnet.example.toml` — non-deployable template; replace the database ID before use.
- `wrangler.mainnet.example.toml` — separate Mainnet static frontend Worker config.
- `mainnet.frontend.env.example` — public Vite build variables for Mainnet. Copy values into the build environment; this file is an example, not an automatically loaded environment file.

Paths in these configs are relative to this directory. Use `--config` explicitly so a deployment targets the intended Worker. Never copy secrets into these files or frontend variables.
