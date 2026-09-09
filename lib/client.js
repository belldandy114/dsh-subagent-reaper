window.__ModuleLoader__.load({
	id: "dsh-subagent-reaper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const BASE = "/subagent-reaper";
		const STYLE_ID = "subagent-reaper-style";

		/** 一次性注入旋转动画（内联样式写不了 @keyframes）。 */
		function ensureStyle() {
			try {
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = "@keyframes reaper-spin{to{transform:rotate(360deg)}}.reaper-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:reaper-spin .7s linear infinite;vertical-align:middle}";
				document.head.appendChild(style);
			} catch (error) { /* ignore */ }
		}

		/** 从 index 注入的 meta 读取本次启动的 token（路由鉴权）。 */
		function token() {
			try {
				const el = document.querySelector('meta[name="subagent-reaper-token"]');
				return el === null ? "" : el.getAttribute("content") || "";
			} catch (error) {
				return "";
			}
		}

		/**
		 * 调 Host 路由。
		 * 注意：带 body 时**必须**用 POST —— fetch 规范禁止 GET 带 body，否则浏览器直接抛 TypeError。
		 * 失败时把 HTTP 状态 / 网络原因原样带回去，UI 才能显示可定位的信息。
		 */
		function call(path, init) {
			const options = { method: "GET", headers: { "x-reaper-token": token() } };
			if (init !== undefined && init !== null) {
				if (init.parentId !== undefined) options.headers["x-reaper-parent"] = String(init.parentId);
				if (init.body !== undefined) {
					options.method = init.method !== undefined ? init.method : "POST";
					options.headers["content-type"] = "application/json";
					options.body = JSON.stringify(init.body);
				} else if (init.method !== undefined) options.method = init.method;
			}
			return fetch(BASE + path, options).then((response) => response.text().then((text) => {
				let payload = null;
				try { payload = text === "" ? null : JSON.parse(text); } catch (error) { payload = null; }
				if (!response.ok) return { ok: false, reason: "HTTP " + String(response.status) };
				if (payload === null) return { ok: false, reason: "响应不是 JSON" };
				return payload;
			})).catch((error) => ({ ok: false, reason: "网络错误：" + String(error !== null && error !== undefined && error.message ? error.message : error) }));
		}

		/** 样式全部走主题别名 token（同 dsh-client-ui-primitives），明/暗主题自动适配；每个 token 带兜底值。 */
		const T = {
			surface: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))",
			surfaceRaised: "var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.18)))",
			border: "var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
			borderStrong: "var(--dsw-alias-border-l2, rgba(127,127,127,0.45))",
			label: "var(--dsw-alias-label-primary, inherit)",
			labelDim: "var(--dsw-alias-label-secondary, inherit)",
			brand: "var(--dsw-alias-brand-primary, #4a7dff)",
			brandFill: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4a7dff))",
			onBrand: "var(--dsw-alias-label-primary-foreground, #fff)",
			danger: "var(--dsw-alias-state-error-primary, #d9534f)",
			idle: "var(--dsw-alias-state-success-primary, #2f9e44)",
			running: "var(--dsw-alias-state-warn-primary, #f59e0b)",
		};

		const chipBase = { font: "inherit", fontSize: "12px", lineHeight: "18px", height: "28px", padding: "0 10px", display: "inline-flex", alignItems: "center", gap: "6px", color: T.label, background: T.surface, border: "1px solid " + T.borderStrong, borderRadius: "14px", cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto" };

		const S = {
			wrap: { position: "relative", display: "inline-flex", alignItems: "center" },
			chip: chipBase,
			chipHot: Object.assign({}, chipBase, { border: "1px solid " + T.brand }),
			badge: { minWidth: "16px", height: "16px", padding: "0 5px", borderRadius: "999px", fontSize: "11px", lineHeight: "16px", textAlign: "center", background: T.brandFill, color: T.onBrand },
			panel: { position: "absolute", top: "34px", right: 0, width: "440px", maxHeight: "420px", overflowY: "auto", zIndex: 40, background: T.surfaceRaised, border: "1px solid " + T.border, borderRadius: "10px", boxShadow: "0 8px 24px rgba(0,0,0,0.24)", padding: "8px" },
			tabs: { display: "flex", gap: "6px", padding: "2px 0 8px" },
			row: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", borderRadius: "6px" },
			groupRow: { display: "flex", alignItems: "center", gap: "6px", padding: "8px 8px 2px", fontSize: "11px", color: T.labelDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			name: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", color: T.label },
			metaIdle: { flex: "0 0 auto", fontSize: "11px", color: T.idle, whiteSpace: "nowrap" },
			metaRunning: { flex: "0 0 auto", fontSize: "11px", color: T.running, whiteSpace: "nowrap" },
			metaBusy: { flex: "0 0 auto", fontSize: "11px", color: T.running, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "4px" },
			x: { flex: "0 0 auto", width: "24px", height: "24px", lineHeight: "20px", textAlign: "center", font: "inherit", fontSize: "14px", color: T.danger, background: "transparent", border: "1px solid " + T.border, borderRadius: "6px", cursor: "pointer" },
			foot: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid " + T.border },
			note: { fontSize: "11px", color: T.labelDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			actRow: { display: "flex", justifyContent: "flex-end", gap: "8px" },
			hint: { fontSize: "12px", color: T.labelDim, padding: "6px 8px" },
		};

		function apply(ctx) {
			ensureStyle();
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			/** 客户端会话状态服务：删除后要靠它把被删子代理从侧栏计数里去掉。 */
			const sessionsSvc = ctx.sessions !== undefined ? ctx.sessions : ctx.get("sessions");

			/**
			 * 删除成功后同步客户端快照。两处都要刷，且各刷两轮：
			 * - refresh()：全量重拉 session.list 基线 → 被删的子代理从 byId 快照里消失
			 *   （侧栏「项目名 / N 个子代理」= max(目录里的子代理数, 快照里的后代数)）
			 * - refreshSubagents(parentId)：重拉子代理目录（页头谱系）
			 * 第二轮是必须的：这两个调用都是"单飞"（in-flight 请求复用），第一轮可能
			 * 并入了删除之前就已发出的请求，拿回来的是删除前的旧基线。
			 */
			function syncClientState(parentId) {
				const svc = sessionsSvc;
				if (svc === undefined) return Promise.resolve("no-sessions-service");
				const round = () => {
					const jobs = [];
					if (typeof svc.refresh === "function") jobs.push(Promise.resolve(svc.refresh()).then(() => true, () => false));
					if (typeof svc.refreshSubagents === "function" && parentId !== "") jobs.push(Promise.resolve(svc.refreshSubagents(parentId)).then(() => true, () => false));
					return Promise.all(jobs).then((flags) => flags.every((flag) => flag === true));
				};
				return round().then((first) => new Promise((resolve) => setTimeout(() => resolve(first), 80)).then(round)).then((second) => (second ? "ok" : "failed"));
			}

			function Reaper(props) {
				const parentId = props !== null && props !== undefined && props.sessionId !== undefined ? String(props.sessionId) : "";
				const [open, setOpen] = react.useState(false);
				const [scope, setScope] = react.useState("child");
				const [rows, setRows] = react.useState([]);
				const [groups, setGroups] = react.useState([]);
				const [loaded, setLoaded] = react.useState(false);
				const [busy, setBusy] = react.useState("");
				const [note, setNote] = react.useState("");
				const [syncTag, setSyncTag] = react.useState(0);
				const [syncNote, setSyncNote] = react.useState("");

				/** 复算侧栏芯片的计数（与 dsh-client-ui-subagent 同一口径）：目录里的子代理数、快照里的后代数、目录状态。 */
				const counts = typeof props.useSessions === "function"
					? props.useSessions((state) => {
						if (state === null || state === undefined) return "no-state";
						const catalog = state.subagentsByParent !== undefined ? state.subagentsByParent[parentId] : undefined;
						const entries = catalog !== undefined && Array.isArray(catalog.entries) ? catalog.entries : [];
						let healthy = 0;
						for (const entry of entries) if (entry !== null && entry !== undefined && entry.kind === "child") healthy += 1;
						const summaries = state.byId !== undefined && state.byId !== null ? state.byId : {};
						let snapshot = 0;
						for (const key of Object.keys(summaries)) {
							let cur = summaries[key];
							const seen = new Set();
							while (cur !== null && cur !== undefined && cur.origin === "subagent" && cur.parentId !== undefined && !seen.has(cur.id)) {
								if (cur.parentId === parentId) { snapshot += 1; break; }
								seen.add(cur.id);
								cur = summaries[cur.parentId];
							}
						}
						const phase = catalog !== undefined && catalog.state !== undefined ? String(catalog.state) : "none";
						return phase + " " + String(healthy) + "/" + String(snapshot);
					})
					: "no-hook";

				const refresh = react.useCallback((which) => {
					const mode = which === undefined ? scope : which;
					if (mode === "any") {
						return call("/all").then((res) => {
							const list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.groups) ? res.groups : [];
							setGroups(list);
							setLoaded(true);
							if (res !== null && res !== undefined && res.ok === false) setNote("读取失败：" + String(res.reason));
							return null;
						}).catch(() => { setGroups([]); setLoaded(true); setNote("读取失败"); return null; });
					}
					if (parentId === "") return Promise.resolve();
					return call("/list", { parentId }).then((res) => {
						const list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.children) ? res.children : [];
						setRows(list);
						setLoaded(true);
						if (res !== null && res !== undefined && res.ok === false) setNote("读取失败：" + String(res.reason));
						return null;
					}).catch(() => { setRows([]); setLoaded(true); setNote("读取失败"); return null; });
				}, [parentId, scope]);

				react.useEffect(() => { refresh(scope); }, [refresh, scope]);

				// 每次侧栏计数变化或每次同步完成后上报一次诊断，便于核对客户端到底看到了什么。
				react.useEffect(() => {
					call("/diag", { body: {
						parent: parentId,
						counts: String(counts),
						sync: syncNote,
						hasRefresh: sessionsSvc !== undefined && typeof sessionsSvc.refresh === "function",
						hasCatalog: sessionsSvc !== undefined && typeof sessionsSvc.refreshSubagents === "function",
					} }).catch(() => null);
				}, [counts, syncTag]);

				const after = () => syncClientState(parentId).then((state) => {
					setSyncNote(String(state));
					setSyncTag((n) => n + 1);
					return refresh(scope);
				});

				const purge = (childId) => {
					setBusy(childId);
					setNote("删除中…");
					call("/purge", { body: { parentId, childId, scope } }).then((res) => {
						if (res !== null && res !== undefined && res.ok === true) {
							setNote("已删除 1 个子代理" + (res.live === "detached" ? "（宿主已摘除会话）" : ""));
						} else {
							setNote("删除失败：" + String(res !== null && res !== undefined && res.reason ? res.reason : "unknown"));
						}
						return after();
					}).then(() => setBusy(""));
				};

				const purgeIdle = () => {
					setBusy("*");
					setNote("清理中…");
					call("/purge-idle", { body: { parentId, scope } }).then((res) => {
						setNote(res !== null && res !== undefined && res.ok === true
							? "已删除 " + String(res.removed) + "/" + String(res.total) + " 个"
							: "清理失败：" + String(res !== null && res !== undefined && res.reason ? res.reason : "unknown"));
						return after();
					}).then(() => setBusy(""));
				};

				const spinner = () => react.createElement("span", { className: "reaper-spin", key: "spin" });
				const statusNode = (running, key) => react.createElement("span", { key, style: running ? S.metaRunning : S.metaIdle }, running ? "运行中" : "空闲");
				const busyNode = (key) => react.createElement("span", { key, style: S.metaBusy }, [spinner(), "删除中…"]);

				const items = [];
				let idleCount = 0;
				if (scope === "any") {
					const flat = [];
					for (const group of groups) for (const child of group.children) flat.push(child);
					idleCount = flat.filter((child) => child.running !== true).length;
					if (flat.length === 0) {
						items.push(react.createElement("div", { key: "empty", style: S.hint }, loaded ? "没有任何会话留下子代理" : "读取中…"));
					} else {
						for (const group of groups) {
							const parentLabel = group.parent === "" ? "（无父会话）" : String(group.parent).replace(/^session-/, "").slice(0, 8);
							items.push(react.createElement("div", { key: "g:" + String(group.parent), style: S.groupRow, title: String(group.parent) },
								"父会话 " + parentLabel + " · " + String(group.children.length) + " 个"));
							for (const child of group.children) {
								const rowBusy = busy === String(child.id);
								items.push(react.createElement("div", { key: String(child.id), style: S.row },
									react.createElement("span", { style: S.name, title: String(child.id) }, String(child.id).slice(0, 20)),
									rowBusy ? busyNode("s") : statusNode(child.running === true, "s"),
									react.createElement("button", {
										type: "button",
										style: rowBusy ? Object.assign({}, S.x, { opacity: 0.4, cursor: "default" }) : S.x,
										title: child.running === true ? "运行中，先中断再删除" : "删除这个子代理（含其会话数据）",
										disabled: busy !== "",
										onClick: () => purge(String(child.id)),
									}, "✕")));
							}
						}
					}
				} else if (rows.length === 0) {
					items.push(react.createElement("div", { key: "empty", style: S.hint }, loaded ? "当前会话没有子代理" : "读取中…"));
				} else {
					idleCount = rows.filter((row) => row.activity !== "running").length;
					for (const row of rows) {
						const title = row.label !== "" ? row.label : String(row.id).slice(0, 20);
						const rowBusy = busy === String(row.id);
						items.push(react.createElement("div", { key: String(row.id), style: S.row },
							react.createElement("span", { style: S.name, title: String(row.id) }, title),
							rowBusy
								? busyNode("s")
								: react.createElement("span", { style: row.activity === "running" ? S.metaRunning : S.metaIdle }, (row.mode === "continuable" ? "可续接" : "一次性") + " · " + (row.activity === "running" ? "运行中" : "空闲")),
							react.createElement("button", {
								type: "button",
								style: rowBusy ? Object.assign({}, S.x, { opacity: 0.4, cursor: "default" }) : S.x,
								title: row.activity === "running" ? "运行中，先中断再删除" : "删除这个子代理（含其会话数据）",
								disabled: busy !== "",
								onClick: () => purge(String(row.id)),
							}, "✕")));
					}
				}

				const tabs = react.createElement("div", { key: "tabs", style: S.tabs },
					react.createElement("button", { type: "button", style: scope === "child" ? S.chipHot : S.chip, disabled: busy !== "", onClick: () => { setScope("child"); setNote(""); } }, "当前会话"),
					react.createElement("button", { type: "button", style: scope === "any" ? S.chipHot : S.chip, disabled: busy !== "", onClick: () => { setScope("any"); setNote(""); } }, "全部会话"));

				const footNote = busy === "*" ? "清理中…（删除完成后侧栏计数会同步刷新）" : (note !== "" ? note : "删除后页头谱系与侧栏计数会同步刷新");
				const diagNote = "侧栏计数 目录/快照 = " + String(counts) + (syncNote === "" ? "" : " · 同步 " + syncNote);
				const foot = react.createElement("div", { key: "foot", style: S.foot }, [
					react.createElement("div", { key: "note", style: S.note, title: footNote }, busy === "*" ? [spinner(), " 清理中…"] : footNote),
					react.createElement("div", { key: "diag", style: S.note, title: diagNote }, diagNote),
					react.createElement("div", { key: "act", style: S.actRow },
						react.createElement("button", { type: "button", style: S.chip, disabled: busy !== "" || idleCount === 0, onClick: purgeIdle }, busy === "*" ? "清理中…" : "清理全部空闲")),
				]);

				const kids = [react.createElement("button", {
					key: "btn",
					type: "button",
					style: open || (loaded && (rows.length > 0 || groups.length > 0)) ? S.chipHot : S.chip,
					title: "子代理回收：列出并删除一次性子代理",
					"aria-label": "子代理回收",
					onClick: () => { const next = !open; setOpen(next); if (next) refresh(scope); },
				},
				react.createElement("span", { key: "i" }, "🧹"),
				react.createElement("span", { key: "t" }, "子代理"),
				loaded && scope === "child" && rows.length > 0 ? react.createElement("span", { key: "b", style: S.badge }, String(rows.length)) : null)];
				if (open) kids.push(react.createElement("div", { key: "panel", style: S.panel }, [tabs].concat(items, [foot])));
				return react.createElement("div", { style: S.wrap }, kids);
			}

			slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "subagent-reaper", order: 50, label: "子代理" },
				Reaper,
			));
		}

		const inject = ["slots", "sessions"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
