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
      ".mkt_card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-primary,#fff);display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".mkt_cardHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".mkt_name{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
      ".mkt_meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mkt_desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".mkt_cardActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:auto;padding-top:4px}",
      ".mkt_infoCard{max-width:640px}",
      ".mkt_panelTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}",
      ".mkt_panelRow{display:flex;align-items:center;gap:8px}",
      ".mkt_panelRow .mkt_link{margin-left:auto}",
      ".mkt_pre{font-family:Consolas,Monaco,monospace;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-secondary,#f6f7f8);border-radius:6px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}",
      ".mkt_ok{color:var(--dsw-alias-state-success-primary,#2f855a)}",
      ".mkt_badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
      ".mkt_link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;cursor:pointer}",
      ".mkt_installedHead{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:0;margin:0;cursor:pointer;font:inherit;text-align:left}",
      ".mkt_installedHead:hover .mkt_panelTitle{color:var(--dsw-alias-state-business-primary)}",
      ".mkt_installedToggle{margin-left:auto}",
      ".mkt_depList{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
      ".mkt_depRow{display:flex;justify-content:space-between;align-items:center;gap:8px}",
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

    // ── job polling ─────────────────────────────────────────────────────────
    function useJobPolling(call, onSettled) {
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
              if (!wasTerminal && nowTerminal && onSettled) {
                try { onSettled(id); } catch (e) { /* best effort */ }
              }
              var output = (old.output || "") + (value.output || "");
              jobsRef.current = Object.assign({}, jobsRef.current, { [id]: Object.assign({}, old, {
                status: snapshot.status,
                detail: snapshot.detail,
                output: output,
              }) });
              setJobs(Object.assign({}, jobsRef.current));
            }).catch(function () { /* keep polling */ });
          });
        }, 1200);
        return function () { clearInterval(timer); };
      }, [call, onSettled]);
      var track = useCallback(function (id, spec) {
        jobsRef.current = Object.assign({}, jobsRef.current, { [id]: { status: "running", spec: spec, output: "" } });
        setJobs(Object.assign({}, jobsRef.current));
      }, []);
      return { jobs: jobs, track: track };
    }

    // ── repo card ───────────────────────────────────────────────────────────
    function RepoCard(props) {
      var item = props.item;
      var installing = props.installing === true;
      return h("div", { className: "mkt_card" },
        h("div", { className: "mkt_cardHead" },
          h("span", { className: "mkt_name" }, item.fullName),
          h("span", { className: "mkt_meta" }, "★" + item.stars),
          item.language ? h("span", { className: "mkt_meta" }, item.language) : null,
          item.license ? h("span", { className: "mkt_meta" }, item.license) : null,
          item.archived ? h("span", { className: "mkt_badge" }, "archived") : null
        ),
        item.description ? h("div", { className: "mkt_desc" }, clip(item.description, 180)) : null,
        h("div", { className: "mkt_meta" }, "更新 " + (item.updatedAt || "").slice(0, 10)),
        h("div", { className: "mkt_cardActions" },
          h("button", { className: "mkt_btn mkt_btnPrimary", disabled: installing, onClick: function () { props.onInstall(item.fullName); } },
            installing ? "安装中…" : "安装"),
          h("button", { className: "mkt_btn", onClick: function () { props.onInfo(item.fullName); } }, "详情")
        )
      );
    }

    // ── info panel ──────────────────────────────────────────────────────────
    function InfoPanel(props) {
      var info = props.info;
      if (!info) return null;
      var data = info.data;
      return h("div", { className: "mkt_card mkt_infoCard", ref: props.panelRef },
        h("div", { className: "mkt_panelRow" },
          h("p", { className: "mkt_panelTitle" }, "仓库详情"),
          props.onClose ? h("span", { className: "mkt_link", onClick: props.onClose }, "✕ 关闭") : null
        ),
        info.loading ? h("div", { className: "mkt_meta" }, "加载中…")
          : info.error ? h("div", { className: "mkt_error" }, info.error)
          : !data ? null
          : h(React.Fragment, null,
            h("div", { className: "mkt_name" }, data.meta.fullName),
            h("div", { className: "mkt_desc" }, clip(data.meta.description, 240)),
            h("div", { className: "mkt_meta" },
              "★" + data.meta.stars + " · " + (data.meta.language || "-") + " · " + (data.meta.license || "-") + " · 分支 " + data.meta.defaultBranch),
            data.packageJson == null
              ? h("div", { className: "mkt_meta" }, "package.json: 未找到（可能不是 npm 插件）")
              : h(React.Fragment, null,
                h("div", { className: "mkt_meta" }, "package.json: " + (data.packageJson.name || "?") + "@" + (data.packageJson.version || "?")),
                data.packageJson.dshBundlePatch != null
                  ? h("div", { className: "mkt_ok" }, "✓ dsh.bundle 宿主插件")
                  : data.packageJson.dshClientPlatform != null
                    ? h("div", { className: "mkt_ok" }, "✓ dsh.client 浏览器UI插件")
                    : h("div", { className: "mkt_meta" }, "⚠ 无 bundle/client 声明，装上是普通依赖")),
            h("button", { className: "mkt_btn mkt_btnPrimary", onClick: function () { props.onInstall(data.meta.fullName); } }, "安装 github:" + data.meta.fullName),
            h("a", { className: "mkt_link", href: data.meta.htmlUrl, target: "_blank", rel: "noreferrer" }, "打开仓库 ↗")
          )
      );
    }

    // ── jobs panel ──────────────────────────────────────────────────────────
    function JobsPanel(props) {
      var ids = Object.keys(props.jobs);
      if (ids.length === 0) return null;
      return h("div", { className: "mkt_card" },
        h("p", { className: "mkt_panelTitle" }, "任务"),
        ids.map(function (id) {
          var job = props.jobs[id];
          var done = job.status === "completed" || job.status === "failed" || job.status === "killed";
          return h("div", { key: id, style: { display: "flex", flexDirection: "column", gap: "4px" } },
            h("div", { className: "mkt_meta" },
              id + " · " + clip(job.spec || "", 40) + " · " + (job.status || "running")),
            job.detail ? h("div", { className: "mkt_desc" }, job.detail) : null,
            done && job.status === "completed"
              ? h("div", { className: "mkt_ok" }, "✓ 完成 — 重启 dsh 后生效")
              : job.status === "failed"
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
          h("span", { className: "mkt_meta mkt_installedToggle" }, open ? "收起 ▲" : "展开 ▼")
        ),
        installed.error
          ? h("div", { className: "mkt_error" }, installed.error)
          : !open ? null
          : (installed.deps || []).length === 0
            ? h("div", { className: "mkt_meta" }, "还没有装过插件")
            : h("div", { className: "mkt_depList" }, (installed.deps || []).map(function (dep) {
              var busy = (props.removing || {})[dep.name] === true;
              return h("div", { key: dep.name, className: "mkt_depRow" },
                h("span", { className: "mkt_desc" }, dep.name + "@" + dep.version),
                h("span", { className: "mkt_badge" }, kindLabel(dep.kind)),
                h("button", {
                  className: "mkt_btn mkt_btnDanger mkt_btnSm",
                  disabled: busy,
                  onClick: function () { props.onUninstall(dep.name); },
                }, busy ? "卸载中…" : "卸载"));
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
      var _info = useState(null);
      var info = _info[0];
      var setInfo = _info[1];
      var _installed = useState(null);
      var installed = _installed[0];
      var setInstalled = _installed[1];
      var _installing = useState({});
      var installing = _installing[0];
      var setInstalling = _installing[1];
      var _removing = useState({});
      var removing = _removing[0];
      var setRemoving = _removing[1];
      var infoRef = useRef(null);

      var call = useCallback(function (endpoint, payload) {
        return rpc.call("/market", endpoint, payload || {}).then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || "market request failed");
          return res.value;
        });
      }, [rpc]);

      var doSearch = useCallback(function () {
        setLoading(true);
        setError(null);
        call("search", { query: query, sort: sort, perPage: 20 }).then(function (value) {
          setResults(value);
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setLoading(false);
        });
      }, [call, query, sort]);

      var doInfo = useCallback(function (repo) {
        setInfo({ repo: repo, loading: true });
        call("info", { repo: repo }).then(function (value) {
          setInfo({ repo: repo, data: value });
        }).catch(function (e) {
          setInfo({ repo: repo, error: errorText(e) });
        });
      }, [call]);

      var doCloseInfo = useCallback(function () {
        setInfo(null);
      }, []);

      // 详情面板在列表上方；点"详情"时平滑滚到面板，免得用户找不到。
      useEffect(function () {
        if (info && infoRef.current && typeof infoRef.current.scrollIntoView === "function") {
          infoRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }, [info]);

      var refreshInstalled = useCallback(function () {
        call("installed", {}).then(function (value) {
          setInstalled(value);
        }).catch(function (e) {
          setInstalled({ error: errorText(e) });
        });
      }, [call]);

      // 点开即自动搜索（空关键词 = 最热插件），安装任务结束自动刷新已装列表。
      var polling = useJobPolling(call, refreshInstalled);
      var track = polling.track;
      var jobs = polling.jobs;

      useEffect(function () {
        doSearch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      var doInstall = useCallback(function (repo) {
        var spec = "github:" + repo;
        setInstalling(function (prev) {
          var next = Object.assign({}, prev, { [repo]: true });
          return next;
        });
        setError(null);
        call("install", { spec: spec }).then(function (value) {
          track(value.jobId, spec);
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setInstalling(function (prev) {
            var next = Object.assign({}, prev);
            delete next[repo];
            return next;
          });
        });
      }, [call, track]);

      var doUninstall = useCallback(function (name) {
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
          h("button", { className: "mkt_btn", onClick: refreshInstalled }, "刷新已装")
        ),
        error ? h("div", { className: "mkt_error" }, error) : null,
        h(InstalledPanel, { installed: installed, removing: removing, onUninstall: doUninstall }),
        h(InfoPanel, { info: info, onInstall: doInstall, onClose: doCloseInfo, panelRef: infoRef }),
        h("div", { className: "mkt_list" },
          results == null
            ? h("div", { className: "mkt_meta mkt_listHead" }, loading ? "正在加载最热插件…" : "—")
            : results.items.length === 0
              ? h("div", { className: "mkt_meta mkt_listHead" }, "没有匹配的仓库。")
              : h(React.Fragment, null,
                h("div", { className: "mkt_meta mkt_listHead" }, "共 " + results.total + " 个仓库（显示 " + results.items.length + " 个）"),
                results.items.map(function (item) {
                  return h(RepoCard, {
                    key: item.fullName,
                    item: item,
                    installing: installing[item.fullName] === true,
                    onInstall: doInstall,
                    onInfo: doInfo,
                  });
                })
              )
        ),
        h(JobsPanel, { jobs: jobs })
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
