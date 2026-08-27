window.__ModuleLoader__.load({
	id: "dsh-token-usage-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region dsh-token-usage-hud client
		/** Services required by the browser half. */
		const inject = ["sessions"];
		const API_PATH = "/api/token-usage/stats";
		const STORAGE_KEY = "dsh-token-usage-hud.hidden";
		const POS_KEY = "dsh-token-usage-hud.pos";
		const DEFAULT_POLL_MS = 1500;

		function resolveClientConfig(config) {
			const cfg = config ?? {};
			return {
				pollMs: typeof cfg.pollMs === "number" && Number.isFinite(cfg.pollMs) && cfg.pollMs >= 300 ? Math.round(cfg.pollMs) : DEFAULT_POLL_MS,
				position: cfg.position === "top-center" || cfg.position === "bottom-right" ? cfg.position : "top-right",
				currency: cfg.currency === "USD" ? "USD" : "CNY",
				visible: cfg.visible !== false
			};
		}

		/** Read the persisted dragged position, or null when absent/invalid. */
		function readSavedPos() {
			try {
				const raw = localStorage.getItem(POS_KEY);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object" && typeof parsed.left === "number" && typeof parsed.top === "number" && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
					return { left: parsed.left, top: parsed.top };
				}
			} catch {}
			return null;
		}

		function writeSavedPos(left, top) {
			try {
				localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
			} catch {}
		}

		function clearSavedPos() {
			try {
				localStorage.removeItem(POS_KEY);
			} catch {}
		}

		function fmtTokens(n) {
			if (!Number.isFinite(n) || n <= 0) return "0";
			if (n >= 1e6) return trimZero((n / 1e6).toFixed(2)) + "M";
			if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + "k";
			return String(Math.round(n));
		}

		function trimZero(s) {
			return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
		}

		function fmtMoney(value, currency) {
			const v = Number.isFinite(value) ? value : 0;
			const symbol = currency === "USD" ? "$" : "¥";
			if (v === 0) return symbol + "0";
			let s;
			if (Math.abs(v) >= 100) s = v.toFixed(2);
			else if (Math.abs(v) >= 1) s = v.toFixed(3);
			else s = v.toPrecision(3);
			return symbol + trimZero(s);
		}

		function apply(ctx, config) {
			const options = resolveClientConfig(config);
			ctx.effect(() => {
				let timer = null;
				let unsubList = null;
				let root = null;
				let pill = null;
				let dataEl = null;
				let currentId = null;
				let lastSteps = -1;
				let disposed = false;

				const hidden = () => {
					try {
						return localStorage.getItem(STORAGE_KEY) === "1";
					} catch {
						return false;
					}
				};

				(() => {
					const css = [
						"[data-token-usage-hud=\"box\"]{position:fixed;z-index:2147483000;min-width:190px;max-width:340px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-3, rgba(15,20,26,.92));color:var(--dsw-alias-label-primary, #d8e0ea);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 6px 24px rgba(0,0,0,.28);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);user-select:none;pointer-events:auto;overflow:hidden}",
						"[data-token-usage-hud=\"box\"][data-position=\"top-right\"]{top:10px;right:12px}",
						"[data-token-usage-hud=\"box\"][data-position=\"top-center\"]{top:10px;left:50%;transform:translateX(-50%)}",
						"[data-token-usage-hud=\"box\"][data-position=\"bottom-right\"]{bottom:10px;right:12px}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"head\"]{display:flex;align-items:center;gap:8px;margin-bottom:4px;cursor:grab;touch-action:none}",
						"[data-token-usage-hud=\"box\"][data-dragging=\"true\"] [data-token-usage-hud=\"head\"],",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"head\"]:active{cursor:grabbing}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"title\"]{flex:1;font-weight:600;color:var(--dsw-alias-label-secondary, #9fb3c8);letter-spacing:.02em}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"dot\"]{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary, #37d67a);box-shadow:0 0 6px rgba(55,214,122,.7);flex:none}",
						"[data-token-usage-hud=\"box\"][data-busy=\"true\"] [data-token-usage-hud=\"dot\"]{animation:tokenUsageHudPulse 1s ease-in-out infinite}",
						"@keyframes tokenUsageHudPulse{0%,100%{opacity:1}50%{opacity:.25}}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"close\"]{appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary, #7a8ba0);cursor:pointer;font:12px/1 monospace;padding:1px 4px;border-radius:4px}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"close\"]:hover{color:var(--dsw-alias-label-primary, #d8e0ea);background:rgba(255,255,255,.08)}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"body\"]{margin:0;white-space:pre;color:inherit}",
						"[data-token-usage-hud=\"box\"] dim{color:var(--dsw-alias-label-tertiary, #7a8ba0)}",
						"[data-token-usage-hud=\"box\"] [data-token-usage-hud=\"cost\"]{color:var(--dsw-alias-brand-primary, #6ab0ff);font-weight:600}",
						"[data-token-usage-hud=\"pill\"]{position:fixed;z-index:2147483000;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-3, rgba(15,20,26,.92));color:var(--dsw-alias-label-secondary, #9fb3c8);font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.24)}",
						"[data-token-usage-hud=\"pill\"]:hover{color:var(--dsw-alias-label-primary, #d8e0ea)}"
					].join("\n");
					if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-token-usage-hud\"]") === null) {
						const tag = document.createElement("style");
						tag.dataset.plugin = "dsh-token-usage-hud";
						tag.dataset.pluginCss = "dsh-token-usage-hud";
						tag.textContent = css;
						document.head.appendChild(tag);
					}
					return css;
				})();

				const ensureVisible = () => {
					if (disposed) return;
					if (typeof document === "undefined" || document.body === null) return;
					if (!options.visible) return;
					if (hidden()) {
						showPill();
						return;
					}
					showBox();
				};

				const showPill = () => {
					if (pill === null) {
						pill = document.createElement("button");
						pill.dataset.tokenUsageHud = "pill";
						pill.textContent = "⚡ 用量";
						const saved = readSavedPos();
						if (saved !== null) {
							pill.style.left = saved.left + "px";
							pill.style.top = saved.top + "px";
						} else {
							pill.style.cssText = positionCss(options.position);
						}
						pill.addEventListener("click", () => {
							try {
								localStorage.setItem(STORAGE_KEY, "0");
							} catch {}
							hidePill();
							showBox();
						});
						document.body.appendChild(pill);
					}
				};

				const hidePill = () => {
					pill?.remove();
					pill = null;
				};

				const positionCss = (position) => {
					if (position === "top-center") return "top:10px;left:50%;transform:translateX(-50%)";
					if (position === "bottom-right") return "bottom:10px;right:12px";
					return "top:10px;right:12px";
				};

				/** 标题栏拖拽：Pointer Events + 指针捕获，松手落盘，双击复位。 */
				const attachDrag = (handle) => {
					let dragging = false;
					let startX = 0;
					let startY = 0;
					let rect = null;
					const onDown = (e) => {
						if (e.button !== undefined && e.button !== 0) return;
						dragging = true;
						startX = e.clientX;
						startY = e.clientY;
						rect = root.getBoundingClientRect();
						root.setAttribute("data-dragging", "true");
						try {
							handle.setPointerCapture(e.pointerId);
						} catch {}
						e.preventDefault();
					};
					const onMove = (e) => {
						if (!dragging || rect === null) return;
						const dx = e.clientX - startX;
						const dy = e.clientY - startY;
						const boxW = root.offsetWidth;
						const boxH = root.offsetHeight;
						const maxLeft = Math.max(0, window.innerWidth - boxW);
						const maxTop = Math.max(0, window.innerHeight - boxH);
						const left = Math.min(Math.max(rect.left + dx, 0), maxLeft);
						const top = Math.min(Math.max(rect.top + dy, 0), maxTop);
						// 拖拽后脱离配置定位，改用绝对坐标。
						root.removeAttribute("data-position");
						root.style.left = left + "px";
						root.style.top = top + "px";
					};
					const onUp = (e) => {
						if (!dragging) return;
						dragging = false;
						rect = null;
						root.removeAttribute("data-dragging");
						try {
							handle.releasePointerCapture(e.pointerId);
						} catch {}
						writeSavedPos(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
					};
					handle.addEventListener("pointerdown", onDown);
					handle.addEventListener("pointermove", onMove);
					handle.addEventListener("pointerup", onUp);
					handle.addEventListener("pointercancel", onUp);
					handle.addEventListener("dblclick", () => {
						if (root === null) return;
						clearSavedPos();
						root.removeAttribute("data-dragging");
						root.style.left = "";
						root.style.top = "";
						root.setAttribute("data-position", options.position);
					});
				};

				const showBox = () => {
					if (root === null) {
						root = document.createElement("div");
						root.dataset.tokenUsageHud = "box";
						root.setAttribute("data-position", options.position);
						const saved = readSavedPos();
						if (saved !== null) {
							// 拖拽保存的位置优先：去掉配置定位，改用绝对 left/top。
							root.removeAttribute("data-position");
							root.style.left = saved.left + "px";
							root.style.top = saved.top + "px";
						}
						const head = document.createElement("div");
						head.dataset.tokenUsageHud = "head";
						head.title = "拖拽移动 · 双击复位";
						const title = document.createElement("span");
						title.dataset.tokenUsageHud = "title";
						title.textContent = "本对话用量";
						const dot = document.createElement("span");
						dot.dataset.tokenUsageHud = "dot";
						const close = document.createElement("button");
						close.dataset.tokenUsageHud = "close";
						close.textContent = "×";
						close.title = "隐藏（刷新可恢复）";
						close.addEventListener("click", () => {
							try {
								localStorage.setItem(STORAGE_KEY, "1");
							} catch {}
							hideBox();
							showPill();
						});
						head.appendChild(title);
						head.appendChild(dot);
						head.appendChild(close);
						attachDrag(head);
						dataEl = document.createElement("pre");
						dataEl.dataset.tokenUsageHud = "body";
						dataEl.textContent = "加载中…";
						root.appendChild(head);
						root.appendChild(dataEl);
						document.body.appendChild(root);
					}
				};

				const hideBox = () => {
					root?.remove();
					root = null;
					dataEl = null;
				};

				const periodLabel = (period) => (period === "peak" ? "高峰" : "空闲");

				const render = (stats) => {
					if (root === null || dataEl === null) return;
					if (stats === null) {
						dataEl.textContent = "等待对话…";
						root.removeAttribute("data-busy");
						return;
					}
					if (!stats.exists) {
						dataEl.textContent = "会话不存在";
						root.removeAttribute("data-busy");
						return;
					}
					const lines = [];
					const t = stats.totals ?? {};
					const total = t.total ?? 0;
					lines.push(
						"输入 " + fmtTokens(t.input) +
						" · 缓存 " + fmtTokens(t.cacheRead) +
						" · 输出 " + fmtTokens(t.output)
					);
					const steps = stats.steps ?? 0;
					lines.push("总 tokens " + fmtTokens(total) + (steps > 0 ? " · " + steps + " 步" : ""));
					if (stats.hasUsage) {
						const model = Array.isArray(stats.models) && stats.models.length === 1 ? stats.models[0].model : "";
						const tags = [];
						if (model) tags.push(model);
						tags.push(periodLabel(stats.period));
						lines.push(
							"费用 <span data-token-usage-hud=\"cost\">" + fmtMoney(stats.cost, stats.currency ?? options.currency) + "</span>" +
							"  <dim>[" + tags.join(" · ") + "]</dim>"
						);
					} else {
						lines.push("费用 <span data-token-usage-hud=\"cost\">" + fmtMoney(0, options.currency) + "</span>  <dim>暂无计费用量</dim>");
						if (typeof stats.estimatedTokens === "number" && stats.estimatedTokens > 0) {
							lines.push("<dim>≈ 估算 " + fmtTokens(stats.estimatedTokens) + " tokens</dim>");
						}
					}
					// 对话框下方的上下文占用显示（与 composer 同一投影数据源）
					const ctxInfo = stats.context;
					if (ctxInfo !== null && typeof ctxInfo === "object" && typeof ctxInfo.usedTokens === "number" && ctxInfo.usedTokens > 0) {
						let line = "上下文 ~" + fmtTokens(ctxInfo.usedTokens);
						if (typeof ctxInfo.contextWindow === "number" && ctxInfo.contextWindow > 0) {
							line += " / " + fmtTokens(ctxInfo.contextWindow) + " (" + Math.min(100, Math.round(ctxInfo.usedTokens / ctxInfo.contextWindow * 100)) + "%)";
						}
						if (typeof ctxInfo.cost === "number" && ctxInfo.cost > 0) {
							line += " · ≈" + fmtMoney(ctxInfo.cost, ctxInfo.currency ?? options.currency);
						}
						lines.push("<dim>" + line + "</dim>");
					}
					dataEl.innerHTML = lines.join("\n");
					root.toggleAttribute("data-busy", (stats.steps ?? 0) !== lastSteps && (stats.steps ?? 0) > 0);
					lastSteps = stats.steps ?? 0;
				};

				const poll = async () => {
					if (disposed || root === null) return;
					if (currentId === null || currentId === undefined) {
						render(null);
						return;
					}
					let stats = null;
					try {
						const response = await fetch(API_PATH + "?session=" + encodeURIComponent(currentId), { cache: "no-store" });
						if (response.ok) {
							const body = await response.json();
							if (body !== null && typeof body === "object") stats = body;
						}
					} catch (error) {
						console.debug("[dsh-token-usage-hud] poll degraded:", error);
					}
					if (disposed) return;
					if (stats === null) {
						if (dataEl !== null) dataEl.textContent = "用量服务不可用";
						return;
					}
					render(stats);
				};

				const refresh = () => {
					const sessions = ctx.get("sessions");
					let next = null;
					try {
						next = sessions?.list?.getSnapshot?.()?.current ?? null;
					} catch {
						next = null;
					}
					if (next !== currentId) {
						currentId = next;
						lastSteps = -1;
						if (root !== null && dataEl !== null) dataEl.textContent = "加载中…";
					}
					if (disposed) return;
					ensureVisible();
					poll();
				};

				try {
					const sessions = ctx.get("sessions");
					unsubList = sessions?.list?.subscribe?.(refresh) ?? null;
				} catch (error) {
					console.debug("[dsh-token-usage-hud] list subscribe degraded:", error);
				}
				if (!options.visible) {
					// configured off: nothing to show
					return () => {
						disposed = true;
						clearInterval(timer);
						unsubList?.();
						hideBox();
						hidePill();
					};
				}
				timer = setInterval(refresh, options.pollMs);
				refresh();
				return () => {
					disposed = true;
					clearInterval(timer);
					unsubList?.();
					hideBox();
					hidePill();
					try {
						if (document.querySelector("style[data-plugin-css=\"dsh-token-usage-hud\"]") !== null) {
							document.querySelector("style[data-plugin-css=\"dsh-token-usage-hud\"]").remove();
						}
					} catch {}
				};
			}, "dsh-token-usage-hud: overlay");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
