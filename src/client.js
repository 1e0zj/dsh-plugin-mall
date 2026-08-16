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
      ".mkt_name{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
      ".mkt_meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mkt_desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".mkt_cardActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:auto;padding-top:4px}",
      ".mkt_cardActions .mkt_btn{text-decoration:none}",
      ".mkt_panelTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}",
      ".mkt_pre{font-family:Consolas,Monaco,monospace;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-secondary,#f6f7f8);border-radius:6px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}",
      ".mkt_ok{color:var(--dsw-alias-state-success-primary,#2f855a)}",
      ".mkt_badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
      ".mkt_badgeOk{border-color:var(--dsw-alias-state-success-primary,#2f855a);color:var(--dsw-alias-state-success-primary,#2f855a)}",
      ".mkt_check{display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
      ".mkt_link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;cursor:pointer}",
      ".mkt_installedHead{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:0;margin:0;cursor:pointer;font:inherit;text-align:left}",
      ".mkt_installedHead:hover .mkt_panelTitle{color:var(--dsw-alias-state-business-primary)}",
      ".mkt_installedToggle{margin-left:auto}",
      ".mkt_depList{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
      ".mkt_depRow{display:flex;justify-content:space-between;align-items:center;gap:8px}",
      ".mkt_depActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
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

    // ── plugin verification badge ───────────────────────────────────────────
    // verified 来自 /market verify 端点（node 侧拉 raw package.json 判定
    // dsh.bundle/dsh.client 声明，进程内缓存）。unknown 不显示徽章。
    function verifyBadge(verified) {
      if (verified === undefined || verified === null) return null;
      if (verified.kind === "bundle") return h("span", { className: "mkt_badge mkt_badgeOk" }, "✓ 宿主插件");
      if (verified.kind === "client") return h("span", { className: "mkt_badge mkt_badgeOk" }, "✓ UI插件");
      if (verified.kind === "plain") return h("span", { className: "mkt_badge" }, "未声明");
      if (verified.kind === "no-manifest") return h("span", { className: "mkt_badge" }, "无package.json");
      return null;
    }

    // ── repo card ───────────────────────────────────────────────────────────
    function RepoCard(props) {
      var item = props.item;
      var installing = props.installing === true;
      var job = props.installJob;
      var installLabel = "安装";
      var installDisabled = installing;
      if (!installing && job) {
        if (job.status === "running") { installLabel = "安装中…"; installDisabled = true; }
        else if (job.status === "completed") { installLabel = "✓ 已装 · 重启生效"; installDisabled = true; }
        else if (job.status === "failed") { installLabel = "安装失败 · 见任务日志"; }
        else { installLabel = "已取消 · 重试"; }
      }
      return h("div", { className: "mkt_card" },
        h("div", { className: "mkt_cardHead" },
          h("span", { className: "mkt_name" }, item.fullName),
          verifyBadge(props.verified),
          h("span", { className: "mkt_meta" }, "★" + item.stars),
          item.language ? h("span", { className: "mkt_meta" }, item.language) : null,
          item.license ? h("span", { className: "mkt_meta" }, item.license) : null,
          item.archived ? h("span", { className: "mkt_badge" }, "archived") : null
        ),
        item.description ? h("div", { className: "mkt_desc" }, clip(item.description, 180)) : null,
        h("div", { className: "mkt_meta" }, "更新 " + (item.updatedAt || "").slice(0, 10)),
        h("div", { className: "mkt_cardActions" },
          h("button", { className: "mkt_btn mkt_btnPrimary", disabled: installDisabled, onClick: function () { props.onInstall(item.fullName); } },
            installLabel),
          h("a", { className: "mkt_btn", href: item.htmlUrl, target: "_blank", rel: "noreferrer" }, "前往仓库 ↗")
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
              var upd = (props.updates || {})[dep.name];
              return h("div", { key: dep.name, className: "mkt_depRow" },
                h("span", { className: "mkt_desc" }, dep.name + "@" + dep.version),
                h("span", { className: "mkt_depActions" },
                  h("span", { className: "mkt_badge" }, kindLabel(dep.kind)),
                  upd && upd.hasUpdate ? h("button", {
                    className: "mkt_btn mkt_btnSm",
                    onClick: function () { props.onInstallSpec(dep.name); },
                  }, "更新 → " + upd.latest) : null,
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
      var _verified = useState({});
      var verified = _verified[0];
      var setVerified = _verified[1];
      var _verifiedOnly = useState(false);
      var verifiedOnly = _verifiedOnly[0];
      var setVerifiedOnly = _verifiedOnly[1];
      var _updates = useState(null);
      var updates = _updates[0];
      var setUpdates = _updates[1];

      var call = useCallback(function (endpoint, payload) {
        return rpc.call("/market", endpoint, payload || {}).then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || "market request failed");
          return res.value;
        });
      }, [rpc]);

      // 每页搜索结果到货后批量验证（node 侧 raw CDN，带缓存），失败静默——
      // 徽章缺失可接受，不该打断浏览。
      var verifyPage = useCallback(function (items) {
        var repos = (items || []).map(function (it) { return it.fullName; });
        if (repos.length === 0) return;
        call("verify", { repos: repos }).then(function (value) {
          setVerified(function (prev) { return Object.assign({}, prev, value.results); });
        }).catch(function () { /* 徽章缺失即可 */ });
      }, [call]);

      var doSearch = useCallback(function () {
        setLoading(true);
        setError(null);
        setPage(1);
        call("search", { query: query, sort: sort, perPage: 20 }).then(function (value) {
          setResults(value);
          setVerified({});
          verifyPage(value.items);
        }).catch(function (e) {
          setError(errorText(e));
        }).finally(function () {
          setLoading(false);
        });
      }, [call, query, sort, verifyPage]);

      // 无限滚动：哨兵进入视口时拉下一页并追加。GitHub topic 的翻页间数据
      // 可能移动造成重复，按 fullName 去重；已显示数追上 total 即到底。
      var canLoadMore = results !== null && results.items.length < results.total;
      var loadMore = useCallback(function () {
        if (!canLoadMore || loading || loadingMore) return;
        setLoadingMore(true);
        call("search", { query: query, sort: sort, perPage: 20, page: page + 1 }).then(function (value) {
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
        }).finally(function () {
          setLoadingMore(false);
        });
      }, [call, canLoadMore, loading, loadingMore, page, query, sort]);

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

      // 点开即自动搜索（空关键词 = 最热插件），安装任务结束自动刷新已装列表。
      var polling = useJobPolling(call, refreshInstalled);
      var track = polling.track;
      var jobs = polling.jobs;

      useEffect(function () {
        doSearch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 通用安装入口：spec 可以是 github:owner/repo（卡片按钮）或 npm 包名
      // （已装面板的更新按钮）。后端会把同源发布的 github spec 改写为 npm
      // tarball 安装（更快），job 里记录的是最终 spec。
      var doInstallSpec = useCallback(function (spec) {
        setInstalling(function (prev) {
          var next = Object.assign({}, prev, { [spec]: true });
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
            delete next[spec];
            return next;
          });
        });
      }, [call, track]);

      var doInstall = useCallback(function (repo) {
        doInstallSpec("github:" + repo);
      }, [doInstallSpec]);

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

      // 活动任务置顶（紧跟已装面板，点安装立刻看到进度）；全部静止后归档到底部当日志。
      var jobsActive = false;
      for (var jid in jobs) { if (jobs[jid] && jobs[jid].status === "running") { jobsActive = true; break; } }

      // "只看已验证"开关下的可见项：verify 判定 bundle/client 的才算插件。
      var visibleItems = results === null ? [] : results.items.filter(function (it) {
        if (verifiedOnly !== true) return true;
        var v = verified[it.fullName];
        return v !== undefined && (v.kind === "bundle" || v.kind === "client");
      });

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
          h("label", { className: "mkt_check" },
            h("input", { type: "checkbox", checked: verifiedOnly, onChange: function (e) { setVerifiedOnly(e.target.checked); } }),
            "只看已验证")
        ),
        error ? h("div", { className: "mkt_error" }, error) : null,
        h(InstalledPanel, { installed: installed, removing: removing, updates: updates, onUninstall: doUninstall, onInstallSpec: doInstallSpec }),
        jobsActive ? h(JobsPanel, { jobs: jobs }) : null,
        h("div", { className: "mkt_list" },
          results == null
            ? h("div", { className: "mkt_meta mkt_listHead" }, loading ? "正在加载最热插件…" : "—")
            : results.items.length === 0
              ? h("div", { className: "mkt_meta mkt_listHead" }, "没有匹配的仓库。")
              : h(React.Fragment, null,
                h("div", { className: "mkt_meta mkt_listHead" }, verifiedOnly
                  ? "已验证 " + visibleItems.length + " · 已显示 " + results.items.length + " · 共 " + results.total + " 个仓库（star≥1）"
                  : "共 " + results.total + " 个仓库（star≥1）· 已显示 " + results.items.length + " 个"),
                visibleItems.length === 0 && verifiedOnly
                  ? h("div", { className: "mkt_meta mkt_listHead" }, "当前结果里没有已验证的 dsh 插件（✓ 徽章）。")
                  : null,
                visibleItems.map(function (item) {
                  var installJob = null;
                  for (var jobId in jobs) {
                    if (jobs[jobId] && jobs[jobId].spec === "github:" + item.fullName) { installJob = jobs[jobId]; break; }
                  }
                  return h(RepoCard, {
                    key: item.fullName,
                    item: item,
                    installing: installing[item.fullName] === true || installing["github:" + item.fullName] === true,
                    installJob: installJob,
                    verified: verified[item.fullName],
                    onInstall: doInstall,
                  });
                }),
                canLoadMore
                  ? h("div", { className: "mkt_loadMore", ref: sentinelRef }, loadingMore ? "加载中…" : "下滑加载更多")
                  : h("div", { className: "mkt_loadMore" }, "已显示全部 " + results.items.length + " 个")
              )
        ),
        jobsActive ? null : h(JobsPanel, { jobs: jobs })
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
