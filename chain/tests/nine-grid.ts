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

  it("认输：对手获胜，之后不能再落子，建局者还能关局退租金", async () => {
    const game = await newStartedGame();
    await play(game, O, 4);
    await play(game, X, 0);

    // O 认输 → X 获胜
    await program.methods
      .resign()
      .accountsPartial({ game, player: O.publicKey })
      .signers([O])
      .rpc();
    const after = await program.account.game.fetch(game);
    assert.deepEqual(after.state, { xWon: {} }, "O 认输后应为 X 胜");
    assert.equal(after.moves, 2, "认输不改变棋谱，只改结果");

    // 终局冻结：认输之后也不能再落子
    await expectError(play(game, X, 8), "GameAlreadyOver");

    // 认输解决了「卡住就退不回租金」：终局后建局者可以关局
    await program.methods
      .closeGame()
      .accountsPartial({ game, playerO: O.publicKey })
      .signers([O])
      .rpc();
  });

  it("认输的拒绝分支：非玩家、等人入座、已经终局", async () => {
    // 1) 路人不能替别人认输
    const playing = await newStartedGame();
    const outsider = Keypair.generate();
    await expectError(
      program.methods
        .resign()
        .accountsPartial({ game: playing, player: outsider.publicKey })
        .signers([outsider])
        .rpc(),
      "NotAPlayer",
    );

    // 2) 还没人入座就「认输」没有意义 —— 该用 close_game 撤回
    const waiting = await createGame();
    await expectError(
      program.methods
        .resign()
        .accountsPartial({ game: waiting, player: O.publicKey })
        .signers([O])
        .rpc(),
      "GameNotStarted",
    );

    // 3) 已经结束的局不能再结束一次
    const over = await newStartedGame();
    await program.methods
      .resign()
      .accountsPartial({ game: over, player: X.publicKey })
      .signers([X])
      .rpc();
    await expectError(
      program.methods
        .resign()
        .accountsPartial({ game: over, player: O.publicKey })
        .signers([O])
        .rpc(),
      "GameAlreadyOver",
    );
  });

  it("超时判负：没到时间不能判，轮到自己更不能判", async () => {
    const game = await newStartedGame(); // O 先手

    // 刚入座，谁都没资格判超时
    await expectError(
      program.methods
        .claimTimeout()
        .accountsPartial({ game, player: X.publicKey })
        .signers([X])
        .rpc(),
      "TimeoutNotReached",
    );

    // O 是轮到落子的一方，不能替自己「申请超时胜利」
    await expectError(
      program.methods
        .claimTimeout()
        .accountsPartial({ game, player: O.publicKey })
        .signers([O])
        .rpc(),
      "OnlyOpponentCanClaimTimeout",
    );

    // 路人也不行
    const outsider = Keypair.generate();
    await expectError(
      program.methods
        .claimTimeout()
        .accountsPartial({ game, player: outsider.publicKey })
        .signers([outsider])
        .rpc(),
      "NotAPlayer",
    );

    // 每落一手都会续期：X 落子后，轮到 O，此时被判超时的是 O
    await play(game, O, 4);
    await play(game, X, 0);
    await expectError(
      program.methods
        .claimTimeout()
        .accountsPartial({ game, player: O.publicKey })
        .signers([O])
        .rpc(),
      "OnlyOpponentCanClaimTimeout",
    );
  });

  it("最后活动时间随落子刷新（超时判定的依据）", async () => {
    const game = await newStartedGame();
    const joined = await program.account.game.fetch(game);
    await play(game, O, 4);
    const moved = await program.account.game.fetch(game);
    assert.isAtLeast(
      moved.lastActivityAt.toNumber(),
      joined.lastActivityAt.toNumber(),
      "落子后活动时间不应倒退",
    );
  });

  // 成功路径需要真的等满 5 分钟。默认跳过，避免把 CI 拖成 6 分钟；
  // 部署到 Devnet 后由 LIVE_TIMEOUT=1 单独跑一次，或手动在页面上验证。
  (process.env.LIVE_TIMEOUT ? it : it.skip)(
    "超时判负的成功路径（需真实等待 5 分钟）",
    async () => {
      const game = await newStartedGame(); // O 先手，一直不动
      await new Promise((r) => setTimeout(r, 305_000));
      await program.methods
        .claimTimeout()
        .accountsPartial({ game, player: X.publicKey })
        .signers([X])
        .rpc();
      const s = await program.account.game.fetch(game);
      assert.deepEqual(s.state, { xWon: {} }, "O 超时未落子，应判 X 胜");
    },
  );
});
