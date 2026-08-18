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
      ".mkt_jobDone{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mkt_modalOverlay{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:1200;padding:16px}",
      ".mkt_modal{background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px 18px;max-width:600px;width:100%;max-height:82vh;overflow:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.18)}",
      ".mkt_modalTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}",
      ".mkt_modalSpec{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
      ".mkt_issueList{list-style:none;display:flex;flex-direction:column;gap:8px;margin:0;padding:0}",
      ".mkt_issue{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-secondary,#fff)}",
      ".mkt_issueBlock{border-color:var(--dsw-alias-state-error-primary)}",
      ".mkt_issueWarn{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}",
      ".mkt_issueTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mkt_issueDetail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:18px;overflow-wrap:anywhere}",
      ".mkt_modalActions{display:flex;gap:8px;justify-content:flex-end;align-items:center}",
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
    function useJobPolling(call, onSettled, onApprovalToken) {
      var jobsRef = useRef({});
      var _jobs = useState({});
      var jobs = _jobs[0];
      var setJobs = _jobs[1];
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
              if (!wasTerminal && nowTerminal && onSettled) {
                try { onSettled(id, snapshot); } catch (e) { /* best effort */ }
              }
              var output = (old.output || "") + (value.output || "");
              jobsRef.current = Object.assign({}, jobsRef.current, { [id]: Object.assign({}, old, {
                status: snapshot.status,
                detail: snapshot.detail,
                needsApproval: snapshot.needsApproval,
                approvalToken: snapshot.approvalToken,
                output: output,
              }) });
              setJobs(Object.assign({}, jobsRef.current));
            }).catch(function () { /* keep polling */ });
          });
        }, 1200);
        return function () { clearInterval(timer); };
      }, [call, onSettled, onApprovalToken]);
      var track = useCallback(function (id, spec) {
        jobsRef.current = Object.assign({}, jobsRef.current, { [id]: { status: "running", spec: spec, output: "" } });
        setJobs(Object.assign({}, jobsRef.current));
      }, []);
      var clear = useCallback(function () {
        jobsRef.current = {};
        setJobs({});
      }, []);
      var drop = useCallback(function (id) {
        var next = Object.assign({}, jobsRef.current);
        delete next[id];
        jobsRef.current = next;
        setJobs(next);
      }, []);
      return { jobs: jobs, track: track, clear: clear, drop: drop };
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

    // ── preflight risk dialog ────────────────────────────────────────────────
    function PreflightDialog(props) {
      var report = props.report || {};
      var verdict = report.verdict;
      var blocked = verdict === "blocked";
      var warning = verdict === "warning";
      var title = blocked ? "安装被阻止" : warning ? "安装存在风险" : "安装检查通过";
      var issues = report.issues || [];
      return h("div", { className: "mkt_modalOverlay" },
        h("div", { className: "mkt_modal" },
          h("p", { className: "mkt_modalTitle" }, title),
          h("div", { className: "mkt_modalSpec" }, clip(props.spec, 80)),
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
          h("div", { className: "mkt_modalActions" },
            blocked
              ? h("button", { className: "mkt_btn mkt_btnSm", onClick: props.onClose }, "关闭")
              : [
                  h("button", { key: "cancel", className: "mkt_btn mkt_btnSm", onClick: props.onClose }, "取消"),
                  h("button", {
                    key: "confirm",
                    className: "mkt_btn mkt_btnPrimary mkt_btnSm",
                    disabled: props.busy === true,
                    onClick: props.onConfirm,
                  }, props.busy ? "安装中…" : (warning ? "我已了解风险，继续安装" : "安装")),
                ]
          )
        )
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
            h("div", { className: "mkt_meta" },
              id + " · " + clip(job.spec || "", 40) + " · " + (job.status || "running")),
            job.needsApproval && job.needsApproval.length > 0
              ? h(ApprovalRequest, {
                needsApproval: job.needsApproval,
                busy: props.approving === job.spec,
                onApprove: function (names) {
                  if (typeof props.onDrop === "function") {
                    props.onDrop(id);
                  }
                  props.onApprove(job.spec, names, job.approvalToken);
                },
                onDismiss: function () { props.onDismiss(id); },
              })
              : job.detail ? h("div", { className: "mkt_desc" }, job.detail) : null,
            done && job.status === "completed"
              ? h("div", { className: "mkt_jobDone" },
                h("span", { className: "mkt_ok" }, "完成"),
                h("button", {
                  className: "mkt_btn mkt_btnPrimary mkt_btnSm",
                  disabled: props.restarting === true,
                  onClick: props.onRestart,
                }, props.restarting ? "重启中…" : "重启 dsh 生效"))
              : job.status === "failed" && !(job.needsApproval && job.needsApproval.length > 0)
                ? h("div", { className: "mkt_error" }, "失败，见下方输出")
                : null,
            job.output ? h("pre", { className: "mkt_pre" }, job.output.slice(-4000)) : null
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
              return h("div", { key: dep.name, className: "mkt_depRow" },
                h("span", { className: "mkt_desc" }, dep.name + "@" + dep.version),
                h("span", { className: "mkt_depActions" },
                  h("span", { className: "mkt_badge" }, kindLabel(dep.kind)),
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
      var _preflight = useState(null);
      var preflight = _preflight[0];
      var setPreflight = _preflight[1];

      // Opaque one-shot approval tokens issued from needsApproval outcomes (spec -> token).
      // Cleared on success, unrelated failure, cancel, modal close, or spec change.
      // No boolean warning-consent map is kept.
      var sessionNonce = useRef(generateSessionNonce()).current;
      var approvalTokensRef = useRef({});

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

      var polling = useJobPolling(call, onJobSettled, onApprovalToken);
      var track = polling.track;
      var jobs = polling.jobs;
      var clearJobs = polling.clear;
      var dropJob = polling.drop;

      useEffect(function () {
        doSearch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      var doRawInstall = useCallback(function (spec, extra) {
        setInstalling(function (prev) {
          var next = Object.assign({}, prev, { [spec]: true });
          return next;
        });
        setError(null);
        var payload = Object.assign({ spec: spec }, extra || {});
        call("install", payload).then(function (value) {
          track(value.jobId, spec);
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

      var doApprove = useCallback(function (spec, names, token) {
        var extra = { allowBuildScripts: names };
        var apprToken = token || approvalTokensRef.current[spec];
        if (apprToken) {
          extra.approvalToken = apprToken;
          delete approvalTokensRef.current[spec];
        }
        doRawInstall(spec, extra);
      }, [doRawInstall]);

      var preflightAndInstall = useCallback(function (spec) {
        delete approvalTokensRef.current[spec];
        setInstalling(function (prev) {
          var next = Object.assign({}, prev, { [spec]: true });
          return next;
        });
        setError(null);
        call("preflight", { spec: spec }).then(function (report) {
          setPreflight({ spec: spec, report: report });
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setInstalling(function (prev) {
            var next = Object.assign({}, prev);
            delete next[spec];
            return next;
          });
        });
      }, [call]);

      var doInstall = useCallback(function (repo) {
        preflightAndInstall("github:" + repo);
      }, [preflightAndInstall]);

      var confirmInstall = useCallback(function () {
        var pending = preflight;
        if (!pending) return;
        setPreflight(null);
        doRawInstall(pending.spec, pending.report.verdict === "warning" ? { acceptWarnings: true } : {});
      }, [preflight, doRawInstall]);

      var doRestart = useCallback(function () {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (window.confirm("重启 dsh？正在进行的任务会中断。") !== true) return;
        }
        setRestarting(true);
        setError(null);
        call("restart", {}).then(function () {
          var tries = 0;
          var ping = setInterval(function () {
            tries++;
            if (tries > 40) {
              clearInterval(ping);
              setRestarting(false);
              setError("2 分钟内未检测到 dsh 重启完成，请手动检查 dsh 状态后刷新页面。");
              return;
            }
            rpc.call("/market", "installed", {}).then(function () {
              clearInterval(ping);
              window.location.reload();
            }).catch(function () { /* host restarting */ });
          }, 3000);
        }).catch(function (e) {
          setRestarting(false);
          setError(errorText(e));
        });
      }, [call, rpc]);

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
        h(InstalledPanel, { installed: installed, removing: removing, updates: updates, onUninstall: doUninstall, onInstallSpec: preflightAndInstall }),
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
          approving: Object.keys(installing).filter(function (s) { return installing[s]; })[0],
        }),
        preflight ? h(PreflightDialog, {
          spec: preflight.spec,
          report: preflight.report,
          busy: installing[preflight.spec] === true,
          onConfirm: confirmInstall,
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
