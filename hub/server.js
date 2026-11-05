#!/usr/bin/env node
// 특수학급 비상호출 중계 서버 (학교 내부망 전용, 외부 패키지 없이 Node 기본 기능만 사용)
// 실행: node server.js                                  (서버 시작)
//       node server.js add-school "학교명" "학교코드"    (학교 등록, 관리자 1회)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "schools.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 4096;

// ---------- 학교 등록 정보 ----------
function loadSchools() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) { return { schools: [] }; }
}
function saveSchools(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

if (process.argv[2] === "add-school") {
  const name = process.argv[3], code = (process.argv[4] || "").toUpperCase();
  if (!name || !/^[A-Z0-9]{6,12}$/.test(code)) {
    console.log("사용법: node server.js add-school \"학교명\" \"학교코드(영문 대문자·숫자 6~12자)\"");
    process.exit(1);
  }
  const data = loadSchools();
  if (data.schools.some((s) => s.code === code)) { console.log("이미 있는 학교 코드입니다."); process.exit(1); }
  data.schools.push({ name, code, createdAt: new Date().toISOString() });
  saveSchools(data);
  console.log("등록 완료:", name, code);
  process.exit(0);
}

// ---------- 내부망 확인 ----------
function isPrivateAddress(addr) {
  const a = (addr || "").replace("::ffff:", "");
  if (a === "127.0.0.1" || a === "::1") return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

// ---------- 상태 (메모리, 서버를 끄면 사라짐) ----------
const sessions = new Map();   // token -> { schoolCode, schoolName, name, role, room }
const activeCall = new Map(); // schoolCode -> { id, room, by, role, at, drill, acked: Set }
const clients = new Map();    // schoolCode -> Set of SSE responses

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function clean(s, max) { return String(s || "").trim().slice(0, max); }
function broadcast(schoolCode, event, data) {
  const set = clients.get(schoolCode);
  if (!set) return;
  const line = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of set) res.write(line);
}
function sessionFrom(url, body) {
  const token = clean((body && body.token) || url.searchParams.get("token"), 64);
  return sessions.get(token) || null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

const server = http.createServer(async (req, res) => {
  if (!isPrivateAddress(req.socket.remoteAddress)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("학교 내부망에서만 접속할 수 있습니다.");
  }
  const url = new URL(req.url, "http://localhost");

  // 정적 파일 (화면)
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(400); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("없는 파일입니다."); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(buf);
    });
    return;
  }

  // 입장: 학교 코드 + 이름 + 교실
  if (req.method === "POST" && url.pathname === "/api/join") {
    let body;
    try { body = await readBody(req); } catch (_) { return sendJson(res, 400, { error: "잘못된 요청입니다." }); }
    const code = clean(body.schoolCode, 12).toUpperCase();
    const school = loadSchools().schools.find((s) => s.code === code);
    if (!school) return sendJson(res, 403, { error: "학교 코드가 맞지 않습니다." });
    const name = clean(body.name, 20), room = clean(body.room, 30), role = clean(body.role, 20);
    if (!name || !room) return sendJson(res, 400, { error: "이름과 교실을 입력하세요." });
    const token = crypto.randomBytes(16).toString("hex");
    const s = { schoolCode: code, schoolName: school.name, name, role, room };
    sessions.set(token, s);
    return sendJson(res, 200, { token, ...s });
  }

  // 실시간 수신 (SSE)
  if (req.method === "GET" && url.pathname === "/api/events") {
    const s = sessionFrom(url, null);
    if (!s) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    if (!clients.has(s.schoolCode)) clients.set(s.schoolCode, new Set());
    clients.get(s.schoolCode).add(res);
    const current = activeCall.get(s.schoolCode);
    if (current) res.write("event: call\ndata: " + JSON.stringify(publicCall(current)) + "\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clients.get(s.schoolCode)?.delete(res); });
    return;
  }

  // 비상 호출
  if (req.method === "POST" && url.pathname === "/api/call") {
    let body;
    try { body = await readBody(req); } catch (_) { return sendJson(res, 400, { error: "잘못된 요청입니다." }); }
    const s = sessionFrom(url, body);
    if (!s) return sendJson(res, 401, { error: "다시 입장해 주세요." });
    const call = {
      id: crypto.randomBytes(6).toString("hex"), room: s.room, by: s.name, role: s.role,
      at: Date.now(), drill: !!body.drill, acked: new Map()
    };
    activeCall.set(s.schoolCode, call);
    broadcast(s.schoolCode, "call", publicCall(call));
    return sendJson(res, 200, { ok: true, id: call.id });
  }

  // 확인 응답
  if (req.method === "POST" && url.pathname === "/api/ack") {
    let body;
    try { body = await readBody(req); } catch (_) { return sendJson(res, 400, { error: "잘못된 요청입니다." }); }
    const s = sessionFrom(url, body);
    if (!s) return sendJson(res, 401, { error: "다시 입장해 주세요." });
    const call = activeCall.get(s.schoolCode);
    if (!call || call.id !== clean(body.callId, 20)) return sendJson(res, 404, { error: "이미 끝난 호출입니다." });
    call.acked.set(s.name + "·" + s.room, Date.now());
    broadcast(s.schoolCode, "ack", { callId: call.id, by: s.name, room: s.room, at: Date.now(), acked: call.acked.size });
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404); res.end();
});

function publicCall(c) {
  return { id: c.id, room: c.room, by: c.by, role: c.role, at: c.at, drill: c.drill, ackedCount: c.acked.size };
}

function localIPv4() {
  const os = require("os");
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal && isPrivateAddress(n.address)) found.push(n.address);
    }
  }
  return found;
}

server.listen(PORT, "0.0.0.0", () => {
  const ips = localIPv4();
  const schools = loadSchools().schools;
  console.log("");
  console.log("=== 비상호출 중계 서버가 시작되었습니다 ===");
  console.log("이 창을 닫으면 서버가 꺼집니다. 열어 두십시오.");
  console.log("");
  if (!schools.length) console.log("아직 등록된 학교가 없습니다. 관리자 안내를 따라 학교를 먼저 등록하세요.");
  for (const s of schools) {
    for (const ip of (ips.length ? ips : ["(IP 확인 불가)"])) {
      console.log("[" + s.name + "] 선생님 접속 링크: http://" + ip + ":" + PORT + "/?code=" + s.code);
    }
  }
  console.log("");
  console.log("위 링크를 학교 선생님들께 전달하세요. 같은 학교 와이파이에서만 열립니다.");
});
