# Deploying Longhand

Production is two pieces (`docs/SPEC.md`, "Architecture"):

- **The web app** (`apps/web`, Next.js) on **AWS Amplify Hosting** (SSR compute).
- **The ledger service** (`apps/server`) on **EC2**, because Durable Streams needs a long-running process. It sits next to its Durable Streams server, uses **Postgres** (RDS) for the read model, **Cognito** to verify sign-ins and an **AWS KMS** asymmetric key to witness every commit.

Nothing here has been deployed; this is the plan and the files for it: `amplify.yml`, `apps/server/Dockerfile`, `deploy/ec2/docker-compose.yml`, `deploy/ec2/longhand-ledger.service` and `deploy/ec2/ledger.env.example`.

```
writer's browser ──HTTPS──► Amplify (apps/web, SSR)            Cognito Hosted UI (code + PKCE)
        │                                                              ▲
        └──HTTPS + SSE──► reverse proxy (TLS) ──► ledger :3200 ──► streams :3300 (EBS volume)
                          on the EC2 instance        │   └─► RDS Postgres (read model)
                                                     ├─► KMS Sign (witness key)
                                                     └─► claude -p (AI editor, MCP tools only)
```

## 1. Cognito

One user pool, one public app client, the Hosted UI.

1. **User pool.** Create a user pool. Sign-in with email. Turn **self sign-up off** (one writer at launch; opening sign-up later is configuration). Create the writer with `aws cognito-idp admin-create-user`.
2. **Domain.** Add a Hosted UI domain (a Cognito prefix domain such as `longhand-<you>.auth.<region>.amazoncognito.com`, or your own).
3. **App client.** A **public client: no client secret** (the browser exchanges the code with PKCE).
   - OAuth grant: **Authorization code** only. Scopes: `openid email profile`.
   - Callback URL: `https://<web origin>/auth/callback`. Sign-out URL: `https://<web origin>/`.
   - Access token lifetime ~1 h, refresh token ~30 days (the app refreshes a minute before expiry).
4. **Optional:** a custom attribute `custom:accountId`. The ledger service keys data by it when present, else by `sub`, so several logins can share one account later without a data migration.

The ledger service verifies the **access token** by default (`COGNITO_TOKEN_USE=access`, with `aws-jwt-verify`); set it to `id` on both sides to use ID tokens instead.

## 2. KMS witness key

Every commit is signed `(projectId, seq, hash, serverTime)` with ECDSA P-256 / SHA-256. The private key never leaves KMS.

```sh
aws kms create-key \
  --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
  --description "Longhand ledger witness key" \
  --policy file://witness-key-policy.json
aws kms create-alias --alias-name alias/longhand-witness --target-key-id <key-id>
```

Key policy (`witness-key-policy.json`): administrators manage the key; only the ledger instance role may sign and read the public key. Nothing else may use it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KeyAdministration",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account>:role/<admin-role>" },
      "Action": [
        "kms:Describe*", "kms:Get*", "kms:List*", "kms:Create*", "kms:Put*", "kms:Update*",
        "kms:Enable*", "kms:Disable*", "kms:TagResource", "kms:UntagResource",
        "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LedgerServiceSigns",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account>:role/longhand-ledger-instance" },
      "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256" } }
    }
  ]
}
```

(`kms:GetPublicKey` and `kms:DescribeKey` do not take the signing-algorithm condition; if your policy linter objects, split them into their own statement.)

- The service converts KMS's DER signatures to the P1363 form the bundle format uses, and its `keyId` is the SHA-256 of the key's SPKI.
- `GET /.well-known/longhand-witness-key` publishes the public key. Publish its `keyId` somewhere you control too (a README, a DNS TXT record), so readers can run `longhand-verify bundle.json --key-id <keyId>` against a key they did not get from the bundle.
- **Never delete or rotate the key casually.** Old bundles stay verifiable with the old public key, but rotating means publishing both ids.

## 3. Postgres

RDS Postgres 16, in private subnets reachable from the instance only. Create a `longhand` database and user. The service applies its numbered migrations at start under an advisory lock. Everything in Postgres except session tokens is rebuildable from the streams (`pnpm --filter @longhand/server rebuild`), so the **streams volume is the system of record**: back that up first.

## 4. The ledger service on EC2

**Instance.** A small Graviton or x86 instance (t4g.small is plenty for one writer), Amazon Linux 2023 or Ubuntu, with Docker and the compose plugin. Attach an **instance role** (`longhand-ledger-instance`) allowed to use the KMS key and nothing else of note. Put the Durable Streams data on an **EBS volume** (the `streams-data` docker volume, or bind-mount a dedicated volume) with daily snapshots.

**Image.** From the repo root:

```sh
docker build -f apps/server/Dockerfile -t longhand-ledger .
```

It runs the TypeScript sources with `tsx` (no build step, `docs/BUILD.md`), installs only the server's workspace dependencies, and installs the Claude Code CLI for real reviews (`--build-arg INSTALL_CLAUDE_CLI=0` to leave it out and run `MODEL_ADAPTER=mock`). The entrypoint is `pnpm --filter @longhand/server`; the command is `start` (migrations, then the service) or `streams` (the Durable Streams server alone).

**Run.** Copy the repo (or just `deploy/`) to `/opt/longhand`, write `/etc/longhand/ledger.env` from `deploy/ec2/ledger.env.example` (mode 0600), then either:

```sh
docker compose -f deploy/ec2/docker-compose.yml --env-file /etc/longhand/ledger.env up -d
# or as a service:
sudo cp deploy/ec2/longhand-ledger.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now longhand-ledger
```

The compose file runs two containers from the image: `streams` (file-backed, on the volume, not published) and `ledger` (published on `127.0.0.1:3200`). Add the `postgres` profile for a single-box setup without RDS.

**Reverse proxy.** Terminate TLS on the instance (Caddy or nginx) or on an ALB, and forward to `127.0.0.1:3200`. The API uses **server-sent events** for the editor and the agent's progress:

- turn off response buffering for `/v1/` (nginx: `proxy_buffering off; proxy_read_timeout 1h;`; Caddy needs nothing);
- an ALB needs its idle timeout raised (e.g. 3600 s);
- keep `Authorization` headers; SSE routes also accept `?access_token=`.

A minimal Caddyfile: `ledger.example.com { reverse_proxy 127.0.0.1:3200 }`.

**Shutdown.** The service cancels running reviews and waits up to 15 s for their end to be recorded; compose's `stop_grace_period: 30s` covers it.

### Ledger service environment

| Variable | Production value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://longhand:…@<rds>:5432/longhand` | |
| `DATABASE_SCHEMA` | `public` | |
| `LEDGER_HOST`, `LEDGER_PORT` | `0.0.0.0`, `3200` | set by the compose file |
| `LEDGER_INTERNAL_URL` | `http://127.0.0.1:3200` | where agent sessions post their drafts (set by compose) |
| `DURABLE_STREAMS_URL` | `http://streams:3300` | set by compose |
| `DURABLE_STREAMS_PREFIX` | `longhand` | |
| `AUTH_MODE` | `cognito` | |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | from step 1 | |
| `COGNITO_TOKEN_USE` | `access` | must match the web app |
| `WITNESS_SIGNER` | `kms` | |
| `WITNESS_KMS_KEY_ID` | `alias/longhand-witness` | |
| `AWS_REGION` | the key's region | credentials come from the instance role |
| `CORS_ORIGINS` | `https://<web origin>` | comma-separated; the Amplify domain and any custom domain |
| `MODEL_ADAPTER` | `claude` | `mock` for a canned reviewer |
| `ANTHROPIC_API_KEY` | | how the Claude Code CLI authenticates inside the container |
| `CLAUDE_BIN` | (unset) | path to `claude` if not on `PATH` |
| `AGENT_MODEL_FULL`, `AGENT_MODEL_QUICK` | `opus`, `sonnet` | CLI model aliases |
| `AGENT_AUTOSTART` | `1` | start a session for every feedback or discuss request |
| `WITNESS_EMBED_EVERY_COMMITS`, `WITNESS_EMBED_INTERVAL_MS` | `256`, `600000` | `ChainHeadWitnessed` cadence |
| `PRELOAD_PROJECTS` | `0` | fold every project at start instead of on first use |

## 5. The web app on Amplify

1. Create an Amplify app from the repository, branch `main`. Amplify detects `amplify.yml` at the root.
2. Set **`AMPLIFY_MONOREPO_APP_ROOT=apps/web`** and the variables below in the console (all branches, or per branch).
3. Amplify builds with Node ≥ 22 (set the build image's Node version if needed), installs with pnpm 11 through corepack, and runs `pnpm run build` in `apps/web`, which also builds the standalone verifier page into `public/verify`.

The root layout inlines the configuration into the page **at request time**, so the same build runs against any ledger service. Amplify exposes console variables to the build only, so the build step writes the ones the app reads into `.env.production`, which Next loads at runtime.

| Variable | Value | Notes |
| --- | --- | --- |
| `LEDGER_URL` (or `LEDGER_PUBLIC_URL`) | `https://ledger.example.com` | the ledger service as the browser reaches it |
| `AUTH_MODE` | `cognito` | |
| `WEB_ORIGIN` | `https://<web origin>` | for the default redirect URIs |
| `COGNITO_DOMAIN` | `longhand-<you>.auth.<region>.amazoncognito.com` | Hosted UI domain, no scheme |
| `COGNITO_CLIENT_ID` | from step 1 | the public app client |
| `COGNITO_TOKEN_USE` | `access` | must match the service |
| `COGNITO_REDIRECT_URI`, `COGNITO_LOGOUT_URI`, `COGNITO_SCOPES` | optional | default `<WEB_ORIGIN>/auth/callback`, `<WEB_ORIGIN>/`, `openid email profile` |

Sign-in flow: the app redirects to `https://<COGNITO_DOMAIN>/oauth2/authorize` with an S256 code challenge, exchanges the code at `/oauth2/token` from the browser (public client, no secret), keeps the tokens in `localStorage`, refreshes them before expiry, and sends `Authorization: Bearer <access token>` to the ledger service through `@longhand/client`. A 401 drops the tokens and starts the sign-in again.

`/verify` serves the verifier page as static files (`apps/web/public/verify`). It runs entirely in the browser; nothing is uploaded.

## 6. After the first deploy

- Open `https://<web origin>`, sign in, write a paragraph, and check the status line says **Saved**.
- `curl https://ledger.example.com/.well-known/longhand-witness-key` and record the `keyId`.
- Download a verification bundle from the report and check it: `node packages/verifier/dist/longhand-verify.mjs bundle.json --key-id <keyId>` (after `pnpm --filter @longhand/verifier build`), or at `https://<web origin>/verify`.
- Snapshot the streams volume on a schedule; that volume plus the KMS key are what make the record verifiable.

## Not covered yet

- No infrastructure-as-code: the steps above are manual (CDK or Terraform would be the next step).
- One ledger instance, no failover (`apps/server/README.md`, "Known gaps"). `Stream-Seq` prevents two writers from interleaving, so a standby must stay stopped until the primary is gone.
- RFC 3161 timestamps or public anchoring of chain heads (spec, "Integrity: Later").
