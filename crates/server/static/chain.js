// 链上版前端：浏览器钱包（Phantom / Solflare / Backpack / OKX）+ Anchor 程序。
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

// ── 集群配置 ──
// 同一个 program keypair 部署到 localnet / devnet，程序 ID 不变，IDL 也通用。
// 公网（GitHub Pages）默认 devnet；本机开发可用 ?cluster=localnet 切回本地验证器。
// URL 参数 > window.CHAIN_RPC_URL > 默认值。
const CLUSTERS = {
  devnet: {
    label: "Devnet",
    rpc: "https://api.devnet.solana.com",
    // 钱包里的网络名，用来核对是否切对
    phantomNetwork: "Devnet",
    explorer: "https://explorer.solana.com",
    explorerParam: "cluster=devnet",
  },
  localnet: {
    label: "本地验证器",
    rpc: "http://127.0.0.1:8899",
    phantomNetwork: "Localhost",
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

// 与链上 `state::TIMEOUT_SECS` 一致。这里只用来算倒计时和按钮是否可点 ——
// 真正的判罚由链上时钟和执行结果决定，前端算错了也骗不过程序。
const TIMEOUT_SECS = 300;

const ui = {
  alert: document.getElementById("chain-alert"),
  alertText: document.getElementById("chain-alert-text"),
  lobby: document.getElementById("chain-lobby"),
  game: document.getElementById("chain-game"),
  connectBtn: document.getElementById("connect-btn"),
  walletAddr: document.getElementById("wallet-addr"),
  networkNote: document.getElementById("network-note"),
  fundsNote: document.getElementById("funds-note"),
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
  txLink: document.getElementById("chain-tx-link"),
  joinGameBtn: document.getElementById("chain-join-game-btn"),
  resignBtn: document.getElementById("chain-resign-btn"),
  timeoutBtn: document.getElementById("chain-timeout-btn"),
  timeoutHint: document.getElementById("chain-timeout-hint"),
  closeBtn: document.getElementById("chain-close-btn"),
  closeRule: document.getElementById("chain-close-rule"),
  leaveBtn: document.getElementById("chain-leave-btn"),
};

const state = {
  connection: null,
  provider: null,
  program: null,
  wallet: null,
  walletProvider: null,
  pda: null,
  accountSub: null,
  account: null,
  busy: false,
  renderedMoves: -1,
};

// ── 浏览器钱包 → Anchor Wallet 适配 ──
// Phantom / Solflare / Backpack / OKX 都按同一套约定注入 provider：
// publicKey + connect() + signTransaction() + signAllTransactions()。
// 所以不绑定某一家，谁在就用谁；AnchorProvider 只认这四样，补一层薄适配器即可。
class InjectedWallet {
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

// 注入点各不相同：Phantom 有 window.phantom.solana，Solflare 用 window.solflare，
// Backpack 用 window.backpack，OKX 用 window.okxwallet.solana，
// 还有一批钱包直接占 window.solana。按顺序取第一个能用的。
const WALLET_CANDIDATES = [
  { label: "Phantom", get: () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null) },
  { label: "Solflare", get: () => window.solflare },
  { label: "Backpack", get: () => window.backpack },
  { label: "OKX Wallet", get: () => window.okxwallet?.solana },
  { label: "浏览器钱包", get: () => (window.solana?.connect ? window.solana : null) },
];

function detectWallet() {
  for (const candidate of WALLET_CANDIDATES) {
    try {
      const provider = candidate.get();
      if (provider && typeof provider.connect === "function") {
        return { label: candidate.label, provider };
      }
    } catch {
      // 某些扩展的 getter 会抛错，忽略继续找下一个
    }
  }
  return null;
}

// 没有注入钱包时别只说「装 Phantom」：手机浏览器里本来就不会有扩展，
// 正确做法是用钱包 App 内置浏览器打开本页。
function showNoWalletHelp() {
  const url = location.href;
  const phantom = `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`;
  ui.connectBtn.disabled = true;
  ui.connectBtn.textContent = "没有检测到钱包";
  ui.alertText.textContent = "";
  ui.alertText.append(
    "这个浏览器里没有钱包扩展。桌面端可安装 Phantom / Solflare / Backpack 任一；手机端请用钱包 App 的浏览器打开本页：",
  );
  const a = document.createElement("a");
  a.href = phantom;
  a.textContent = "用 Phantom App 打开";
  a.target = "_blank";
  a.rel = "noopener";
  ui.alertText.append(a, "。装好扩展后刷新本页。");
  ui.alert.classList.remove("hidden");
}

function showAlert(text) {
  ui.alertText.textContent = text;
  ui.alert.classList.remove("hidden");
}
function clearAlert() {
  ui.alert.classList.add("hidden");
}
function setTxState(text, kind = "idle", sig = null) {
  ui.txState.textContent = text;
  ui.txState.dataset.kind = kind;
  if (sig) {
    ui.txLink.href = explorerLink(sig);
    ui.txLink.classList.remove("hidden");
  } else {
    ui.txLink.classList.add("hidden");
  }
}
function shortAddr(pk) {
  const s = pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function setupClusterUi() {
  // Pages 上只发布链上版，本地版/观战链接指向的相对页面不存在，隐藏掉
  const onPages = location.hostname.endsWith("github.io");
  if (onPages) {
    document.querySelectorAll(".top-nav a.local-only").forEach((a) => {
      a.classList.add("hidden");
    });
  }
  const sw = document.getElementById("cluster-switch");
  const hint = document.getElementById("cluster-hint");
  if (!sw || !hint) return;
  if (isLocalnet) {
    sw.textContent = "切到 Devnet";
    sw.href = "?cluster=devnet";
    hint.textContent = "当前本地验证器 · 钱包切到 Localhost · 需先在本机起验证器并部署程序";
  } else {
    sw.textContent = "切到本地验证器";
    sw.href = "?cluster=localnet";
    hint.textContent = "当前 Devnet · 程序已上公网，钱包切到 Devnet 即可玩";
  }
}

async function boot() {
  buildBoard();
  setupClusterUi();

  const found = detectWallet();
  if (!found) {
    showNoWalletHelp();
    return;
  }
  ui.connectBtn.textContent = `连接 ${found.label}`;

  try {
    state.connection = new Connection(RPC_URL, "confirmed");
    state.walletProvider = found.provider;
    state.wallet = new InjectedWallet(found.provider);
    state.provider = new anchor.AnchorProvider(state.connection, state.wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(state.provider);

    // IDL 本地托管，和部署的程序 ID 对齐。相对路径兼容本地与 Pages 子路径。
    const idl = await fetch("./chain/idl.json").then((r) => {
      if (!r.ok) throw new Error("IDL 加载失败");
      return r.json();
    });
    state.program = new Program(idl, state.provider);

    // 已连接过就直接进入可用状态
    if (found.provider.isConnected && found.provider.publicKey) {
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
  ui.joinGameBtn.addEventListener("click", onJoinGameClick);
  ui.resignBtn.addEventListener("click", onResign);
  ui.timeoutBtn.addEventListener("click", onClaimTimeout);
  ui.closeBtn.addEventListener("click", onClose);
  ui.leaveBtn.addEventListener("click", leaveGame);

  // 超时是「等」出来的：每秒刷新一次倒计时，不重新读链
  setInterval(() => {
    if (state.account) updateProtocolButtons(state.account);
  }, 1000);
}

async function onConnectClick() {
  try {
    const resp = await state.walletProvider.connect();
    onConnected(resp?.publicKey);
  } catch (err) {
    showAlert(`钱包连接被拒绝：${err.message}`);
  }
}

function onConnected(pubkey) {
  const key = pubkey || state.walletProvider.publicKey;
  clearAlert();
  ui.walletAddr.textContent = shortAddr(key);
  ui.connectBtn.textContent = "钱包已连接";
  ui.connectBtn.disabled = true;
  ui.createBtn.disabled = false;
  ui.joinBtn.disabled = false;
  checkNetwork();
  warnIfNoFunds(key);

  // 若 URL 带了 ?pda=，直接进那局
  const pda = new URLSearchParams(location.search).get("pda");
  if (pda) enterGame(pda);
}

async function checkNetwork() {
  // 只用 RPC 配置提示该切到哪个网络。
  // 不去比对 genesis 指纹：本地验证器每次 reset 都换 genesis，硬编码会误报。
  ui.networkNote.textContent = isLocalnet
    ? `当前：本地验证器（${RPC_URL}）。请先把钱包切到 Localhost，再建局。`
    : `当前：Devnet（${RPC_URL}）。请把钱包也切到 Devnet —— 网络不一致会签名失败。`;
  ui.networkNote.classList.remove("hidden");
  try {
    await state.connection.getGenesisHash(); // 探活：能拿到就说明 RPC 通
    ui.networkNote.dataset.ok = "true";
  } catch {
    ui.networkNote.dataset.ok = "false";
    ui.networkNote.textContent += isLocalnet
      ? " 但 RPC 不可达 —— 本地验证器起了吗？"
      : " 但 RPC 不可达 —— 检查网络。";
  }
}

// 新钱包最常见的第一个坑：余额为 0，建局时付不出账户租金，
// 只会拿到一句 "Attempt to debit an account but found no record of a prior credit"。
// 与其让人对着这句话猜，不如直接告诉他去哪儿领。
async function warnIfNoFunds(owner) {
  const el = ui.fundsNote;
  if (!el) return;
  el.classList.add("hidden");
  try {
    const lamports = await state.connection.getBalance(owner);
    if (lamports > 0) return;
    el.textContent = "";
    if (isLocalnet) {
      el.textContent =
        "这个钱包在本地验证器上余额为 0。先领一点再建局：" +
        `solana airdrop 2 ${owner.toBase58()} --url ${RPC_URL}`;
    } else {
      el.append("这个钱包在 Devnet 上没有 SOL，建局付不出账户租金。先去 ");
      const a = document.createElement("a");
      a.href = "https://faucet.solana.com/?cluster=devnet";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "水龙头";
      el.append(a, " 领 1 SOL，回来刷新页面即可。");
    }
    el.classList.remove("hidden");
  } catch {
    // 余额查不到（RPC 限流等）就不打扰，别把网络问题说成没余额
  }
}

// 区块浏览器链接（带正确集群参数）
function explorerLink(sig) {
  return `${CLUSTER.explorer}/tx/${sig}?${CLUSTER.explorerParam}`;
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
    setTxState(`建局成功 ${sig.slice(0, 8)}…`, "ok", sig);
    enterGame(pda.toBase58());
  } catch (err) {
    setTxState("建局失败", "err");
    showAlert(`建局失败：${err.message}`);
  } finally {
    state.busy = false;
    ui.createBtn.disabled = false;
  }
}

// X 方入座：发一笔真正的 joinGame 交易，链上把 player_x 写上、状态推进到对局中。
// 前端绝不自己改状态 —— 只发交易，结果由链上裁决后再刷新账户。
async function sendJoinGame(pdaStr) {
  if (state.busy) return false;
  let pda;
  try {
    pda = new PublicKey(pdaStr);
  } catch {
    showAlert("PDA 地址格式不对，请检查是否复制完整。");
    return false;
  }
  state.busy = true;
  setTxState("发送入座交易…", "busy");
  try {
    const sig = await state.program.methods
      .joinGame()
      .accountsPartial({ game: pda, playerX: state.wallet.publicKey })
      .rpc();
    setTxState(`入座成功 ${sig.slice(0, 8)}…`, "ok", sig);
    return true;
  } catch (err) {
    setTxState("入座失败", "err");
    showAlert(`入座失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

async function onJoin(event) {
  event.preventDefault();
  const pda = ui.pdaInput.value.trim();
  if (!pda) return;
  // 先发入座交易，成功后再订阅/渲染这局。
  if (await sendJoinGame(pda)) {
    enterGame(pda);
  }
}

// 通过邀请链接 ?pda= 进来时会自动 enterGame，但还没落链上入座交易。
// 对局页这个按钮让 X 补发 joinGame，按钮只在「等人 + 自己不是 O」时出现。
async function onJoinGameClick() {
  if (!state.pda) return;
  if (await sendJoinGame(state.pda.toBase58())) {
    const account = await state.program.account.game.fetch(state.pda);
    renderAccount(account);
  }
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
  const clusterParam = CLUSTER_KEY ? `cluster=${CLUSTER_KEY}&` : "";
  history.replaceState(null, "", `?${clusterParam}pda=${pda.toBase58()}`);

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
  state.account = null;
  ui.timeoutHint.classList.add("hidden");
  ui.game.classList.add("hidden");
  ui.lobby.classList.remove("hidden");
  history.replaceState(null, "", CLUSTER_KEY ? `?cluster=${CLUSTER_KEY}` : location.pathname);
  setTxState("等待签名", "idle");
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
  state.account = account;
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
  const iamO = account.playerO.equals(state.wallet.publicKey);
  // 终局后关局是「收尾」，等人入座时关局是「撤回」——链上都允许（只禁对局中）。
  const canClose = (isOver || stateKey === "waitingForOpponent") && iamO;
  ui.closeBtn.classList.toggle("hidden", !canClose);
  ui.closeBtn.textContent = isOver ? "关局退租金" : "撤回这局";

  // 对局中把按钮藏起来只是「不给点」，真正的约束在链上（CloseGame 的 constraint）。
  // 这里多写一句，是为了避免有人以为按钮藏起来就等于规则生效。
  ui.closeRule?.classList.toggle("hidden", !(stateKey === "inProgress" && iamO));

  // 等人入座时，非建局方（潜在 X）显示「入座」按钮去发 joinGame。
  // 建局方 O 看不到（链上也不允许自己入自己的局）。
  ui.joinGameBtn.classList.toggle(
    "hidden",
    !(stateKey === "waitingForOpponent" && !iamO),
  );

  updateProtocolButtons(account);
}

/** 读取账户状态名的 helper：Anchor 把枚举解析成 { inProgress: {} } 这种形状 */
function stateKeyOf(account) {
  return Object.keys(STATE_LABEL).find((k) => account.state[k] !== undefined);
}

function chainNow(account) {
  // Anchor 的 i64 解析成 BN；兜底成 Number 以防 IDL 以后换类型
  const last = account.lastActivityAt ?? account.createdAt ?? 0;
  return typeof last?.toNumber === "function" ? last.toNumber() : Number(last);
}

function fmtDuration(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/**
 * 协议按钮：认输 + 判对方超时。
 *
 * 两条都只在「双方都在局中」时出现，因为只有在局中才可能卡住。
 * 判超时只给「等着的那一方」——轮到自己时点它，链上会直接拒绝
 * （OnlyOpponentCanClaimTimeout），前端先藏起来只是省一次失败交易。
 */
function updateProtocolButtons(account) {
  const stateKey = stateKeyOf(account);
  const myMark = walletMark(account);
  const inGame = stateKey === "inProgress";

  ui.resignBtn.classList.toggle("hidden", !(inGame && myMark));

  const waitingOnOpponent =
    inGame && myMark && (account.turn === 1 ? "O" : "X") !== myMark;
  ui.timeoutBtn.classList.toggle("hidden", !waitingOnOpponent);
  if (!waitingOnOpponent) {
    ui.timeoutHint.classList.add("hidden");
    return;
  }

  const idle = Math.max(0, Math.floor(Date.now() / 1000) - chainNow(account));
  const left = TIMEOUT_SECS - idle;
  ui.timeoutHint.classList.remove("hidden");
  if (left > 0) {
    ui.timeoutBtn.disabled = true;
    ui.timeoutHint.textContent = `对方已 ${fmtDuration(idle)} 没落子，再等 ${fmtDuration(
      left,
    )} 就能判超时`;
  } else {
    ui.timeoutBtn.disabled = false;
    ui.timeoutHint.textContent = `对方已 ${fmtDuration(idle)} 没落子，可以判超时了`;
  }
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
    setTxState(`落子成功 ${sig.slice(0, 8)}…`, "ok", sig);
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

// 认输：这是唯一能让「不想下了」的一方体面结束、并且把租金拿回来的路径。
// 没有它，A-01（对局中禁止关局）会把双方一起锁死。
async function onResign() {
  if (state.busy || !state.pda) return;
  const ok = window.confirm("认输后对手直接获胜，交易上链后无法撤回。确定认输吗？");
  if (!ok) return;

  state.busy = true;
  setTxState("发送认输交易…", "busy");
  try {
    const sig = await state.program.methods
      .resign()
      .accountsPartial({ game: state.pda, player: state.wallet.publicKey })
      .rpc();
    setTxState(`已认输 ${sig.slice(0, 8)}…`, "ok", sig);
    renderAccount(await state.program.account.game.fetch(state.pda));
  } catch (err) {
    setTxState("认输失败", "err");
    showAlert(`认输失败：${err.message}`);
  } finally {
    state.busy = false;
    if (state.pda) renderAccount(await state.program.account.game.fetch(state.pda));
  }
}

// 判对方超时：链上按「最后活动时间 + 5 分钟」裁决，对手关掉浏览器也躲不过。
// 前端只负责把按钮在倒计时结束后点亮，判不判得成由程序说了算。
async function onClaimTimeout() {
  if (state.busy || !state.pda) return;
  const ok = window.confirm("确认对方已超过 5 分钟没有落子？交易上链后会判你获胜。");
  if (!ok) return;

  state.busy = true;
  setTxState("发送超时判负交易…", "busy");
  try {
    const sig = await state.program.methods
      .claimTimeout()
      .accountsPartial({ game: state.pda, player: state.wallet.publicKey })
      .rpc();
    setTxState(`已判超时 ${sig.slice(0, 8)}…`, "ok", sig);
    renderAccount(await state.program.account.game.fetch(state.pda));
  } catch (err) {
    setTxState("判超时失败", "err");
    // 最常见的是本地时钟比链上快几秒，链上还没到点
    showAlert(`判超时失败：${err.message}`);
  } finally {
    state.busy = false;
    if (state.pda) renderAccount(await state.program.account.game.fetch(state.pda));
  }
}

async function onClose() {
  if (state.busy || !state.pda) return;
  state.busy = true;
  try {
    const sig = await state.program.methods
      .closeGame()
      .accountsPartial({ game: state.pda, playerO: state.wallet.publicKey })
      .rpc();
    setTxState(`已关局 ${sig.slice(0, 8)}…`, "ok", sig);
    leaveGame();
  } catch (err) {
    showAlert(`关局失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

boot();
