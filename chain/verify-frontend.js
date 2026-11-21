/**
 * 验证 chain.js 前端构造交易的方式是否正确。
 * 用和浏览器完全相同的 IDL、PDA 派生、program.methods 调用跑一局，
 * 通过说明前端的交易逻辑没问题（Phantom 只负责签名，这里用 Node keypair 代替）。
 */
const anchor = require("@coral-xyz/anchor");
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
} = require("@solana/web3.js");
const fs = require("fs");

const RPC = "http://127.0.0.1:8899";
const IDL = JSON.parse(
  fs.readFileSync(
    require("path").join(__dirname, "../crates/server/static/chain/idl.json"),
    "utf8"
  )
);

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const wallet = Keypair.generate();
  // 空投 SOL 当手续费
  const sig = await connection.requestAirdrop(wallet.publicKey, 2 * 1e9);
  await connection.confirmTransaction(sig, "confirmed");

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL, provider);

  const GAME_SEED = Buffer.from("game");
  const PROGRAM_ID = new PublicKey(
    "AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6"
  );
  const gameId = Date.now().toString();
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(gameId));
  const pda = PublicKey.findProgramAddressSync(
    [GAME_SEED, wallet.publicKey.toBuffer(), idBuf],
    PROGRAM_ID
  )[0];

  // 1. createGame —— 前端 onCreate 的调用方式
  await program.methods
    .createGame(new anchor.BN(gameId))
    .accountsPartial({
      game: pda,
      playerO: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  let acct = await program.account.game.fetch(pda);
  console.log(
    "createGame OK, state =",
    JSON.stringify(acct.state),
    "board =",
    acct.board.join(",")
  );

  // 自己跟自己下不了（CannotPlayYourself），所以加一个 X 钱包
  const playerX = Keypair.generate();
  const sigX = await connection.requestAirdrop(playerX.publicKey, 2 * 1e9);
  await connection.confirmTransaction(sigX, "confirmed");

  // 2. joinGame —— 前端 onJoin 后链上账户的变化由 enterGame 读取
  const providerX = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(playerX),
    {
      commitment: "confirmed",
    }
  );
  const programX = new anchor.Program(IDL, providerX);
  await programX.methods
    .joinGame()
    .accountsPartial({ game: pda, playerX: playerX.publicKey })
    .rpc();
  acct = await program.account.game.fetch(pda);
  console.log(
    "joinGame OK, state =",
    JSON.stringify(acct.state),
    "playerX =",
    acct.playerX.toBase58().slice(0, 8)
  );

  // 3. play —— 前端 onCellClick 的调用方式，O/X 交替，O 下 0,1,2 三连获胜
  //    O:0  X:3  O:1  X:4  O:2
  const moves = [
    [program, 0],
    [programX, 3],
    [program, 1],
    [programX, 4],
    [program, 2],
  ];
  for (const [pgm, pos] of moves) {
    const signer = pgm === program ? wallet.publicKey : playerX.publicKey;
    await pgm.methods
      .play(pos)
      .accountsPartial({ game: pda, player: signer })
      .rpc();
  }
  acct = await program.account.game.fetch(pda);
  console.log(
    "play OK, state =",
    JSON.stringify(acct.state),
    "board =",
    acct.board.join(",")
  );
  if (!acct.state.oWon) throw new Error("期望 O 方获胜");

  // 4. 验证账户 coder 解码（前端 onAccountChange 用的就是它）
  const raw = await connection.getAccountInfo(pda);
  const decoded = program.coder.accounts.decode("game", raw.data);
  console.log(
    "coder.decode OK, state =",
    JSON.stringify(decoded.state),
    "moves =",
    decoded.moves
  );

  // 5. closeGame —— 前端 onClose 的调用方式
  await program.methods
    .closeGame()
    .accountsPartial({ game: pda, playerO: wallet.publicKey })
    .rpc();
  const closed = await connection.getAccountInfo(pda);
  console.log("closeGame OK, account closed =", closed === null);

  console.log("\n前端交易逻辑验证全部通过");
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
