window.__ModuleLoader__.load({
	id: "dsh-subagent-reaper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** 官方图标组件（拿不到就退回 emoji，保证按钮永远可见）。 */
		let UI = null;
		try { UI = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (error) { UI = null; }

		const BASE = "/subagent-reaper";
		const STYLE_ID = "subagent-reaper-style";

		/**
		 * 跨重挂载保留的 UI 状态。
		 * 宿主刷新会话列表后可能重建页头 slot，组件重挂载会让 useState 回到默认值
		 * （面板突然自己关掉、页签跳回「当前会话」）。这里用模块级对象兜住。
		 */
		const persist = { open: false, scope: "child" };

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

		/** 图标按钮：正方形、无文字，靠 title/aria-label 说明用途。 */
		const iconBtn = { position: "relative", width: "28px", height: "28px", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: T.label, background: T.surface, border: "1px solid " + T.borderStrong, borderRadius: "8px", cursor: "pointer", flex: "0 0 auto" };
		const chipBase = { font: "inherit", fontSize: "12px", lineHeight: "18px", height: "28px", padding: "0 10px", display: "inline-flex", alignItems: "center", gap: "6px", color: T.label, background: T.surface, border: "1px solid " + T.borderStrong, borderRadius: "14px", cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto" };

		const S = {
			wrap: { position: "relative", display: "inline-flex", alignItems: "center" },
			icon: iconBtn,
			iconHot: Object.assign({}, iconBtn, { border: "1px solid " + T.brand, color: T.brand }),
			chip: chipBase,
			chipHot: Object.assign({}, chipBase, { border: "1px solid " + T.brand }),
			badge: { position: "absolute", top: "-5px", right: "-5px", minWidth: "15px", height: "15px", padding: "0 4px", borderRadius: "999px", fontSize: "10px", lineHeight: "15px", textAlign: "center", background: T.brandFill, color: T.onBrand, pointerEvents: "none" },
			/**
			 * 面板必须用 fixed：页头所在的 .*_root / .*_centerCol 都是 overflow:hidden，
			 * absolute 面板会被裁掉左半边（实测 440px 面板只剩 339px 可见）。
			 * fixed 不受 overflow 裁剪（祖先无 transform/filter/contain 时相对视口定位）。
			 */
			panel: { position: "fixed", width: "380px", maxHeight: "360px", overflowY: "auto", zIndex: 60, background: T.surfaceRaised, border: "1px solid " + T.border, borderRadius: "10px", boxShadow: "0 8px 24px rgba(0,0,0,0.24)", padding: "6px" },
			tabs: { display: "flex", gap: "4px", padding: "0 0 6px" },
			row: { display: "flex", alignItems: "center", gap: "6px", padding: "3px 6px", borderRadius: "6px" },
			groupRow: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 6px 0", fontSize: "11px", color: T.labelDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			name: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", color: T.label },
			metaIdle: { flex: "0 0 auto", fontSize: "11px", color: T.idle, whiteSpace: "nowrap" },
			metaRunning: { flex: "0 0 auto", fontSize: "11px", color: T.running, whiteSpace: "nowrap" },
			metaBusy: { flex: "0 0 auto", fontSize: "11px", color: T.running, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "4px" },
			x: { flex: "0 0 auto", width: "22px", height: "22px", lineHeight: "18px", textAlign: "center", font: "inherit", fontSize: "13px", color: T.danger, background: "transparent", border: "1px solid " + T.border, borderRadius: "6px", cursor: "pointer" },
			foot: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px", paddingTop: "6px", borderTop: "1px solid " + T.border },
			note: { fontSize: "11px", color: T.labelDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			actRow: { display: "flex", justifyContent: "flex-end", gap: "6px" },
			hint: { fontSize: "12px", color: T.labelDim, padding: "4px 6px" },
			reapedHead: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 6px 0" },
			reapedTitle: { flex: "1 1 auto", minWidth: 0, fontSize: "11px", color: T.labelDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			reapedChip: { display: "inline-flex", alignItems: "center", gap: "2px", height: "22px", padding: "0 2px 0 7px", fontSize: "11px", lineHeight: "18px", color: T.labelDim, background: T.surface, border: "1px solid " + T.border, borderRadius: "11px", whiteSpace: "nowrap" },
			reapedChipText: { fontVariantNumeric: "tabular-nums" },
			reapedChipX: { width: "16px", height: "16px", padding: 0, font: "inherit", fontSize: "10px", lineHeight: "14px", textAlign: "center", color: T.labelDim, background: "transparent", border: "none", borderRadius: "8px", cursor: "pointer" },
			smallChip: { font: "inherit", fontSize: "11px", lineHeight: "16px", height: "22px", padding: "0 8px", display: "inline-flex", alignItems: "center", color: T.labelDim, background: T.surface, border: "1px solid " + T.border, borderRadius: "11px", cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto" },
		};

		function apply(ctx) {
			ensureStyle();
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			/** 客户端会话服务：删除后靠 refreshProjections 让侧栏/页头重读。 */
			const sessionsSvc = ctx.sessions !== undefined ? ctx.sessions : ctx.get("sessions");

			/**
			 * 删除成功后同步客户端快照。
			 * 两件事都要做：
			 * 1) refresh()：重拉整个会话列表。宿主不再列出的会话会从 byId 里消失，
			 *    侧栏（better-sidebar 按 byId 里 origin==='subagent' && parentId 计数）才会真的减一。
			 * 2) refreshProjections(parentId)：重拉父会话投影（含 subagentCatalog）。
			 *    注意它在 state==='ready' 时会直接 resolve 不重拉，所以不能只靠它。
			 */
			function syncClientState(parentId) {
				const svc = sessionsSvc;
				if (svc === undefined || svc === null) return Promise.resolve("no-sessions-service");
				const refreshOne = (id) => {
					if (typeof svc.refreshProjections !== "function") return Promise.resolve(false);
					return Promise.resolve(svc.refreshProjections(id)).then(() => true, () => false);
				};
				const refreshList = () => {
					if (typeof svc.refresh !== "function") return Promise.resolve(false);
					return Promise.resolve(svc.refresh()).then(() => true, () => false);
				};
				const round = () => Promise.all([refreshList(), refreshOne(parentId)]).then((flags) => flags.some((flag) => flag === true));
				return round().then((first) => new Promise((resolve) => setTimeout(() => resolve(first), 80)).then(round)).then((second) => (second ? "ok" : "failed"));
			}

			/**
			 * 把「已回收」的 id 从客户端投影里摘掉。
			 *
			 * 为什么必须这么做：页头那个「N 个子智能体」按钮和侧栏计数都不读 Host 列表，
			 * 而是读客户端 `projectionStores[parentId].values().subagentCatalog`
			 * （见 ClientSessions.buildListSnapshot / projectList）。父会话日志里的
			 * subagent/catalog 事件是只追加的，官方没有移除事件，所以删完文件后
			 * 投影里那一行还在，计数就不会变。
			 *
			 * 这里直接改写客户端投影 store（apply 会覆盖同 key 的旧值并触发订阅），
			 * 让页头与侧栏立刻与实际一致。Host 侧数据不受影响，刷新后由本函数重新施加。
			 */
			function patchCatalog(hiddenIds) {
				const svc = sessionsSvc;
				if (svc === undefined || svc === null) return false;
				const manager = svc.manager;
				if (manager === undefined || manager === null) return false;
				const stores = manager.projectionStores;
				if (!(stores instanceof Map)) return false;
				const hidden = new Set((Array.isArray(hiddenIds) ? hiddenIds : []).map((id) => String(id)));
				if (hidden.size === 0) return false;
				let touched = false;
				for (const store of stores.values()) {
					if (store === null || store === undefined) continue;
					if (typeof store.values !== "function" || typeof store.apply !== "function") continue;
					const values = store.values();
					const catalog = values !== null && values !== undefined ? values.subagentCatalog : undefined;
					if (!Array.isArray(catalog)) continue;
					const kept = catalog.filter((entry) => entry !== null && entry !== undefined && !hidden.has(String(entry.id)));
					if (kept.length === catalog.length) continue;
					const seq = typeof store.seqOf === "function" ? (store.seqOf("subagentCatalog") ?? 0) : 0;
					try { store.apply("subagentCatalog", kept, seq + 1); touched = true; } catch (error) { /* 只读 store 就跳过 */ }
				}
				if (touched) {
					try { if (manager.notifier !== undefined && manager.notifier !== null && typeof manager.notifier.markDirty === "function") manager.notifier.markDirty(); } catch (error) { /* ignore */ }
				}
				return touched;
			}

			/** 诊断用：把内部能力挂到 window，方便在控制台核对（不影响功能）。 */
			try {
				window.__subagentReaper = {
					hasSessions: sessionsSvc !== undefined && sessionsSvc !== null,
					hasManager: sessionsSvc !== undefined && sessionsSvc !== null && sessionsSvc.manager !== undefined && sessionsSvc.manager !== null,
					hasStores: sessionsSvc !== undefined && sessionsSvc !== null && sessionsSvc.manager !== undefined && sessionsSvc.manager !== null && sessionsSvc.manager.projectionStores instanceof Map,
					patchCatalog,
					stores: () => {
						const out = [];
						const m = sessionsSvc !== undefined && sessionsSvc !== null ? sessionsSvc.manager : undefined;
						if (m === undefined || m === null || !(m.projectionStores instanceof Map)) return out;
						for (const [id, store] of m.projectionStores) {
							const v = typeof store.values === "function" ? store.values() : {};
							const cat = v !== null && v !== undefined ? v.subagentCatalog : undefined;
							out.push({ id, catalog: Array.isArray(cat) ? cat.map((e) => String(e.id)) : null });
						}
						return out;
					},
				};
			} catch (error) { /* ignore */ }

			/** 图标：优先官方 primitives，拿不到退回 emoji。 */
			function iconNode(size) {
				const name = "IconUsersOutlineRegular";
				if (UI !== null && UI !== undefined && UI[name] !== undefined) {
					try { return react.createElement(UI[name], { size }); } catch (error) { /* fall through */ }
				}
				return react.createElement("span", { style: { fontSize: String(size) + "px", lineHeight: 1 } }, "🧹");
			}

			function Reaper(props) {
				const parentId = props !== null && props !== undefined && props.sessionId !== undefined ? String(props.sessionId) : "";
				/**
				 * 面板开合/页签存在模块级：宿主在会话列表刷新后可能重建页头 slot，
				 * 组件一旦重挂载，useState 会回到默认值，面板就"自己关了"。
				 * 用模块级变量兜住，重挂载后仍保持用户刚才的状态。
				 */
				const [open, setOpenState] = react.useState(persist.open);
				const [scope, setScopeState] = react.useState(persist.scope);
				const setOpen = (next) => { persist.open = next; setOpenState(next); };
				const setScope = (next) => { persist.scope = next; setScopeState(next); };
				const [rows, setRows] = react.useState([]);
				const [groups, setGroups] = react.useState([]);
				const [reaped, setReaped] = react.useState([]);
				/** 两个页签各自记「是否已读过」，否则切到「全部会话」会先闪一句「没有任何会话留下子代理」。 */
				const [loadedChild, setLoadedChild] = react.useState(false);
				const [loadedAny, setLoadedAny] = react.useState(false);
				const [busy, setBusy] = react.useState("");
				const [note, setNote] = react.useState("");
				const [syncNote, setSyncNote] = react.useState("");
				const btnRef = react.useRef(null);
				const [pos, setPos] = react.useState(null);

				/** 面板用 fixed 定位，坐标由按钮矩形算出（并夹在视口内，避免右侧溢出）。 */
				const place = react.useCallback(() => {
					const node = btnRef.current;
					if (node === null || node === undefined) return;
					const rect = node.getBoundingClientRect();
					const width = 380;
					const margin = 8;
					const maxLeft = Math.max(margin, window.innerWidth - width - margin);
					const left = Math.min(Math.max(margin, rect.right - width), maxLeft);
					const top = Math.min(rect.bottom + 6, Math.max(margin, window.innerHeight - 120));
					setPos({ left, top });
				}, []);

				react.useEffect(() => {
					if (!open) return undefined;
					place();
					const onResize = () => place();
					window.addEventListener("resize", onResize);
					window.addEventListener("scroll", onResize, true);
					return () => {
						window.removeEventListener("resize", onResize);
						window.removeEventListener("scroll", onResize, true);
					};
				}, [open, place]);

				const loadReaped = react.useCallback(() => call("/reaped").then((res) => {
					const ids = res !== null && res !== undefined && res.ok === true && Array.isArray(res.ids) ? res.ids : [];
					const all = res !== null && res !== undefined && res.ok === true && Array.isArray(res.all) ? res.all : ids;
					setReaped(ids);
					// 隐藏名单里的 id 也要从客户端投影里摘掉，否则页头「N 个子智能体」不会变。
					patchCatalog(all);
					return null;
				}).catch(() => null), []);

				const refresh = react.useCallback((which) => {
					const mode = which === undefined ? scope : which;
					// 先读回收名单并改写客户端投影，再拉列表：顺序反了页头计数会闪一下旧值。
					return loadReaped().then(() => {
						if (mode === "any") {
							return call("/all").then((res) => {
								const list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.groups) ? res.groups : [];
								setGroups(list);
								setLoadedAny(true);
								if (res !== null && res !== undefined && res.ok === false) setNote("读取失败：" + String(res.reason));
								return null;
							}).catch(() => { setGroups([]); setLoadedAny(true); setNote("读取失败"); return null; });
						}
						if (parentId === "") { setLoadedChild(true); return Promise.resolve(null); }
						return call("/list", { parentId }).then((res) => {
							const list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.children) ? res.children : [];
							setRows(list);
							setLoadedChild(true);
							if (res !== null && res !== undefined && res.ok === false) setNote("读取失败：" + String(res.reason));
							return null;
						}).catch(() => { setRows([]); setLoadedChild(true); setNote("读取失败"); return null; });
					});
				}, [parentId, scope, loadReaped]);

				// 挂载即读一次：徽标要在面板没打开时也能显示数量。
				react.useEffect(() => { refresh(scope); }, [refresh]);

				const after = () => syncClientState(parentId).then((state) => {
					setSyncNote(String(state));
					return refresh(scope);
				});

				const purge = (childId) => {
					setBusy(childId);
					setNote("删除中…");
					call("/purge", { body: { parentId, childId, scope } }).then((res) => {
						if (res !== null && res !== undefined && res.ok === true) {
							const n = res.count !== undefined ? Number(res.count) : 1;
							const rows = Array.isArray(res.removed) ? res.removed : [];
							const noArtifact = rows.some((row) => row !== null && row !== undefined && row.note === "no-artifact");
							setNote("已回收 " + String(n) + " 个会话" + (n > 1 ? "（含后代）" : "") + (noArtifact ? "（该子代理从未落盘，仅摘除并标记）" : ""));
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

				/** 从「已回收」栏删掉一条：行仍然隐藏，不恢复。 */
				const dismiss = (id) => {
					setBusy(String(id));
					call("/dismiss", { body: { id } }).then(() => after()).then(() => setBusy(""));
				};

				/** 清空整份「已回收」栏：同样不恢复，行继续隐藏。 */
				const clearReaped = () => {
					setBusy("#");
					setNote("清空中…");
					call("/clear-reaped", { body: {} }).then((res) => {
						const n = res !== null && res !== undefined && res.cleared !== undefined ? Number(res.cleared) : 0;
						setNote(res !== null && res !== undefined && res.ok === true ? "已清空回收记录（" + String(n) + " 个，仍保持隐藏）" : "清空失败");
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
						items.push(react.createElement("div", { key: "empty", style: S.hint }, loadedAny ? "没有任何会话留下子代理" : "读取中…"));
					} else {
						for (const group of groups) {
							const parentTitle = group.parentTitle !== undefined && group.parentTitle !== null ? String(group.parentTitle) : "";
							const parentLabel = group.parent === ""
								? "（无父会话）"
								: (parentTitle !== "" ? parentTitle : String(group.parent).replace(/^session-/, "").slice(0, 8));
							items.push(react.createElement("div", { key: "g:" + String(group.parent), style: S.groupRow, title: String(group.parent) },
								"父会话 " + parentLabel + " · " + String(group.children.length) + " 个"));
							for (const child of group.children) {
								const rowBusy = busy === String(child.id);
								const childTitle = child.title !== undefined && child.title !== null ? String(child.title) : "";
								const childLabel = childTitle !== "" ? childTitle : String(child.id).slice(0, 20);
								items.push(react.createElement("div", { key: String(child.id), style: S.row },
									react.createElement("span", { style: S.name, title: String(child.id) }, childLabel),
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
					items.push(react.createElement("div", { key: "empty", style: S.hint }, loadedChild ? "当前会话没有子代理" : "读取中…"));
				} else {
					idleCount = rows.filter((row) => row.activity !== "running").length;
					for (const row of rows) {
						const rowTitle = row.title !== undefined && row.title !== null ? String(row.title) : "";
						const title = rowTitle !== "" ? rowTitle : (row.label !== "" ? row.label : String(row.id).slice(0, 20));
						const rowBusy = busy === String(row.id);
						const meta = row.diagnostic === true
							? "目录损坏（" + String(row.reason) + "）"
							: (row.mode === "continuable" ? "可续接" : (row.mode === "external" ? "外部" : "一次性")) + " · " + (row.activity === "running" ? "运行中" : "空闲");
						items.push(react.createElement("div", { key: String(row.id), style: S.row },
							react.createElement("span", { style: S.name, title: String(row.id) }, title),
							rowBusy
								? busyNode("s")
								: react.createElement("span", { style: row.activity === "running" ? S.metaRunning : S.metaIdle }, meta),
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
					react.createElement("button", { type: "button", style: scope === "child" ? S.chipHot : S.chip, disabled: busy !== "", onClick: () => { setScope("child"); setNote(""); refresh("child"); } }, "当前会话"),
					react.createElement("button", { type: "button", style: scope === "any" ? S.chipHot : S.chip, disabled: busy !== "", onClick: () => { setScope("any"); setNote(""); refresh("any"); } }, "全部会话"));

				const footNote = busy === "*" ? "清理中…" : (note !== "" ? note : "删除后页头与侧栏计数会同步刷新");
				const reapedRows = [];
				if (reaped.length > 0) {
					reapedRows.push(react.createElement("div", { key: "rh", style: S.reapedHead, title: "这些子代理的会话数据已删除，只是从列表里隐藏；删掉记录不会让它们回来" },
						react.createElement("span", { key: "t", style: S.reapedTitle }, "已回收 " + String(reaped.length) + " 个"),
						react.createElement("button", {
							key: "clear",
							type: "button",
							style: busy === "#" ? Object.assign({}, S.smallChip, { opacity: 0.4, cursor: "default" }) : S.smallChip,
							title: "清空这份回收记录（数据已删除，不会恢复）",
							disabled: busy !== "",
							onClick: clearReaped,
						}, busy === "#" ? "清空中…" : "清空")));
					const chips = [];
					for (const id of reaped.slice(-12)) {
						const rowBusy = busy === String(id);
						chips.push(react.createElement("span", {
							key: "r:" + String(id),
							style: rowBusy ? Object.assign({}, S.reapedChip, { opacity: 0.4 }) : S.reapedChip,
							title: "已回收：" + String(id),
						},
						react.createElement("span", { key: "n", style: S.reapedChipText }, String(id).slice(0, 8)),
						react.createElement("button", {
							key: "x",
							type: "button",
							style: S.reapedChipX,
							title: "从回收记录里删掉这条（不会恢复该子代理）",
							disabled: busy !== "",
							onClick: () => dismiss(String(id)),
						}, "✕")));
					}
					reapedRows.push(react.createElement("div", { key: "rc", style: { display: "flex", flexWrap: "wrap", gap: "4px", padding: "4px 6px 0" } }, chips));
				}
				const foot = react.createElement("div", { key: "foot", style: S.foot }, [
					react.createElement("div", { key: "note", style: S.note, title: footNote }, busy === "*" ? [spinner(), " 清理中…"] : footNote),
					syncNote === "" ? null : react.createElement("div", { key: "sync", style: S.note, title: syncNote }, "同步 " + syncNote),
					react.createElement("div", { key: "act", style: S.actRow },
						react.createElement("button", { type: "button", style: S.chip, disabled: busy !== "" || idleCount === 0, onClick: purgeIdle }, busy === "*" ? "清理中…" : "清理全部空闲")),
				].concat(reapedRows));

				const count = scope === "child" ? rows.length : groups.reduce((sum, group) => sum + group.children.length, 0);
				const label = "子代理回收：列出并删除子代理会话";
				const kids = [react.createElement("button", {
					key: "btn",
					ref: btnRef,
					type: "button",
					style: open ? S.iconHot : S.icon,
					title: label,
					"aria-label": label,
					"aria-expanded": open ? "true" : "false",
					onClick: () => { const next = !open; setOpen(next); if (next) { place(); refresh(scope); } },
				},
				iconNode(16),
				(scope === "child" ? loadedChild : loadedAny) && count > 0 ? react.createElement("span", { key: "b", style: S.badge }, String(count)) : null)];
				if (open) {
					const panelStyle = pos === null ? Object.assign({}, S.panel, { visibility: "hidden" }) : Object.assign({}, S.panel, { left: String(pos.left) + "px", top: String(pos.top) + "px" });
					kids.push(react.createElement("div", { key: "panel", style: panelStyle }, [tabs].concat(items, [foot])));
				}
				return react.createElement("div", { style: S.wrap }, kids);
			}

			slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "subagent-reaper", order: 50, label: "子代理回收" },
				Reaper,
			));
		}

		const inject = ["slots", "sessions"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
