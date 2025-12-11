import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ==============================
//  메모리 상태 (DB 없이 여기만 사용)
// ==============================

// 현재 곡: 없으면 null
// { songId: number|null, title: string, artist: string, memo: string }
let currentSong = null;

// 대기열: 배열
// { id, songId, title, artist, memo, position }
let queue = [];

// 대기열 아이템 ID 자동 증가용
let nextQueueItemId = 1;

// ==============================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// public 폴더 정적 제공 (admin.html, overlay.html)
app.use(express.static(path.join(__dirname, "public")));

/** API용 관리자 키 체크 (쓰기 작업 보호) */
function checkAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  const headerKey = req.headers["x-admin-key"];
  if (!adminKey) {
    return res
      .status(500)
      .json({ error: "ADMIN_KEY is not set in environment variables" });
  }
  if (headerKey !== adminKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/** /admin 페이지 Basic Auth 보호 */
function basicAuth(req, res, next) {
  const user = process.env.ADMIN_UI_USER;
  const pass = process.env.ADMIN_UI_PASS;

  if (!user || !pass) {
    return res
      .status(500)
      .send("ADMIN_UI_USER / ADMIN_UI_PASS not set on server");
  }

  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
    return res.status(401).send("Authentication required");
  }

  const base64 = auth.split(" ")[1];
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [reqUser, reqPass] = decoded.split(":");

  if (reqUser === user && reqPass === pass) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
  return res.status(401).send("Invalid credentials");
}

/* ==========================
   1. 큐 조회 (OBS / 누구나)
   ========================== */

// GET /api/queue
// → { current: {...} | null, next: {...} | null, queue: [...] }
app.get("/api/queue", (req, res) => {
  const next = queue.length > 0 ? queue[0] : null;

  res.json({
    current: currentSong,
    next,
    queue,
  });
});

/* ==========================
   2. 관리자용 큐 조작 API
   ========================== */

// POST /api/queue/add
// body: { songId?, title, artist, memo? }
app.post("/api/queue/add", checkAdmin, (req, res) => {
  const { songId, title, artist, memo } = req.body;

  if (!title || !artist) {
    return res
      .status(400)
      .json({ error: "title and artist are required" });
  }

  const position = queue.length > 0 ? queue[queue.length - 1].position + 1 : 1;

  const item = {
    id: nextQueueItemId++,
    songId: songId ?? null,
    title,
    artist,
    memo: memo ?? "",
    position,
  };

  queue.push(item);

  res.status(201).json(item);
});

// POST /api/queue/next
// → 대기열 맨 앞 곡을 현재곡으로 이동
app.post("/api/queue/next", checkAdmin, (req, res) => {
  if (queue.length === 0) {
    return res.status(400).json({ error: "Queue is empty" });
  }

  const nextItem = queue.shift(); // 맨 앞 제거
  currentSong = {
    songId: nextItem.songId,
    title: nextItem.title,
    artist: nextItem.artist,
    memo: nextItem.memo,
  };

  // position 재정렬
  queue = queue.map((item, index) => ({
    ...item,
    position: index + 1,
  }));

  res.json({ current: currentSong });
});

// POST /api/queue/current
// body: { songId?, title, artist, memo? }
// → 대기열과 상관없이 “지금 부르는 곡” 직접 지정
app.post("/api/queue/current", checkAdmin, (req, res) => {
  const { songId, title, artist, memo } = req.body;

  if (!title || !artist) {
    return res
      .status(400)
      .json({ error: "title and artist are required" });
  }

  currentSong = {
    songId: songId ?? null,
    title,
    artist,
    memo: memo ?? "",
  };

  res.json({ current: currentSong });
});

// DELETE /api/queue/:id
// → 대기열에서 특정 아이템 삭제
app.delete("/api/queue/:id", checkAdmin, (req, res) => {
  const id = Number(req.params.id);
  const index = queue.findIndex((item) => item.id === id);

  if (index === -1) {
    return res.status(404).json({ error: "Queue item not found" });
  }

  queue.splice(index, 1);

  // position 재정렬
  queue = queue.map((item, idx) => ({
    ...item,
    position: idx + 1,
  }));

  res.json({ success: true });
});

// POST /api/queue/reorder  (선택: 드래그로 순서 바꾸고 싶을 때 사용)
// body: { items: [{ id, position }, ...] }
app.post("/api/queue/reorder", checkAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }

  const posMap = new Map();
  for (const it of items) {
    posMap.set(Number(it.id), Number(it.position));
  }

  queue = queue.map((item) => ({
    ...item,
    position: posMap.get(item.id) ?? item.position,
  }));

  queue.sort((a, b) => a.position - b.position);

  res.json({ success: true });
});

/* ==========================
   3. 멜로밍 API 프록시 (노래책)
   ========================== */

const MELOMING_BASE = "https://api.meloming.com/v1";

// GET /api/meloming/songs  → 멜로밍 노래책 프록시
app.get("/api/meloming/songs", async (req, res) => {
  try {
    const channelId = process.env.MELOMING_CHANNEL_ID || "beberry";

    const response = await fetch(
      `${MELOMING_BASE}/songs/channel/${channelId}`
    );
    if (!response.ok) {
      return res.status(500).json({ error: "Failed to fetch from Meloming" });
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Meloming proxy error" });
  }
});

/* ==========================
   4. HTML 라우트
   ========================== */

// /admin → 관리자 페이지 (Basic Auth 보호)
app.get("/admin", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// /overlay/now-playing → OBS 브라우저 소스
app.get("/overlay/now-playing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "overlay.html"));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
