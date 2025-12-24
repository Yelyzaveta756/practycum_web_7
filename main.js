const dom = {
  sheet: document.getElementById("sheet"),
  playBtn: document.getElementById("playBtn"),
  closeBtn: document.getElementById("closeBtn"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  clearBtn: document.querySelector(".clear-btn"),
  anim: document.getElementById("anim"),
  square: document.getElementById("square"),
  messageList: document.getElementById("message"),
  result: document.getElementById("result"),
  resultsBody: document.getElementById("resultsBody"),
  simpleMessage: document.getElementById("simple-message"),
};

const STORAGE_KEY = "animEvents";
const STORAGE_SEQ_KEY = "animEventSeq";
const STORAGE_BATCH_SEQ_KEY = "animEventBatchSeq";
const MAX_MESSAGES = 8;
const STEP_MS = 30;

let localEvents = loadLocalEvents();
let eventSeq = initEventSeq(localEvents);
let lastBatchSeq = loadBatchSeq();

const sendQueue = { current: Promise.resolve() };

const squareState = {
  size: 10,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  running: false,
  exiting: false,
  ready: false,
  opacity: 1,
  lastTick: 0,
  rafId: 0,
};

init();

function init() {
  if (dom.square) {
    dom.square.style.display = "none";
    dom.square.style.opacity = "1";
    dom.square.style.transform = "translate(0px, 0px)";
  }
  bindEvents();
}

function bindEvents() {
  if (dom.playBtn) dom.playBtn.addEventListener("click", openAnimBlock);
  if (dom.closeBtn) dom.closeBtn.addEventListener("click", closeAnimBlock);
  if (dom.startBtn) dom.startBtn.addEventListener("click", startAnimation);
  if (dom.stopBtn)
    dom.stopBtn.addEventListener("click", () => stopAnimation(false));
  if (dom.reloadBtn) dom.reloadBtn.addEventListener("click", reloadAnimation);
  if (dom.clearBtn) dom.clearBtn.addEventListener("click", clearLogs);
}

function loadLocalEvents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function initEventSeq(events) {
  let maxSeq = 0;
  try {
    const stored = Number(localStorage.getItem(STORAGE_SEQ_KEY));
    if (Number.isInteger(stored) && stored > maxSeq) {
      maxSeq = stored;
    }
  } catch (error) {}
  for (const entry of events) {
    if (entry && Number.isInteger(entry.seq) && entry.seq > maxSeq) {
      maxSeq = entry.seq;
    }
  }
  return maxSeq;
}

function loadBatchSeq() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_BATCH_SEQ_KEY));
    if (Number.isInteger(stored) && stored > 0) {
      return stored;
    }
  } catch (error) {}
  return 0;
}

function saveLocalEvents() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localEvents));
  } catch (error) {}
}

function nextSeq() {
  eventSeq += 1;
  try {
    localStorage.setItem(STORAGE_SEQ_KEY, String(eventSeq));
  } catch (error) {}
  return eventSeq;
}

function queueInstant(payload) {
  const body = JSON.stringify(payload);
  sendQueue.current = sendQueue.current
    .then(() =>
      fetch("/api/events/instant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      })
    )
    .catch(() => {});
}

function logEvent(eventType, message, extra) {
  if (!message) {
    return;
  }
  const seq = nextSeq();
  const localTime = new Date().toISOString();
  const entry = {
    seq,
    eventType: eventType || null,
    message,
    localTime,
    extra: extra || null,
  };
  localEvents.push(entry);
  saveLocalEvents();
  queueInstant({
    seq,
    eventType: eventType || null,
    message,
    clientTime: localTime,
    meta: extra || null,
  });
  pushMessage(entry);
}

function pushMessage(entry) {
  if (!dom.messageList) {
    return;
  }
  const li = document.createElement("li");
  const seq = entry.seq ? `#${entry.seq}` : "";
  li.textContent = [seq, entry.message].filter(Boolean).join(" ");
  dom.messageList.appendChild(li);
  while (dom.messageList.children.length > MAX_MESSAGES) {
    dom.messageList.removeChild(dom.messageList.firstChild);
  }
}

function resetMessages() {
  if (dom.messageList) {
    dom.messageList.textContent = "";
  }
}

function openAnimBlock() {
  if (!dom.sheet) {
    return;
  }

  dom.sheet.style.display = "flex";

  dom.anim.style.display = "block";
  dom.square.style.display = "block";

  clearLogs();
  logEvent("play", "Play clicked");
}

async function closeAnimBlock() {
  stopAnimation(true);

  squareState.ready = false;
  squareState.exiting = false;
  squareState.running = false;

  if (dom.square) {
    dom.square.style.display = "none";
    dom.square.style.transform = "none";
    dom.square.style.opacity = "1";
  }

  setControls({ start: true, stop: false, reload: false });

  if (dom.sheet) {
    dom.sheet.style.display = "none";
  }

  logEvent("close", "Close clicked");
  await sendBatchEvents();
  const serverData = await fetchServerEvents();
  renderResults(serverData.instant, localEvents);
}

async function sendBatchEvents() {
  const batch = localEvents.filter((entry) => entry.seq > lastBatchSeq);
  if (!batch.length) {
    return { sent: 0 };
  }
  const payload = {
    events: batch.map(({ seq, message, eventType, localTime, extra }) => ({
      seq,
      message,
      eventType,
      localTime,
      extra,
    })),
  };
  try {
    const res = await fetch("/api/events/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (res.ok) {
      lastBatchSeq = batch[batch.length - 1].seq;
      try {
        localStorage.setItem(STORAGE_BATCH_SEQ_KEY, String(lastBatchSeq));
      } catch (error) {}
      return { sent: batch.length };
    }
  } catch (error) {}
  return { sent: 0 };
}

async function fetchServerEvents() {
  try {
    const res = await fetch("/api/events", { cache: "no-store" });
    if (!res.ok) {
      return { instant: [], batch: [] };
    }
    const data = await res.json();
    return {
      instant: Array.isArray(data.instant) ? data.instant : [],
      batch: Array.isArray(data.batch) ? data.batch : [],
    };
  } catch (error) {
    return { instant: [], batch: [] };
  }
}

function renderResults(serverEvents, localItems) {
  if (!dom.resultsBody || !dom.result || !dom.simpleMessage) {
    return;
  }
  dom.resultsBody.textContent = "";
  const serverList = Array.isArray(serverEvents) ? serverEvents : [];
  const localList = Array.isArray(localItems) ? localItems : [];
  const rows = Math.max(serverList.length, localList.length);
  if (rows === 0) {
    dom.result.style.display = "none";
    dom.simpleMessage.style.display = "block";
    return;
  }
  for (let i = 0; i < rows; i += 1) {
    const row = document.createElement("tr");
    const serverCell = document.createElement("td");
    const localCell = document.createElement("td");
    serverCell.textContent = formatServerCell(serverList[i]);
    localCell.textContent = formatLocalCell(localList[i]);
    row.append(serverCell, localCell);
    dom.resultsBody.appendChild(row);
  }
  dom.result.style.display = "block";
  dom.simpleMessage.style.display = "none";
}

function formatServerCell(event) {
  if (!event) {
    return "";
  }
  const seq = Number.isInteger(event.seq) ? `#${event.seq}` : "";
  const time = event.serverTimeLocal || event.serverTime || "";
  const clientTime = event.clientTime ? `client:${event.clientTime}` : "";
  const message = event.message || "";
  return [seq, time, clientTime, message].filter(Boolean).join(" ");
}

function formatLocalCell(event) {
  if (!event) {
    return "";
  }
  const seq = Number.isInteger(event.seq) ? `#${event.seq}` : "";
  const time = event.localTime || "";
  const message = event.message || "";
  return [seq, time, message].filter(Boolean).join(" ");
}

async function clearLogs() {
  localEvents = [];
  eventSeq = 0;
  lastBatchSeq = 0;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_SEQ_KEY);
    localStorage.removeItem(STORAGE_BATCH_SEQ_KEY);
  } catch (error) {}
  resetMessages();
  renderResults([], []);
  try {
    await fetch("/api/events", { method: "DELETE" });
  } catch (error) {}
}

function setControls({ start, stop, reload }) {
  if (dom.startBtn) {
    dom.startBtn.style.display = start ? "inline-block" : "none";
  }
  if (dom.stopBtn) {
    dom.stopBtn.style.display = stop ? "inline-block" : "none";
  }
  if (dom.reloadBtn) {
    dom.reloadBtn.style.display = reload ? "inline-block" : "none";
  }
}

function getAnimBounds() {
  if (!dom.anim) {
    return null;
  }
  return {
    width: dom.anim.clientWidth,
    height: dom.anim.clientHeight,
  };
}

function updateSquareStyle() {
  if (!dom.square) {
    return;
  }
  dom.square.style.transform = `translate(${squareState.x}px, ${squareState.y}px)`;
  dom.square.style.opacity = String(squareState.opacity);
}

function prepareSquare() {
  if (!dom.square || !dom.anim) {
    return;
  }
  const bounds = getAnimBounds();
  if (!bounds) {
    return;
  }
  const size = dom.square.offsetWidth || 10;
  const maxX = Math.max(0, bounds.width - size);
  const angle = (Math.random() * 50 + 20) * (Math.PI / 180);
  const speed = 3.2;
  const dir = Math.random() < 0.5 ? -1 : 1;
  squareState.size = size;
  squareState.x = 0;
  squareState.y = 0;
  squareState.vx = Math.cos(angle) * speed * dir;
  squareState.vy = Math.sin(angle) * speed;
  squareState.opacity = 1;
  squareState.exiting = false;
  squareState.running = false;
  squareState.ready = true;
  dom.square.style.display = "block";
  updateSquareStyle();
}

function startAnimation() {
  if (!dom.square || !dom.anim) {
    return;
  }
  if (squareState.running || squareState.exiting) {
    return;
  }
  if (!squareState.ready) {
    prepareSquare();
  }
  squareState.running = true;
  squareState.lastTick = performance.now();
  setControls({ start: false, stop: true, reload: false });
  logEvent("start", "Start clicked");
  squareState.rafId = requestAnimationFrame(tick);
}

function stopAnimation(silent) {
  if (squareState.rafId) {
    cancelAnimationFrame(squareState.rafId);
  }
  const wasRunning = squareState.running;
  squareState.running = false;
  if (!silent && wasRunning) {
    logEvent("stop", "Stop clicked");
  }
  if (squareState.exiting) {
    setControls({ start: false, stop: false, reload: true });
  } else {
    setControls({ start: true, stop: false, reload: false });
  }
}

function reloadAnimation() {
  stopAnimation(true);
  prepareSquare();
  setControls({ start: true, stop: false, reload: false });
  logEvent("reload", "Reload clicked");
}

function tick(now) {
  if (!squareState.running) {
    return;
  }
  if (now - squareState.lastTick < STEP_MS) {
    squareState.rafId = requestAnimationFrame(tick);
    return;
  }
  squareState.lastTick = now;

  const bounds = getAnimBounds();
  if (!bounds) {
    squareState.rafId = requestAnimationFrame(tick);
    return;
  }

  squareState.x += squareState.vx;
  squareState.y += squareState.vy;

  if (squareState.x <= 0) {
    squareState.x = 0;
    squareState.vx = Math.abs(squareState.vx);
    logEvent("wall-left", "Hit left wall");
  } else if (squareState.x + squareState.size >= bounds.width) {
    squareState.x = Math.max(0, bounds.width - squareState.size);
    squareState.vx = -Math.abs(squareState.vx);
    logEvent("wall-right", "Hit right wall");
  }

  if (squareState.y > bounds.height) {
    squareState.y = bounds.height;
    squareState.exiting = true;
    stopAnimation(false);
    setControls({ start: false, stop: false, reload: true });
    logEvent("exit", "Exited animation area");
    return;
  }

  updateSquareStyle();
  logEvent(
    "step",
    `Step x=${Math.round(squareState.x)} y=${Math.round(squareState.y)}`
  );
  squareState.rafId = requestAnimationFrame(tick);
}
