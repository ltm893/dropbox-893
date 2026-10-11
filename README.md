# dropbox-893

CDK add-on that deploys a **private file-manager API** (Cognito-protected) and a **public slideshow API** on top of an existing **Cognito User Pool** and **S3 buckets**. Intended to sit beside **`cognito-s3-stack-893`** (or any deployment that gives you a pool + buckets).

Amplify is **not** used for this backend — run **`deploy.sh`** from your machine or CI; APIs are **API Gateway + Lambda**.

## Features

- **`/files`** — list, presigned upload/download, delete (private bucket; Cognito JWT)
- **`GET /albums`** — list album prefixes (public bucket; no auth)
- **`GET /albums/{album}`** — list image URLs in an album (public bucket; no auth)

S3 buckets are **referenced only**; this stack does **not** create or delete them.

## Prerequisites

- AWS account, CLI configured (`aws sts get-caller-identity`)
- Node.js 18+ (for CDK / Lambda tooling)
- An existing **Cognito User Pool**
- Existing **private** and **public** S3 buckets (slideshow reads from the public bucket)

## Quick start

```bash
git clone <your-fork-or-repo-url>
cd dropbox-893/backend

cp bin/config.example.ts bin/config.ts
# Edit bin/config.ts — set id, awsRegion, userPoolId, privateBucket, publicBucket,
# and optionally publicSlideshowPrefix (e.g. "images/" when albums sit under that prefix).

npm install
./scripts/deploy.sh
```

`deploy.sh` prompts for confirmation, runs **`cdk deploy`**, and writes **`dropbox_outputs.json`** at the **repository root** (pool ID, client ID, API URL — **keep private**, gitignored by default).

## Verify

From `backend/`:

```bash
./scripts/verify.sh --public-only
./scripts/verify.sh --email you@example.com --password 'your-password'
```

## Integrating with the base stack

If you use **cognito-s3-stack-893**, deploy that first and take **`user_pool_id`** and bucket names from **`base_outputs.json`** into **`bin/config.ts`**.

`deploy.sh` creates the app client `{id}-dropbox-client` with `ALLOW_USER_PASSWORD_AUTH` and writes it to **`dropbox_outputs.json`**. The website copies these fields into Amplify:

| Amplify variable | Field |
|------------------|--------|
| `APP_REGION` | `aws_region` |
| `USER_POOL_ID` | `auth.user_pool_id` |
| `USER_POOL_CLIENT_ID` | `auth.user_pool_client_id` |
| `DROPBOX_API_URL` | `api.base_url` |

Do not use `auth.user_pool_client_id` from `base_outputs.json`. That is `{id}-app-client`, a different client.

## Project layout

| Path | Role |
|------|------|
| `backend/bin/app.ts` | CDK entry |
| `backend/bin/config.example.ts` | Template — copy to `config.ts` |
| `backend/bin/config.ts` | **Local only** — gitignored |
| `backend/lib/dropbox-stack.ts` | Stack definition |
| `backend/lambda/*` | Lambda sources |
| `backend/scripts/deploy.sh` | Deploy + write outputs |
| `backend/scripts/verify.sh` | Smoke tests |
| `CONTEXT.md` | Maintainer notes |
| `dropbox_outputs.example.json` | Example output shape |

## Security

- Never commit **`backend/bin/config.ts`** or **`dropbox_outputs.json`** (see `.gitignore`).
- Presigned URLs: uploads ~15 minutes, downloads ~12 hours (see `CONTEXT.md`).

## License

Add a `LICENSE` file if you publish publicly.
