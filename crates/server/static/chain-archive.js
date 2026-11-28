// 链上棋谱馆：只读地把链上的对局和棋谱读回来。
//
// 这里没有后端、没有数据库、也不需要钱包签名：
//   1. 对局列表来自 program.account.game.all()（getProgramAccounts 枚举 PDA 账户）；
//   2. 棋谱来自该 PDA 的签名历史 —— 每笔 play(position) 交易里都有一个落子位置；
//   3. 重建完的盘面会和账户里的终局盘面比对，不一致就在页面上标红。
//
// 前端不判胜负：结果直接读账户里的 state（那是链上程序用 core 算出来的）。

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6");

// 与 chain.js 保持一致的集群配置。只读页面优先用 URL 参数，其次 window 变量，最后 devnet。
const CLUSTERS = {
  devnet: {
    label: "Devnet",
    rpc: "https://api.devnet.solana.com",
    explorer: "https://explorer.solana.com",
    explorerParam: "cluster=devnet",
  },
  localnet: {
    label: "本地验证器",
    rpc: "http://127.0.0.1:8899",
    explorer: "https://explorer.solana.com",
    explorerParam: "cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
  },
};
const params = new URLSearchParams(location.search);
const CLUSTER_KEY = params.get("cluster");
const CLUSTER =
  CLUSTERS[CLUSTER_KEY] ||
  (window.CHAIN_CLUSTER && CLUSTERS[window.CHAIN_CLUSTER]) ||
  CLUSTERS.devnet;
const RPC_URL = window.CHAIN_RPC_URL || CLUSTER.rpc;
const isLocalnet = CLUSTER === CLUSTERS.localnet;

const STATE_LABEL = {
  waitingForOpponent: "等待入座",
  inProgress: "对局中",
  oWon: "O 方胜",
  xWon: "X 方胜",
  draw: "和棋",
};
/** 一局最多 9 手，所以回放上限就按 9 算，避免异常数据把列表撑爆 */
const MAX_PLIES = 9;
/** 列表最多渲染多少局（链上账户多起来时，首屏不该被拖死） */
const MAX_ROWS = 60;

const ui = {
  alert: document.getElementById("archive-alert"),
  alertText: document.getElementById("archive-alert-text"),
  scope: document.getElementById("archive-scope"),
  stats: document.getElementById("archive-stats"),
  total: document.getElementById("stat-total"),
  finished: document.getElementById("stat-finished"),
  live: document.getElementById("stat-live"),
  oWins: document.getElementById("stat-o"),
  xWins: document.getElementById("stat-x"),
  draws: document.getElementById("stat-draw"),
  mineForm: document.getElementById("mine-form"),
  mineInput: document.getElementById("mine-input"),
  mineWalletBtn: document.getElementById("mine-wallet-btn"),
  mineResult: document.getElementById("mine-result"),
  mineWins: document.getElementById("mine-wins"),
  mineLosses: document.getElementById("mine-losses"),
  mineDraws: document.getElementById("mine-draws"),
  mineRate: document.getElementById("mine-rate"),
  mineNote: document.getElementById("mine-note"),
  mineHint: document.getElementById("mine-hint"),
  count: document.getElementById("archive-count"),
  games: document.getElementById("archive-games"),
  empty: document.getElementById("archive-empty"),
  pdaForm: document.getElementById("pda-form"),
  pdaInput: document.getElementById("pda-input"),
};

const state = {
  connection: null,
  program: null,
  games: [],
  /** RPC 不允许枚举程序账户时为 true：列表/统计不可用，但单局查询仍然可行 */
  listFailed: false,
  /** pda -> { plies: number[], error: string | null }，避免重复拉交易 */
  history: new Map(),
};

// ── 只读 Anchor Provider ──
// program.account.* 只需要 connection；签名相关能力这里根本用不到，
// 但 AnchorProvider 要求有个 wallet，于是给一个不会签名的空壳。
function readOnlyWallet() {
  return {
    publicKey: null,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
}

// ── 小工具 ──
function shortAddr(pk) {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
function showAlert(text, kind = "warn") {
  ui.alertText.textContent = text;
  ui.alert.dataset.kind = kind;
  ui.alert.classList.remove("hidden");
}
function clearAlert() {
  ui.alert.classList.add("hidden");
}
function fmtTime(secs) {
  if (!secs) return "—";
  const d = new Date(Number(secs) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function explorerAccount(pda) {
  return `${CLUSTER.explorer}/address/${pda}?${CLUSTER.explorerParam}`;
}
function markName(code) {
  return code === 1 ? "O" : code === 2 ? "X" : "";
}

// ── 账户 → 视图模型 ──
// Anchor 把枚举解码成 { oWon: {} } 这种单键对象，取键名即可。
function normalize(publicKey, account) {
  const key = publicKey.toBase58 ? publicKey.toBase58() : String(publicKey);
  const stateKey = Object.keys(account.state || {})[0] || "inProgress";
  const playerO = account.playerO.toBase58();
  const playerX = account.playerX.toBase58();
  return {
    pda: key,
    stateKey,
    stateLabel: STATE_LABEL[stateKey] || stateKey,
    over: stateKey === "oWon" || stateKey === "xWon" || stateKey === "draw",
    playerO,
    playerX,
    // 未入座时 player_x 是全零公钥
    hasX: playerX !== PublicKey.default.toBase58(),
    board: Array.from(account.board, Number),
    moves: Number(account.moves),
    lastActivityAt: Number(account.lastActivityAt.toString()),
    gameId: account.gameId.toString(),
  };
}

function setupClusterUi() {
  const onPages = location.hostname.endsWith("github.io");
  if (onPages) {
    document.querySelectorAll(".top-nav a.local-only").forEach((a) => a.classList.add("hidden"));
  }
  const sw = document.getElementById("cluster-switch");
  const hint = document.getElementById("cluster-hint");
  if (!sw || !hint) return;
  if (isLocalnet) {
    sw.textContent = "切到 Devnet";
    sw.href = "?cluster=devnet";
    hint.textContent = "当前本地验证器 · 只读查询，无需连接钱包";
  } else {
    sw.textContent = "切到本地验证器";
    sw.href = "?cluster=localnet";
    hint.textContent = "当前 Devnet · 只读查询，无需连接钱包";
  }
}

async function boot() {
  setupClusterUi();

  try {
    state.connection = new Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(state.connection, readOnlyWallet(), {
      commitment: "confirmed",
    });
    const idl = await fetch("./chain/idl.json").then((r) => {
      if (!r.ok) throw new Error("IDL 加载失败");
      return r.json();
    });
    state.program = new Program(idl, provider);
  } catch (err) {
    showAlert(`链上环境初始化失败：${err.message}。检查 RPC（${RPC_URL}）是否可达。`, "err");
    ui.scope.textContent = "不可用";
    return;
  }

  bindEvents();
  await loadGames();

  // 邀请链接 / 分享链接带 ?pda=，直接展开那一局
  const pda = params.get("pda");
  if (pda) focusGame(pda);
}

function bindEvents() {
  ui.mineForm.addEventListener("submit", onMineQuery);
  ui.pdaForm.addEventListener("submit", onPdaQuery);
  if (window.solana?.isPhantom) {
    ui.mineWalletBtn.classList.remove("hidden");
    ui.mineWalletBtn.addEventListener("click", onUseWallet);
  }
}

// ── 列表 ──
async function loadGames() {
  ui.scope.textContent = `从 ${CLUSTER.label} 读取…`;
  try {
    const all = await state.program.account.game.all();
    state.games = all
      .map(({ publicKey, account }) => normalize(publicKey, account))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.moves - a.moves);
    clearAlert();
  } catch (err) {
    // 公共 RPC 可能禁用 getProgramAccounts。这时列表不可用，但单局查询仍然可行。
    state.games = [];
    state.listFailed = true;
    ui.scope.textContent = "枚举不可用";
    showAlert(
      `这个 RPC 不允许枚举程序账户（${err.message}）。仍可在下方直接填 PDA 查单局 —— 只读查询不受影响。`,
      "warn",
    );
  }
  renderStats();
  renderList();
}

function tally() {
  const t = { total: state.games.length, o: 0, x: 0, draw: 0, live: 0, waiting: 0 };
  for (const g of state.games) {
    if (g.stateKey === "oWon") t.o += 1;
    else if (g.stateKey === "xWon") t.x += 1;
    else if (g.stateKey === "draw") t.draw += 1;
    else if (g.stateKey === "inProgress") t.live += 1;
    else t.waiting += 1;
  }
  t.finished = t.o + t.x + t.draw;
  return t;
}

function renderStats() {
  const t = tally();
  ui.total.textContent = t.total;
  ui.finished.textContent = t.finished;
  ui.live.textContent = t.live;
  ui.oWins.textContent = t.o;
  ui.xWins.textContent = t.x;
  ui.draws.textContent = t.draw;
  ui.stats.setAttribute("aria-busy", "false");
  ui.scope.textContent = state.listFailed
    ? `${CLUSTER.label} · 枚举不可用，可用 PDA 查单局`
    : t.total === 0
      ? `${CLUSTER.label} · 暂无对局`
      : `${CLUSTER.label} · 已终局 ${t.finished} / 共 ${t.total} 局${t.waiting ? ` · ${t.waiting} 局等待入座` : ""}`;
}

function miniBoard(board) {
  const cells = board
    .map((c) => {
      const m = markName(c);
      return `<i class="arc-mini-cell">${m ? `<span class="mark ${m.toLowerCase()}"></span>` : ""}</i>`;
    })
    .join("");
  return `<div class="arc-mini" aria-hidden="true">${cells}</div>`;
}

function resultClass(g) {
  if (g.stateKey === "oWon" || g.stateKey === "xWon") return "is-over";
  if (g.stateKey === "draw") return "is-draw";
  if (g.stateKey === "inProgress") return "is-live";
  return "is-waiting";
}

function renderList() {
  const rows = state.games.slice(0, MAX_ROWS);
  ui.games.innerHTML = rows
    .map((g, i) => {
      const xText = g.hasX ? shortAddr(g.playerX) : "待入座";
      return `
      <article class="arc-row" data-pda="${g.pda}" data-index="${i}">
        <div class="arc-main">
          ${miniBoard(g.board)}
          <div class="arc-body">
            <div class="arc-line">
              <span class="arc-badge ${resultClass(g)}">${g.stateLabel}</span>
              <span class="arc-pair"><b>O</b> ${shortAddr(g.playerO)} <span class="arc-vs">vs</span> <b>X</b> ${xText}</span>
            </div>
            <div class="arc-meta">
              <span>${g.moves} 手</span>
              <span>${fmtTime(g.lastActivityAt)}</span>
              <a href="${explorerAccount(g.pda)}" target="_blank" rel="noopener">浏览器 ↗</a>
            </div>
          </div>
          <button class="ghost small arc-open" type="button" aria-expanded="false">看棋谱</button>
        </div>
        <div class="arc-detail hidden"></div>
      </article>`;
    })
    .join("");

  ui.empty.classList.toggle("hidden", state.games.length > 0);
  ui.count.textContent =
    state.games.length > MAX_ROWS
      ? `共 ${state.games.length} 局，显示最近 ${MAX_ROWS} 局`
      : `${state.games.length} 局`;

  for (const row of ui.games.querySelectorAll(".arc-row")) {
    const btn = row.querySelector(".arc-open");
    btn.addEventListener("click", () => toggleDetail(row));
  }
}

// ── 棋谱：从交易历史重建 ──
// 账户里只存终局快照。要拿到"第几手落在哪"，只能回到交易里找 play(position)。
function toBase58(value) {
  if (typeof value === "string") return value;
  return value?.toBase58?.() ?? String(value);
}

function decodeInstruction(dataB58) {
  // getParsedTransaction 里非内置程序的指令是「部分解码」形态：
  // programId 是字符串，data 是 base58 字符串。Anchor 的 decode 默认按 hex 解，
  // 所以第二个参数必须显式写 "base58"。
  try {
    const decoded = state.program.coder.instruction.decode(dataB58, "base58");
    if (decoded) return decoded;
  } catch {
    /* 落到下面的兜底解析 */
  }
  // 兜底：自己按 discriminator 解 play(position) —— 8 字节判别符 + 1 字节位置
  try {
    const raw = anchor.utils.bytes.bs58.decode(dataB58);
    const disc = anchor.utils.sha256.hash("global:play").slice(0, 8);
    if (raw.length === 9 && disc.every((b, i) => raw[i] === b)) {
      return { name: "play", data: { position: raw[8] } };
    }
  } catch {
    /* 不是本程序的指令 */
  }
  return null;
}

async function loadPlies(pda) {
  const cached = state.history.get(pda);
  if (cached) return cached;

  const sigs = await state.connection.getSignaturesForAddress(new PublicKey(pda), { limit: 100 }, "confirmed");
  // RPC 返回的是从新到旧；棋谱要从头摆起，所以反过来
  const ordered = [...sigs].reverse();
  const plies = [];
  let scanned = 0;

  for (const info of ordered) {
    const tx = await state.connection.getParsedTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    scanned += 1;
    if (!tx) continue;
    const ixs = tx.transaction?.message?.instructions || [];
    for (const ix of ixs) {
      if (toBase58(ix.programId) !== PROGRAM_ID.toBase58()) continue;
      const decoded = decodeInstruction(ix.data);
      if (decoded?.name !== "play") continue;
      const pos = Number(decoded.data.position);
      if (Number.isInteger(pos) && pos >= 0 && pos <= 8 && plies.length < MAX_PLIES) {
        plies.push(pos);
      }
    }
  }

  const result = { plies, scanned, error: null };
  state.history.set(pda, result);
  return result;
}

/** 按 O 先手、交替落子重建盘面 */
function boardFromPlies(plies, upTo) {
  const board = new Array(9).fill(0);
  for (let i = 0; i < Math.min(upTo, plies.length); i += 1) {
    board[plies[i]] = i % 2 === 0 ? 1 : 2;
  }
  return board;
}

function sameBoard(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function replayBoard(board) {
  const cells = board
    .map((c) => {
      const m = markName(c);
      return `<i class="arc-cell">${m ? `<span class="mark ${m.toLowerCase()}"></span>` : ""}</i>`;
    })
    .join("");
  return `<div class="arc-replay-board">${cells}</div>`;
}

function moveText(plies) {
  return plies
    .map((pos, i) => `${i + 1}. ${i % 2 === 0 ? "O" : "X"}→${pos}`)
    .join("　");
}

async function toggleDetail(row) {
  const pda = row.dataset.pda;
  const detail = row.querySelector(".arc-detail");
  const btn = row.querySelector(".arc-open");
  if (!detail.classList.contains("hidden")) {
    detail.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "看棋谱";
    return;
  }

  detail.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  btn.textContent = "收起";

  if (detail.dataset.ready === "1") return;
  detail.innerHTML = `<p class="arc-loading">从链上取这笔 PDA 的交易，解出落子…</p>`;

  const game = state.games.find((g) => g.pda === pda) || (await fetchOne(pda));
  if (!game) {
    detail.innerHTML = `<p class="arc-loading arc-bad">账户读取失败，可能已被创建者关掉（close_game）。</p>`;
    return;
  }

  let info;
  try {
    info = await loadPlies(pda);
  } catch (err) {
    detail.innerHTML = `<p class="arc-loading arc-bad">取交易失败：${err.message}</p>`;
    return;
  }

  const plies = info.plies;
  detail.dataset.ready = "1";

  if (plies.length === 0) {
    detail.innerHTML = `
      <p class="arc-loading">链上还没有这局的落子交易${game.moves > 0 ? `（账户记着 ${game.moves} 手，可能超出了本次扫描范围）` : ""}。</p>
      <p class="arc-note">共扫了 ${info.scanned} 笔签名。</p>`;
    return;
  }

  const rebuilt = boardFromPlies(plies, plies.length);
  const matched = sameBoard(rebuilt, game.board);

  detail.innerHTML = `
    <div class="arc-replay">
      <div class="arc-replay-left">
        <div class="arc-replay-stage">${replayBoard(boardFromPlies(plies, plies.length))}</div>
      </div>
      <div class="arc-replay-right">
        <p class="arc-move-text">${moveText(plies)}</p>
        <p class="arc-note">自 ${info.scanned} 笔签名里解出 ${plies.length} 手落子。</p>
        <p class="arc-check ${matched ? "ok" : "bad"}">${
          matched
            ? "重建盘面与链上账户一致 ✓"
            : "重建盘面与账户不一致 ✗ —— 账户可能记的是被 close 前的旧局，或扫描范围不足"
        }</p>
        <div class="arc-replay-controls">
          <button type="button" class="ghost small arc-prev">◀ 上一手</button>
          <span class="arc-cursor">第 ${plies.length} / ${plies.length} 手</span>
          <button type="button" class="ghost small arc-next">下一手 ▶</button>
          <button type="button" class="ghost small arc-last">终局</button>
        </div>
      </div>
    </div>`;

  bindReplay(detail, plies);
}

function bindReplay(detail, plies) {
  // 默认停在终局：列表里的缩略盘面就是终局，展开后先看到同一盘，避免"对不上"的错觉
  let cursor = plies.length;
  const boardEl = detail.querySelector(".arc-replay-stage");
  const cursorEl = detail.querySelector(".arc-cursor");
  const prev = detail.querySelector(".arc-prev");
  const next = detail.querySelector(".arc-next");
  const last = detail.querySelector(".arc-last");

  const paint = () => {
    boardEl.innerHTML = replayBoard(boardFromPlies(plies, cursor));
    cursorEl.textContent = `第 ${cursor} / ${plies.length} 手`;
    prev.disabled = cursor <= 1;
    next.disabled = cursor >= plies.length;
  };
  prev.addEventListener("click", () => {
    if (cursor > 1) {
      cursor -= 1;
      paint();
    }
  });
  next.addEventListener("click", () => {
    if (cursor < plies.length) {
      cursor += 1;
      paint();
    }
  });
  last.addEventListener("click", () => {
    cursor = plies.length;
    paint();
  });
  paint();
}

async function fetchOne(pdaStr) {
  try {
    const pda = new PublicKey(pdaStr);
    const account = await state.program.account.game.fetch(pda);
    return normalize(pda, account);
  } catch {
    return null;
  }
}

/** 展开指定 PDA 的那一局；不在列表里就直接查账户再补一行 */
async function focusGame(pdaStr) {
  let game = state.games.find((g) => g.pda === pdaStr);
  if (!game) {
    game = await fetchOne(pdaStr);
    if (!game) {
      showAlert("这个 PDA 地址上没有对局账户（可能地址写错，或已被创建者关掉）。", "warn");
      return;
    }
    state.games.push(game);
    renderStats();
    renderList();
  }
  const row = ui.games.querySelector(`.arc-row[data-pda="${pdaStr}"]`);
  if (!row) {
    showAlert(`这一局不在前 ${MAX_ROWS} 行里，可用上方的 PDA 查询单独打开。`, "warn");
    return;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  await toggleDetail(row);
}

// ── 我的战绩 ──
function onMineQuery(event) {
  if (event) event.preventDefault();
  const addr = ui.mineInput.value.trim();
  if (!addr) return;
  let pk;
  try {
    pk = new PublicKey(addr);
  } catch {
    ui.mineResult.classList.add("hidden");
    ui.mineHint.textContent = "地址格式不对 —— Solana 地址是 32–44 位 base58 字符。";
    return;
  }
  clearAlert();

  if (state.listFailed) {
    ui.mineResult.classList.add("hidden");
    ui.mineHint.textContent =
      "当前 RPC 不支持枚举程序账户，没法按地址汇总战绩。可用下方的 PDA 查询单看某一局。";
    return;
  }

  const mine = state.games.filter((g) => g.playerO === pk.toBase58() || g.playerX === pk.toBase58());
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const g of mine) {
    const side = g.playerO === pk.toBase58() ? "o" : "x";
    if (g.stateKey === "draw") draws += 1;
    else if (g.stateKey === "oWon") side === "o" ? (wins += 1) : (losses += 1);
    else if (g.stateKey === "xWon") side === "x" ? (wins += 1) : (losses += 1);
  }
  const decided = wins + losses + draws;
  const rate = decided ? `${Math.round((wins / decided) * 100)}%` : "—";

  ui.mineWins.textContent = wins;
  ui.mineLosses.textContent = losses;
  ui.mineDraws.textContent = draws;
  ui.mineRate.textContent = rate;
  ui.mineNote.textContent = decided
    ? `共 ${mine.length} 局参与，${decided} 局已终局（胜率按终局计，和棋也计入分母）。`
    : mine.length
      ? `共 ${mine.length} 局参与，都还没终局。`
      : `链上还没有 ${shortAddr(pk)} 参与的对局。`;
  ui.mineResult.classList.remove("hidden");
  ui.mineHint.textContent = "地址从链上账户里比对，不发给任何服务器。链上版对局全部参与统计。";
}

async function onUseWallet() {
  try {
    const resp = await window.solana.connect();
    const pk = resp?.publicKey || window.solana.publicKey;
    ui.mineInput.value = pk.toBase58();
    onMineQuery();
  } catch (err) {
    ui.mineHint.textContent = `钱包连接被拒绝：${err.message}`;
  }
}

async function onPdaQuery(event) {
  event.preventDefault();
  const pda = ui.pdaInput.value.trim();
  if (!pda) return;
  await focusGame(pda);
}

boot();
