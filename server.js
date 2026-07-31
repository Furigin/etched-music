import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Configuration (from environment / .env) ----------------------------
const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = "main",
  UPLOAD_DIR = "audio",
  UPLOAD_PASSWORD = "",
} = process.env;

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

// Extensions Etched can play. Others are rejected so the repo isn't abused.
const ALLOWED_EXT = new Set([".mp3", ".ogg", ".wav", ".opus", ".flac", ".m4a", ".aac"]);

// Fail fast if the server is misconfigured.
for (const [key, val] of Object.entries({ GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO })) {
  if (!val) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---- Helpers ------------------------------------------------------------
function sanitize(name) {
  const ext = path.extname(name).toLowerCase();
  const base = path
    .basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // strip anything unsafe / non-ascii (e.g. Cyrillic)
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "track";
  return { base, ext };
}

function requirePassword(req, res) {
  if (!UPLOAD_PASSWORD) return true;
  const given = req.get("x-upload-password") || req.body?.password || "";
  if (given === UPLOAD_PASSWORD) return true;
  res.status(401).json({ error: "Неверный пароль загрузки." });
  return false;
}

// ---- Routes -------------------------------------------------------------

// Lets the frontend know how to render (password needed? size limit? repo?).
app.get("/api/config", (_req, res) => {
  res.json({
    passwordRequired: Boolean(UPLOAD_PASSWORD),
    maxUploadMb: MAX_UPLOAD_MB,
    repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH,
    allowedExtensions: [...ALLOWED_EXT],
  });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!requirePassword(req, res)) return;
    if (!req.file) return res.status(400).json({ error: "Файл не передан." });

    const { base, ext } = sanitize(req.file.originalname);
    if (!ALLOWED_EXT.has(ext)) {
      return res.status(400).json({
        error: `Тип "${ext || "без расширения"}" не поддерживается. Разрешено: ${[...ALLOWED_EXT].join(", ")}`,
      });
    }

    // Unique path so uploads never overwrite each other.
    const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const repoPath = `${UPLOAD_DIR}/${unique}-${base}${ext}`.replace(/^\/+/, "");

    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(repoPath)}`;
    const ghRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "etched-uploader",
      },
      body: JSON.stringify({
        message: `Add ${repoPath}`,
        content: req.file.buffer.toString("base64"),
        branch: GITHUB_BRANCH,
      }),
    });

    const data = await ghRes.json().catch(() => ({}));
    if (!ghRes.ok) {
      const msg = data?.message || `GitHub API error ${ghRes.status}`;
      return res.status(502).json({ error: `GitHub: ${msg}` });
    }

    const rawUrl =
      data?.content?.download_url ||
      `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoPath}`;
    const jsdelivrUrl = `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}/${repoPath}`;

    res.json({ ok: true, path: repoPath, rawUrl, jsdelivrUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Внутренняя ошибка сервера." });
  }
});

// Multer errors (e.g. file too large) arrive here.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? `Файл больше ${MAX_UPLOAD_MB} МБ.`
        : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`Etched uploader → http://localhost:${PORT}`);
  console.log(`Repo: ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}, dir: ${UPLOAD_DIR}/`);
});
