(function () {
  "use strict";
  const CFG = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const DEMO = !CFG.firebase.projectId; // 설정이 비어 있으면 시연 모드
  const CHANNEL = "special-class-call-" + CFG.schoolId;

  const state = { user: null, soundBlobUrl: null, audioCtx: null, repeatTimer: null, activeCallId: null };

  // ---------- 저장 (기기 안, IndexedDB) ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("special-class-call", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kvGet(key) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvSet(key, value) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ---------- 로그·상태 ----------
  function setStatus(text) { $("status").textContent = text; }
  function log(text) {
    const p = document.createElement("p");
    p.textContent = new Date().toLocaleTimeString("ko-KR") + "  " + text;
    $("log").prepend(p);
  }

  // ---------- 통신 계층 (시연 모드: BroadcastChannel / 실제 모드: Firebase 자리) ----------
  const bus = DEMO ? new BroadcastChannel(CHANNEL) : null;
  function publish(msg) {
    if (DEMO) { bus.postMessage(msg); handle(msg); return; }
    // 실제 모드: Firestore에 호출 문서를 쓰고 FCM으로 등록 기기에 알림을 보냅니다.
    // 구현은 2단계에서 Firebase 설정값을 받은 뒤 채웁니다.
    log("실제 연결 설정이 아직 없어 시연 모드로만 동작합니다.");
    handle(msg);
  }
  if (DEMO) bus.onmessage = (e) => handle(e.data);

  // ---------- 알람 ----------
  function audio() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return state.audioCtx;
  }
  function volume() { return Number($("volume").value); }

  function beepOnce(ctx, freq, start, dur, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(start); o.stop(start + dur + 0.02);
  }

  async function playSound() {
    if (!$("sound-on").checked) return;
    const choice = $("sound-choice").value;
    const ctx = audio();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (_) {} }
    if (choice === "custom" && state.soundBlobUrl) {
      const a = new Audio(state.soundBlobUrl);
      a.volume = volume();
      a.play().catch(() => { log("음악 재생이 막혔습니다. 화면을 한 번 누른 뒤 다시 시도하세요."); });
      return;
    }
    const t = ctx.currentTime, v = volume() * 0.4;
    if (choice === "chime") {
      [523, 659, 784].forEach((f, i) => beepOnce(ctx, f, t + i * 0.35, 0.3, v));
    } else {
      for (let i = 0; i < 3; i++) beepOnce(ctx, 880, t + i * 0.5, 0.35, v);
    }
  }

  function showAlarm(title, detail, isDrill) {
    $("alarm-title").textContent = (isDrill ? "[훈련] " : "") + title;
    $("alarm-detail").textContent = detail;
    $("alarm").classList.remove("hidden");
    $("alarm").classList.toggle("flash", $("visual-on").checked);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  }
  function hideAlarm() {
    $("alarm").classList.add("hidden");
    $("alarm").classList.remove("flash");
  }

  function startRepeat(callId) {
    stopRepeat();
    state.repeatTimer = setInterval(() => {
      if (!state.activeCallId || state.activeCallId !== callId) return stopRepeat();
      playSound();
    }, 4000);
  }
  function stopRepeat() {
    if (state.repeatTimer) clearInterval(state.repeatTimer);
    state.repeatTimer = null;
  }

  // ---------- 메시지 처리 ----------
  function handle(msg) {
    if (!state.user) return; // 로그인한 기기만 알람을 받습니다
    if (msg.type === "call" && msg.room && msg.schoolId === CFG.schoolId) {
      state.activeCallId = msg.id;
      const who = msg.by + "(" + msg.role + ")";
      showAlarm(msg.room + " 비상 호출", who + " · " + new Date(msg.at).toLocaleTimeString("ko-KR"), msg.drill);
      log((msg.drill ? "훈련 " : "") + msg.room + " 호출 수신");
      playSound();
      startRepeat(msg.id);
    } else if (msg.type === "ack" && msg.callId === state.activeCallId) {
      state.activeCallId = null;
      stopRepeat();
      hideAlarm();
      log(msg.by + " 확인");
    }
  }

  // ---------- 이벤트 ----------
  async function login() {
    const name = $("user-name").value.trim();
    const room = $("room").value.trim();
    if (!name || !room) { alert("이름과 교실을 입력하세요."); return; }
    state.user = { name, role: $("user-role").selectedOptions[0].textContent, room };
    await kvSet("user", state.user);
    showMain();
    audio(); // 사용자 클릭 뒤에 오디오를 준비해 자동 재생 차단을 줄입니다
    log("로그인: " + name + " (" + state.user.role + ")");
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function showMain() {
    $("login-panel").classList.add("hidden");
    $("call-panel").classList.remove("hidden");
    $("settings-panel").classList.remove("hidden");
    $("who").textContent = state.user.room + " · " + state.user.name + " 님 (" + state.user.role + ")";
    setStatus(DEMO ? "시연 모드" : "연결됨");
  }

  function sendCall(drill) {
    if (!state.user) return;
    const msg = {
      type: "call", id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      schoolId: CFG.schoolId, room: state.user.room, by: state.user.name,
      role: state.user.role, at: Date.now(), drill: !!drill
    };
    publish(msg);
  }

  $("login-btn").addEventListener("click", login);
  $("call-btn").addEventListener("click", () => sendCall(false));
  $("drill-btn").addEventListener("click", () => sendCall(true));
  $("ack-btn").addEventListener("click", () => {
    if (!state.activeCallId) return hideAlarm();
    const msg = { type: "ack", callId: state.activeCallId, by: state.user.name, at: Date.now() };
    publish(msg);
    handle(msg);
  });
  $("test-alarm").addEventListener("click", playSound);
  $("sound-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > CFG.maxSoundBytes) {
      $("sound-file-info").textContent = "2MB를 넘는 파일은 올릴 수 없습니다.";
      e.target.value = ""; return;
    }
    await kvSet("sound", { name: f.name, blob: f });
    if (state.soundBlobUrl) URL.revokeObjectURL(state.soundBlobUrl);
    state.soundBlobUrl = URL.createObjectURL(f);
    $("sound-choice").value = "custom";
    $("sound-file-info").textContent = "저장됨: " + f.name;
  });

  // ---------- 시작 ----------
  async function init() {
    const saved = await kvGet("user").catch(() => null);
    const snd = await kvGet("sound").catch(() => null);
    if (snd && snd.blob) {
      state.soundBlobUrl = URL.createObjectURL(snd.blob);
      $("sound-file-info").textContent = "저장됨: " + snd.name;
    }
    if (saved) {
      state.user = saved;
      $("user-name").value = saved.name;
      $("room").value = saved.room;
      showMain();
    }
    setStatus(DEMO ? "시연 모드" : "연결 중");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  init();
})();
