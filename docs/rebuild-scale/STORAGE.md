# Product photos (Supabase Storage)

Photos are stored in one public Supabase Storage bucket, so every instance of the shop shows the same photos and nothing is written to a server disk. Cost: included in Supabase Pro (no extra service).

## Set up (about 5 minutes)
1. In your Supabase project: **Project Settings > API**. Copy the **Project URL** and the **service_role** key.
2. Put them in the environment (Render: Environment tab; local: `.env`):
   - `SUPABASE_URL=https://xxxx.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=...` (secret: server only, never in the browser, never in git)
   - `SUPABASE_BUCKET=shop-images`
3. Check it works, from your computer with those variables set: `npm run check:storage`. It creates the bucket if needed, uploads a 1-pixel image, reads it back from its public address, and deletes it. It prints `PASS` or says what failed.
4. Start the shop. The log says `Photos: Supabase Storage.` and the admin photo upload now saves there.

If the keys are missing in production, uploads answer "photo storage is not set up" rather than saving to a disk that disappears.

## Move your existing photos
Use the copy of the old `uploads` folder from the live server (Render disk or the machine it ran on).
1. `npm run migrate:images -- --dir /path/to/uploads --dry-run` lists what it would move and any files it cannot find. Changes nothing.
2. `npm run migrate:images -- --dir /path/to/uploads` uploads each photo, reads it back, and only then updates the database links (products, order items, settings), all in one transaction.
- Files missing from the folder are listed and left as they are. Copy them in and run again.
- Nothing is deleted from your disk. It is safe to run again.
- This changes data of the site it points at. Point `DATABASE_URL` at staging first; run it on the live database only when you have said so.

## Notes
- Limits: 2 MB per photo; png, jpg, webp, gif only (set when the bucket is created and checked by the app).
- Old `/uploads/<name>` links redirect to the stored photo.
- Optional `PUBLIC_IMAGE_BASE_URL` serves photos through your own domain or a CDN.
