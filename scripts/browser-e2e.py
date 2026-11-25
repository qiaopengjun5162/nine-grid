#!/usr/bin/env python3
"""
浏览器端链上 E2E：模拟 Phantom 钱包，通过真实 UI 走一整局。

与 verify-frontend.js 的分工：
- verify-frontend.js 用 Node keypair 直接调 program.methods，验证「交易构造逻辑」；
- 本脚本验证「浏览器那条链」：boot() 初始化、钱包适配、按钮绑定、
  建局/入座/落子/关局的 UI 交互、账户订阅刷新、判胜高亮。
  上一轮线上出现过 Buffer 未注入导致 boot() 整体崩溃、连按钮都点不动 ——
  那类事故只有走真实浏览器才会暴露，Node 脚本测不出来。

前置：browser-e2e.sh 已经起好验证器、部署程序、静态服务和两个测试钱包。
依赖：playwright（Python）+ pynacl + Chromium（playwright install chromium）。
"""
import base64
import json
import os
import sys

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "crates", "server", "static")
BASE = os.environ.get("BROWSER_E2E_URL", "http://127.0.0.1:8099/chain.html?cluster=localnet")
WALLET_DIR = os.environ.get("BROWSER_E2E_WALLETS", "/tmp")

# 页面里注入的模拟 Phantom。签名通过 binding 回调到 Python 侧真实私钥签。
INIT = r"""
(() => {
  const secret = __SECRET__;
  window.solana = {
    isPhantom: true,
    isConnected: false,
    publicKey: null,
    async connect() {
      if (!this.publicKey) {
        const mod = await import("https://esm.sh/@solana/web3.js@1.98.4?target=es2022");
        this.publicKey = mod.Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey;
      }
      this.isConnected = true;
      return { publicKey: this.publicKey };
    },
    async signTransaction(tx) {
      const sigB64 = await window.__signTx(Array.from(tx.serializeMessage()));
      const { PublicKey } = await import("https://esm.sh/@solana/web3.js@1.98.4?target=es2022");
      tx.addSignature(this.publicKey, Buffer.from(sigB64, "base64"));
      return tx;
    },
    async signAllTransactions(txs) {
      for (const tx of txs) await this.signTransaction(tx);
      return txs;
    },
  };
})();
"""

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(data):
    """Solana 用的 base58 编码（比特币字母表）。"""
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return out


def load_wallet(who):
    import nacl.signing

    path = os.path.join(WALLET_DIR, f"nine-grid-browser-{who}.json")
    with open(path) as f:
        raw = json.load(f)
    key = nacl.signing.SigningKey(bytes(raw[:32]))
    return key, b58(bytes(key.verify_key))


def main():
    secrets = {}
    keys = {}
    addrs = {}
    for who in ("o", "x"):
        path = os.path.join(WALLET_DIR, f"nine-grid-browser-{who}.json")
        with open(path) as f:
            secrets[who] = json.load(f)
        keys[who], addrs[who] = load_wallet(who)
    print(f"O 钱包: {addrs['o']}\nX 钱包: {addrs['x']}")

    errors = {"o": [], "x": []}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        def setup(ctx, who):
            ctx.add_init_script(INIT.replace("__SECRET__", json.dumps(secrets[who])))
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors[who].append(str(e)))

            def sign_tx(source, msg_bytes):
                sig = keys[who].sign(bytes(msg_bytes)).signature
                return base64.b64encode(sig).decode("ascii")

            page.expose_binding("__signTx", sign_tx)
            return page

        po = setup(browser.new_context(), "o")
        px = setup(browser.new_context(), "x")

        pages = {"o": po, "x": px}

        # ── 复用动作：一局从建局到入座的完整流程 ──
        def back_to_lobby(page):
            if not page.locator("#chain-lobby").is_visible():
                page.locator("#chain-leave-btn").click()
                expect(page.locator("#chain-lobby")).to_be_visible(timeout=15000)

        def create_game():
            back_to_lobby(po)
            po.locator("#chain-create-btn").click()
            expect(po.locator("#chain-status")).to_contain_text("等对手入座", timeout=25000)
            pda = po.locator("#chain-pda-display").inner_text().strip()
            print(f"[O] 建局 {pda[:12]}…")
            return pda

        def x_join(pda):
            px.goto(BASE + "&pda=" + pda, wait_until="domcontentloaded")
            px.wait_for_timeout(3500)  # 等 esm.sh 模块加载
            expect(px.locator("#chain-alert")).to_be_hidden(timeout=10000)
            if px.locator("#connect-btn").is_enabled():
                px.locator("#connect-btn").click()
            expect(px.locator("#chain-status")).to_contain_text("等对手入座", timeout=15000)
            expect(px.locator("#chain-join-game-btn")).to_be_visible()
            px.locator("#chain-join-game-btn").click()
            expect(px.locator("#chain-join-game-btn")).to_be_hidden(timeout=25000)
            # O 侧靠账户订阅自动刷新到对局中
            expect(po.locator("#chain-status")).to_contain_text("轮到你落子（O）", timeout=30000)
            print("[X] 入座成功，O 侧订阅已刷新")

        def play(moves):
            for who, pos in moves:
                other = "x" if who == "o" else "o"
                cell = pages[who].locator(f"#chain-board .cell[data-index='{pos}']")
                expect(cell).to_be_enabled(timeout=30000)
                cell.click()
                # 落子后双方都要看到这枚子：本地乐观渲染 + 对侧订阅刷新
                expect(
                    pages[who].locator(f"#chain-board .cell[data-index='{pos}'] .mark")
                ).to_be_visible(timeout=25000)
                expect(
                    pages[other].locator(f"#chain-board .cell[data-index='{pos}'] .mark")
                ).to_be_visible(timeout=25000)
                print(f"[{who.upper()}] 落子 {pos}，双方均已刷新")

        # 1. O 连钱包（这一步就会验证 boot() 正常、按钮事件已绑定）
        po.goto(BASE, wait_until="domcontentloaded")
        po.wait_for_timeout(3500)  # 等 esm.sh 模块加载
        expect(po.locator("#chain-alert")).to_be_hidden(timeout=10000)
        po.locator("#connect-btn").click()
        expect(po.locator("#connect-btn")).to_have_text("钱包已连接", timeout=10000)
        print(f"[O] 钱包已连接: {po.locator('#wallet-addr').inner_text()}")

        # 2. 第一局：O 三连胜（5 手）。终局后**不关局** —— 留给棋谱馆读
        pda_a = create_game()
        expect(po.locator("#chain-join-game-btn")).to_be_hidden()  # O 看不到入座按钮
        x_join(pda_a)
        play([("o", 0), ("x", 3), ("o", 1), ("x", 4), ("o", 2)])
        expect(po.locator("#chain-status")).to_contain_text("获胜", timeout=15000)
        assert po.locator("#chain-board .cell.win").count() == 3, "O 侧获胜线应有 3 格"
        assert px.locator("#chain-board .cell.win").count() == 3, "X 侧获胜线应有 3 格"
        expect(po.locator("#chain-close-btn")).to_be_visible()
        expect(px.locator("#chain-close-btn")).to_be_hidden()
        print(f"[A] {po.locator('#chain-status').inner_text()}，关局按钮仅 O 方可见")
        back_to_lobby(po)  # 退出视图但保留链上账户
        print("[A] 退出对局视图，账户留在链上")

        # 3. 第二局：X 中排三连（6 手）—— 顺带验证判胜对执 X 一侧同样成立
        pda_b = create_game()
        x_join(pda_b)
        play([("o", 0), ("x", 3), ("o", 1), ("x", 4), ("o", 8), ("x", 5)])
        expect(po.locator("#chain-status")).to_contain_text("获胜", timeout=15000)
        assert po.locator("#chain-board .cell.win").count() == 3, "X 获胜线应为中排 3 格"
        print(f"[B] {po.locator('#chain-status').inner_text()}")

        # 4. O 关局退租金：账户从链上消失，棋谱馆里也不该再出现
        po.locator("#chain-close-btn").click()
        expect(po.locator("#chain-lobby")).to_be_visible(timeout=25000)
        print("[B] 关局成功，退回大厅")

        # 5. 第三局：只建局不入座，制造一个「等待入座」样本
        pda_c = create_game()
        back_to_lobby(po)
        print(f"[C] 保持等待入座：{pda_c[:12]}…")

        # 6. 棋谱馆：纯只读页，不连钱包也能看
        archive = BASE.split("/chain.html")[0] + "/chain-archive.html?cluster=localnet"
        po.goto(archive, wait_until="domcontentloaded")
        po.wait_for_timeout(4000)
        expect(po.locator("#archive-alert")).to_be_hidden(timeout=25000)
        expect(po.locator("#stat-total")).to_have_text("2", timeout=30000)
        expect(po.locator("#stat-finished")).to_have_text("1")
        expect(po.locator("#stat-o")).to_have_text("1")
        expect(po.locator("#stat-x")).to_have_text("0")
        expect(po.locator("#stat-live")).to_have_text("0")
        expect(po.locator("#archive-scope")).to_contain_text("等待入座")
        print("[棋谱馆] 全局统计与链上账户一致：2 局 / 终局 1 / 等待 1")

        # 7. 从交易历史重建棋谱，并与账户里的终局盘面比对
        row = po.locator(".arc-row", has_text="O 方胜")
        expect(row).to_have_count(1)
        row.locator(".arc-open").click()
        expect(row.locator(".arc-move-text")).to_contain_text("5. O→2", timeout=30000)
        expect(row.locator(".arc-check.ok")).to_be_visible()
        expect(row.locator(".arc-cursor")).to_have_text("第 5 / 5 手")
        row.locator(".arc-prev").click()
        expect(row.locator(".arc-cursor")).to_have_text("第 4 / 5 手")
        print("[棋谱馆] 5 手棋谱由链上交易还原，重建盘面与账户一致 ✓")

        # 8. 我的战绩：只比对地址，不签名
        po.locator("#mine-input").fill(addrs["o"])
        po.locator("#mine-form button[type=submit]").click()
        expect(po.locator("#mine-wins")).to_have_text("1")
        expect(po.locator("#mine-losses")).to_have_text("0")
        po.locator("#mine-input").fill(addrs["x"])
        po.locator("#mine-form button[type=submit]").click()
        expect(po.locator("#mine-wins")).to_have_text("0")
        expect(po.locator("#mine-losses")).to_have_text("1")
        print("[棋谱馆] 我的战绩：O 1 胜 0 负，X 0 胜 1 负（已关的局不计入）")

        bad = {k: v[:3] for k, v in errors.items() if v}
        print("JS 报错:", bad or "none")
        assert not bad, "存在 JS 报错"
        print("\n浏览器 E2E 通过：建局 → 入座 → 判胜 → 关局 → 棋谱馆还原棋谱")
        browser.close()


if __name__ == "__main__":
    main()
