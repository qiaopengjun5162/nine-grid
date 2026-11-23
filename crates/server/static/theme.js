// 主题切换：古典（公园锈铁木块）/ 星穹会员（深空星盘）。
// 选择存 localStorage；真正的防闪烁在每页 head 的内联脚本里，
// 这里只负责绑定按钮、同步按钮态、更新 theme-color，并广播事件给需要的页面。
(function () {
  "use strict";
  var KEY = "ninegrid-theme";
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  var meta = document.querySelector('meta[name="theme-color"]');

  function current() {
    return root.getAttribute("data-theme") === "cosmos" ? "cosmos" : "classic";
  }

  function apply(theme, persist) {
    root.setAttribute("data-theme", theme);
    if (persist) {
      try { localStorage.setItem(KEY, theme); } catch (e) { /* 隐私模式下忽略 */ }
    }
    if (meta) {
      meta.setAttribute("content", theme === "cosmos" ? "#070b1a" : "#efe4d0");
    }
    if (btn) {
      var opts = btn.querySelectorAll("[data-theme-opt]");
      for (var i = 0; i < opts.length; i += 1) {
        var on = opts[i].getAttribute("data-theme-opt") === theme;
        opts[i].classList.toggle("is-active", on);
        opts[i].setAttribute("aria-pressed", on ? "true" : "false");
      }
      btn.setAttribute(
        "aria-label",
        theme === "cosmos"
          ? "当前星穹会员版，点击切回古典版"
          : "当前古典版，点击切换到星穹会员版",
      );
    }
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: theme } }));
  }

  apply(current(), false);

  if (btn) {
    btn.addEventListener("click", function () {
      apply(current() === "cosmos" ? "classic" : "cosmos", true);
    });
  }
})();
