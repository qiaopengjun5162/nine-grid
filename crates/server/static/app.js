// 九宫棋前端：只负责「渲染服务端给的局面」和「发送落子意图」。
// 这里刻意不做胜负判定 —— 规则只存在于 Rust 的 nine-grid-core 里。
// 唯一涉及规则的代码是下面的 WIN_LINES，它只用来给获胜的三格加高亮，纯装饰。

const PLAYER_KEY = "nine-grid-player-id";
const SOUND_KEY = "nine-grid-sound";
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const ui = {
  lobby: document.getElementById("lobby"),
  game: document.getElementById("game"),
  createBtn: document.getElementById("create-btn"),
  joinForm: document.getElementById("join-form"),
  codeInput: document.getElementById("code-input"),
  roomCode: document.getElementById("room-code"),
  copyBtn: document.getElementById("copy-btn"),
  botBtn: document.getElementById("bot-btn"),
  botCreateBtn: document.getElementById("bot-create-btn"),
  seatO: document.getElementById("seat-o"),
  seatX: document.getElementById("seat-x"),
  seatOName: document.getElementById("seat-o-name"),
  seatXName: document.getElementById("seat-x-name"),
  status: document.getElementById("status"),
  stage: document.getElementById("stage"),
  board: document.getElementById("board"),
  soundBtn: document.getElementById("sound-btn"),
  plyCount: document.getElementById("ply-count"),
  moveList: document.getElementById("move-list"),
  newBtn: document.getElementById("new-btn"),
  toast: document.getElementById("toast"),
};

const state = {
  playerId: ensurePlayerId(),
  room: null,
  view: null,
  timer: null,
  busy: false,
  // 已经渲染过多少手：只有比它新的那一手才播落下动画与声音，
  // 否则 1.2 秒一次的轮询会把整盘棋反复「重放」。
  renderedPlies: 0,
};

const sound = {
  on: localStorage.getItem(SOUND_KEY) !== "off",
  ctx: null,
};

function ensurePlayerId() {
  let id = localStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : fallbackId();
    localStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}

function fallbackId() {
  return "p-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `请求失败（${res.status}）`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

const fetchView = (code) =>
  api(`/api/games/${encodeURIComponent(code)}?player_id=${encodeURIComponent(state.playerId)}`);

const isOver = (value) => ["o_won", "x_won", "draw"].includes(value);

function shortId(id) {
  return id ? id.slice(0, 4).toUpperCase() : "—";
}

// ── 声音：全部由 WebAudio 现场合成，不下载任何音频文件 ──
// 木质叩击 = 一段快速衰减的噪声（木头表面的摩擦）+ 一个下滑的低频（木块落定的闷响）。
function audioContext() {
  if (!sound.on) return null;
  if (!sound.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sound.ctx = new Ctx();
  }
  if (sound.ctx.state === "suspended") sound.ctx.resume();
  return sound.ctx;
}

function clack(scale = 1) {
  const ctx = audioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const length = Math.floor(ctx.sampleRate * 0.12);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 8);
  }

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 760;
  band.Q.value = 1.1;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.3 * scale;
  noise.connect(band).connect(noiseGain).connect(ctx.destination);
  noise.start(now);

  const thud = ctx.createOscillator();
  thud.type = "triangle";
  thud.frequency.setValueAtTime(190, now);
  thud.frequency.exponentialRampToValueAtTime(70, now + 0.13);
  const thudGain = ctx.createGain();
  thudGain.gain.setValueAtTime(0.15 * scale, now);
  thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  thud.connect(thudGain).connect(ctx.destination);
  thud.start(now);
  thud.stop(now + 0.2);
}

// 三连：三个上行泛音，像木槌轻敲三下
function chime() {
  const ctx = audioContext();
  if (!ctx) return;
  const start = ctx.currentTime;
  [523.25, 659.25, 783.99].forEach((frequency, index) => {
    const at = start + index * 0.11;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.75);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.8);
  });
}

// 平局：两声下沉
function sigh() {
  const ctx = audioContext();
  if (!ctx) return;
  const start = ctx.currentTime;
  [392, 294].forEach((frequency, index) => {
    const at = start + index * 0.16;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.1, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.65);
  });
}

function syncSoundButton() {
  ui.soundBtn.textContent = sound.on ? "声响 · 开" : "声响 · 关";
  ui.soundBtn.setAttribute("aria-pressed", String(sound.on));
}

// ── 棋盘 ──
function buildBoard() {
  ui.board.innerHTML = "";
  for (let index = 0; index < 9; index += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.dataset.index = String(index);
    cell.addEventListener("click", () => onCellClick(index));
    ui.board.appendChild(cell);
  }
}

// 指针移动改变透视角度：棋盘像放在桌上，看的人稍微挪一下身子。
// 纯装饰，所以用 rAF 节流，且不阻断页面滚动（.stage 设了 touch-action: pan-y）。
function bindParallax() {
  const baseTilt = Number.parseFloat(
    getComputedStyle(ui.board).getPropertyValue("--tilt-x"),
  ) || 15;
  let frame = 0;

  const apply = (nx, ny) => {
    ui.board.style.setProperty("--tilt-x", `${(baseTilt - ny * 7).toFixed(2)}deg`);
    ui.board.style.setProperty("--tilt-z", `${(nx * 4).toFixed(2)}deg`);
    ui.board.style.setProperty("--shift-x", `${(nx * 5).toFixed(2)}px`);
  };

  ui.stage.addEventListener("pointermove", (event) => {
    const box = ui.stage.getBoundingClientRect();
    const nx = (event.clientX - box.left) / box.width - 0.5;
    const ny = (event.clientY - box.top) / box.height - 0.5;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => apply(nx, ny));
  });

  const rest = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => apply(0, 0));
  };
  ui.stage.addEventListener("pointerleave", rest);
  ui.stage.addEventListener("pointercancel", rest);
}

// 方向键在九格间移动焦点，回车/空格由按钮本身负责落子。
// 行、列都循环，所以从右下按右键会回到左下，不用记边界。
function bindBoardKeys() {
  const moves = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };

  ui.board.addEventListener("keydown", (event) => {
    const cells = Array.from(ui.board.children);
    const current = cells.indexOf(document.activeElement);
    if (current < 0) return;

    let row = Math.floor(current / 3);
    let col = current % 3;

    if (event.key === "Home") {
      row = 0;
      col = 0;
    } else if (event.key === "End") {
      row = 2;
      col = 2;
    } else if (moves[event.key]) {
      const [dRow, dCol] = moves[event.key];
      row = (row + dRow + 3) % 3;
      col = (col + dCol + 3) % 3;
    } else {
      return;
    }

    event.preventDefault();
    cells[row * 3 + col].focus();
  });
}

function canPlay(view, index) {
  return Boolean(
    view &&
      !state.busy &&
      view.state === "in_progress" &&
      view.you &&
      view.turn === view.you &&
      !view.board[index],
  );
}

function winningCells(view) {
  if (view.state !== "o_won" && view.state !== "x_won") return [];
  const mark = view.state === "o_won" ? "O" : "X";
  return (
    WIN_LINES.find(
      ([a, b, c]) => view.board[a] === mark && view.board[b] === mark && view.board[c] === mark,
    ) ?? []
  );
}

function render(view) {
  const previous = state.view;
  state.view = view;
  ui.lobby.classList.add("hidden");
  ui.game.classList.remove("hidden");
  ui.roomCode.textContent = view.code;
  document.title = `${view.code} · 九宫棋`;

  // 换了一局（手数回退）就把动画基线归零
  if (view.moves.length < state.renderedPlies) state.renderedPlies = 0;

  renderSeats(view);
  renderStatus(view);
  renderBoard(view);
  renderMoves(view);
  ui.newBtn.classList.toggle("hidden", !isOver(view.state));
  ui.botBtn.classList.toggle("hidden", !(view.state === "waiting" && view.you === "O"));

  // 终局音只在「刚刚结束」时响，进房间看一盘已结束的棋不该有声音
  if (previous && previous.state === "in_progress" && isOver(view.state)) {
    if (view.state === "draw") sigh();
    else chime();
  }
}

function renderSeats(view) {
  const { o, x } = view.players;
  ui.seatOName.textContent = seatLabel(o, view.you, "O");
  ui.seatXName.textContent = seatLabel(x, view.you, "X");
  ui.seatO.classList.toggle("active", view.state === "in_progress" && view.turn === "O");
  ui.seatX.classList.toggle("active", view.state === "in_progress" && view.turn === "X");
}

// 座位怎么显示：自己 → 你；机器人 → 机器人；真人 → 昵称或短 id
function seatLabel(seat, you, mark) {
  if (!seat) return "待入座";
  if (you === mark) return "你";
  if (seat.is_bot) return "机器人";
  return seat.handle || shortId(seat.id);
}

function renderStatus(view) {
  let text = "";
  let over = false;

  if (view.state === "waiting") {
    text = "等对手入座。把房间码或邀请链接递过去，也可以请机器人来。";
  } else if (view.state === "in_progress") {
    const opponent = view.turn === "O" ? view.players.o : view.players.x;
    if (!view.you) text = "你在旁观这一局。";
    else if (view.turn === view.you) text = `轮到你落子（${view.you}）`;
    else text = opponent?.is_bot ? "机器人正在想…" : "等对手落子…";
  } else if (view.state === "draw") {
    text = "九格下满，平局。";
    over = true;
  } else {
    const winner = view.state === "o_won" ? "O" : "X";
    text = `${winner} 方连成一线，赢了`;
    text += view.you === winner ? "，恭喜。" : "。";
    over = true;
  }

  ui.status.textContent = text;
  ui.status.classList.toggle("over", over);
}

function renderBoard(view) {
  const winSet = new Set(winningCells(view));
  const isNewPly = view.moves.length > state.renderedPlies;
  const latest = isNewPly ? view.moves[view.moves.length - 1].position : -1;

  Array.from(ui.board.children).forEach((cell, index) => {
    const mark = view.board[index] || "";
    // 只改动真正变了的那一格：轮询不重建 DOM，动画才不会被反复触发
    if ((cell.dataset.mark || "") !== mark) {
      cell.dataset.mark = mark;
      cell.innerHTML = "";
      if (mark) {
        const symbol = document.createElement("span");
        symbol.className = `mark ${mark.toLowerCase()}`;
        if (index === latest) symbol.classList.add("drop");
        cell.appendChild(symbol);
      }
    }

    cell.disabled = !canPlay(view, index);
    cell.classList.toggle("win", winSet.has(index));

    const row = Math.floor(index / 3) + 1;
    const col = (index % 3) + 1;
    cell.setAttribute(
      "aria-label",
      `第 ${row} 行第 ${col} 列，${mark ? `已有 ${mark}` : "空"}`,
    );
  });

  if (latest >= 0) clack(1);
  state.renderedPlies = view.moves.length;
}

function renderMoves(view) {
  ui.plyCount.textContent = String(view.moves.length);
  ui.moveList.innerHTML = view.moves
    .map((move) => {
      const row = Math.floor(move.position / 3) + 1;
      const col = (move.position % 3) + 1;
      return `<li><b>${move.mark}</b> 落在第 ${row} 行第 ${col} 列</li>`;
    })
    .join("");
}

async function onCellClick(index) {
  const view = state.view;
  if (!view || !canPlay(view, index)) return;

  state.busy = true;
  renderBoard(view);
  try {
    const next = await api(`/api/games/${encodeURIComponent(view.code)}/moves`, {
      method: "POST",
      body: { player_id: state.playerId, position: index, version: view.version },
    });
    render(next);
  } catch (err) {
    if (err.code === "stale_version") {
      toast("有人抢先走了一步，已同步最新局面");
      await refresh();
    } else {
      toast(err.message);
    }
  } finally {
    state.busy = false;
    if (state.view) renderBoard(state.view);
  }
}

async function refresh() {
  if (!state.room) return null;
  try {
    const view = await fetchView(state.room);
    render(view);
    return view;
  } catch (err) {
    if (err.status === 404) {
      stopPolling();
      state.room = null;
      showLobby();
      toast("这一局不存在了");
    }
    return null;
  }
}

function stopPolling() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function startPolling() {
  stopPolling();
  const loop = async () => {
    if (!state.room) return;
    await refresh();
    const interval = isOver(state.view?.state ?? "") ? 4000 : 1200;
    state.timer = setTimeout(loop, interval);
  };
  state.timer = setTimeout(loop, 1200);
}

async function createGame() {
  ui.createBtn.disabled = true;
  try {
    const view = await api("/api/games", {
      method: "POST",
      body: { player_id: state.playerId },
    });
    state.room = view.code;
    state.renderedPlies = 0;
    history.replaceState(null, "", `?room=${view.code}`);
    render(view);
    startPolling();
    toast("棋局已开，把链接递给对手");
  } catch (err) {
    toast(err.message);
  } finally {
    ui.createBtn.disabled = false;
  }
}

// 建局 + 立刻让机器人落座：一个人也能开一局
async function createBotGame() {
  ui.botCreateBtn.disabled = true;
  try {
    const created = await api("/api/games", {
      method: "POST",
      body: { player_id: state.playerId },
    });
    state.room = created.code;
    state.renderedPlies = 0;
    history.replaceState(null, "", `?room=${created.code}`);
    render(created);
    await seatBot();
    startPolling();
  } catch (err) {
    toast(err.message);
  } finally {
    ui.botCreateBtn.disabled = false;
  }
}

// 让机器人坐进 X 座位。之后它就是一个普通对手：
// 你每落一子，服务端在同一个事务里走完它的应招。
async function seatBot() {
  if (!state.room) return;
  ui.botBtn.disabled = true;
  try {
    const view = await api(`/api/games/${encodeURIComponent(state.room)}/bot`, {
      method: "POST",
      body: { player_id: state.playerId },
    });
    render(view);
    toast("机器人执 X 入座，你先走");
  } catch (err) {
    toast(err.message);
  } finally {
    ui.botBtn.disabled = false;
  }
}

async function openRoom(code) {
  state.room = code;
  state.renderedPlies = 0;
  try {
    let view = await fetchView(code);
    // 链接打开者如果还没入座、且这局在等人，就直接坐进去
    if (!view.you && view.state === "waiting") {
      view = await api(`/api/games/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: { player_id: state.playerId },
      });
      toast("已入座，你执 X");
    }
    history.replaceState(null, "", `?room=${view.code}`);
    render(view);
    startPolling();
  } catch (err) {
    stopPolling();
    state.room = null;
    showLobby();
    ui.codeInput.value = code;
    toast(err.message);
  }
}

function showLobby() {
  ui.game.classList.add("hidden");
  ui.lobby.classList.remove("hidden");
  document.title = "九宫棋 · Nine Grid";
}

let toastTimer = null;

function toast(message) {
  clearTimeout(toastTimer);
  if (!message) {
    ui.toast.classList.remove("show");
    return;
  }
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2800);
}

async function copyLink() {
  if (!state.room) return;
  const link = `${location.origin}${location.pathname}?room=${state.room}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("邀请链接已复制");
  } catch {
    toast(link);
  }
}

async function boot() {
  buildBoard();
  bindParallax();
  bindBoardKeys();
  syncSoundButton();

  ui.createBtn.addEventListener("click", createGame);
  ui.botCreateBtn.addEventListener("click", createBotGame);
  ui.botBtn.addEventListener("click", seatBot);
  ui.newBtn.addEventListener("click", createGame);
  ui.copyBtn.addEventListener("click", copyLink);

  ui.soundBtn.addEventListener("click", () => {
    sound.on = !sound.on;
    localStorage.setItem(SOUND_KEY, sound.on ? "on" : "off");
    syncSoundButton();
    if (sound.on) clack(0.8);
  });

  ui.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = ui.codeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      toast("房间码是六位");
      return;
    }
    openRoom(code);
  });
  ui.codeInput.addEventListener("input", () => {
    ui.codeInput.value = ui.codeInput.value.toUpperCase();
  });

  const room = new URLSearchParams(location.search).get("room");
  if (!room) {
    showLobby();
    return;
  }
  await openRoom(room.trim().toUpperCase());
}

boot();
