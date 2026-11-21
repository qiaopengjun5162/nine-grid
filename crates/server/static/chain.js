// 链上版前端：Phantom 钱包 + Anchor 程序。
//
// 这里同样不判规则 —— 棋盘来自链上账户的 board 数组，能不能点由 state/turn 决定，
// 落子结果由链上程序裁决。前端只负责发交易、签名、渲染账户状态。

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6");
const GAME_SEED = Buffer.from("game");
// RPC 地址：本地验证器默认 8899。部署到 devnet 时改这里即可，程序 ID 不变。
const RPC_URL = window.CHAIN_RPC_URL || "http://127.0.0.1:8899";
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const STATE_LABEL = {
  waitingForOpponent: "等待对手",
  inProgress: "对局中",
  oWon: "O 方获胜",
  xWon: "X 方获胜",
  draw: "平局",
};

const ui = {
  alert: document.getElementById("chain-alert"),
  alertText: document.getElementById("chain-alert-text"),
  lobby: document.getElementById("chain-lobby"),
  game: document.getElementById("chain-game"),
  connectBtn: document.getElementById("connect-btn"),
  walletAddr: document.getElementById("wallet-addr"),
  networkNote: document.getElementById("network-note"),
  createBtn: document.getElementById("chain-create-btn"),
  joinForm: document.getElementById("chain-join-form"),
  pdaInput: document.getElementById("chain-pda-input"),
  joinBtn: document.querySelector("#chain-join-form button[type=submit]"),
  pdaDisplay: document.getElementById("chain-pda-display"),
  copyBtn: document.getElementById("chain-copy-btn"),
  seatO: document.getElementById("chain-seat-o"),
  seatX: document.getElementById("chain-seat-x"),
  seatOName: document.getElementById("chain-seat-o-name"),
  seatXName: document.getElementById("chain-seat-x-name"),
  status: document.getElementById("chain-status"),
  board: document.getElementById("chain-board"),
  stage: document.getElementById("chain-stage"),
  txState: document.getElementById("chain-tx-state"),
  closeBtn: document.getElementById("chain-close-btn"),
  leaveBtn: document.getElementById("chain-leave-btn"),
};

const state = {
  connection: null,
  provider: null,
  program: null,
  wallet: null,
  pda: null,
  accountSub: null,
  busy: false,
  renderedMoves: -1,
};

// ── Phantom → Anchor Wallet 适配 ──
// Phantom 注入 window.solana，提供 publicKey / signTransaction / signAllTransactions，
// AnchorProvider 正好需要这三个，补一层薄适配器即可。
class PhantomWallet {
  constructor(provider) {
    this.provider = provider;
  }
  get publicKey() {
    return this.provider.publicKey;
  }
  get payer() {
    return this.provider.publicKey;
  }
  signTransaction(tx) {
    return this.provider.signTransaction(tx);
  }
  signAllTransactions(txs) {
    return this.provider.signAllTransactions(txs);
  }
}

function showAlert(text) {
  ui.alertText.textContent = text;
  ui.alert.classList.remove("hidden");
}
function clearAlert() {
  ui.alert.classList.add("hidden");
}
function setTxState(text, kind = "idle") {
  ui.txState.textContent = text;
  ui.txState.dataset.kind = kind;
}
function shortAddr(pk) {
  const s = pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function boot() {
  buildBoard();

  if (!window.solana?.isPhantom) {
    showAlert("没有检测到 Phantom 钱包。请先安装 Phantom 浏览器扩展，再刷新本页。本地版（首页）无需钱包也能玩。");
    return;
  }

  try {
    state.connection = new Connection(RPC_URL, "confirmed");
    const wallet = new PhantomWallet(window.solana);
    state.wallet = wallet;
    state.provider = new anchor.AnchorProvider(state.connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(state.provider);

    // IDL 本地托管，和部署的程序 ID 对齐
    const idl = await fetch("/chain/idl.json").then((r) => {
      if (!r.ok) throw new Error("IDL 加载失败");
      return r.json();
    });
    state.program = new Program(idl, state.provider);

    // 已连接过就直接进入可用状态
    if (window.solana.isConnected && window.solana.publicKey) {
      onConnected();
    }
  } catch (err) {
    showAlert(`链上环境初始化失败：${err.message}。检查 RPC（${RPC_URL}）是否可达。`);
  }

  bindEvents();
}

function bindEvents() {
  ui.connectBtn.addEventListener("click", onConnectClick);
  ui.createBtn.addEventListener("click", onCreate);
  ui.joinForm.addEventListener("submit", onJoin);
  ui.copyBtn.addEventListener("click", copyPda);
  ui.closeBtn.addEventListener("click", onClose);
  ui.leaveBtn.addEventListener("click", leaveGame);
}

async function onConnectClick() {
  try {
    const resp = await window.solana.connect();
    onConnected(resp.publicKey);
  } catch (err) {
    showAlert(`钱包连接被拒绝：${err.message}`);
  }
}

function onConnected(pubkey) {
  const key = pubkey || window.solana.publicKey;
  clearAlert();
  ui.walletAddr.textContent = shortAddr(key);
  ui.connectBtn.textContent = "钱包已连接";
  ui.connectBtn.disabled = true;
  ui.createBtn.disabled = false;
  ui.joinBtn.disabled = false;
  checkNetwork();

  // 若 URL 带了 ?pda=，直接进那局
  const pda = new URLSearchParams(location.search).get("pda");
  if (pda) enterGame(pda);
}

async function checkNetwork() {
  try {
    const genesis = await state.connection.getGenesisHash();
    const isLocal = genesis.startsWith("EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    ui.networkNote.textContent = `当前 RPC：${RPC_URL}（${isLocal ? "本地验证器" : "自定义集群"}）。确保 Phantom 也切到同一网络。`;
    ui.networkNote.classList.remove("hidden");
  } catch {
    // RPC 不可达时建局/落子会报错，这里不重复提示
  }
}

function gamePda(owner, gameId) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(gameId));
  return PublicKey.findProgramAddressSync(
    [GAME_SEED, owner.toBuffer(), idBuf],
    PROGRAM_ID,
  )[0];
}

async function onCreate() {
  if (state.busy) return;
  state.busy = true;
  ui.createBtn.disabled = true;
  setTxState("发送建局交易…", "busy");
  try {
    // game_id 用时间戳，保证同一钱包能开很多局且地址不同
    const gameId = Date.now().toString();
    const pda = gamePda(state.wallet.publicKey, gameId);
    const sig = await state.program.methods
      .createGame(new anchor.BN(gameId))
      .accountsPartial({
        game: pda,
        playerO: state.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    setTxState(`建局成功 ${sig.slice(0, 8)}…`, "ok");
    enterGame(pda.toBase58());
  } catch (err) {
    setTxState("建局失败", "err");
    showAlert(`建局失败：${err.message}`);
  } finally {
    state.busy = false;
    ui.createBtn.disabled = false;
  }
}

async function onJoin(event) {
  event.preventDefault();
  const pda = ui.pdaInput.value.trim();
  if (!pda) return;
  enterGame(pda);
}

async function enterGame(pdaStr) {
  let pda;
  try {
    pda = new PublicKey(pdaStr);
  } catch {
    showAlert("PDA 地址格式不对，请检查是否复制完整。");
    return;
  }

  cleanupSubscription();
  state.pda = pda;
  state.renderedMoves = -1;
  ui.lobby.classList.add("hidden");
  ui.game.classList.remove("hidden");
  ui.pdaDisplay.textContent = pda.toBase58();
  history.replaceState(null, "", `?pda=${pda.toBase58()}`);

  try {
    const account = await state.program.account.game.fetch(pda);
    renderAccount(account);

    // 账户一变就重新拉，等价于本地版的轮询但更及时；规则仍由链上裁决
    state.accountSub = state.connection.onAccountChange(
      pda,
      (info) => {
        try {
          const decoded = state.program.coder.accounts.decode("game", info.data);
          renderAccount(decoded);
        } catch (err) {
          console.warn("账户解码失败", err);
        }
      },
      "confirmed",
    );
  } catch (err) {
    showAlert(`读取链上账户失败：${err.message}。确认程序已部署到 ${RPC_URL}、地址正确。`);
    leaveGame();
  }
}

function leaveGame() {
  cleanupSubscription();
  state.pda = null;
  ui.game.classList.add("hidden");
  ui.lobby.classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
  clearAlert();
}

function cleanupSubscription() {
  if (state.accountSub != null) {
    state.connection.removeAccountChangeListener(state.accountSub).catch(() => {});
    state.accountSub = null;
  }
}

function buildBoard() {
  ui.board.innerHTML = "";
  for (let i = 0; i < 9; i += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.dataset.index = String(i);
    cell.addEventListener("click", () => onCellClick(i));
    ui.board.appendChild(cell);
  }
}

function renderAccount(account) {
  const board = account.board.map((code) => (code === 1 ? "O" : code === 2 ? "X" : ""));
  const stateKey = Object.keys(STATE_LABEL).find(
    (k) => account.state[k] !== undefined,
  );
  const stateName = stateKey ? STATE_LABEL[stateKey] : String(account.state);
  const myMark = walletMark(account);

  ui.seatOName.textContent = shortAddr(account.playerO);
  ui.seatXName.textContent =
    account.playerX && !account.playerX.equals(PublicKey.default)
      ? shortAddr(account.playerX)
      : "待入座";
  ui.seatO.classList.toggle(
    "active",
    stateKey === "inProgress" && account.turn === 1,
  );
  ui.seatX.classList.toggle(
    "active",
    stateKey === "inProgress" && account.turn === 2,
  );

  renderStatus(account, stateName, myMark);
  renderBoard(board, account, myMark);

  const isOver = ["oWon", "xWon", "draw"].includes(stateKey);
  ui.closeBtn.classList.toggle(
    "hidden",
    !(isOver && account.playerO.equals(state.wallet.publicKey)),
  );
}

function walletMark(account) {
  if (!state.wallet?.publicKey) return null;
  if (account.playerO.equals(state.wallet.publicKey)) return "O";
  if (
    account.playerX &&
    !account.playerX.equals(PublicKey.default) &&
    account.playerX.equals(state.wallet.publicKey)
  ) {
    return "X";
  }
  return null;
}

function renderStatus(account, stateName, myMark) {
  let text = stateName;
  const stateKey = Object.keys(STATE_LABEL).find((k) => account.state[k] !== undefined);
  if (stateKey === "waitingForOpponent") {
    text = "等对手入座。把 PDA 地址递过去。";
  } else if (stateKey === "inProgress") {
    const turnMark = account.turn === 1 ? "O" : "X";
    text = myMark === turnMark ? `轮到你落子（${turnMark}）` : `等 ${turnMark} 方落子`;
  }
  ui.status.textContent = text;
  ui.status.classList.toggle("over", ["oWon", "xWon", "draw"].includes(stateKey));
}

function renderBoard(board, account, myMark) {
  const stateKey = Object.keys(STATE_LABEL).find((k) => account.state[k] !== undefined);
  const canPlay =
    stateKey === "inProgress" &&
    myMark &&
    (account.turn === 1 ? "O" : "X") === myMark &&
    !state.busy;

  const winSet = new Set(
    (["oWon", "xWon"].includes(stateKey)
      ? WIN_LINES.find(([a, b, c]) =>
          board[a] === board[b] && board[b] === board[c] && board[a] !== "",
        ) || []
      : []),
  );

  Array.from(ui.board.children).forEach((cell, index) => {
    const mark = board[index];
    if ((cell.dataset.mark || "") !== mark) {
      cell.dataset.mark = mark;
      cell.innerHTML = "";
      if (mark) {
        const symbol = document.createElement("span");
        symbol.className = `mark ${mark.toLowerCase()}`;
        cell.appendChild(symbol);
      }
    }
    cell.disabled = !canPlay || Boolean(mark);
    cell.classList.toggle("win", winSet.has(index));
  });
}

async function onCellClick(index) {
  if (state.busy || !state.pda) return;
  state.busy = true;
  setTxState("等待钱包签名…", "busy");
  try {
    const sig = await state.program.methods
      .play(index)
      .accountsPartial({ game: state.pda, player: state.wallet.publicKey })
      .rpc();
    setTxState(`落子成功 ${sig.slice(0, 8)}…`, "ok");
    // 账户订阅会触发刷新；这里也主动拉一次，避免订阅延迟
    const account = await state.program.account.game.fetch(state.pda);
    renderAccount(account);
  } catch (err) {
    setTxState("落子失败", "err");
    showAlert(`落子失败：${err.message}`);
  } finally {
    state.busy = false;
    if (state.pda) renderAccount(await state.program.account.game.fetch(state.pda));
  }
}

async function copyPda() {
  if (!state.pda) return;
  const link = `${location.origin}${location.pathname}?pda=${state.pda.toBase58()}`;
  try {
    await navigator.clipboard.writeText(link);
    setTxState("邀请链接已复制", "ok");
  } catch {
    setTxState(link, "idle");
  }
}

async function onClose() {
  if (state.busy || !state.pda) return;
  state.busy = true;
  try {
    await state.program.methods
      .closeGame()
      .accountsPartial({ game: state.pda, playerO: state.wallet.publicKey })
      .rpc();
    setTxState("已关局，租金退回", "ok");
    leaveGame();
  } catch (err) {
    showAlert(`关局失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

boot();
