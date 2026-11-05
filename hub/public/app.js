(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "scc-session";
  const POLL_MS = 1500;
  const state = {
    session: null, activeCallId: null, lastSeenCallId: null,
    ackedIds: new Set(), repeatTimer: null, pollTimer: null, audioCtx: null
  };

  function setStatus(t) { $("status").textContent = t; }
  function log(t) {
    const p = document.createElement("p");
    p.textContent = new Date().toLocaleTimeString("ko-KR") + "  " + t;
    $("log").prepend(p);
  }

  // ---------- 소리 ----------
  function ctx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return state.audioCtx;
  }
  function beep(c, freq, start, dur, vol) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start); o.stop(start + dur + 0.02);
  }
  function playSound() {
    if (!$("sound-on").checked) return;
    const c = ctx();
    if (c.state === "suspended") c.resume().catch(() => {});
    const t = c.currentTime, v = Number($("volume").value) * 0.4;
    if ($("sound-choice").value === "chime") {
      [523, 659, 784].forEach((f, i) => beep(c, f, t + i * 0.35, 0.3, v));
    } else {
      for (let i = 0; i < 3; i++) beep(c, 880, t + i * 0.5, 0.35, v);
    }
  }

  // ---------- 화면 꺼짐 방지 ----------
  let wakeLock = null;
  async function keepAwake() {
    if (!("wakeLock" in navigator)) return;
    if (!$("keep-awake").checked || !state.session || document.visibilityState !== "visible") return releaseWake();
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", keepAwake);
  $("keep-awake").addEventListener("change", keepAwake);

  // ---------- 알람 화면 ----------
  function showAlarm(title, detail, drill) {
    $("alarm-title").textContent = (drill ? "[훈련] " : "") + title;
    $("alarm-detail").textContent = detail;
    $("alarm").classList.remove("hidden");
    $("alarm").classList.toggle("flash", $("visual-on").checked);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  }
  function hideAlarm() {
    $("alarm").classList.add("hidden");
    $("alarm").classList.remove("flash");
  }
  function startRepeat(id) {
    stopRepeat();
    state.repeatTimer = setInterval(() => {
      if (state.activeCallId !== id) return stopRepeat();
      playSound();
    }, 4000);
  }
  function stopRepeat() { if (state.repeatTimer) clearInterval(state.repeatTimer); state.repeatTimer = null; }

  // ---------- 호출 수신 (1.5초마다 확인) ----------
  function onCall(c) {
    if (state.ackedIds.has(c.id)) return;
    state.activeCallId = c.id;
    showAlarm(c.room + " 비상 호출", c.by + "(" + c.role + ") · " + new Date(c.at).toLocaleTimeString("ko-KR"), c.drill);
    log((c.drill ? "훈련 " : "") + c.room + " 호출 수신");
    playSound();
    startRepeat(c.id);
  }

  async function poll() {
    if (!state.session) return;
    try {
      const r = await fetch("/api/state?token=" + encodeURIComponent(state.session.token), { cache: "no-store" });
      if (r.status === 401) {
        localStorage.removeItem(KEY);
        state.session = null;
        stopPolling();
        setStatus("다시 입장해 주세요");
        location.reload();
        return;
      }
      const d = await r.json();
      setStatus(state.session.schoolName + " · 연결됨");
      if (d.call && d.call.id !== state.lastSeenCallId) {
        state.lastSeenCallId = d.call.id;
        onCall(d.call);
      }
    } catch (e) {
      setStatus("연결 끊김, 다시 연결 중");
    }
  }
  function startPolling() { stopPolling(); poll(); state.pollTimer = setInterval(poll, POLL_MS); }
  function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

  // ---------- 요청 ----------
  async function post(path, body) {
    const r = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token: state.session && state.session.token })
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function showMain() {
    $("join-panel").classList.add("hidden");
    $("call-panel").classList.remove("hidden");
    $("settings-panel").classList.remove("hidden");
    $("who").textContent = state.session.schoolName + " · " + state.session.room + " · " + state.session.name + " 님 (" + state.session.role + ")";
    keepAwake();
  }

  async function join() {
    $("join-error").classList.add("hidden");
    const r = await post("/api/join", {
      schoolCode: $("school-code").value, name: $("user-name").value,
      role: $("user-role").value, room: $("room").value
    });
    if (!r.ok) {
      $("join-error").textContent = r.data.error || "입장에 실패했습니다.";
      $("join-error").classList.remove("hidden");
      return;
    }
    state.session = r.data;
    localStorage.setItem(KEY, JSON.stringify(r.data));
    ctx();
    showMain();
    startPolling();
    log("입장: " + r.data.schoolName + " " + r.data.room);
  }

  async function sendCall(drill) {
    const r = await post("/api/call", { drill: !!drill });
    if (!r.ok) log("호출 실패: " + (r.data.error || r.status));
  }

  async function ack() {
    if (!state.activeCallId) return hideAlarm();
    const id = state.activeCallId;
    const r = await post("/api/ack", { callId: id });
    if (r.ok) {
      state.ackedIds.add(id);
      state.activeCallId = null;
      stopRepeat();
      hideAlarm();
      log("확인 완료 (지금까지 " + r.data.ackedCount + "명)");
    } else {
      log("확인 실패: " + (r.data.error || r.status));
    }
  }

  // ---------- 이벤트 ----------
  $("join-btn").addEventListener("click", join);
  $("call-btn").addEventListener("click", () => sendCall(false));
  $("drill-btn").addEventListener("click", () => sendCall(true));
  $("ack-btn").addEventListener("click", ack);
  $("test-alarm").addEventListener("click", playSound);

  // ---------- 시작 ----------
  const saved = localStorage.getItem(KEY);
  if (saved) {
    state.session = JSON.parse(saved);
    showMain();
    startPolling();
  } else {
    setStatus("입장 전");
    const code = new URLSearchParams(location.search).get("code");
    if (code) $("school-code").value = code.toUpperCase();
  }
})();
