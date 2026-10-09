---
title: "Get started with Akter Cloud"
description: "Create an account, connect the CLI and your own Postgres, then deploy."
---

Akter Cloud hosts your Akter app on managed runners. **You supply Postgres for every environment on every plan**; Akter does not provision or bill for databases. You upload source with the CLI, and the platform builds it, applies migrations to your database and rolls out runners. You can also [self-host Akter](/guides/deploy).

## Sign up

1. Open the [Akter Cloud console](https://app.akter.dev/sign-up). Enter your name, email and a password of at least 12 characters, and accept the Terms of Service and Privacy Policy.
2. Open the verification link sent to your email address. A verified account is required to use the Cloud API and approve CLI login.
3. Follow onboarding to name your organization and create your first project. Organizations own projects, members and billing; projects contain environments and deployments.
4. Keep your project's ID for `--project`, or set `AKTER_PROJECT` in your shell. The CLI needs the ID, not the project name or slug.

Start with the available home region. Adding a second region is not part of the launch offering.

## Install the CLI

The package is `@rikalabs/akter-cli`; its executable is `akter`. It supports Bun 1.4.2+ or Node 24+.

Use the `alpha` dist-tag for both packages: `@rikalabs/akter-cli@alpha` for the CLI and `@rikalabs/akter@alpha` for your app, as in the [quickstart](/quickstart). The framework's `latest` tag may still point to an older alpha.

<Tabs>
  <Tab title="Bun">
    ```sh
    bun add -d @rikalabs/akter-cli@alpha
    bunx akter login
    ```
  </Tab>
  <Tab title="Node / npm">
    ```sh
    npm install --save-dev @rikalabs/akter-cli@alpha
    npx akter login
    ```
  </Tab>
</Tabs>

`login` prints a browser URL and an eight-character code. Open that URL, sign in and approve the matching code. Wait for the CLI to confirm that it saved your credentials. Never share the code or credential file.

For a preview or another control plane, use its API URL explicitly:

```sh
bunx akter login --api-url https://YOUR-PREVIEW-API
```

The flag is `--api-url`, not `--api`. `AKTER_API_URL` also selects the API for login. Otherwise, login uses `https://api.akter.dev`. Subsequent commands use the API saved by login, not a newly changed `AKTER_API_URL`. Remote APIs must use HTTPS; HTTP is accepted only for loopback hosts.

```sh
bunx akter whoami
```

`whoami` prints your email, organization slugs, roles and organization IDs. Credentials are stored in the platform's configuration directory; `AKTER_CONFIG_DIR` overrides that location. On macOS the default is `~/Library/Application Support/akter`. Do not commit this directory.

## Connect Postgres before deploying

[Choose a Postgres](/cloud/choose-postgres) near the runners in Fly `iad` / AWS `us-east-1`, then [set its direct connection URL as `DATABASE_URL`](/cloud/database) in each environment you will deploy. This is required on Free, Pro, Team and Enterprise. Transaction-pooler URLs are refused; a deploy-time p50 latency above 5 ms warns but does not block deployment.

Next, [deploy your app](/cloud/deploy) and review [compute-only pricing and limits](/cloud/pricing-and-limits). You own the database's capacity, backups and provider bill, and Akter never deletes it. See [environment variables](/cloud/environment-variables) for your other configuration.

## Sign out

```sh
bunx akter logout
```

This attempts to sign out the stored CLI session and removes its local credentials. If the API cannot revoke the session, the CLI warns that it remains valid until expiry. Logout does not delete your account, organization or deployments.
