/**
 * feishu-sso.js — MES 飞书免登接入（零依赖，单文件）
 *
 * 用法（home.html 的 </body> 前）：
 *   <script src="./feishu-sso.js"></script>
 *   <script>
 *     FeishuSSO.init({
 *       appId: "cli_xxxxxxxxxx",                 // 飞书自建应用 App ID
 *       authEndpoint: "https://hub.newenergycoder.club/auth/feishu",
 *       onLogin(user) {                          // user = {name, en_name, open_id, avatar_url}
 *         document.querySelector("#user-name").textContent = user.name;
 *       },
 *     });
 *   </script>
 *
 * 行为：
 *  - 飞书内打开：自动跳转授权（无感），回来后自动登录
 *  - 普通浏览器打开：不打扰，只暴露 FeishuSSO.login() 供"飞书登录"按钮调用
 *  - MES 是单机离线应用：登录失败/未登录不影响任何本地功能
 */
(function () {
  const STORAGE_KEY = "nec_feishu_user";

  function inFeishu() {
    return /Lark|Feishu/i.test(navigator.userAgent) || "tt" in window;
  }

  function getStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function store(user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }

  function cleanCodeFromUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    history.replaceState(null, "", url.toString());
  }

  async function exchangeCode(cfg, code) {
    const resp = await fetch(cfg.authEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  function buildAuthorizeUrl(cfg) {
    const redirect = location.origin + location.pathname;
    const params = new URLSearchParams({
      app_id: cfg.appId,
      redirect_uri: redirect,
      state: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    });
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?${params}`;
  }

  const FeishuSSO = {
    /** 当前登录用户（未登录为 null） */
    user: getStored(),

    /** 手动触发登录跳转（用于"飞书登录"按钮） */
    login() {
      if (!this._cfg) throw new Error("请先 FeishuSSO.init()");
      location.href = buildAuthorizeUrl(this._cfg);
    },

    /** 退出登录（清除本地身份，不影响 MES 数据） */
    logout() {
      localStorage.removeItem(STORAGE_KEY);
      this.user = null;
    },

    /**
     * 初始化。飞书内自动完成免登；飞书外静默待命。
     * cfg: { appId, authEndpoint, onLogin(user), onError(err) }
     */
    async init(cfg) {
      this._cfg = cfg;
      const code = new URLSearchParams(location.search).get("code");

      // 情况1：授权回调带 code → 兑换用户信息
      if (code) {
        cleanCodeFromUrl();
        try {
          this.user = await exchangeCode(cfg, code);
          store(this.user);
          cfg.onLogin && cfg.onLogin(this.user);
        } catch (err) {
          cfg.onError && cfg.onError(err);
          console.warn("[FeishuSSO] 登录失败：", err);
        }
        return;
      }

      // 情况2：已有本地身份 → 直接回调
      if (this.user) {
        cfg.onLogin && cfg.onLogin(this.user);
        return;
      }

      // 情况3：飞书内且未登录 → 自动跳转授权（无感免登）
      if (inFeishu()) {
        this.login();
      }
      // 情况4：普通浏览器 → 什么都不做，等用户点"飞书登录"
    },
  };

  window.FeishuSSO = FeishuSSO;
})();
