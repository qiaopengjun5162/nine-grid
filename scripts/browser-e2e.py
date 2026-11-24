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

        # 1. O 连钱包（这一步就会验证 boot() 正常、按钮事件已绑定）
        po.goto(BASE, wait_until="domcontentloaded")
        po.wait_for_timeout(3500)  # 等 esm.sh 模块加载
        expect(po.locator("#chain-alert")).to_be_hidden(timeout=10000)
        po.locator("#connect-btn").click()
        expect(po.locator("#connect-btn")).to_have_text("钱包已连接", timeout=10000)
        print(f"[O] 钱包已连接: {po.locator('#wallet-addr').inner_text()}")

        # 2. O 建局
        po.locator("#chain-create-btn").click()
        expect(po.locator("#chain-status")).to_contain_text("等对手入座", timeout=20000)
        pda = po.locator("#chain-pda-display").inner_text().strip()
        print(f"[O] 建局成功，PDA: {pda[:16]}…")
        expect(po.locator("#chain-join-game-btn")).to_be_hidden()  # O 看不到入座按钮

        # 3. X 通过邀请链接进局并点入座（验证上一轮修的 joinGame 那条链）
        px.goto(BASE + "&pda=" + pda, wait_until="domcontentloaded")
        px.wait_for_timeout(3500)
        expect(px.locator("#chain-alert")).to_be_hidden(timeout=10000)
        px.locator("#connect-btn").click()
        expect(px.locator("#chain-status")).to_contain_text("等对手入座", timeout=15000)
        expect(px.locator("#chain-join-game-btn")).to_be_visible()
        px.locator("#chain-join-game-btn").click()
        expect(px.locator("#chain-join-game-btn")).to_be_hidden(timeout=20000)
        print("[X] 邀请链接进局 → 入座成功")

        # 4. O 侧靠账户订阅自动刷新到对局中
        expect(po.locator("#chain-status")).to_contain_text("轮到你落子（O）", timeout=25000)
        print("[O] 订阅刷新：轮到 O 落子")

        # 5. 轮流落子 O:0 → X:3 → O:1 → X:4 → O:2（O 三连胜）
        moves = [("o", 0), ("x", 3), ("o", 1), ("x", 4), ("o", 2)]
        pages = {"o": po, "x": px}
        for who, pos in moves:
            other = "x" if who == "o" else "o"
            cell = pages[who].locator(f"#chain-board .cell[data-index='{pos}']")
            expect(cell).to_be_enabled(timeout=25000)
            cell.click()
            expect(
                pages[who].locator(f"#chain-board .cell[data-index='{pos}'] .mark")
            ).to_be_visible(timeout=25000)
            expect(
                pages[other].locator(f"#chain-board .cell[data-index='{pos}'] .mark")
            ).to_be_visible(timeout=25000)
            print(f"[{who.upper()}] 落子 {pos} 成功，双方均已刷新")

        # 6. 判胜 + 获胜线 + 关局按钮权限
        expect(po.locator("#chain-status")).to_contain_text("获胜", timeout=15000)
        assert po.locator("#chain-board .cell.win").count() == 3, "O 侧获胜线应有 3 格"
        assert px.locator("#chain-board .cell.win").count() == 3, "X 侧获胜线应有 3 格"
        expect(po.locator("#chain-close-btn")).to_be_visible()
        expect(px.locator("#chain-close-btn")).to_be_hidden()
        print(f"[终局] {po.locator('#chain-status').inner_text()}，关局按钮仅 O 方可见")

        # 7. O 关局退租金
        po.locator("#chain-close-btn").click()
        expect(po.locator("#chain-lobby")).to_be_visible(timeout=20000)
        print("[O] 关局成功，退回大厅")

        bad = {k: v[:3] for k, v in errors.items() if v}
        print("JS 报错:", bad or "none")
        assert not bad, "存在 JS 报错"
        print("\n浏览器 E2E 通过：连钱包 → 建局 → 入座 → 5 手落子 → 判胜 → 关局")
        browser.close()


if __name__ == "__main__":
    main()
