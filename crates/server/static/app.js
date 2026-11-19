// 九宫棋前端：只负责「渲染服务端给的局面」和「发送落子意图」。
// 这里刻意不做胜负判定 —— 规则只存在于 Rust 的 nine-grid-core 里。
// 唯一涉及规则的代码是下面的 WIN_LINES，它只用来给获胜的三格加高亮，纯装饰。

const PLAYER_KEY = "nine-grid-player-id";
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
  seatO: document.getElementById("seat-o"),
  seatX: document.getElementById("seat-x"),
  seatOName: document.getElementById("seat-o-name"),
  seatXName: document.getElementById("seat-x-name"),
  status: document.getElementById("status"),
  board: document.getElementById("board"),
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
  state.view = view;
  ui.lobby.classList.add("hidden");
  ui.game.classList.remove("hidden");
  ui.roomCode.textContent = view.code;
  document.title = `${view.code} · 九宫棋`;

  renderSeats(view);
  renderStatus(view);
  renderBoard(view);
  renderMoves(view);
  ui.newBtn.classList.toggle("hidden", !isOver(view.state));
}

function renderSeats(view) {
  const { o, x } = view.players;
  ui.seatOName.textContent = o ? (view.you === "O" ? "你" : shortId(o.id)) : "等待中";
  ui.seatXName.textContent = x ? (view.you === "X" ? "你" : shortId(x.id)) : "待加入";
  ui.seatO.classList.toggle("active", view.state === "in_progress" && view.turn === "O");
  ui.seatX.classList.toggle("active", view.state === "in_progress" && view.turn === "X");
}

function renderStatus(view) {
  let text = "";
  let over = false;

  if (view.state === "waiting") {
    text = "等对手加入。把房间码或邀请链接发给他。";
  } else if (view.state === "in_progress") {
    if (!view.you) text = "你在旁观这一局。";
    else if (view.turn === view.you) text = `轮到你落子（${view.you}）`;
    else text = "等对手落子…";
  } else if (view.state === "draw") {
    text = "九格下满，平局。";
    over = true;
  } else {
    const winner = view.state === "o_won" ? "O" : "X";
    text = `${winner} 方连成一线，赢了`;
    text += view.you === winner ? "，恭喜你。" : "。";
    over = true;
  }

  ui.status.textContent = text;
  ui.status.classList.toggle("over", over);
}

function renderBoard(view) {
  const winSet = new Set(winningCells(view));
  Array.from(ui.board.children).forEach((cell, index) => {
    const mark = view.board[index];
    cell.innerHTML = "";
    if (mark) {
      const symbol = document.createElement("span");
      symbol.className = `mark ${mark.toLowerCase()}`;
      cell.appendChild(symbol);
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
    history.replaceState(null, "", `?room=${view.code}`);
    render(view);
    startPolling();
    toast("房间已创建，把链接发给对手");
  } catch (err) {
    toast(err.message);
  } finally {
    ui.createBtn.disabled = false;
  }
}

async function openRoom(code) {
  state.room = code;
  try {
    let view = await fetchView(code);
    // 链接打开者如果还没入座、且这局在等人，就直接坐进去
    if (!view.you && view.state === "waiting") {
      view = await api(`/api/games/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: { player_id: state.playerId },
      });
      toast("已加入对局，你执 X");
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

  ui.createBtn.addEventListener("click", createGame);
  ui.newBtn.addEventListener("click", createGame);
  ui.copyBtn.addEventListener("click", copyLink);
  ui.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = ui.codeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      toast("房间码是 6 位");
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
