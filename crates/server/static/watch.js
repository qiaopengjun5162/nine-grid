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
};

const state = {
  source: null,
  renderedPlies: 0,
};

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
  ui.roomCode.textContent = view.code;
  document.title = `${view.code} · 观战 · 九宫棋`;

  // 换了一局就把动画基线归零
  if (view.moves.length < state.renderedPlies) state.renderedPlies = 0;

  ui.seatOName.textContent = seatLabel(view.players.o, view);
  ui.seatXName.textContent = seatLabel(view.players.x, view);
  ui.seatO.classList.toggle("active", view.state === "in_progress" && view.turn === "O");
  ui.seatX.classList.toggle("active", view.state === "in_progress" && view.turn === "X");

  renderStatus(view);
  renderBoard(view);
  renderMoves(view);
}

function renderStatus(view) {
  let text = "";
  let over = false;
  if (view.state === "waiting") {
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

function renderBoard(view) {
  const winSet = new Set(winningCells(view));
  const isNew = view.moves.length > state.renderedPlies;
  const latest = isNew ? view.moves[view.moves.length - 1].position : -1;

  Array.from(ui.board.children).forEach((cell, index) => {
    const mark = view.board[index] || "";
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

buildBoard();
const initial = new URLSearchParams(location.search).get("room");
if (initial) {
  ui.codeInput.value = initial.trim().toUpperCase();
  startWatching(initial.trim().toUpperCase());
}
