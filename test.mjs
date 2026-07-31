// Smoke test: boots the real server, mocks only the GitHub API call.
const realFetch = globalThis.fetch;
let capturedGitHubBody = null;

globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes("api.github.com")) {
    capturedGitHubBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        content: {
          download_url:
            "https://raw.githubusercontent.com/me/repo/main/" +
            decodeURI(String(url).split("/contents/")[1]),
        },
      }),
    };
  }
  return realFetch(url, opts); // real requests to localhost
};

process.env.GITHUB_TOKEN = "fake";
process.env.GITHUB_OWNER = "me";
process.env.GITHUB_REPO = "repo";
process.env.GITHUB_BRANCH = "main";
process.env.PORT = "3999";
process.env.UPLOAD_PASSWORD = "secret";
process.env.MAX_UPLOAD_MB = "1";

await import("./server.js");
await new Promise((r) => setTimeout(r, 500));

const base = "http://localhost:3999";
let pass = 0, fail = 0;
const check = (name, cond) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// 1. config endpoint
const cfg = await realFetch(base + "/api/config").then((r) => r.json());
check("config: password required", cfg.passwordRequired === true);
check("config: repo shown", cfg.repo === "me/repo");

// 2. upload without password → 401
{
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("fake mp3")], { type: "audio/mpeg" }), "song.mp3");
  const r = await realFetch(base + "/api/upload", { method: "POST", body: fd });
  check("no password → 401", r.status === 401);
}

// 3. wrong extension → 400
{
  const fd = new FormData();
  fd.append("password", "secret");
  fd.append("file", new Blob([Buffer.from("x")], { type: "text/plain" }), "note.txt");
  const r = await realFetch(base + "/api/upload", { method: "POST", body: fd });
  check("bad extension → 400", r.status === 400);
}

// 4. valid upload → 200 with links, cyrillic name sanitized
{
  const fd = new FormData();
  fd.append("password", "secret");
  fd.append("file", new Blob([Buffer.from("ID3 fake")], { type: "audio/mpeg" }), "Моя Песня!.mp3");
  const r = await realFetch(base + "/api/upload", { method: "POST", body: fd });
  const j = await r.json();
  check("valid upload → 200", r.status === 200 && j.ok === true);
  check("returns jsdelivr url", /cdn\.jsdelivr\.net\/gh\/me\/repo@main\/audio\//.test(j.jsdelivrUrl || ""));
  check("returns raw url", /raw\.githubusercontent\.com\/me\/repo\/main\/audio\//.test(j.rawUrl || ""));
  check("path ends with .mp3", (j.path || "").endsWith(".mp3"));
  check("cyrillic sanitized to ascii", /^audio\/[a-z0-9.\-]+$/.test(j.path || ""));
  check("github received base64 content", typeof capturedGitHubBody?.content === "string" && capturedGitHubBody.content.length > 0);
}

// 5. oversized file → 400 (limit is 1 MB)
{
  const fd = new FormData();
  fd.append("password", "secret");
  fd.append("file", new Blob([Buffer.alloc(1.5 * 1024 * 1024)], { type: "audio/mpeg" }), "big.mp3");
  const r = await realFetch(base + "/api/upload", { method: "POST", body: fd });
  check("oversized → 400", r.status === 400);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
