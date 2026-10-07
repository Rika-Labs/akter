---
title: "Get started with Akter Cloud"
description: "Create an account, organization and project, then connect the CLI."
---

Akter Cloud hosts your Akter app and provisions its customer database. You upload source with the CLI; the platform builds it, applies migrations and rolls out runners. You can also [self-host Akter](/guides/deploy).

## Sign up

1. Open the [Akter Cloud console](https://app.akter.dev/sign-up). Enter your name, email and a password of at least 12 characters, and accept the Terms of Service and Privacy Policy.
2. Open the verification link sent to your email address. A verified account is required to use the Cloud API and approve CLI login.
3. Follow onboarding to name your organization and create your first project. Organizations own projects, members and billing; projects contain environments and deployments.
4. Keep your project's ID for `--project`, or set `AKTER_PROJECT` in your shell. The CLI needs the ID, not the project name or slug.

Start with the available home region. Adding a second region is not part of the launch offering.

## Install the CLI

The package is `@rikalabs/akter-cli`; its executable is `akter`. It supports Bun 1.4.2+ or Node 24+.

<Warning>
The first registry publication is pending. These registry install commands become available after that publication.
</Warning>

<Tabs>
  <Tab title="Bun">
    ```sh
    bun add -d @rikalabs/akter-cli
    bunx akter login
    ```
  </Tab>
  <Tab title="Node / npm">
    ```sh
    npm install --save-dev @rikalabs/akter-cli
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

`whoami` prints your email, organizations and active organization. Credentials are stored in the platform's configuration directory; `AKTER_CONFIG_DIR` overrides that location. On macOS the default is `~/Library/Application Support/akter`. Do not commit this directory.

Next, [deploy your app](/cloud/deploy), review the [pricing and limits](/cloud/pricing-and-limits), and configure [environment variables](/cloud/environment-variables).

## Sign out

```sh
bunx akter logout
```

This signs out the stored CLI session and removes its local credentials. It does not delete your account, organization or deployments.
