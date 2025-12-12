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
// { songId: number|null, title: string, artist: string }
let currentSong = null;

// 대기열: 배열
// { id, songId, title, artist, position }
let queue = [];

// 대기열 아이템 ID 자동 증가용
let nextQueueItemId = 1;

// SSE 구독자 (오버레이 연결들)
const sseClients = new Set();

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
   공용: 현재 상태 스냅샷 & SSE 브로드캐스트
   ========================== */

function getQueueSnapshot() {
  const next = queue.length > 0 ? queue[0] : null;
  return {
    current: currentSong,
    next,
    queue,
  };
}

function broadcastQueue() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(getQueueSnapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      console.error("SSE write error:", e);
    }
  }
}

/* ==========================
   1. 큐 조회 (OBS / 누구나)
   ========================== */

// GET /api/queue
// → { current: {...} | null, next: {...} | null, queue: [...] }
app.get("/api/queue", (req, res) => {
  res.json(getQueueSnapshot());
});

// GET /api/queue/stream (SSE)
// → 오버레이가 여기에 EventSource로 붙어서 실시간 업데이트 받음
app.get("/api/queue/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 재연결 간격 힌트
  res.write("retry: 5000\n\n");

  // 처음 접속 시 현재 상태 한 번 보내기
  res.write(`data: ${JSON.stringify(getQueueSnapshot())}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/* ==========================
   2. 관리자용 큐 조작 API
   ========================== */

// POST /api/queue/add
// body: { songId?, title, artist }
app.post("/api/queue/add", checkAdmin, (req, res) => {
  const { songId, title, artist } = req.body;

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
    position,
  };

  queue.push(item);

  broadcastQueue();
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
  };

  // position 재정렬
  queue = queue.map((item, index) => ({
    ...item,
    position: index + 1,
  }));

  broadcastQueue();
  res.json({ current: currentSong });
});

// POST /api/queue/current
// body: { songId?, title, artist }
// → 대기열과 상관없이 “지금 부르는 곡” 직접 지정
app.post("/api/queue/current", checkAdmin, (req, res) => {
  const { songId, title, artist } = req.body;

  if (!title || !artist) {
    return res
      .status(400)
      .json({ error: "title and artist are required" });
  }

  currentSong = {
    songId: songId ?? null,
    title,
    artist,
  };

  broadcastQueue();
  res.json({ current: currentSong });
});

// POST /api/queue/current/clear
// → 현재곡을 완전히 비우기 (null로)
app.post("/api/queue/current/clear", checkAdmin, (req, res) => {
  currentSong = null;
  broadcastQueue();
  res.json({ current: null });
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

  broadcastQueue();
  res.json({ success: true });
});

// POST /api/queue/reorder
// body: { items: [{ id, position }, ...] }
// → 드래그로 순서 바꾼 결과를 서버에 반영
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

  broadcastQueue();
  res.json({ success: true });
});

/* ==========================
   3. 멜로밍 API 프록시 (노래책 전체)
   ========================== */

const MELOMING_BASE = "https://api.meloming.com/v1";

// GET /api/meloming/songs  → 멜로밍 노래책 "전체" 모아서 반환
app.get("/api/meloming/songs", async (req, res) => {
  try {
    const channelId = process.env.MELOMING_CHANNEL_ID || "beberry";

    const limit = 100; // 한 번에 최대 100곡
    const MAX_PAGES = 10; // 안전장치: 최대 10페이지(=1000곡)까지만

    let page = 1;
    let allSongs = [];

    while (page <= MAX_PAGES) {
      const url = `${MELOMING_BASE}/songs/channel/${channelId}?page=${page}&limit=${limit}&sortBy=title`;

      const response = await fetch(url);
      if (!response.ok) {
        try {
          const text = await response.text();
          console.error("Meloming fetch error:", response.status, text);
        } catch (e2) {
          console.error("Meloming fetch error:", response.status);
        }
        return res.status(500).json({ error: "Failed to fetch from Meloming" });
      }

      const data = await response.json();
      const batch = Array.isArray(data)
        ? data
        : Array.isArray(data.songs)
        ? data.songs
        : [];

      allSongs = allSongs.concat(batch);

      if (batch.length < limit) {
        break;
      }

      page += 1;
    }

    res.json(allSongs);
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

// 선택: 루트 페이지 간단 안내
app.get("/", (req, res) => {
  res.send(
    '<h1>Song Queue Server</h1>' +
      '<p><a href="/admin">관리자 페이지</a></p>' +
      '<p><a href="/overlay/now-playing">오버레이</a></p>'
  );
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
