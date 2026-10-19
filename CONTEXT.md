# CONTEXT.md — dropbox-893
# Read this first at the start of every session.
# Last updated: 2026-10-18

## What this repo is
Standalone add-on for cognito-s3-stack-893.
Provides private file manager API and public slideshow API (`/albums`).
Typically consumed by a forkable web frontend (e.g. web-app-893) and mobile apps that share the same Cognito pool and private bucket.

## Status
Template / CDK implementation — deploy with `deploy.sh` using your own `config.ts`.

## Part of the add-on family (conceptual)
| Repo | Description |
|------|-------------|
| `cognito-s3-stack-893` | Base: Cognito + S3 |
| `dropbox-893` | Private file manager + slideshow — **this repo** |
| `calendar-893` | Calendar CRUD (separate stack) |
| `music-player-893` | Example consumer (iOS) |
| `web-app-893` | Generic forkable web frontend |
| `video-convert-893` | Family DVD ingest + ffmpeg convert |
| `mileage-expense-tracker-893` | Separate MET stack |

## What this stack owns
- API Gateway (idempotent when used with `deploy.sh` logical-ID pinning)
- Cognito App Client on your existing User Pool (created once by script + CDK pattern)
- Lambda: **getPrivateFiles** — list, upload, download, delete, and share into the root Music, Photos, and Videos folders (private S3)
- Lambda: **getDlivPhotoBuckets** — list albums (public S3), `GET /albums`
- Lambda: **getDlivPhotos** — list photos in album (public S3), `GET /albums/{album}`

## What this stack imports (never creates or deletes)
- Cognito User Pool — from `config.ts`
- S3 private bucket — from `config.ts`
- S3 public bucket — from `config.ts` (slideshow source)

Slideshow album layout is controlled by **`publicSlideshowPrefix`** in `config.ts` (e.g. `"images/"` when each album folder lives under that prefix).

## Presigned URL expiry
- Downloads: 43200 seconds (12 hours)
- Uploads:   900 seconds (15 minutes)

## Example resource naming (after deploy)
`{id}` is the `id` in `cognito-s3-stack-893/base/bin/config.ts` when this config omits it. An `id` already set here is kept.

- Stack: `DropboxStack-{id}`
- API Gateway name: `{id}-dropbox-api`
- App client name: `{id}-dropbox-client`

Fill in real IDs only in **gitignored** `backend/bin/config.ts` — never commit them.

## Example `config.ts` shape (do not copy real IDs into git)
```ts
export const config = {
  // id comes from cognito-s3-stack-893/base/bin/config.ts
  awsRegion:     "us-east-1",
  userPoolId:    "us-east-1_XXXXXXXXX",
  privateBucket: "your-private-bucket-name",
  publicBucket:  "your-public-slideshow-bucket-name",
  publicSlideshowPrefix: "",
  reservedSharedPrefixes: ["Music/", "Photos/", "Videos/"],
};
```

Use `"images/"` (or another prefix) when albums are folders under that path instead of at the bucket root.

Copy from `backend/bin/config.example.ts` and edit locally.

## Deploy
```bash
cd backend
./scripts/deploy.sh
```
Writes `dropbox_outputs.json` at repo root (gitignored).

## Verify
```bash
cd backend
./scripts/verify.sh --public-only
./scripts/verify.sh --email your@example.com --password 'yourpassword'
```

## API routes — `/files` (Cognito)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /files | Cognito | List files and folders (`hasMp3s`, `hasImages`, `hasFiles`, `hasSubFolders`) |
| GET | /files?prefix=X | Cognito | List with prefix |
| POST | /files | Cognito | Get presigned upload URL (15min) |
| POST | /files/share | Cognito | Copy a Mine Music, Photos, or Videos file or folder into the shared library |
| GET | /files/{key+} | Cognito | Get presigned download URL (12hr) |
| DELETE | /files/{key+} | Cognito | Delete single file. A shared copy can be deleted only by the user who shared it |
| DELETE | /files?prefix=X&mode=empty | Cognito | Empty folder. Refuses when the prefix holds a shared copy owned by someone else |
| DELETE | /files?prefix=X&mode=remove | Cognito | Remove folder. Same owner check as empty |

## Share with all DLIV users
`POST /files/share` with `{ "key": "users/{sub}/Videos/Camping/clip.mp4" }`, or a folder key that ends in `/`. The caller must own that key, and it must sit inside their `Music/`, `Photos/`, or `Videos/` library, not on the library root itself.

The copy is placed under a folder named for the sharer. The name comes from the account name, or the email name when no account name is set: `users/{sub}/Videos/Camping/clip.mp4` becomes `Videos/Wenner2026/Camping/clip.mp4`. A folder copy includes every object under that prefix. The personal original stays. If that shared file or folder already exists, the call returns 409 and copies nothing. Files larger than 5 GB are rejected.

Each copied object stores S3 user metadata `owner` set to the caller's Cognito sub. Remove, empty, and a presigned upload that would replace that object are allowed only for that user. Shared objects with no `owner` metadata, including files uploaded directly into `Music/`, `Photos/`, or `Videos/`, can still be removed by any signed-in user.

The Mine menu item is **All DLIV users** in `web-app-893`. Deploy this API from `backend/` with `./scripts/deploy.sh`. That updates the API the site already calls. The menu is static JavaScript, so it appears only after Amplify rebuilds `dliv-web` and `scripts/assemble.sh` clones the `web-app-893` branch named by `TEMPLATE_REF`. A push to `web-app-893` does not start that build.

## API routes — slideshow (public)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /albums | none | List slideshow albums |
| GET | /albums/{album} | none | List photos in album |

## Structure
```
dropbox-893/
├── backend/
│   ├── bin/
│   │   ├── app.ts
│   │   ├── config.ts           ← gitignored — your deploy values
│   │   └── config.example.ts
│   ├── lib/dropbox-stack.ts
│   ├── lambda/
│   │   ├── getPrivateFiles/handler.mjs
│   │   ├── getPrivateFiles/shareKey.mjs
│   │   ├── getDlivPhotoBuckets/handler.mjs
│   │   └── getDlivPhotos/handler.mjs
│   ├── scripts/
│   │   ├── deploy.sh
│   │   └── verify.sh
│   ├── package.json
│   ├── tsconfig.json
│   └── cdk.json
├── dropbox_outputs.json        ← gitignored — generated by deploy.sh
├── dropbox_outputs.example.json
├── CONTEXT.md
└── .gitignore
```
