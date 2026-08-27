// dsh-token-usage-hud — host half.
//
// Computes per-session token consumption and an estimated monetary cost from
// the durable session log (provider-reported usage on assistant/message
// events, attributed to the model in force from request/header), and exposes
// a loopback-fenced JSON route for the browser overlay to poll.
//
// Pure fold functions are exported separately so the accounting can be tested
// against a real session log without booting a host.

// ---------------------------------------------------------------------------
// Pure fold: durable session log -> usage buckets per model
// ---------------------------------------------------------------------------

/**
 * Whether `date` falls in DeepSeek's peak-priced hours (Beijing time):
 * Monday-Friday 09:00-12:00 and 14:00-18:00; everything else is off-peak.
 * @param date - instant to classify.
 */
export function isPeakHour(date) {
	const instant = date instanceof Date ? date : new Date(date);
	let weekday;
	let hour;
	try {
		const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(instant);
		weekday = parts.find((part) => part.type === "weekday")?.value;
		hour = Number(parts.find((part) => part.type === "hour")?.value);
	} catch {
		// Fallback: manual UTC+8 shift.
		const shifted = new Date(instant.getTime() + 8 * 3600e3);
		weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][shifted.getUTCDay()];
		hour = shifted.getUTCHours();
	}
	if (weekday === "Sat" || weekday === "Sun") return false;
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** New empty fold state for one session. */
export function createFold() {
	return {
		consumed: 0,
		model: undefined,
		provider: undefined,
		byModel: new Map(),
		// Per (model, billing period) buckets for peak/off-peak priced billing.
		byModelPeriod: new Map(),
		steps: 0
	};
}

function bucketFor(fold, model) {
	let record = fold.byModel.get(model);
	if (record === undefined) {
		record = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, steps: 0 };
		fold.byModel.set(model, record);
	}
	return record;
}

function periodBucketFor(fold, model, period) {
	const key = model + "\u0000" + period;
	let record = fold.byModelPeriod.get(key);
	if (record === undefined) {
		record = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		fold.byModelPeriod.set(key, record);
	}
	return record;
}

/** Fold one session event onto the state. Mutates `fold`; returns it. */
export function foldEvent(fold, event) {
	if (event === null || typeof event !== "object" || typeof event.type !== "string") return fold;
	const data = event.data;
	switch (event.type) {
		case "request/header": {
			const config = data?.header?.config;
			if (config !== undefined && config !== null && typeof config.model === "string" && config.model.length > 0) {
				fold.model = config.model;
				fold.provider = typeof config.provider === "string" ? config.provider : fold.provider;
			}
			break;
		}
		case "request/context": {
			if (data !== undefined && data !== null && typeof data.model === "string" && data.model.length > 0) {
				fold.model = data.model;
				fold.provider = typeof data.provider === "string" ? data.provider : fold.provider;
			}
			break;
		}
		case "assistant/message": {
			const usage = data?.usage;
			if (usage !== undefined && usage !== null && typeof usage === "object") {
				const model = fold.model ?? "unknown";
				const record = bucketFor(fold, model);
				record.input += safeNum(usage.inputTokens);
				record.cacheRead += safeNum(usage.cacheReadTokens);
				record.cacheWrite += safeNum(usage.cacheWriteTokens);
				record.output += safeNum(usage.outputTokens);
				record.steps += 1;
				fold.steps += 1;
				// Billing bucket by the instant the step completed: DeepSeek
				// prices peak vs off-peak hours differently (2x).
				const period = isPeakHour(event.time ?? Date.now()) ? "peak" : "offpeak";
				const periodRecord = periodBucketFor(fold, model, period);
				periodRecord.input += safeNum(usage.inputTokens);
				periodRecord.cacheRead += safeNum(usage.cacheReadTokens);
				periodRecord.cacheWrite += safeNum(usage.cacheWriteTokens);
				periodRecord.output += safeNum(usage.outputTokens);
			}
			break;
		}
		default:
			break;
	}
	return fold;
}

function safeNum(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Catch a session's fold up to its current durable tail (idempotent: each
 * event is folded exactly once). `events` must be the session's event log.
 */
export function syncFold(fold, events) {
	const list = Array.isArray(events) ? events : [];
	while (fold.consumed < list.length) {
		foldEvent(fold, list[fold.consumed]);
		fold.consumed += 1;
	}
	return fold;
}

/**
 * Heuristic surface-token estimate (chars/4 + per-message overhead), mirroring
 * the dsh-token-meter estimator. Used only when the provider has not reported
 * usage yet — a "≈" figure, never a billing record.
 */
export function estimateSessionTokens(events) {
	const list = Array.isArray(events) ? events : [];
	let total = 0;
	for (const event of list) {
		const data = event?.data;
		let chars = 0;
		switch (event?.type) {
			case "user/message":
				chars = contentChars(data?.content);
				break;
			case "assistant/message":
				chars = contentChars(data?.message?.content);
				break;
			default:
				continue;
		}
		total += Math.ceil(chars / 4) + 4;
	}
	return total;
}

/** Count characters of content blocks (text/reasoning/tool-call/tool-result). */
function contentChars(blocks) {
	if (!Array.isArray(blocks)) return 0;
	let chars = 0;
	for (const block of blocks) {
		if (block === null || typeof block !== "object") continue;
		switch (block.type) {
			case "text":
			case "reasoning":
				chars += typeof block.text === "string" ? block.text.length : 0;
				break;
			case "tool-call":
				chars += typeof block.name === "string" ? block.name.length : 0;
				chars += typeof block.arguments === "string" ? block.arguments.length : 0;
				break;
			case "tool-result":
				chars += contentChars(block.content);
				break;
			default:
				try {
					chars += JSON.stringify(block).length;
				} catch {
					/* ignore non-serializable residue */
				}
		}
	}
	return chars;
}

/**
 * Normalize one price entry into the two billing periods. Accepts both the
 * flat form `{input, cacheRead, cacheWrite, output}` (both periods equal) and
 * the DeepSeek V4 form `{peak: {...}, offpeak: {...}}` (a missing period
 * mirrors the other). Missing cacheWrite defaults to cacheRead.
 */
function normalizePriceEntry(entry, fallback) {
	const source = entry ?? fallback;
	if (source === undefined) return undefined;
	const norm = (part) => ({
		input: safeNum(part.input),
		cacheRead: safeNum(part.cacheRead),
		cacheWrite: safeNum(part.cacheWrite ?? part.cacheRead),
		output: safeNum(part.output)
	});
	if (source.peak !== undefined || source.offpeak !== undefined) {
		const peak = norm(source.peak ?? source.offpeak ?? {});
		const offpeak = norm(source.offpeak ?? source.peak ?? {});
		return { peak, offpeak };
	}
	const both = norm(source);
	return { peak: both, offpeak: both };
}

/** Resolve the price for (model, period), falling back to the default entry. */
function priceForPeriod(table, model, period) {
	const entry = normalizePriceEntry(table?.[model]) ?? normalizePriceEntry(table?.default);
	return entry === undefined ? undefined : entry[period];
}

/**
 * Finalize a fold into the wire stats: totals + per-model breakdown + cost.
 * Cost is billed per (model, billing period) bucket against the peak/off-peak
 * price table, so historical tokens are charged at the rate in force at the
 * time the step completed.
 * @param fold - folded session state.
 * @param prices - config price table: modelId -> flat or {peak, offpeak} entry,
 *   plus optional `default`; CNY per 1M tokens.
 * @param currency - "CNY" | "USD" | other label.
 * @param now - instant used for the response's current `period` label.
 */
export function finalizeFold(fold, prices, currency, now = new Date()) {
	const table = prices ?? {};
	const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const perModelCost = new Map();
	let cost = 0;
	for (const [key, record] of fold.byModelPeriod) {
		const sep = key.indexOf("\u0000");
		const model = key.slice(0, sep);
		const period = key.slice(sep + 1);
		const price = priceForPeriod(table, model, period);
		if (price === undefined) continue;
		const bucketCost = record.input / 1e6 * price.input
			+ record.cacheRead / 1e6 * price.cacheRead
			+ record.cacheWrite / 1e6 * price.cacheWrite
			+ record.output / 1e6 * price.output;
		perModelCost.set(model, (perModelCost.get(model) ?? 0) + bucketCost);
		cost += bucketCost;
	}
	const models = [];
	for (const [model, record] of fold.byModel) {
		totals.input += record.input;
		totals.cacheRead += record.cacheRead;
		totals.cacheWrite += record.cacheWrite;
		totals.output += record.output;
		models.push({
			model,
			input: record.input,
			cacheRead: record.cacheRead,
			cacheWrite: record.cacheWrite,
			output: record.output,
			steps: record.steps,
			cost: roundCost(perModelCost.get(model) ?? 0)
		});
	}
	return {
		currency,
		// Current billing period at the time of the request (display label).
		period: isPeakHour(now) ? "peak" : "offpeak",
		hasUsage: fold.steps > 0,
		steps: fold.steps,
		totals: {
			...totals,
			total: totals.input + totals.cacheRead + totals.cacheWrite + totals.output
		},
		cost: roundCost(cost),
		models
	};
}

function roundCost(value) {
	return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

const name = "dsh-token-usage-hud";
const inject = ["webServer", "sessions"];
const API_PATH = "/api/token-usage/stats";
const MOUNTED = Symbol.for("dsh-token-usage-hud.mounted");

/** Host single-instance guard (the web-ui family pattern): a second mount is a no-op. */
function mountOnce(packageName, fn) {
	return (...args) => {
		const registry = globalThis;
		const mounted = registry[MOUNTED] ??= new Set();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		args[0]?.effect?.(() => () => {
			mounted.delete(packageName);
		});
		return fn(...args);
	};
}

export function resolveConfig(config) {
	const cfg = config ?? {};
	const currency = cfg.currency === "USD" ? "USD" : "CNY";
	const position = cfg.position === "top-center" || cfg.position === "bottom-right" ? cfg.position : "top-right";
	const pollMs = typeof cfg.pollMs === "number" && Number.isFinite(cfg.pollMs) && cfg.pollMs >= 300 ? Math.round(cfg.pollMs) : 1500;
	const visible = cfg.visible !== false;
	const rawPrices = cfg.prices !== undefined && cfg.prices !== null && typeof cfg.prices === "object" ? cfg.prices : {};
	const prices = {};
	for (const [key, entry] of Object.entries(rawPrices)) {
		if (entry !== null && typeof entry === "object") prices[key] = entry;
	}
	const rawBalance = cfg.balance !== undefined && cfg.balance !== null && typeof cfg.balance === "object" ? cfg.balance : {};
	const balance = {
		enabled: rawBalance.enabled !== false,
		refreshMs: typeof rawBalance.refreshMs === "number" && Number.isFinite(rawBalance.refreshMs) && rawBalance.refreshMs >= 5000 ? Math.round(rawBalance.refreshMs) : 30000,
		apiKeyEnv: typeof rawBalance.apiKeyEnv === "string" && rawBalance.apiKeyEnv.length > 0 ? rawBalance.apiKeyEnv : "DEEPSEEK_API_KEY",
		baseURL: typeof rawBalance.baseURL === "string" && rawBalance.baseURL.length > 0 ? rawBalance.baseURL.replace(/\/+$/u, "") : "https://api.deepseek.com"
	};
	return { enabled: cfg.enabled !== false, currency, position, pollMs, visible, prices, balance };
}

// ---------------------------------------------------------------------------
// Account balance (DeepSeek GET /user/balance, host-side only)
// ---------------------------------------------------------------------------

/** Resolve the balance API key through the credentials service (env-inherited
 *  managed store), falling back to the process environment. The key never
 *  leaves the host: only the balance numbers cross the loopback route. */
async function resolveBalanceApiKey(ctx, ref) {
	try {
		const credentials = ctx.get?.("credentials");
		if (credentials !== undefined) {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined && hit !== null && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
		}
	} catch {
		/* fall through to env */
	}
	try {
		const ambient = process.env[ref];
		if (typeof ambient === "string" && ambient.length > 0) return ambient;
	} catch {
		/* ignore */
	}
	return undefined;
}

/** One balance fetch (no caching). Returns a normalized value or an error
 *  envelope; never throws. */
async function fetchBalance(ctx, options) {
	try {
		const key = await resolveBalanceApiKey(ctx, options.balance.apiKeyEnv);
		if (key === undefined) return { error: "no-api-key" };
		const response = await fetch(`${options.balance.baseURL}/user/balance`, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
			signal: AbortSignal.timeout(10000)
		});
		if (!response.ok) return { error: `http ${response.status}` };
		const body = await response.json();
		if (body === null || typeof body !== "object") return { error: "bad-response" };
		const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
		const info = infos.find((entry) => entry !== null && typeof entry === "object" && typeof entry.currency === "string")
			?? infos[0];
		return {
			isAvailable: body.is_available === true,
			currency: info !== undefined && info !== null && typeof info.currency === "string" ? info.currency : "CNY",
			total: info !== undefined && info !== null ? safeNum(Number(info.total_balance)) : 0,
			granted: info !== undefined && info !== null ? safeNum(Number(info.granted_balance)) : 0,
			toppedUp: info !== undefined && info !== null ? safeNum(Number(info.topped_up_balance)) : 0,
			fetchedAt: Date.now()
		};
	} catch (error) {
		return { error: error instanceof Error ? error.name : String(error) };
	}
}

/**
 * Cached balance reader: one in-flight promise is shared (no stampede), and a
 * successful value is served for `balance.refreshMs` before refetching.
 */
async function getBalanceCached(ctx, options, cache) {
	const now = Date.now();
	if (cache.value !== undefined && cache.value.error === undefined && now - cache.fetchedAt < options.balance.refreshMs) {
		return cache.value;
	}
	if (cache.inflight !== undefined) return cache.inflight;
	const promise = fetchBalance(ctx, options).then((value) => {
		cache.inflight = undefined;
		cache.fetchedAt = Date.now();
		if (value.error === undefined) cache.value = value;
		return value;
	}).catch((error) => {
		cache.inflight = undefined;
		return { error: error instanceof Error ? error.name : String(error) };
	});
	cache.inflight = promise;
	return promise;
}

const apply = mountOnce(name, (ctx, config) => {
	const options = resolveConfig(config);
	// Per-session fold state, keyed by session id (the Session object is not
	// stable across restarts; the id is). Session objects are re-synced lazily
	// from their durable log on read, so events emitted before this plugin
	// mounted are accounted too.
	const states = new Map();
	const balanceCache = { value: undefined, fetchedAt: 0, inflight: undefined };
	const upsert = (session) => {
		let state = states.get(session.id);
		if (state === undefined) {
			state = { fold: createFold(), session };
			states.set(session.id, state);
		}
		syncFold(state.fold, session.events);
		return state;
	};

	let disposers = [];
	// cordis ctx.effect runs its callback immediately and registers the
	// RETURNED function as the fiber-unload disposer; the outer arrow must
	// therefore return the disposer instead of disposing inline. Registered
	// first so a later setup failure still cleans up whatever was attached.
	ctx.effect(() => () => {
		for (const dispose of disposers) {
			try {
				dispose();
			} catch {
				/* disposal is best-effort */
			}
		}
		disposers = [];
	}, `${name}: host runtime`);

	if (!options.enabled) {
		ctx.logger?.info?.("[dsh-token-usage-hud] disabled by config");
		return;
	}

	// Seed sessions that already exist, then keep folding live events.
	try {
		for (const session of ctx.sessions.list()) upsert(session);
	} catch (error) {
		ctx.logger?.warn?.("[dsh-token-usage-hud] session seed failed:", error);
	}
	const offEvent = ctx.on("session/event", (session) => {
		if (session === undefined || session === null || typeof session.id !== "string") return;
		try {
			// session/event fires after the event is already in the durable log,
			// so the incremental sync folds exactly the new event (no double count).
			upsert(session);
		} catch (error) {
			ctx.logger?.warn?.("[dsh-token-usage-hud] fold failed:", error);
		}
	});
	disposers.push(offEvent);

	const route = ctx.webServer.register({
		kind: "exact",
		path: API_PATH,
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) {
				writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
				return;
			}
			let sessionId;
			try {
				sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("session") ?? "";
			} catch {
				sessionId = "";
			}
			if (sessionId === "") {
				writeJson(res, 400, { ok: false, error: "missing session id" });
				return;
			}
			let session;
			try {
				session = ctx.sessions.get(sessionId);
			} catch {
				session = undefined;
			}
			if (session === undefined) {
				writeJson(res, 200, { ok: true, sessionId, exists: false });
				return;
			}
			try {
				const state = upsert(session);
				const events = session.events;
				const stats = finalizeFold(state.fold, options.prices, options.currency);
				const [balance, context] = await Promise.all([
					options.balance.enabled ? getBalanceCached(ctx, options, balanceCache) : Promise.resolve(null),
					Promise.resolve(readContextProjection(ctx, session, state.fold, options.prices, options.currency))
				]);
				writeJson(res, 200, {
					ok: true,
					ts: Date.now(),
					sessionId,
					exists: true,
					...stats,
					estimatedTokens: estimateSessionTokens(events),
					balance,
					// 对话框（composer）下方显示的上下文占用：直接读取 host 端的
					// contextPressure 投影（与界面同一数据源），并给出其估算费用
					// （当前模型输入单价 × 上下文 tokens，按当前时段计价）。
					context
				});
			} catch (error) {
				ctx.logger?.warn?.("[dsh-token-usage-hud] stats failed:", error);
				writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		}
	});
	disposers.push(route);
});

// ---------------------------------------------------------------------------
// Context-occupancy projection (the token figure shown below the composer)
// ---------------------------------------------------------------------------

/**
 * Read the session's `contextPressure` projection — the same data the
 * composer's occupancy meter below the dialog box renders — and price it:
 * `projectedTokens` (or `pressureTokens`) is what the NEXT request's prompt
 * would cost, billed at the current model's input rate for the current
 * billing period. Returns null when the projection is unavailable.
 */
function readContextProjection(ctx, session, fold, prices, currency) {
	try {
		const projections = ctx.get?.("sessionProjections");
		if (projections === undefined) return null;
		const snapshot = projections.snapshot(session);
		const pressure = snapshot?.values?.["contextPressure"];
		if (pressure === null || pressure === undefined || typeof pressure !== "object") return null;
		const usedTokens = typeof pressure.projectedTokens === "number"
			? pressure.projectedTokens
			: typeof pressure.pressureTokens === "number"
				? pressure.pressureTokens
				: null;
		const model = fold.model ?? "unknown";
		const period = isPeakHour(new Date()) ? "peak" : "offpeak";
		const price = priceForPeriod(prices ?? {}, model, period);
		return {
			usedTokens,
			pressureTokens: typeof pressure.pressureTokens === "number" ? pressure.pressureTokens : null,
			projectedTokens: typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : null,
			contextWindow: typeof pressure.contextWindow === "number" ? pressure.contextWindow : null,
			period,
			model,
			currency,
			cost: usedTokens !== null && price !== undefined ? roundCost(usedTokens / 1e6 * price.input) : 0
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers (loopback fence + JSON writer), same discipline as dsh-perf
// ---------------------------------------------------------------------------

function isIPv4Loopback(parts) {
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isLoopbackAddress(address) {
	if (address === undefined) return false;
	const normalized = String(address).toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7).split("."));
	return isIPv4Loopback(normalized.split("."));
}

function isLoopbackHostname(hostname) {
	return hostname === "localhost" || hostname === "[::1]" || isIPv4Loopback(hostname.split("."));
}

function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers?.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers?.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}

export { name, inject, apply };
