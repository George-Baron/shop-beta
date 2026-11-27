# Product photos by link (Image URLs column)

- The product import/export file has an **Image URLs** column. Put up to 5 `https://` links per product, separated by a space, comma, `;` or `|`.
- On import choose **copy photos into our storage** (default; runs in the background, products are saved at once) or **use the links as they are** (no download; https only).
- Progress and failures (with the reason) show on the finish screen; **Retry failed photos** tries again and keeps photos already copied.
- Copying needs working product-image storage (Supabase bucket or local). Links must be public JPG/PNG/WebP; private network addresses are refused.
- Update mode adds new photos after the existing ones (max 8 per product); a blank cell keeps current photos. Exports contain full links, so export then re-import changes nothing.
