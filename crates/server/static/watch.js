// 观战端：拉快照 → 订阅 SSE → 收到通知就回拉快照。
// 这里没有任何规则判断，也没有落子 —— 棋盘完全由服务端给的 board 数组画出来。

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const ui = {
  lobby: document.getElementById("watch-lobby"),
  game: document.getElementById("watch-game"),
  form: document.getElementById("watch-form"),
  codeInput: document.getElementById("watch-code-input"),
  roomCode: document.getElementById("watch-room-code"),
  conn: document.getElementById("watch-conn"),
  seatOName: document.getElementById("watch-seat-o-name"),
  seatXName: document.getElementById("watch-seat-x-name"),
  seatO: document.getElementById("watch-seat-o"),
  seatX: document.getElementById("watch-seat-x"),
  status: document.getElementById("watch-status"),
  board: document.getElementById("watch-board"),
  plyCount: document.getElementById("watch-ply-count"),
  moveList: document.getElementById("watch-move-list"),
  leaveBtn: document.getElementById("watch-leave-btn"),
  replayBar: document.getElementById("watch-replay-bar"),
  replayRange: document.getElementById("watch-replay-range"),
  replayLabel: document.getElementById("watch-replay-label"),
  replayPrev: document.getElementById("watch-replay-prev"),
  replayNext: document.getElementById("watch-replay-next"),
  replayLive: document.getElementById("watch-replay-live"),
};

const state = {
  source: null,
  room: null,
  view: null,
  renderedPlies: 0,
  followLive: true, // true：跟随最新快照；false：锁定在某一手回放
  replayPly: 0,
};

// 从空盘逐手重放前 n 手，得到那一刻的盘面。
// 只摆子、不判胜负 —— 胜负始终以服务端快照为准。
function boardAfter(moves, n) {
  const board = Array(9).fill("");
  for (let i = 0; i < Math.min(n, moves.length); i += 1) {
    board[moves[i].position] = moves[i].mark;
  }
  return board;
}

function displayPly() {
  if (!state.view) return 0;
  return state.followLive ? state.view.moves.length : state.replayPly;
}

function buildBoard() {
  ui.board.innerHTML = "";
  for (let index = 0; index < 9; index += 1) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.index = String(index);
    cell.setAttribute("aria-hidden", "true");
    ui.board.appendChild(cell);
  }
}

function setConn(text, kind) {
  ui.conn.textContent = text;
  ui.conn.dataset.kind = kind;
}

function seatLabel(seat, view) {
  if (!seat) return "空";
  if (seat.is_bot) {
    const label = { easy: "简单", medium: "中等", hard: "困难" }[view.bot_difficulty] ?? "";
    return `机器人${label ? ` · ${label}` : ""}`;
  }
  return seat.handle || seat.id.slice(0, 4).toUpperCase();
}

function winningCells(view) {
  if (view.state !== "o_won" && view.state !== "x_won") return [];
  const mark = view.state === "o_won" ? "O" : "X";
  return WIN_LINES.find(
    ([a, b, c]) => view.board[a] === mark && view.board[b] === mark && view.board[c] === mark,
  ) ?? [];
}

function render(view) {
  // 换了一局（或退出后重进）就重置回放基线
  if (state.room !== view.code) {
    state.room = view.code;
    state.followLive = true;
    state.replayPly = 0;
    state.renderedPlies = 0;
  }
  state.view = view;

  const ply = displayPly();
  const isLive = state.followLive || ply >= view.moves.length;

  ui.roomCode.textContent = view.code;
  document.title = `${view.code} · 观战 · 九宫棋`;
  ui.seatOName.textContent = seatLabel(view.players.o, view);
  ui.seatXName.textContent = seatLabel(view.players.x, view);
  ui.seatO.classList.toggle("active", isLive && view.state === "in_progress" && view.turn === "O");
  ui.seatX.classList.toggle("active", isLive && view.state === "in_progress" && view.turn === "X");

  renderStatus(view, ply, isLive);
  renderBoard(view, ply, isLive);
  renderMoves(view, ply, isLive);
  renderReplayControls(ply, view.moves.length);
}

function renderStatus(view, ply, isLive) {
  let text = "";
  let over = false;
  if (!isLive) {
    text = `回放 · 第 ${ply} / ${view.moves.length} 手`;
  } else if (view.state === "waiting") {
    text = "等对手入座中…";
  } else if (view.state === "in_progress") {
    text = `${view.turn} 方行棋`;
  } else if (view.state === "draw") {
    text = "九格下满，平局。";
    over = true;
  } else {
    text = `${view.state === "o_won" ? "O" : "X"} 方连成一线，赢了`;
    over = true;
  }
  ui.status.textContent = text;
  ui.status.classList.toggle("over", over);
}

function renderBoard(view, ply, isLive) {
  const board = boardAfter(view.moves, ply);
  const winSet = new Set(isLive ? winningCells(view) : []);
  // 只有前进到新的手数才播落子动画；回退时直接重画
  const latest = ply > state.renderedPlies ? view.moves[ply - 1]?.position ?? -1 : -1;

  Array.from(ui.board.children).forEach((cell, index) => {
    const mark = board[index] || "";
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
    cell.classList.toggle("win", winSet.has(index));
  });
  state.renderedPlies = ply;
}

function renderMoves(view, ply, isLive) {
  ui.plyCount.textContent = String(view.moves.length);
  ui.moveList.innerHTML = view.moves
    .map((move, i) => {
      const row = Math.floor(move.position / 3) + 1;
      const col = (move.position % 3) + 1;
      const cls = !isLive && i === ply - 1 ? ' class="current"' : "";
      return `<li${cls}><b>${move.mark}</b> 落在第 ${row} 行第 ${col} 列</li>`;
    })
    .join("");
}

function renderReplayControls(ply, total) {
  ui.replayRange.max = String(total);
  ui.replayRange.value = String(ply);
  ui.replayLabel.textContent = `第 ${ply} / ${total} 手`;
  ui.replayPrev.disabled = ply <= 0;
  ui.replayNext.disabled = ply >= total;
  ui.replayLive.disabled = state.followLive;
  ui.replayBar.dataset.mode = state.followLive ? "live" : "replay";
}

// 把视图定位到第 ply 手；拖到最新一手即回归实时跟随
function seekPly(ply) {
  if (!state.view) return;
  const total = state.view.moves.length;
  const next = Math.max(0, Math.min(total, ply));
  if (next === total) {
    state.followLive = true;
  } else {
    state.followLive = false;
    state.replayPly = next;
  }
  render(state.view);
}

async function fetchView(code) {
  const res = await fetch(`/api/games/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "这局棋不存在" : `读取失败（${res.status}）`);
  return res.json();
}

async function startWatching(code) {
  stopWatching();
  try {
    // 订阅前先拉一次完整快照，避免错过订阅前的落子
    const view = await fetchView(code);
    state.room = code;
    state.renderedPlies = 0;
    ui.lobby.classList.add("hidden");
    ui.game.classList.remove("hidden");
    history.replaceState(null, "", `?room=${encodeURIComponent(code)}`);
    render(view);
    setConn("实时连接中", "live");

    const source = new EventSource(`/api/games/${encodeURIComponent(code)}/events`);
    state.source = source;
    source.addEventListener("move", () => {
      // 只当通知用：回拉完整快照，自己不判胜负
      fetchView(code).then(render).catch(() => setConn("连接断开", "dead"));
    });
    source.addEventListener("open", () => setConn("实时连接中", "live"));
    source.onerror = () => setConn("重连中…", "retry");
  } catch (err) {
    setConn("未连接", "dead");
    window.alert(err.message);
  }
}

function stopWatching() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  state.room = null;
}

function showLobby() {
  stopWatching();
  state.view = null;
  ui.game.classList.add("hidden");
  ui.lobby.classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
  document.title = "观战 · 九宫棋";
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = ui.codeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    window.alert("房间码是六位");
    return;
  }
  startWatching(code);
});
ui.codeInput.addEventListener("input", () => {
  ui.codeInput.value = ui.codeInput.value.toUpperCase();
});
ui.leaveBtn.addEventListener("click", showLobby);
ui.replayRange.addEventListener("input", () => seekPly(Number(ui.replayRange.value)));
ui.replayPrev.addEventListener("click", () => seekPly(displayPly() - 1));
ui.replayNext.addEventListener("click", () => seekPly(displayPly() + 1));
ui.replayLive.addEventListener("click", () => {
  state.followLive = true;
  if (state.view) render(state.view);
});

buildBoard();
const initial = new URLSearchParams(location.search).get("room");
if (initial) {
  ui.codeInput.value = initial.trim().toUpperCase();
  startWatching(initial.trim().toUpperCase());
}
