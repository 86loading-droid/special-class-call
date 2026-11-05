(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "scc-session";
  const state = { session: null, es: null, activeCallId: null, repeatTimer: null, audioCtx: null };

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

  // ---------- 실시간 수신 ----------
  function connect() {
    if (state.es) state.es.close();
    const es = new EventSource("/api/events?token=" + encodeURIComponent(state.session.token));
    state.es = es;
    es.onopen = () => setStatus(state.session.schoolName + " · 연결됨");
    es.onerror = () => setStatus("연결 끊김, 다시 연결 중");
    es.addEventListener("call", (e) => onCall(JSON.parse(e.data)));
    es.addEventListener("ack", (e) => {
      const d = JSON.parse(e.data);
      if (d.callId === state.activeCallId) log(d.by + " 확인 (" + d.acked + "명)");
    });
  }
  function onCall(c) {
    if (state.activeCallId === c.id) return;
    state.activeCallId = c.id;
    showAlarm(c.room + " 비상 호출", c.by + "(" + c.role + ") · " + new Date(c.at).toLocaleTimeString("ko-KR"), c.drill);
    log((c.drill ? "훈련 " : "") + c.room + " 호출 수신");
    playSound();
    startRepeat(c.id);
  }

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
    connect();
    log("입장: " + r.data.schoolName + " " + r.data.room);
  }

  async function sendCall(drill) {
    const r = await post("/api/call", { drill: !!drill });
    if (!r.ok) log("호출 실패: " + (r.data.error || r.status));
  }

  async function ack() {
    if (!state.activeCallId) return hideAlarm();
    const r = await post("/api/ack", { callId: state.activeCallId });
    if (r.ok) {
      state.activeCallId = null; stopRepeat(); hideAlarm();
      log("확인 완료");
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
    connect();
  } else {
    setStatus("입장 전");
  }
})();
