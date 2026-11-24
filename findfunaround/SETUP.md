# findfunaround.me: fresh setup (all free)

## A. Keys
- Gemini: aistudio.google.com > Get API key
- Pixabay: pixabay.com/api/docs/ (logged in) > your key is shown
- YouTube (optional): skip it if unsure

## B. New GitHub repo
1. github.com > New repository > name `findfunaround` > Public > Create.
2. Click "uploading an existing file". Drag in everything from the unzipped folder EXCEPT the
   file `COPY-THIS-auto-post.yml` (and the hidden .github folder if it will not drag). Commit.
3. Add the workflow: Add file > Create new file. In the name box type exactly
   `.github/workflows/auto-post.yml`  (each / makes a folder).
   Paste the whole content of `COPY-THIS-auto-post.yml`. Commit.
4. Settings > Secrets and variables > Actions > New repository secret:
   `GEMINI_API_KEY`, `PIXABAY_API_KEY` (and `YOUTUBE_API_KEY` if you have one).
   Names must match exactly. Paste values with no spaces or quotes.
5. Check the repo's Code tab shows: scripts, content, netlify.toml, package.json, sources.json.

## C. First run (do this BEFORE Netlify, so it deploys once with real posts)
Actions tab > "Auto post" > Run workflow. It takes 2-5 minutes (6 posts, with pauses).
Green run + new files in content/posts = success. A red run now shows the exact reason in the log.

## D. Netlify
Add new project > Import from GitHub > pick the repo > Deploy (settings come from netlify.toml).
Then Domain management > Add domain `findfunaround.me` and follow the DNS steps.

## Notes
- It posts every 3 days (6 posts per run) because Netlify Free allows ~20 deploys/month.
- Delete a bad post by deleting its file in content/posts.
