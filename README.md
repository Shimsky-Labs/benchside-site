# Build Buddy

A live camera helper for a physical build. Point a webcam at your bench, keep the page open, and when you are not sure, hold Space and ask: "is this the right part?", "which way does the stripe go?", "what's next?". The current frame, the project's full instructions and the step you are on go to Claude, and the answer streams back and is read aloud.

The first project loaded is the **Tello Charging Dock** (13 steps). Swap `project.json` for any other build.

## Run

```bash
cd ~/Desktop/repos/build-buddy
cp .env.example .env        # then put your key in it: ANTHROPIC_API_KEY=sk-ant-...
npm start                   # http://localhost:4790
```

Open it in Chrome (push-to-talk uses Chrome's speech recognition; Safari and Firefox still work with typed questions). Allow camera access for localhost. An iPhone on the same Apple ID shows up as a camera (Continuity Camera) and makes a good bench cam.

## Using it

- **Pick the step** with the arrows next to the title or the `←` `→` keys. The "What right looks like" list is what Buddy checks against.
- **Hold Space** (or the mic button) and talk, release to send. Or type and press Enter. The quick chips cover the common questions.
- Every ask sends the full frame plus a zoomed crop of the center (the dashed box). Put the part inside the box for small things like the diodes. Untick "also send zoomed center crop" to send only the full frame.
- "Read answers aloud" uses the Mac's speech voice. Untick it to read instead.
- Ask again while an answer streams to stop it.

## How it works

`server.mjs` is a dependency-free Node server. It serves `public/index.html`, and `POST /ask` takes the question, the step index, up to two JPEG frames and the last few text turns, then streams Claude's reply back as server-sent events. The project JSON is sent as a cached system prompt, so repeat asks mostly pay for the images and the answer.

The browser never sees the API key. Only the server reads `.env`.

Model and effort are set in `.env`:

| Variable | Default | Notes |
|---|---|---|
| `BUDDY_MODEL` | `claude-opus-5-5` | Any current vision model |
| `BUDDY_EFFORT` | `medium` | `low` answers faster, `high` inspects more carefully |
| `BUDDY_PORT` | `4790` | |
| `BUDDY_PROJECT` | `./project.json` | Point at another build |

Requests opt into the server-side refusal fallback (`fallbacks: "default"`), so a safety-classifier decline on the main model is retried on a fallback model inside the same call instead of failing.

## Writing a project file

`project.json` has `name`, `summary`, `parts` (with an `identify` field describing what each part looks like on camera), `steps` (each with `title`, `caption` and a `checks` list of what a correct result looks like) and `safety`. The `checks` and `identify` fields are what make the answers specific, so spend the words there.
