// Build Buddy — local server.
// Serves the camera page and proxies "ask" requests to Claude with the
// current webcam frame, the project instructions and the step you're on.
// The API key never reaches the browser.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- .env (no dependency) ---------------------------------------------------
try {
  const env = fs.readFileSync(path.join(here, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env file; rely on the environment */
}

const PORT = Number(process.env.BUDDY_PORT || 4790);
const MODEL = process.env.BUDDY_MODEL || "claude-opus-5-5";
const EFFORT = process.env.BUDDY_EFFORT || "medium"; // low | medium | high
const PROJECT_FILE = process.env.BUDDY_PROJECT || path.join(here, "project.json");
const MAX_HISTORY_TURNS = 12;

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error(
    "\nNo ANTHROPIC_API_KEY found. Put it in " + path.join(here, ".env") +
    " as ANTHROPIC_API_KEY=sk-ant-... (the file is gitignored) or export it before starting.\n" +
    "The page will load, but every Ask will fail until a key is set.\n",
  );
}

const client = new Anthropic();

// ---- project knowledge -------------------------------------------------------
function loadProject() {
  return JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
}

function systemPrompt(project) {
  return [
    `You are Build Buddy, a hands-on helper sitting next to someone who is building "${project.name}" at their workbench. ` +
      "A webcam is pointed at the bench. Each message brings one or two camera frames: the full view and, when present, a zoomed crop of the center. " +
      "The person asks out loud and is holding or pointing at things, so answer like a friend leaning over the bench, not like a manual.",
    "",
    "How to answer:",
    "- Lead with the verdict in one short sentence: yes that's the right part / no that's X / looks right / one thing is off.",
    "- Then at most three short sentences of why or what to do next. Plain words. No headings, no bullet lists, no markdown.",
    "- Describe what you actually see in the frame (color, shape, markings, position) so the person can tell whether you are looking at the right thing.",
    "- If the frame is too blurry, dark, far away or the part is hidden, say exactly what to change: move closer, turn it over, show the stripe, hold it against a plain background.",
    "- When something looks wrong or risky, say so first and say how to fix it. Safety notes are below.",
    "- Never invent a detail you cannot see. If you are unsure between two parts, say which two and what would settle it.",
    "- The person tells you which step they are on. Stay on that step unless they ask what comes next.",
    "",
    "Project knowledge (JSON):",
    JSON.stringify(project, null, 1),
  ].join("\n");
}

// ---- helpers ----------------------------------------------------------------
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function dataUrlToImageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---- /ask -------------------------------------------------------------------
async function handleAsk(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad request: " + e.message }));
    return;
  }

  const project = loadProject();
  const question = String(payload.question || "").trim() || "Is what I'm holding right for this step?";
  const stepIndex = Number.isInteger(payload.stepIndex) ? payload.stepIndex : 0;
  const step = project.steps[stepIndex] || project.steps[0];
  const images = (payload.images || []).map(dataUrlToImageBlock).filter(Boolean).slice(0, 2);

  // Earlier turns, text only (images from past turns are not re-sent).
  const history = Array.isArray(payload.history) ? payload.history : [];
  const priorTurns = history
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content }));

  const content = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: i === 0 ? "Camera, full view:" : "Camera, zoomed crop of the center:" });
    content.push(img);
  });
  content.push({
    type: "text",
    text:
      `I'm on step ${step.n} of ${project.steps.length}: "${step.title}". ` +
      `Step says: ${step.caption}\n\n` +
      (images.length ? "" : "(No camera frame this time.)\n") +
      `My question: ${question}`,
  });

  const messages = [...priorTurns, { role: "user", content }];

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    sse(res, "error", { message: "No API key. Add ANTHROPIC_API_KEY=sk-ant-... to .env next to server.mjs and restart with npm start." });
    res.end();
    return;
  }

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 1024,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: EFFORT },
        system: [{ type: "text", text: systemPrompt(project), cache_control: { type: "ephemeral" } }],
        messages,
      },
      { signal: controller.signal },
    );

    stream.on("text", (delta) => sse(res, "text", { delta }));

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sse(res, "error", { message: "Claude declined to answer this one. Rephrase the question or change the view." });
    }
    sse(res, "done", {
      stop_reason: final.stop_reason,
      model: final.model,
      usage: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cache_read: final.usage.cache_read_input_tokens ?? 0,
        cache_write: final.usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (err) {
    if (controller.signal.aborted) {
      /* client went away */
    } else if (err instanceof Anthropic.AuthenticationError) {
      sse(res, "error", { message: "The API key was rejected. Check ANTHROPIC_API_KEY in .env and restart the server." });
    } else if (err instanceof Anthropic.RateLimitError) {
      sse(res, "error", { message: "Rate limited. Wait a few seconds and ask again." });
    } else if (err instanceof Anthropic.BadRequestError) {
      sse(res, "error", { message: "Bad request: " + err.message });
    } else if (err instanceof Anthropic.APIError) {
      sse(res, "error", { message: `API error ${err.status}: ${err.message}` });
    } else {
      sse(res, "error", { message: err.message || String(err) });
    }
    console.error("[ask]", err?.message || err);
  } finally {
    res.end();
  }
}

// ---- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/ask") return handleAsk(req, res);
  if (req.method === "GET" && url.pathname === "/project.json") {
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-cache" });
    res.end(fs.readFileSync(PROJECT_FILE));
    return;
  }
  if (req.method === "GET" && url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    res.end(JSON.stringify({ model: MODEL, effort: EFFORT, hasKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) }));
    return;
  }
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(here, "public", path.normalize(rel));
    if (!filePath.startsWith(path.join(here, "public"))) {
      res.writeHead(403);
      res.end();
      return;
    }
    return serveStatic(res, filePath);
  }
  res.writeHead(405);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  const project = loadProject();
  console.log(`Build Buddy for "${project.name}" (${project.steps.length} steps)`);
  console.log(`Model ${MODEL}, effort ${EFFORT}`);
  console.log(`Open http://localhost:${PORT}`);
});
