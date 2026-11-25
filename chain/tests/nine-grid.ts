/**
 * 九宫棋链上端到端测试（跑在 solana-test-validator 上的真实交易）
 *
 * 与本地版 smoke.sh 是同一批场景：建局 → 加入 → 落子 → 判胜 → 终局冻结，
 * 外加全部拒绝分支。规则由 core 裁决，这里验证的是「部署后的程序
 * 确实按 core 的规则在链上执行」。
 *
 * 棋盘编号：
 *   0 | 1 | 2
 *  ---+---+---
 *   3 | 4 | 5
 *  ---+---+---
 *   6 | 7 | 8
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NineGrid } from "../target/types/nine_grid";
import { assert } from "chai";

describe("nine-grid (on-chain)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.nineGrid as Program<NineGrid>;

  const O = Keypair.generate(); // 建局者，执 O 先手
  const X = Keypair.generate(); // 加入者，执 X 后手
  let gameCounter = 0;

  const gamePda = (owner: PublicKey, gameId: anchor.BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("game"), owner.toBuffer(), gameId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];

  async function createGame(owner: Keypair = O) {
    const gameId = new anchor.BN(++gameCounter);
    const game = gamePda(owner.publicKey, gameId);
    await program.methods
      .createGame(gameId)
      .accountsPartial({
        game,
        playerO: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    return game;
  }

  async function newStartedGame() {
    const game = await createGame();
    await program.methods
      .joinGame()
      .accountsPartial({ game, playerX: X.publicKey })
      .signers([X])
      .rpc();
    return game;
  }

  const play = (game: PublicKey, player: Keypair, position: number) =>
    program.methods
      .play(position)
      .accountsPartial({ game, player: player.publicKey })
      .signers([player])
      .rpc();

  async function expectError(promise: Promise<unknown>, code: string) {
    try {
      await promise;
      assert.fail(`应该报错 ${code}，但交易成功了`);
    } catch (err: any) {
      const actual = err?.error?.errorCode?.code ?? err?.errorCode?.code;
      assert.equal(actual, code, `错误码不符: ${JSON.stringify(err?.error ?? err?.message)}`);
    }
  }

  before(async () => {
    for (const kp of [O, X]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  it("建局后处于等待对手、棋盘全空", async () => {
    const game = await createGame();
    const s = await program.account.game.fetch(game);
    assert.deepEqual(s.state, { waitingForOpponent: {} });
    assert.equal(s.moves, 0);
    assert.deepEqual(Array.from(s.board), Array(9).fill(0));
    assert.equal(s.playerO.toBase58(), O.publicKey.toBase58());
    assert.equal(s.playerX.toBase58(), PublicKey.default.toBase58());
    assert.equal(s.turn, 1); // MARK_O
  });

  it("对手没加入前不能落子", async () => {
    const game = await createGame();
    await expectError(play(game, O, 0), "GameNotStarted");
  });

  it("不能和自己下棋，也不能加入满员的局", async () => {
    const game = await createGame();
    await expectError(
      program.methods
        .joinGame()
        .accountsPartial({ game, playerX: O.publicKey })
        .signers([O])
        .rpc(),
      "CannotPlayYourself",
    );
    await program.methods
      .joinGame()
      .accountsPartial({ game, playerX: X.publicKey })
      .signers([X])
      .rpc();
    await expectError(
      program.methods
        .joinGame()
        .accountsPartial({ game, playerX: X.publicKey })
        .signers([X])
        .rpc(),
      "GameAlreadyFull",
    );
  });

  it("两人已入座、一手未下时也能落子（空棋谱 + InProgress）", async () => {
    const game = await newStartedGame();
    const s0 = await program.account.game.fetch(game);
    assert.deepEqual(s0.state, { inProgress: {} });
    assert.equal(s0.moves, 0);
    // 这一步若能成功，就证明 restore() 没有把 InProgress+0 误判成矛盾数据
    await play(game, O, 4);
    const s1 = await program.account.game.fetch(game);
    assert.equal(s1.moves, 1);
    assert.equal(s1.board[4], 1);
  });

  it("轮次、占位、越界、非玩家都被拒绝", async () => {
    const game = await newStartedGame();
    const stranger = Keypair.generate();

    await expectError(play(game, X, 0), "NotYourTurn"); // O 先手，X 抢先
    await expectError(play(game, stranger, 0), "NotAPlayer");
    await expectError(play(game, O, 9), "InvalidPosition");

    await play(game, O, 4);
    await expectError(play(game, X, 4), "CellOccupied");
    await expectError(play(game, O, 0), "NotYourTurn");
  });

  it("横三连：O 获胜，终局后不能再下", async () => {
    const game = await newStartedGame();
    await play(game, O, 0);
    await play(game, X, 3);
    await play(game, O, 1);
    await play(game, X, 4);
    await play(game, O, 2); // 0-1-2

    const s = await program.account.game.fetch(game);
    assert.deepEqual(s.state, { oWon: {} });
    assert.equal(s.moves, 5);
    assert.equal(s.turn, 1, "终局后 turn 保持获胜方");

    await expectError(play(game, X, 5), "GameAlreadyOver");
    await expectError(play(game, O, 8), "GameAlreadyOver");
  });

  it("斜三连：X 获胜", async () => {
    const game = await newStartedGame();
    await play(game, O, 1);
    await play(game, X, 0);
    await play(game, O, 3);
    await play(game, X, 4);
    await play(game, O, 7);
    await play(game, X, 8); // 0-4-8

    const s = await program.account.game.fetch(game);
    assert.deepEqual(s.state, { xWon: {} });
    assert.equal(s.moves, 6);
  });

  it("下满九格无人三连 → 平局", async () => {
    const game = await newStartedGame();
    const seq: Array<[Keypair, number]> = [
      [O, 0], [X, 1], [O, 2], [X, 4], [O, 3], [X, 5], [O, 7], [X, 6], [O, 8],
    ];
    for (const [player, pos] of seq) await play(game, player, pos);

    const s = await program.account.game.fetch(game);
    assert.deepEqual(s.state, { draw: {} });
    assert.equal(s.moves, 9);
    assert.deepEqual(Array.from(s.board), [1, 2, 1, 1, 2, 2, 2, 1, 1]);
  });

  it("不同对局互不干扰", async () => {
    const a = await newStartedGame();
    const b = await newStartedGame();
    assert.notEqual(a.toBase58(), b.toBase58());

    await play(a, O, 4);
    const sb = await program.account.game.fetch(b);
    assert.equal(sb.moves, 0, "另一局不应受影响");
  });

  it("只有建局者能关闭账户，且对局中不许关", async () => {
    const playing = await newStartedGame();

    // 1) 非建局者：连碰都碰不到
    await expectError(
      program.methods
        .closeGame()
        .accountsPartial({ game: playing, playerO: X.publicKey })
        .signers([X])
        .rpc(),
      "ConstraintHasOne",
    );

    // 2) 建局者也不行 —— 账户是这盘棋唯一的记录，对手已入座就不能单方销毁
    await expectError(
      program.methods
        .closeGame()
        .accountsPartial({ game: playing, playerO: O.publicKey })
        .signers([O])
        .rpc(),
      "GameInProgress",
    );
    const stillThere = await program.account.game.fetch(playing);
    assert.equal(stillThere.moves, 0, "关局被拒后账户应原封不动");
  });

  it("等待入座可以撤回，终局之后可以关局退租金", async () => {
    // 建错了的局得能撤回，否则创建者要为每一局空局付租金
    const empty = await createGame();
    await program.methods
      .closeGame()
      .accountsPartial({ game: empty, playerO: O.publicKey })
      .signers([O])
      .rpc();
    let closed = false;
    try {
      await program.account.game.fetch(empty);
    } catch {
      closed = true;
    }
    assert.isTrue(closed, "账户应已被关闭");

    // 下完之后可以关，租金退给创建者
    const done = await newStartedGame();
    for (const [who, pos] of [
      [O, 0], [X, 3], [O, 1], [X, 4], [O, 2],
    ] as const) {
      await play(done, who, pos);
    }
    const fin = await program.account.game.fetch(done);
    assert.isDefined(fin.state.oWon, "应为 O 方胜");
    await program.methods
      .closeGame()
      .accountsPartial({ game: done, playerO: O.publicKey })
      .signers([O])
      .rpc();
  });
});
