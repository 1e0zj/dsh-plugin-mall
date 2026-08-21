// Browser half of dsh-plugin-mall: the Settings → Plugins → 插件市场 tab.
//
// Client plugin contract (see @deepseek-ai/dsh-client-modules): the bundle
// registers itself on window.__ModuleLoader__, exports a cordis-style
// { apply, inject }, and is served at /plugins/@1e0zj/dsh-plugin-mall/client.js.
// This file is hand-written ES5-ish JS on purpose — no build step — using the
// React instance the shell shares through the client module loader.
window.__ModuleLoader__.load({
  id: "@1e0zj/dsh-plugin-mall",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    // ── styles ──────────────────────────────────────────────────────────────
    var css = [
      ".mkt_root{display:flex;flex-direction:column;gap:12px;max-width:1040px}",
      ".mkt_head{display:flex;flex-direction:column;gap:2px}",
      ".mkt_title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mkt_sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mkt_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".mkt_input{flex:1;min-width:200px;background:var(--dsw-alias-bg-secondary,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".mkt_select{background:var(--dsw-alias-bg-secondary,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".mkt_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-secondary,#fff);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer}",
      ".mkt_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      ".mkt_btn:disabled{opacity:.55;cursor:default}",
      ".mkt_btnPrimary{background:var(--dsw-alias-state-business-primary,#2b6cb0);border-color:transparent;color:#fff}",
      ".mkt_btnPrimary:hover:not(:disabled){color:#fff;opacity:.92}",
      ".mkt_btnDanger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".mkt_btnSm{padding:3px 10px;font-size:12px}",
      ".mkt_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".mkt_list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:stretch;min-width:0}",
      "@media (max-width:820px){.mkt_list{grid-template-columns:minmax(0,1fr)}}",
      ".mkt_listHead{grid-column:1/-1;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mkt_loadMore{grid-column:1/-1;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary);padding:10px 0}",
      ".mkt_card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-primary,#fff);display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".mkt_cardHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".mkt_metaRow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".mkt_name{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
      ".mkt_meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mkt_desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".mkt_cardActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:auto;padding-top:4px}",
      ".mkt_cardActions .mkt_btn{text-decoration:none}",
      ".mkt_panelTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}",
      ".mkt_panelRow{display:flex;align-items:center;gap:8px}",
      ".mkt_panelRow .mkt_link{margin-left:auto}",
      ".mkt_pre{font-family:Consolas,Monaco,monospace;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-secondary,#f6f7f8);border-radius:6px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}",
      ".mkt_ok{color:var(--dsw-alias-state-success-primary,#2f855a)}",
      ".mkt_badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
      ".mkt_badgeOk{border-color:var(--dsw-alias-state-success-primary,#2f855a);color:var(--dsw-alias-state-success-primary,#2f855a)}",
      ".mkt_badgeWarn{border-color:var(--dsw-alias-state-warning-primary,#b7791f);color:var(--dsw-alias-state-warning-primary,#b7791f)}",
      ".mkt_badgeBad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".mkt_check{display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
      ".mkt_link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;cursor:pointer}",
      ".mkt_installedHead{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:0;margin:0;cursor:pointer;font:inherit;text-align:left}",
      ".mkt_installedHead:hover .mkt_panelTitle{color:var(--dsw-alias-state-business-primary)}",
      ".mkt_installedToggle{margin-left:auto}",
      ".mkt_depList{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
      ".mkt_depRow{display:flex;justify-content:space-between;align-items:center;gap:8px}",
      ".mkt_depActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".mkt_approve{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:10px 12px;margin:4px 0}",
      ".mkt_approveHead{font-size:13px;font-weight:600;color:var(--dsw-alias-state-error-primary)}",
      ".mkt_approvePkg{display:flex;flex-direction:column;gap:4px}",
      ".mkt_approveName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-right:8px;overflow-wrap:anywhere}",
      ".mkt_approveCmd{max-height:none;margin:0}",
      ".mkt_jobDone{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}",
      ".mkt_logBlock{display:flex;flex-direction:column;gap:4px;align-items:flex-start}",
      ".mkt_depOff{opacity:.5;text-decoration:line-through}",
      ".mkt_switch{position:relative;width:34px;height:18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-secondary,#e5e7eb);cursor:pointer;padding:0;transition:background .15s,border-color .15s}",
      ".mkt_switch:disabled{opacity:.55;cursor:default}",
      ".mkt_switchOn{background:var(--dsw-alias-state-business-primary,#2b6cb0);border-color:transparent}",
      ".mkt_switchKnob{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)}",
      ".mkt_switchOn .mkt_switchKnob{transform:translateX(16px)}",
      ".mkt_issueList{list-style:none;display:flex;flex-direction:column;gap:8px;margin:0;padding:0}",
      ".mkt_issue{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-secondary,#fff)}",
      ".mkt_issueBlock{border-color:var(--dsw-alias-state-error-primary)}",
      ".mkt_issueWarn{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}",
      ".mkt_issueTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mkt_issueDetail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:18px;overflow-wrap:anywhere}",
    ].join("\n");
    var tagId = "@1e0zj/dsh-plugin-mall/market-tab.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = "@1e0zj/dsh-plugin-mall";
      styleTag.dataset.pluginCss = tagId;
      styleTag.textContent = css;
      document.head.appendChild(styleTag);
    }

    // ── tiny helpers ────────────────────────────────────────────────────────
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    function clip(text, max) {
      var t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
      return t.length > max ? t.slice(0, max - 1) + "…" : t;
    }

    function errorText(e) {
      return String(e && e.message ? e.message : e);
    }

    function kindLabel(kind) {
      if (kind === "bundle") return "宿主插件层";
      if (kind === "client") return "浏览器UI插件";
      if (kind === "missing") return "未解析";
      return "普通依赖";
    }

    function generateSessionNonce() {
      if (typeof crypto !== "undefined") {
        if (typeof crypto.randomUUID === "function") {
          return "sess_" + crypto.randomUUID();
        }
        if (typeof crypto.getRandomValues === "function") {
          var bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          var hex = "";
          for (var i = 0; i < bytes.length; i++) {
            hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
          }
          return "sess_" + hex;
        }
      }
      throw new Error("Secure browser randomness is unavailable; plugin marketplace actions are disabled");
    }

    // ── job polling ─────────────────────────────────────────────────────────
    // onPreflightSettled：预检 job（kind=dsh-plugin-preflight）落定时回调，
    // 携带 (spec, report)。safe 由调用方直接续装；有风险由调用方出内联卡片。
    function useJobPolling(call, onSettled, onApprovalToken, onPreflightSettled) {
      // 重挂载垫底：安装完成的收尾会写 cordis.patch.yml，dsh 随之重放装配树、
      // 整个市场 UI 重挂载，React state 归零——面板先空一拍再被异步的
      // call("jobs") 恢复，用户看到「任务清掉又回来」的割裂（实测反馈）。
      // sessionStorage 镜像让重挂载的第一帧直接渲染上一帧的面板，随后的
      // RPC 恢复用后端权威数据覆盖。tab 级存储，随 tab 关闭而清，
      // 与内存里的任务数据同生命周期。
      var JOBS_MIRROR_KEY = "@1e0zj/dsh-plugin-mall:jobs";
      var readJobsMirror = function () {
        try {
          var parsed = JSON.parse(window.sessionStorage.getItem(JOBS_MIRROR_KEY) || "null");
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch (e) { return {}; }
      };
      var jobsRef = useRef(null);
      if (jobsRef.current === null) jobsRef.current = readJobsMirror();
      var _jobs = useState(Object.assign({}, jobsRef.current));
      var jobs = _jobs[0];
      var setJobs = _jobs[1];
      var commit = useCallback(function (next) {
        jobsRef.current = next;
        setJobs(Object.assign({}, next));
        try { window.sessionStorage.setItem(JOBS_MIRROR_KEY, JSON.stringify(next)); } catch (e) { /* 存储被禁/写满不致命 */ }
      }, []);
      useEffect(function () {
        var timer = setInterval(function () {
          var current = jobsRef.current;
          var running = Object.keys(current).filter(function (id) {
            var job = current[id];
            return job && job.status !== "completed" && job.status !== "failed" && job.status !== "killed";
          });
          if (running.length === 0) return;
          running.forEach(function (id) {
            call("job", { jobId: id }).then(function (value) {
              var snapshot = value.snapshot || {};
              var old = jobsRef.current[id] || {};
              var wasTerminal = old.status === "completed" || old.status === "failed" || old.status === "killed";
              var nowTerminal = snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "killed";
              if (snapshot.needsApproval && snapshot.approvalToken && onApprovalToken) {
                try { onApprovalToken(snapshot.spec, snapshot.approvalToken); } catch (e) { /* best effort */ }
              }
              if (!wasTerminal && nowTerminal) {
                if (onSettled) {
                  try { onSettled(id, snapshot); } catch (e) { /* best effort */ }
                }
                // 预检 job 落定 → 把结论交给上层后继（只触发一次）
                if (snapshot.kind === "dsh-plugin-preflight" && !old.preflightHandled && onPreflightSettled) {
                  jobsRef.current[id] = Object.assign({}, old, { preflightHandled: true });
                  try { onPreflightSettled(snapshot.spec, snapshot.extras, id); } catch (e) { /* best effort */ }
                }
              }
              var output = (old.output || "") + (value.output || "");
              commit(Object.assign({}, jobsRef.current, { [id]: Object.assign({}, old, {
                status: snapshot.status,
                detail: snapshot.detail,
                needsApproval: snapshot.needsApproval,
                staleOnRestart: snapshot.staleOnRestart,
                approvalToken: snapshot.approvalToken,
                kind: snapshot.kind,
                output: output,
                finishedAt: snapshot.finishedAt,
              }) }));
            }).catch(function () { /* keep polling */ });
          });
        }, 1200);
        return function () { clearInterval(timer); };
      }, [call, onSettled, onApprovalToken]);
      // carryFromId：把上一阶段（预检）的日志接过来并撤掉它的条目。一次点击
      // 只应该在面板里留下一个任务，日志连续——而不是 market-1 预检、
      // market-2 安装两条并排，让人以为自己点了两次。
      // 重试同理：同一 spec 上一轮失败/完成的终态条目一并撤掉——用户没点
      // 「清空」就重试时，面板照样只留新一轮一条。旧失败日志不拼进新任务
      // （两轮 pnpm 输出混在一起没法读）；running 的不动，那是真并发任务。
      var track = useCallback(function (id, spec, carryFromId) {
        var next = Object.assign({}, jobsRef.current);
        var carried = "";
        if (carryFromId && next[carryFromId]) {
          carried = next[carryFromId].output || "";
          delete next[carryFromId];
        }
        for (var key in next) {
          if (key !== id && next[key] && next[key].spec === spec && next[key].status !== "running") {
            delete next[key];
          }
        }
        next[id] = { status: "running", spec: spec, output: carried };
        commit(next);
      }, [commit]);
      var clear = useCallback(function () {
        commit({});
      }, [commit]);
      var drop = useCallback(function (id) {
        var next = Object.assign({}, jobsRef.current);
        delete next[id];
        commit(next);
      }, [commit]);
      // 恢复后端任务记录（tracker.list 的形状）：安装事务改写
      // cordis.patch.yml 会让 dsh 重放装配树、整个市场 UI 重挂载，React
      // state 全丢——任务面板、完成提醒、重启按钮一起消失（真实事故：
      // 更新其实成功了，用户靠手动重启+查版本才确认）。记录在后端活着，
      // 挂载时拉回来。两个细节：恢复出的**已落定**预检任务标
      // preflightHandled，否则轮询的第一拍会重放 onPreflightSettled——
      // 那等于页面一刷新就自动续装一次；running 的不标，交回轮询线。
      var restore = useCallback(function (entries) {
        var next = Object.assign({}, jobsRef.current);
        var serverIds = {};
        for (var index = 0; index < (entries || []).length; index++) {
          var entry = entries[index] || {};
          var snap = entry.snapshot || {};
          if (!entry.id) continue;
          serverIds[entry.id] = true;
          // 服务器记录是权威（覆盖垫底镜像）；本地独有的 id 保留——后端
          // 修剪掉的旧条目不至于从面板上闪没。
          next[entry.id] = {
            status: snap.status,
            spec: snap.spec,
            detail: snap.detail,
            needsApproval: snap.needsApproval,
            staleOnRestart: snap.staleOnRestart,
            approvalToken: snap.approvalToken,
            kind: snap.kind,
            output: entry.output || "",
            finishedAt: snap.finishedAt,
            preflightHandled: snap.kind === "dsh-plugin-preflight" && snap.status !== "running",
          };
        }
        // 不在本次服务器列表里的条目属于上一次宿主会话（进程重启后
        // tracker 清空）。已兑现的直接翻篇撤掉：completed 的重启已经
        // 发生；needsApproval 暂停的批准卡片已随进程失效（事务由启动
        // 恢复处置），留着只会让人点一个必然失败的按钮；staleOnRestart
        // 的失败是「被另一个未了结事务挡住」，而那个事务必然已被启动恢复
        // 处置——它的报错是现在时写的（「还没做完」「现在无法安装」），
        // 留到重启之后会被当成当前状态读，而它描述的情形已经不存在。
        // running 的标中断，别让轮询对着不存在的 id 空转。其余 failed
        // 保留——网络、预检阻断这类原因重启后可能仍然成立，日志有排障
        // 价值。这个判据不依赖 finishedAt（旧镜像里没有该字段）。
        for (var key in next) {
          if (serverIds[key]) continue;
          var stale = next[key];
          if (stale.status === "running") {
            next[key] = Object.assign({}, stale, {
              status: "killed",
              detail: "宿主进程已重启，该任务的记录随之丢失",
            });
          } else if (stale.status === "completed"
            || stale.staleOnRestart === true
            || (Array.isArray(stale.needsApproval) && stale.needsApproval.length > 0)) {
            delete next[key];
          }
        }
        commit(next);
      }, [commit]);
      return { jobs: jobs, track: track, clear: clear, drop: drop, restore: restore };
    }

    // ── plugin verification badge ───────────────────────────────────────────
    function verifyBadge(verified) {
      if (verified === undefined || verified === null) return null;
      if (verified.hostDeps !== undefined && verified.hostDeps.length > 0) {
        return h("span", { className: "mkt_badge mkt_badgeBad", title: verified.hostDeps.join(", ") }, "宿主依赖风险");
      }
      if (verified.kind === "bundle") return h("span", { className: "mkt_badge mkt_badgeOk" }, "宿主插件");
      if (verified.kind === "client") return h("span", { className: "mkt_badge mkt_badgeOk" }, "UI插件");
      if (verified.kind === "plain") return h("span", { className: "mkt_badge" }, "未声明");
      if (verified.kind === "no-manifest") return h("span", { className: "mkt_badge" }, "无package.json");
      return null;
    }

    // ── browsing-time compat badge ──────────────────────────────────────────
    // Static server-side scan of the repo manifest/patch against the profile.
    // Advisory only: the install preflight remains the enforcing gate.
    function compatBadge(compat) {
      if (compat === undefined || compat === null) return null;
      var titles = (compat.issues || []).map(function (item) { return (item.severity === "block" ? "[阻断] " : "[警告] ") + item.title; });
      var tip = (compat.summary || "") + (titles.length > 0 ? "\n" + titles.join("\n") : "") + (compat.patchChecked === false ? "\n补丁未获取，加载冲突未检查" : "");
      if (compat.state === "conflict") return h("span", { className: "mkt_badge mkt_badgeBad", title: tip }, "冲突");
      if (compat.state === "warning") return h("span", { className: "mkt_badge mkt_badgeWarn", title: tip }, "有风险");
      if (compat.state === "compatible") return h("span", { className: "mkt_badge mkt_badgeOk", title: tip }, "适配");
      return h("span", { className: "mkt_badge", title: tip || "兼容性未知" }, "适配未知");
    }

    // ── repo card ───────────────────────────────────────────────────────────
    function RepoCard(props) {
      var item = props.item;
      var installing = props.installing === true;
      var job = props.installJob;
      var installLabel = props.alreadyInstalled === true ? "已装" : "安装";
      var installDisabled = installing || props.alreadyInstalled === true;
      if (!installing && job) {
        if (job.status === "running") { installLabel = "安装中…"; installDisabled = true; }
        else if (job.status === "completed") { installLabel = "已装 · 重启生效"; installDisabled = true; }
        else if (job.status === "failed") { installLabel = "安装失败 · 见任务日志"; }
        else { installLabel = "已取消 · 重试"; }
      }
      return h("div", { className: "mkt_card" },
        h("div", { className: "mkt_cardHead" },
          h("span", { className: "mkt_name" }, item.fullName),
          verifyBadge(props.verified),
          compatBadge(props.compat),
          item.archived ? h("span", { className: "mkt_badge" }, "archived") : null
        ),
        item.description ? h("div", { className: "mkt_desc" }, item.description) : null,
        h("div", { className: "mkt_metaRow" },
          h("span", { className: "mkt_meta" }, "★" + item.stars),
          item.language ? h("span", { className: "mkt_meta" }, item.language) : null,
          item.license ? h("span", { className: "mkt_meta" }, item.license) : null,
          h("span", { className: "mkt_meta" }, "更新 " + (item.updatedAt || "").slice(0, 10))
        ),
        h("div", { className: "mkt_cardActions" },
          h("button", { className: "mkt_btn mkt_btnPrimary", disabled: installDisabled, onClick: function () { props.onInstall(item.fullName); } },
            installLabel),
          h("a", { className: "mkt_btn", href: item.htmlUrl, target: "_blank", rel: "noreferrer" }, "前往仓库")
        )
      );
    }

    // ── install-script approval ─────────────────────────────────────────────
    function ApprovalRequest(props) {
      var pkgs = props.needsApproval || [];
      return h("div", { className: "mkt_approve" },
        h("div", { className: "mkt_approveHead" }, "需要你确认：这次安装会执行安装期代码"),
        pkgs.map(function (p, index) {
          var facts = [];
          if (typeof p.weeklyDownloads === "number") facts.push("周下载 " + p.weeklyDownloads.toLocaleString());
          facts.push(p.provenance === true ? "有来源证明" : "无来源证明");
          if (typeof p.unpackedSize === "number") facts.push((Math.round(p.unpackedSize / 104857.6) / 10) + " MB");
          if (p.selector) facts.push("pnpm 标识 " + p.selector);
          return h("div", { key: p.selector || (p.name + ":" + index), className: "mkt_approvePkg" },
            h("div", null,
              h("span", { className: "mkt_approveName" }, p.name + (p.version ? "@" + p.version : "")),
              h("span", { className: "mkt_badge " + (p.direct ? "" : "mkt_badgeBad") },
                p.direct ? "你要装的插件本身" : "传递依赖 · 不是你选的那个包")
            ),
            Object.keys(p.scripts || {}).map(function (k) {
              return h("pre", { key: k, className: "mkt_pre mkt_approveCmd" }, k + ": " + p.scripts[k]);
            }),
            p.contentHash ? h("div", { className: "mkt_pre mkt_approveCmd" }, "制品 SHA-256: " + p.contentHash) : null,
            h("div", { className: "mkt_meta" }, facts.join(" · "))
          );
        }),
        h("div", { className: "mkt_meta" }, "这些命令会以你的权限在你的机器上运行，早于任何插件代码加载。"),
        h("div", { className: "mkt_row" },
          h("button", {
            className: "mkt_btn mkt_btnPrimary mkt_btnSm",
            disabled: props.busy === true,
            onClick: function () { props.onApprove(pkgs.map(function (p) { return p.name; })); },
          }, props.busy ? "继续中…" : "允许并继续"),
          h("button", { className: "mkt_btn mkt_btnSm", onClick: props.onDismiss }, "取消")
        )
      );
    }

    // ── preflight result card ────────────────────────────────────────────────
    // 预检通过（safe）根本不渲染这张卡片——直接开始安装，不打扰。只有
    // warning / blocked 才出现，且用任务面板同款的内联卡片语言，不弹模态框：
    // 市场里一切任务都在面板里流动，弹窗会打断这个节奏。
    function PreflightCard(props) {
      var report = props.report || {};
      var blocked = report.verdict === "blocked";
      var title = blocked ? "安装被阻止" : "安装存在风险";
      var issues = report.issues || [];
      return h("div", { className: "mkt_card" },
        h("div", { className: "mkt_panelRow" },
          h("p", { className: "mkt_panelTitle" + (blocked ? " mkt_error" : "") }, title),
          h("span", { className: "mkt_meta" }, clip(props.spec, 50))
        ),
        report.summary ? h("div", { className: "mkt_desc" }, report.summary) : null,
        issues.length > 0 ? h("ul", { className: "mkt_issueList" },
          issues.map(function (issue) {
            return h("li", {
              key: (issue.code || "") + "-" + (issue.title || ""),
              className: "mkt_issue " + (issue.severity === "block" ? "mkt_issueBlock" : "mkt_issueWarn"),
            },
              h("div", { className: "mkt_issueTitle" }, issue.title),
              issue.detail ? h("div", { className: "mkt_issueDetail" }, issue.detail) : null);
          })
        ) : null,
        h("div", { className: "mkt_row" },
          blocked
            ? h("button", { className: "mkt_btn mkt_btnSm", onClick: props.onClose }, "关闭")
            : [
              h("button", { key: "cancel", className: "mkt_btn mkt_btnSm", onClick: props.onClose }, "取消"),
              h("button", {
                key: "confirm",
                className: "mkt_btn mkt_btnPrimary mkt_btnSm",
                disabled: props.busy === true,
                onClick: props.onConfirm,
              }, props.busy ? "安装中…" : "我已了解风险，继续安装"),
            ]
        )
      );
    }

    var MARKET_PACKAGE = "@1e0zj/dsh-plugin-mall";

    function jobKindLabel(kind) {
      if (kind === "dsh-plugin-preflight") return "预检 ";
      if (kind === "dsh-plugin-uninstall") return "卸载 ";
      return "安装 ";
    }

    function jobStatusLabel(status) {
      if (status === "completed") return "完成";
      if (status === "failed") return "失败";
      if (status === "killed") return "已取消";
      return "进行中";
    }

    function jobStatusClass(status) {
      if (status === "completed") return "mkt_ok";
      if (status === "failed" || status === "killed") return "mkt_error";
      return "";
    }

    // 任务日志：跑的时候只露尾部几行（够看进度，不霸屏），落定后默认折叠
    // ——成功的日志没人回头读，失败的才需要，点开即可。
    var LOG_TAIL_LINES = 8;
    function JobLog(props) {
      var _open = useState(false);
      var open = _open[0];
      var setOpen = _open[1];
      var text = String(props.output || "").trimEnd();
      if (text.length === 0) return null;
      var lines = text.split("\n");
      var collapsed = props.done && !open;
      var shown = (props.done || lines.length <= LOG_TAIL_LINES) ? lines : lines.slice(-LOG_TAIL_LINES);
      // 展开/收起始终在日志块上方：放在下方的话，点开后按钮会被推到长长的
      // 日志末尾，想收起还得先滚回去。
      return h("div", { className: "mkt_logBlock" },
        props.done
          ? h("span", {
            className: "mkt_link",
            onClick: function () { setOpen(!open); },
          }, open ? "收起日志" : "查看日志（" + lines.length + " 行）")
          : lines.length > LOG_TAIL_LINES
            ? h("div", { className: "mkt_meta" }, "只显示最后 " + LOG_TAIL_LINES + " 行")
            : null,
        collapsed ? null : h("pre", { className: "mkt_pre" }, shown.join("\n").slice(-4000))
      );
    }

    // ── jobs panel ──────────────────────────────────────────────────────────
    function JobsPanel(props) {
      var ids = Object.keys(props.jobs);
      if (ids.length === 0) return null;
      return h("div", { className: "mkt_card" },
        h("div", { className: "mkt_panelRow" },
          h("p", { className: "mkt_panelTitle" }, "任务"),
          props.onClear ? h("span", { className: "mkt_link", onClick: props.onClear }, "清空") : null
        ),
        ids.map(function (id) {
          var job = props.jobs[id];
          var done = job.status === "completed" || job.status === "failed" || job.status === "killed";
          return h("div", { key: id, style: { display: "flex", flexDirection: "column", gap: "4px" } },
            // 不再显示 market-N 这种内部 id——对用户没有意义，反而让人以为
            // 自己点了两次。只说清「在做什么 · 到哪一步了」。
            // 状态词单独上色（完成绿、失败/取消红），前半段保持灰——整行
            // 都染色会喧宾夺主，只有结论需要一眼看见。
            h("div", { className: "mkt_meta" },
              jobKindLabel(job.kind) + clip(job.spec || "", 44) + " · ",
              h("span", { className: jobStatusClass(job.status) }, jobStatusLabel(job.status))),
            job.needsApproval && job.needsApproval.length > 0
              ? h(ApprovalRequest, {
                needsApproval: job.needsApproval,
                busy: props.approving === job.spec,
                onApprove: function (names) {
                  // 不先 drop：旧条目由重试任务的 track(carryFromId) 原子接管
                  // （撤条目 + 日志接续一拍完成）。先删的话，call("install")
                  // 要走数秒（重试还会重跑一次隔离预检），面板会空白一段，
                  // 「批准后任务消失、开始安装才冒出来」的割裂就是这么来的。
                  // 等待期间按钮由 approving 态显示「继续中…」。
                  props.onApprove(job.spec, names, job.approvalToken, id);
                },
                onDismiss: function () { props.onDismiss(id); },
              })
              : job.detail ? h("div", { className: "mkt_desc" }, job.detail) : null,
            // 预检完成不提示重启——它没有改动任何东西，接下来才是安装。
            // 也不再重复一个绿色「完成」：状态行已经写了「· 完成」。
            done && job.status === "completed" && job.kind !== "dsh-plugin-preflight"
              ? h("div", { className: "mkt_jobDone" },
                // 完成时间早于本次宿主启动 = 重启已经发生过了（防御分支：
                // 已兑现的条目通常在恢复时就被撤掉了）：换成说明文字，
                // 不再催一次没必要的重启。
                props.hostStartedAt && job.finishedAt && job.finishedAt < props.hostStartedAt
                  ? h("span", { className: "mkt_meta" }, "重启已生效")
                  : h("button", {
                    className: "mkt_btn mkt_btnPrimary mkt_btnSm",
                    disabled: props.restarting === true,
                    onClick: props.onRestart,
                  }, props.restarting ? "重启中…" : "重启 dsh 生效"))
              : job.status === "failed" && !(job.needsApproval && job.needsApproval.length > 0)
                ? h("div", { className: "mkt_error" }, "失败，见下方输出")
                : null,
            h(JobLog, { output: job.output, done: done })
          );
        })
      );
    }

    // ── installed panel (collapsible summary) ───────────────────────────────
    function InstalledPanel(props) {
      var installed = props.installed;
      var _open = useState(false);
      var open = _open[0];
      var setOpen = _open[1];
      if (!installed) return null;
      var count = installed.error ? 0 : (installed.deps || []).length;
      return h("div", { className: "mkt_card" },
        h("button", {
          type: "button",
          className: "mkt_installedHead",
          onClick: function () { setOpen(!open); },
          "aria-expanded": open ? "true" : "false",
        },
          h("span", { className: "mkt_panelTitle" }, "已装插件"),
          h("span", { className: "mkt_badge" }, count + " 个"),
          h("span", { className: "mkt_meta mkt_installedToggle" }, open ? "收起" : "展开")
        ),
        installed.error
          ? h("div", { className: "mkt_error" }, installed.error)
          : !open ? null
          : (installed.deps || []).length === 0
            ? h("div", { className: "mkt_meta" }, "还没有装过插件")
            : h("div", { className: "mkt_depList" }, (installed.deps || []).map(function (dep) {
              var busy = (props.removing || {})[dep.name] === true;
              var upd = (props.updates || {})[dep.name];
              var entry = (props.entries || {})[dep.name];
              // 没在装配树里的依赖（普通依赖、或声明了 client 但没挂载的）
              // 没有可切换的东西，不给开关。
              var togglable = entry !== undefined && dep.name !== MARKET_PACKAGE;
              var enabled = entry === undefined ? true : entry.enabled !== false;
              var toggling = (props.toggling || {})[dep.name] === true;
              return h("div", { key: dep.name, className: "mkt_depRow" },
                h("span", { className: "mkt_desc" + (enabled ? "" : " mkt_depOff") }, dep.name + "@" + dep.version),
                h("span", { className: "mkt_depActions" },
                  h("span", { className: "mkt_badge" }, enabled ? kindLabel(dep.kind) : "已停用"),
                  togglable ? h("button", {
                    className: "mkt_switch" + (enabled ? " mkt_switchOn" : ""),
                    disabled: toggling,
                    title: enabled ? "停用（立即生效，不卸载）" : "启用（立即生效）",
                    "aria-pressed": enabled ? "true" : "false",
                    onClick: function () { props.onToggle(dep.name, !enabled); },
                  }, h("span", { className: "mkt_switchKnob" })) : null,
                  upd && upd.hasUpdate ? h("button", {
                    className: "mkt_btn mkt_btnSm",
                    onClick: function () { props.onInstallSpec(dep.name + "@" + upd.latest); },
                  }, "更新至 " + upd.latest) : null,
                  h("button", {
                    className: "mkt_btn mkt_btnDanger mkt_btnSm",
                    disabled: busy,
                    onClick: function () { props.onUninstall(dep.name); },
                  }, busy ? "卸载中…" : "卸载")));
            }))
      );
    }

    // ── the marketplace tab ─────────────────────────────────────────────────
    function MarketplaceTab(props) {
      var rpc = props.rpc;
      var _query = useState("");
      var query = _query[0];
      var setQuery = _query[1];
      var _sort = useState("stars");
      var sort = _sort[0];
      var setSort = _sort[1];
      var _results = useState(null);
      var results = _results[0];
      var setResults = _results[1];
      var _loading = useState(false);
      var loading = _loading[0];
      var setLoading = _loading[1];
      var _error = useState(null);
      var error = _error[0];
      var setError = _error[1];
      var _installed = useState(null);
      var installed = _installed[0];
      var setInstalled = _installed[1];
      var _installing = useState({});
      var installing = _installing[0];
      var setInstalling = _installing[1];
      var _removing = useState({});
      var removing = _removing[0];
      var setRemoving = _removing[1];
      var _toggling = useState({});
      var toggling = _toggling[0];
      var setToggling = _toggling[1];
      var _page = useState(1);
      var page = _page[0];
      var setPage = _page[1];
      var _loadingMore = useState(false);
      var loadingMore = _loadingMore[0];
      var setLoadingMore = _loadingMore[1];
      var sentinelRef = useRef(null);
      var resultsRef = useRef(null);
      var _verified = useState({});
      var verified = _verified[0];
      var setVerified = _verified[1];
      var _compat = useState({});
      var compat = _compat[0];
      var setCompat = _compat[1];
      var _verifiedOnly = useState(true);
      var verifiedOnly = _verifiedOnly[0];
      var setVerifiedOnly = _verifiedOnly[1];
      var _updates = useState(null);
      var updates = _updates[0];
      var setUpdates = _updates[1];
      var _reachedLimit = useState(false);
      var reachedLimit = _reachedLimit[0];
      var setReachedLimit = _reachedLimit[1];
      var _retryAt = useState(0);
      var retryAt = _retryAt[0];
      var setRetryAt = _retryAt[1];
      var _restarting = useState(false);
      var restarting = _restarting[0];
      var setRestarting = _restarting[1];
      // 本次宿主进程的启动时间（jobs 端点带回）：完成时间早于它的任务，
      // 其「重启 dsh 生效」按钮已经兑现，改显示「重启已生效」。
      var _hostStartedAt = useState(0);
      var hostStartedAt = _hostStartedAt[0];
      var setHostStartedAt = _hostStartedAt[1];
      var _preflight = useState(null);
      var preflight = _preflight[0];
      var setPreflight = _preflight[1];

      // Opaque one-shot approval tokens issued from needsApproval outcomes (spec -> token).
      // Cleared on success, unrelated failure, cancel, modal close, or spec change.
      // No boolean warning-consent map is kept.
      var sessionNonce = useRef(generateSessionNonce()).current;
      var approvalTokensRef = useRef({});
      var restartControlRef = useRef({ mounted: true, ping: null });
      var clearRestartPing = useCallback(function () {
        var control = restartControlRef.current;
        if (control.ping !== null) {
          clearInterval(control.ping);
          control.ping = null;
        }
      }, []);
      useEffect(function () {
        var control = restartControlRef.current;
        control.mounted = true;
        return function () {
          control.mounted = false;
          if (control.ping !== null) {
            clearInterval(control.ping);
            control.ping = null;
          }
        };
      }, []);

      var call = useCallback(function (endpoint, payload) {
        var body = Object.assign({ session: sessionNonce }, payload || {});
        return rpc.call("/market", endpoint, body).then(function (res) {
          if (!res || res.ok !== true) {
            var err = res && res.error;
            var msg = err && typeof err === "object" ? (err.message || JSON.stringify(err)) : (err || "market request failed");
            throw new Error(msg);
          }
          return res.value;
        });
      }, [rpc, sessionNonce]);

      var verifyPage = useCallback(function (items) {
        var repos = (items || []).map(function (it) { return it.fullName; });
        if (repos.length === 0) return;
        call("verify", { repos: repos }).then(function (value) {
          setVerified(function (prev) { return Object.assign({}, prev, value.results); });
        }).catch(function () { /* optional */ });
        call("compat", { repos: repos }).then(function (value) {
          setCompat(function (prev) { return Object.assign({}, prev, value.results); });
        }).catch(function () { /* optional */ });
      }, [call]);

      var doSearch = useCallback(function () {
        setLoading(true);
        setError(null);
        setPage(1);
        setReachedLimit(false);
        setRetryAt(0);
        call("search", { query: query, sort: sort, perPage: 20 }).then(function (value) {
          setResults(value);
          setVerified({});
          setCompat({});
          verifyPage(value.items);
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setLoading(false);
        });
      }, [call, query, sort, verifyPage]);

      var canLoadMore = results !== null && results.items.length < results.total && !reachedLimit;
      var loadMoreLock = useRef(false);
      var loadMore = useCallback(function () {
        if (!canLoadMore || loading || loadingMore) return;
        if (loadMoreLock.current) return;
        if (Date.now() < retryAt) return;
        loadMoreLock.current = true;
        setLoadingMore(true);
        call("search", { query: query, sort: sort, perPage: 20, page: page + 1 }).then(function (value) {
          if (value.truncated === true) { setReachedLimit(true); return; }
          setPage(page + 1);
          verifyPage(value.items);
          setResults(function (prev) {
            if (prev === null) return value;
            var seen = {};
            var merged = [];
            prev.items.concat(value.items).forEach(function (it) {
              if (seen[it.fullName] === true) return;
              seen[it.fullName] = true;
              merged.push(it);
            });
            return { total: value.total, items: merged };
          });
        }).catch(function (e) {
          setError(errorText(e));
          setRetryAt(Date.now() + 60000);
        }).finally(function () {
          loadMoreLock.current = false;
          setLoadingMore(false);
        });
      }, [call, canLoadMore, loading, loadingMore, page, query, sort, retryAt, verifyPage]);

      useEffect(function () {
        var node = sentinelRef.current;
        if (node === null || node === undefined) return undefined;
        if (typeof IntersectionObserver === "undefined") return undefined;
        var observer = new IntersectionObserver(function (entries) {
          for (var index = 0; index < entries.length; index++) {
            if (entries[index].isIntersecting) { loadMore(); break; }
          }
        }, { rootMargin: "300px" });
        observer.observe(node);
        return function () { observer.disconnect(); };
      }, [loadMore]);

      // 启用/停用：热生效，不重启也不重装——所以成功后只刷新已装列表，
      // 不提示重启，也不动任务面板（它不是一个需要看日志的长任务）。
      var doToggle = useCallback(function (packageName, enabled) {
        setToggling(function (prev) { return Object.assign({}, prev, { [packageName]: true }); });
        setError(null);
        call("togglePlugin", { package: packageName, enabled: enabled }).then(function (value) {
          setInstalled(function (prev) {
            return prev && !prev.error ? Object.assign({}, prev, { entries: value.entries }) : prev;
          });
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setToggling(function (prev) {
            var next = Object.assign({}, prev);
            delete next[packageName];
            return next;
          });
        });
      }, [call]);

      var refreshInstalled = useCallback(function () {
        call("installed", {}).then(function (value) {
          setInstalled(value);
          call("updates", {}).then(setUpdates).catch(function () { setUpdates(null); });
        }).catch(function (e) {
          setInstalled({ error: errorText(e) });
        });
      }, [call]);

      var onJobSettled = useCallback(function (id, snapshot) {
        refreshInstalled();
        // 装/卸改变了 profile，旧适配徽标全部失效，按当前列表重扫。
        setCompat({});
        var items = resultsRef.current ? resultsRef.current.items : [];
        if (items.length > 0) verifyPage(items);
        if (snapshot && (snapshot.status === "completed" || (snapshot.status === "failed" && !snapshot.needsApproval) || snapshot.status === "killed")) {
          if (snapshot.spec) delete approvalTokensRef.current[snapshot.spec];
        }
      }, [refreshInstalled, verifyPage]);

      var onApprovalToken = useCallback(function (spec, token) {
        if (spec && token) {
          approvalTokensRef.current[spec] = token;
        }
      }, []);

      // 预检落定的后继动作要用到下面才定义的 doRawInstall，用 ref 转接，
      // 免得为了闭包顺序把整块逻辑往上搬。
      var preflightHandlerRef = useRef(null);
      var onPreflightSettled = useCallback(function (spec, report, jobId) {
        if (preflightHandlerRef.current) preflightHandlerRef.current(spec, report, jobId);
      }, []);

      var polling = useJobPolling(call, onJobSettled, onApprovalToken, onPreflightSettled);
      var track = polling.track;
      var jobs = polling.jobs;
      var clearJobs = polling.clear;
      var dropJob = polling.drop;

      useEffect(function () {
        doSearch();
        // 挂载即恢复任务面板（见 useJobPolling.restore 的注释）：重挂载丢掉
        // 的完成提醒、重启按钮、暂停中的批准卡片都从后端拉回来。
        // hostStartedAt：本次宿主进程的启动时间——早于它的完成任务说明
        // 重启已经发生，按钮要换成「重启已生效」而不是再催一次。
        call("jobs", {}).then(function (value) {
          if (value.hostStartedAt) setHostStartedAt(value.hostStartedAt);
          polling.restore(value.jobs);
        }).catch(function () { /* 恢复失败不阻塞面板 */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      var doRawInstall = useCallback(function (spec, extra, carryFromId) {
        setInstalling(function (prev) {
          var next = Object.assign({}, prev, { [spec]: true });
          return next;
        });
        setError(null);
        var payload = Object.assign({ spec: spec }, extra || {});
        call("install", payload).then(function (value) {
          track(value.jobId, spec, carryFromId);
        }).catch(function (e) {
          delete approvalTokensRef.current[spec];
          setError(errorText(e));
        }).finally(function () {
          setInstalling(function (prev) {
            var next = Object.assign({}, prev);
            delete next[spec];
            return next;
          });
        });
      }, [call, track]);

      var doApprove = useCallback(function (spec, names, token, carryFromId) {
        var extra = { allowBuildScripts: names };
        var apprToken = token || approvalTokensRef.current[spec];
        if (apprToken) {
          extra.approvalToken = apprToken;
          delete approvalTokensRef.current[spec];
        }
        doRawInstall(spec, extra, carryFromId);
      }, [doRawInstall]);

      // 预检落定后的去向：safe 直接续装，其余出内联风险卡片。
      useEffect(function () {
        preflightHandlerRef.current = function (spec, report, jobId) {
          if (!report || !report.verdict) {
            setError("预检没有返回结论，请重试");
            return;
          }
          if (report.verdict === "safe") {
            // 安全：接过预检的日志、撤掉预检条目，面板上只剩这一个任务。
            doRawInstall(spec, {}, jobId);
          } else {
            setPreflight({ spec: spec, report: report, jobId: jobId });
          }
        };
      }, [doRawInstall]);

      // 点安装 = 立刻起一个预检 job，面板马上有东西看、日志实时流。
      // 结论由轮询经 onPreflightSettled 交回上面的 handler，这里不等待。
      var preflightAndInstall = useCallback(function (spec) {
        delete approvalTokensRef.current[spec];
        setError(null);
        call("preflight", { spec: spec }).then(function (value) {
          track(value.jobId, value.spec || spec);
        }).catch(function (e) {
          setError(errorText(e));
        });
      }, [call, track]);

      var doInstall = useCallback(function (repo) {
        preflightAndInstall("github:" + repo);
      }, [preflightAndInstall]);

      var doRestart = useCallback(function () {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (window.confirm("重启 dsh？正在进行的任务会中断。") !== true) return;
        }
        clearRestartPing();
        setRestarting(true);
        setError(null);
        var requestedAt = Date.now();
        var previousHostStartedAt = Number(hostStartedAt);
        call("restart", {}).then(function () {
          if (restartControlRef.current.mounted !== true) return;
          var tries = 0;
          var ping = setInterval(function () {
            if (restartControlRef.current.mounted !== true) {
              clearRestartPing();
              return;
            }
            tries++;
            if (tries > 40) {
              clearRestartPing();
              setRestarting(false);
              setError("2 分钟内未检测到 dsh 重启完成，请手动检查 dsh 状态后刷新页面。");
              return;
            }
            // Prefer identity change over wall-clock ordering: NTP may move the
            // successor's timeOrigin backwards. If initial restore did not
            // provide an identity, retain the stricter requestedAt fallback.
            call("jobs", {}).then(function (value) {
              if (restartControlRef.current.mounted !== true) return;
              var observedHostStartedAt = Number(value.hostStartedAt);
              if (!Number.isFinite(observedHostStartedAt) || observedHostStartedAt <= 0) return;
              var hadPreviousIdentity = Number.isFinite(previousHostStartedAt) && previousHostStartedAt > 0;
              if (hadPreviousIdentity
                ? observedHostStartedAt === previousHostStartedAt
                : observedHostStartedAt <= requestedAt) return;
              clearRestartPing();
              window.location.reload();
            }).catch(function () { /* host restarting */ });
          }, 3000);
          restartControlRef.current.ping = ping;
        }).catch(function (e) {
          if (restartControlRef.current.mounted !== true) return;
          clearRestartPing();
          setRestarting(false);
          setError(errorText(e));
        });
      }, [call, clearRestartPing, hostStartedAt]);

      var doUninstall = useCallback(function (name) {
        delete approvalTokensRef.current[name];
        setRemoving(function (prev) {
          var next = Object.assign({}, prev, { [name]: true });
          return next;
        });
        setError(null);
        call("uninstall", { package: name }).then(function (value) {
          track(value.jobId, name);
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setRemoving(function (prev) {
            var next = Object.assign({}, prev);
            delete next[name];
            return next;
          });
        });
      }, [call, track]);

      useEffect(function () {
        refreshInstalled();
      }, [refreshInstalled]);

      var visibleItems = results === null ? [] : results.items.filter(function (it) {
        if (verifiedOnly !== true) return true;
        var v = verified[it.fullName];
        return v !== undefined && (v.kind === "bundle" || v.kind === "client")
          && !(v.hostDeps !== undefined && v.hostDeps.length > 0);
      });
      resultsRef.current = results;
      var verifyPending = results !== null && results.items.some(function (it) { return verified[it.fullName] === undefined; });

      return h("div", { className: "mkt_root" },
        h("div", { className: "mkt_head" },
          h("div", { className: "mkt_title" }, "插件市场"),
          h("div", { className: "mkt_sub" }, "搜索 GitHub dsh-plugin 话题插件 · 装/卸后需重启 dsh 生效")
        ),
        h("div", { className: "mkt_row" },
          h("input", {
            className: "mkt_input",
            placeholder: "搜索插件（留空列出最热）",
            value: query,
            onChange: function (e) { setQuery(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") doSearch(); },
          }),
          h("select", {
            className: "mkt_select",
            value: sort,
            onChange: function (e) { setSort(e.target.value); },
          },
            h("option", { value: "stars" }, "按 star"),
            h("option", { value: "updated" }, "最近更新"),
            h("option", { value: "forks" }, "按 fork")
          ),
          h("button", { className: "mkt_btn mkt_btnPrimary", disabled: loading, onClick: doSearch }, loading ? "搜索中…" : "搜索"),
          h("button", { className: "mkt_btn", onClick: refreshInstalled }, "刷新已装"),
          h("button", { className: "mkt_btn mkt_btnDanger", disabled: restarting, onClick: doRestart }, restarting ? "重启中…" : "重启 dsh"),
          h("label", { className: "mkt_check" },
            h("input", { type: "checkbox", checked: verifiedOnly, onChange: function (e) { setVerifiedOnly(e.target.checked); } }),
            "只看已验证插件")
        ),
        error ? h("div", { className: "mkt_error" }, error) : null,
        h(InstalledPanel, {
          installed: installed,
          removing: removing,
          updates: updates,
          entries: installed && !installed.error ? installed.entries : undefined,
          toggling: toggling,
          onToggle: doToggle,
          onUninstall: doUninstall,
          onInstallSpec: preflightAndInstall,
        }),
        h(JobsPanel, {
          jobs: jobs,
          onClear: function () {
            Object.keys(jobs).forEach(function (id) {
              var job = jobs[id];
              var token = job && job.approvalToken ? job.approvalToken : (job && job.spec ? approvalTokensRef.current[job.spec] : undefined);
              call("jobDismiss", { jobId: id, token: token }).catch(function () {});
            });
            approvalTokensRef.current = {};
            clearJobs();
          },
          onApprove: doApprove,
          onDismiss: function (id) {
            var job = jobs[id];
            var token = job && job.approvalToken ? job.approvalToken : (job && job.spec ? approvalTokensRef.current[job.spec] : undefined);
            if (job && job.spec) delete approvalTokensRef.current[job.spec];
            call("jobDismiss", { jobId: id, token: token }).catch(function () {});
            dropJob(id);
          },
          onDrop: dropJob,
          onRestart: doRestart,
          restarting: restarting,
          hostStartedAt: hostStartedAt,
          approving: Object.keys(installing).filter(function (s) { return installing[s]; })[0],
        }),
        preflight ? h(PreflightCard, {
          spec: preflight.spec,
          report: preflight.report,
          busy: installing[preflight.spec] === true,
          onConfirm: function () {
            var spec = preflight.spec;
            var carry = preflight.jobId;
            setPreflight(null);
            doRawInstall(spec, { acceptWarnings: true }, carry);
          },
          onClose: function () {
            if (preflight && preflight.spec) delete approvalTokensRef.current[preflight.spec];
            setPreflight(null);
          },
        }) : null,
        h("div", { className: "mkt_list" },
          results == null
            ? h("div", { className: "mkt_meta mkt_listHead" }, loading ? "正在加载最热插件…" : "—")
            : results.items.length === 0
              ? h("div", { className: "mkt_meta mkt_listHead" }, "没有匹配的仓库。")
              : h(React.Fragment, null,
                h("div", { className: "mkt_meta mkt_listHead" }, verifiedOnly
                  ? "已验证插件 " + visibleItems.length + " 个 · 已加载 " + results.items.length + "/" + results.total + " 个仓库（star≥1）" + (verifyPending ? " · 验证中…" : "")
                  : "共 " + results.total + " 个仓库（star≥1）· 已显示 " + results.items.length + " 个"),
                visibleItems.length === 0 && verifiedOnly
                  ? h("div", { className: "mkt_meta mkt_listHead" }, verifyPending ? "正在验证仓库是否为 dsh 插件…" : "当前加载的结果里没有已验证的 dsh 插件，下滑加载更多。")
                  : null,
                visibleItems.map(function (item) {
                  var installJob = null;
                  for (var jobId in jobs) {
                    if (jobs[jobId] && jobs[jobId].spec === "github:" + item.fullName) { installJob = jobs[jobId]; break; }
                  }
                  var vInfo = verified[item.fullName];
                  var alreadyInstalled = vInfo !== undefined && typeof vInfo.name === "string"
                    && installed !== null && installed.error === undefined
                    && (installed.deps || []).some(function (dep) { return dep.name === vInfo.name; });
                  return h(RepoCard, {
                    key: item.fullName,
                    item: item,
                    installing: installing[item.fullName] === true || installing["github:" + item.fullName] === true,
                    installJob: installJob,
                    verified: vInfo,
                    compat: compat[item.fullName],
                    alreadyInstalled: alreadyInstalled,
                    onInstall: doInstall,
                  });
                }),
                canLoadMore
                  ? h("div", { className: "mkt_loadMore", ref: sentinelRef }, loadingMore ? "加载中…" : Date.now() < retryAt ? "GitHub 限流中，稍后再下滑加载" : "下滑加载更多")
                  : h("div", { className: "mkt_loadMore" }, reachedLimit ? "已达 GitHub 搜索上限（前 1000 个结果）" : "已显示全部 " + results.items.length + " 个")
              )
        )
      );
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    var inject = ["slots", "connection"];
    function apply(ctx) {
      var rpc = ctx.get("connection").rpc;
      ctx.effect(function () {
        return ctx.slots.inject("settings.plugins.tab", function () {
          return ctx.slots.register({
            name: "settings.plugins.tab",
            id: "market",
            order: 30,
            label: "插件市场",
            inject: function () {
              return { rpc: rpc };
            },
          }, MarketplaceTab);
        });
      }, "@1e0zj/dsh-plugin-mall: marketplace tab");
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
