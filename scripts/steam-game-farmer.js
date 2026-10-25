(async () => {
    "use strict";

    if (window.__gfLock) {
        try { document.getElementById("gf-stop")?.click(); } catch (_) { }
        document.querySelectorAll("#gf-ui, #gf-styles").forEach(e => e.remove());
        window.__gfLock = false;
        await new Promise(r => setTimeout(r, 400));
    }
    window.__gfLock = true;

    const CONFIG = {
        NAME: "Steam Game Farmer",
        VERSION: "v3.3",
        MAX_LOG: 60,
        CACHE_KEY: "gf_games_cache_v4",
        CACHE_TTL: 24 * 60 * 60 * 1000,
        PLAYED_KEY: "gf_played_v3",
        BANNED_KEY: "gf_banned_v1",
        MANUAL_KEY: "gf_manual_v1",
        SETTINGS_KEY: "gf_settings_v1",
        STATS_KEY: "gf_stats_v1",
        EXCLUDE: /(?:\bsoundtrack\b|\bdemo\b|\bplaytest\b|\bdedicated server\b|\bsdk\b|\bbenchmark\b|\bbeta\b)/i
    };

    const SYS = {
        MIN_DUR: 15,
        MAX_DUR: 7200,
        PRESENCE_BEAT: 45000,
        PATCH_BEAT: 5000,
        SETTINGS_BEAT: 60000,
        FETCH_ATTEMPTS: 4,
        RETRY_BASE: 2000,
        TICK: 200,
        LIST_LIMIT: 80,
        HISTORY_LIMIT: 40
    };

    const RT = {
        running: true,
        duration: 90,
        durationMax: 180,
        randomDuration: false,
        target: 50,
        gap: 5,
        maxMinutes: 0,
        shuffle: true,
        sound: true,
        skipPlayed: true,
        notify: false,
        loop: false,
        played: new Set(),
        banned: new Set(),
        selection: null,
        stats: { played: 0, minutes: 0 },
        prevShowGame: null,
        prevRecentGames: null,
        sessionStart: Date.now()
    };

    const CTL = {
        skip: false,
        paused: false,
        extend: 0,
        ban: false
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const fmt = sec => {
        const min = Math.round(sec / 60);
        return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
    };
    const clock = sec => {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };

    const store = {
        read(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (_) {
                return fallback;
            }
        },
        write(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { }
        },
        drop(key) {
            try { localStorage.removeItem(key); } catch (_) { }
        }
    };

    const saveSettings = () => store.write(CONFIG.SETTINGS_KEY, {
        duration: RT.duration,
        durationMax: RT.durationMax,
        randomDuration: RT.randomDuration,
        target: RT.target,
        gap: RT.gap,
        maxMinutes: RT.maxMinutes,
        shuffle: RT.shuffle,
        sound: RT.sound,
        skipPlayed: RT.skipPlayed,
        notify: RT.notify,
        loop: RT.loop
    });

    const saved = store.read(CONFIG.SETTINGS_KEY, null);
    if (saved && typeof saved === "object") {
        for (const key of ["duration", "durationMax", "target", "gap", "maxMinutes"]) {
            if (Number.isFinite(saved[key])) RT[key] = saved[key];
        }
        for (const key of ["randomDuration", "shuffle", "sound", "skipPlayed", "notify", "loop"]) {
            if (typeof saved[key] === "boolean") RT[key] = saved[key];
        }
    }

    RT.duration = clamp(Math.round(RT.duration), 15, 7200);
    RT.durationMax = clamp(Math.round(RT.durationMax), 15, 7200);
    RT.target = clamp(Math.round(RT.target), 1, 500);
    RT.gap = clamp(Math.round(RT.gap), 0, 600);
    RT.maxMinutes = clamp(Math.round(RT.maxMinutes), 0, 1440);

    const playedRaw = store.read(CONFIG.PLAYED_KEY, []);
    if (Array.isArray(playedRaw)) playedRaw.forEach(id => RT.played.add(String(id)));

    const bannedRaw = store.read(CONFIG.BANNED_KEY, []);
    if (Array.isArray(bannedRaw)) bannedRaw.forEach(id => RT.banned.add(String(id)));

    const statsRaw = store.read(CONFIG.STATS_KEY, null);
    if (statsRaw && Number.isFinite(statsRaw.played) && Number.isFinite(statsRaw.minutes)) {
        RT.stats.played = statsRaw.played;
        RT.stats.minutes = statsRaw.minutes;
    }

    const Sound = {
        ctx: null,
        beep(freq = 660, dur = 0.15, vol = 0.32) {
            if (!RT.sound) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                if (!this.ctx || this.ctx.state === "closed") this.ctx = new Ctx();
                const c = this.ctx;
                if (c.state === "suspended") c.resume().catch(() => { });
                const o = c.createOscillator();
                const g = c.createGain();
                o.type = "sine";
                o.frequency.value = freq;
                o.connect(g); g.connect(c.destination);
                g.gain.setValueAtTime(vol, c.currentTime);
                g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
                o.start(); o.stop(c.currentTime + dur + 0.02);
            } catch (_) { }
        }
    };

    const ICONS = {
        LOGO: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`,
        STOP: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`,
        CHECK: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        GAME: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>`
    };

    let Mods = {};

    const getToken = () => {
        try {
            const t = Mods.UserStore?.getToken?.();
            if (t) return t;
            const l = window.localStorage?.getItem("token");
            if (l) return l.replace(/^"|"$/g, "");
        } catch (_) { }
        return null;
    };

    async function nativeFetch(method, endpoint, body) {
        const token = getToken();
        const url = endpoint.startsWith("http") ? endpoint : `/api/v9${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
        const headers = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = token;

        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;

        try {
            const res = await window.fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                credentials: "include",
                signal: ctrl ? ctrl.signal : undefined
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const e = new Error(data?.message || `HTTP ${res.status}`);
                e.status = res.status;
                e.body = data;
                throw e;
            }
            return { body: data, status: res.status };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function apiGet(url) {
        if (Mods.API?.get) {
            try {
                return await Mods.API.get({ url, trackedActionData: { properties: {} } });
            } catch (e) {
                if (e instanceof TypeError || !(e?.status || e?.statusCode)) return nativeFetch("GET", url);
                throw e;
            }
        }
        return nativeFetch("GET", url);
    }

    const isIntlProxy = o => {
        if (!o || (typeof o !== "object" && typeof o !== "function")) return false;
        try {
            if (typeof o.__proxy_test_never_exists_xyz__ === "function") return true;
            if (o.intl || o._messages || o._translations || o.defaultLocale) return true;
        } catch (_) { return true; }
        return false;
    };

    function findUserSettings(moduleCache) {
        if (!moduleCache) return null;
        let actions, BoolValue, delay = null;
        const list = moduleCache instanceof Map ? [...moduleCache.values()] : Object.values(moduleCache);
        for (const m of list) {
            try {
                const exp = m?.exports;
                if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;

                const candidates = [exp];
                try { if (exp.default) candidates.push(exp.default); } catch (_) { }
                try { candidates.push(...Object.values(exp)); } catch (_) { }

                for (const p of candidates) {
                    if (!p || (typeof p !== "object" && typeof p !== "function")) continue;
                    try {
                        if (!BoolValue && typeof p.create === "function" && String(p.typeName ?? "").includes("Bool")) {
                            BoolValue = p;
                        }
                        if (delay === null && Number.isFinite(p.INFREQUENT_USER_ACTION)) {
                            delay = p.INFREQUENT_USER_ACTION;
                        }
                        if (!actions && typeof p.updateAsync === "function" &&
                            (p.ProtoClass?.typeName?.endsWith(".PreloadedUserSettings") ||
                                String(p.ProtoClass?.typeName ?? "").includes("PreloadedUserSettings") ||
                                p.type === 1)) {
                            actions = p;
                            delay = p.UserSettingsDelay?.INFREQUENT_USER_ACTION
                                ?? exp.UserSettingsDelay?.INFREQUENT_USER_ACTION
                                ?? delay;
                        }
                    } catch (_) { }
                }
                if (actions && BoolValue) break;
            } catch (_) { }
        }
        if (!actions) return null;

        const current = () => {
            try {
                if (typeof actions.getSetting === "function") return actions.getSetting();
            } catch (_) { }
            try {
                if (typeof actions.getCurrentValue === "function") return actions.getCurrentValue();
            } catch (_) { }
            try {
                if (typeof actions.getEditInfo === "function") return actions.getEditInfo()?.proto;
            } catch (_) { }
            return null;
        };
        const read = (scope, key) => {
            try { return current()?.[scope]?.[key]?.value ?? null; } catch (_) { return null; }
        };
        const write = (scope, key, v) => actions.updateAsync(scope, s => {
            if (!s) return;
            if (s[key]) s[key].value = v;
            else if (BoolValue) s[key] = BoolValue.create({ value: v });
        }, delay ?? 0);

        return {
            get: () => read("status", "showCurrentGame"),
            set: v => write("status", "showCurrentGame", v),
            getRecent: () => read("privacy", "recentGamesEnabled"),
            setRecent: v => write("privacy", "recentGamesEnabled", v)
        };
    }

    function loadModules() {
        try {
            if (window.Vencord?.Webpack) {
                const W = window.Vencord.Webpack;
                const userSettings = findUserSettings(W.cache || W.wreq?.c);
                Mods = {
                    RunStore: W.findStore("RunningGameStore"),
                    UserStore: W.findStore("UserStore"),
                    Dispatcher: W.Common?.FluxDispatcher || W.findByProps("dispatch", "subscribe", "flushWaitQueue"),
                    API: W.Common?.RestAPI || W.findByProps("get", "post", "del"),
                    ShowCurrentGame: userSettings,
                    RecentGames: userSettings ? { get: userSettings.getRecent, set: userSettings.setRecent } : null
                };
                if (Mods.RunStore && Mods.Dispatcher) return true;
            }

            if (window.BdApi?.Webpack) {
                const B = window.BdApi.Webpack;
                Mods = {
                    RunStore: B.getStore("RunningGameStore"),
                    UserStore: B.getStore("UserStore"),
                    Dispatcher: B.getByProps("dispatch", "subscribe"),
                    API: B.getByProps("get", "post", "del"),
                    ShowCurrentGame: null,
                    RecentGames: null
                };
                if (Mods.RunStore && Mods.Dispatcher) return true;
            }

            if (typeof webpackChunkdiscord_app === "undefined") throw new Error("webpack chunk not found");

            let req;
            webpackChunkdiscord_app.push([[Symbol()], {}, r => {
                const cur = req?.c ? Object.keys(req.c).length : 0;
                const inc = r?.c ? Object.keys(r.c).length : 0;
                if (inc > cur) req = r;
            }]);
            webpackChunkdiscord_app.pop();

            if (!req?.c) throw new Error("module registry unavailable");
            const mods = Object.values(req.c);

            const pick = test => {
                for (const m of mods) {
                    try {
                        const exp = m?.exports;
                        if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
                        for (const p of [exp, exp.default, ...Object.values(exp)]) {
                            if (!p || typeof p !== "object" || isIntlProxy(p)) continue;
                            try { if (test(p)) return p; } catch (_) { }
                        }
                    } catch (_) { }
                }
                return undefined;
            };

            const storeByName = name => pick(p =>
                p.getName?.() === name ||
                p.constructor?.displayName === name ||
                p.__proto__?.constructor?.displayName === name
            );

            Mods = {
                RunStore: storeByName("RunningGameStore") || pick(p =>
                    typeof p.getRunningGames === "function" &&
                    (typeof p.getGameForPID === "function" || typeof p.getVisibleGame === "function")
                ),
                UserStore: storeByName("UserStore"),
                Dispatcher: pick(p => typeof p.dispatch === "function" && typeof p.subscribe === "function" && typeof p.unsubscribe === "function"),
                API: pick(p => typeof p.get === "function" && typeof p.post === "function" && typeof p.del === "function"),
                ShowCurrentGame: null,
                RecentGames: null
            };

            const userSettings = findUserSettings(req.c);
            if (userSettings) {
                Mods.ShowCurrentGame = userSettings;
                Mods.RecentGames = { get: userSettings.getRecent, set: userSettings.setRecent };
            }

            if (!Mods.RunStore) throw new Error("RunningGameStore not found");
            if (!Mods.Dispatcher) throw new Error("FluxDispatcher not found");
            return true;
        } catch (e) {
            console.error("[GameFarm] module load:", e);
            return false;
        }
    }

    async function loadModulesRetry() {
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (loadModules()) return true;
            if (attempt < 3) {
                UI.log(`[System] Module lookup failed, retry ${attempt}/3`, "warn");
                await sleep(2000);
            }
        }
        return false;
    }

    const Patcher = {
        games: [],
        seen: [],
        real: {},
        active: false,
        METHODS: [
            "getRunningGames",
            "getGameForPID",
            "getVisibleGame",
            "getVisibleRunningGames",
            "getRunningDiscordApplicationIds",
            "getRunningVerifiedApplicationIds",
            "getCurrentGameForAnalytics",
            "getGameForName",
            "getGamesSeen",
            "isGameSeen",
            "getCandidateGames"
        ],

        init() {
            const S = Mods.RunStore;
            this.real = {};
            if (!S) return;
            for (const n of this.METHODS) {
                if (typeof S[n] === "function") this.real[n] = S[n];
            }
        },

        merge(list) {
            const ours = this.games;
            return [...(list || []).filter(x => !ours.some(g => String(g.id) === String(x?.id))), ...ours];
        },

        history() {
            const out = this.seen.slice();
            for (const g of this.games) {
                if (!out.some(x => String(x.id) === String(g.id))) out.push(g);
            }
            return out;
        },

        mergeSeen(list) {
            const ours = this.history();
            return [...(list || []).filter(x => !ours.some(g => String(g.id) === String(x?.id))), ...ours];
        },

        apply() {
            const S = Mods.RunStore;
            if (!S) return;
            const R = this.real;

            if (R.getRunningGames) S.getRunningGames = () => this.merge(R.getRunningGames.call(S));
            if (R.getGameForPID) S.getGameForPID = pid => this.games.find(g => g.pid === pid) || R.getGameForPID.call(S, pid);
            if (R.getVisibleGame) S.getVisibleGame = () => this.games[0] ?? R.getVisibleGame.call(S);
            if (R.getVisibleRunningGames) S.getVisibleRunningGames = () => this.merge(R.getVisibleRunningGames.call(S));
            if (R.getCandidateGames) S.getCandidateGames = () => this.merge(R.getCandidateGames.call(S));
            if (R.getRunningDiscordApplicationIds) {
                S.getRunningDiscordApplicationIds = () => {
                    const ids = R.getRunningDiscordApplicationIds.call(S);
                    const ours = this.games.map(g => String(g.id));
                    return ids instanceof Set ? new Set([...ids, ...ours]) : [...(ids || []), ...ours];
                };
            }
            if (R.getRunningVerifiedApplicationIds) {
                S.getRunningVerifiedApplicationIds = () => {
                    const ids = R.getRunningVerifiedApplicationIds.call(S) || [];
                    return [...new Set([...ids, ...this.games.map(g => String(g.id))])];
                };
            }
            if (R.getCurrentGameForAnalytics) S.getCurrentGameForAnalytics = () => this.games[0] ?? R.getCurrentGameForAnalytics.call(S);
            if (R.getGameForName) {
                S.getGameForName = name => this.games.find(g => g.name.toLowerCase() === String(name ?? "").toLowerCase())
                    || R.getGameForName.call(S, name);
            }
            this.applySeen();
            this.active = true;
        },

        applySeen() {
            const S = Mods.RunStore;
            if (!S) return;
            const R = this.real;
            if (R.getGamesSeen) {
                S.getGamesSeen = (includeCurrent, sort) => {
                    const real = R.getGamesSeen.call(S, includeCurrent, sort) || [];
                    if (includeCurrent) return real;
                    const out = this.mergeSeen(real);
                    if (sort !== false) out.sort((a, b) => (b.lastFocused || 0) - (a.lastFocused || 0));
                    return out;
                };
            }
            if (R.isGameSeen) {
                S.isGameSeen = id => this.seen.some(g => String(g.id) === String(id))
                    || this.games.some(g => String(g.id) === String(id))
                    || R.isGameSeen.call(S, id);
            }
        },

        restore() {
            const S = Mods.RunStore;
            if (!S) return;
            for (const [n, fn] of Object.entries(this.real)) S[n] = fn;
            this.active = false;
        },

        add(g) {
            this.games = this.games.filter(x => x.pid !== g.pid && String(x.id) !== String(g.id));
            this.games.push(g);
            this.seen = this.seen.filter(x => String(x.id) !== String(g.id));
            this.seen.push(g);
            if (this.seen.length > 300) this.seen.splice(0, this.seen.length - 300);
            this.apply();
            this.dispatch([g], []);
            this.presence(g);
        },

        remove(g) {
            const before = this.games.length;
            this.games = this.games.filter(x => x.pid !== g.pid);
            if (this.games.length === before) return;
            if (this.games.length) this.apply();
            else {
                this.restore();
                this.applySeen();
            }
            this.dispatch([], [g]);
            this.presence(this.games[0] || null);
        },

        dispatch(added, removed) {
            try {
                Mods.Dispatcher?.dispatch({
                    type: "RUNNING_GAMES_CHANGE",
                    added,
                    removed,
                    games: Mods.RunStore?.getRunningGames?.() || []
                });
            } catch (_) { }
        },

        presence(g) {
            try {
                const inject = g && !this.real.getVisibleGame;
                Mods.Dispatcher?.dispatch({
                    type: "LOCAL_ACTIVITY_UPDATE",
                    socketId: null,
                    pid: g ? g.pid : 0,
                    applicationId: g ? String(g.id) : undefined,
                    activity: inject ? {
                        type: 0,
                        name: g.name,
                        application_id: String(g.id),
                        timestamps: { start: g.start }
                    } : null
                });
            } catch (_) { }
        },

        alive(pid) {
            try {
                return (Mods.RunStore?.getRunningGames?.() || []).some(x => x && x.pid === pid);
            } catch (_) {
                return false;
            }
        },

        clean() {
            const had = this.games;
            this.games = [];
            this.restore();
            this.dispatch([], had);
            this.presence(null);
        }
    };

    const GameSource = {
        all: [],
        manual: (() => {
            const v = store.read(CONFIG.MANUAL_KEY, []);
            return Array.isArray(v) ? v.filter(x => x && x.id && x.name) : [];
        })(),

        mergeManual() {
            for (const g of this.manual) {
                if (!this.all.some(x => String(x.id) === String(g.id))) this.all.push(g);
            }
            this.all.sort((a, b) => a.name.localeCompare(b.name));
        },

        normalize(app) {
            if (!app || !app.id || !app.name) return null;

            const name = String(app.name).trim();
            if (!name || CONFIG.EXCLUDE.test(name) || name.toLowerCase() === "steam") return null;

            const exes = Array.isArray(app.executables) ? app.executables : [];
            const win = exes.find(x => x?.os === "win32" && x?.name) || exes.find(x => x?.name);

            const skus = Array.isArray(app.third_party_skus) ? app.third_party_skus : [];
            const steam = skus.find(s => {
                const distributor = String(s?.distributor ?? "").toLowerCase();
                const key = String(s?.id ?? "").toLowerCase();
                return distributor === "steam" || key === "steam";
            });

            if (!win && !steam) return null;

            const fallbackExe = `${name.replace(/[^a-zA-Z0-9]/g, "") || "game"}.exe`;

            return {
                id: String(app.id),
                name,
                icon: app.icon || null,
                exe: win ? String(win.name).replace(/^>/, "") : fallbackExe,
                steamId: steam ? String(steam.sku ?? steam.distributor_sku ?? steam.id ?? "0") : null
            };
        },

        async load() {
            try {
                const cached = store.read(CONFIG.CACHE_KEY, null);
                if (cached && Array.isArray(cached.data) && cached.data.length > 100 &&
                    Date.now() - (cached.at || 0) < CONFIG.CACHE_TTL) {
                    this.all = cached.data;
                    this.mergeManual();
                    UI.log(`[Source] ${this.all.length} apps loaded from cache`, "debug");
                    return this.all;
                }
            } catch (_) { }

            let raw = null;
            let lastErr = null;

            for (let attempt = 1; attempt <= SYS.FETCH_ATTEMPTS; attempt++) {
                let retryDelay = null;
                try {
                    UI.log(`[Source] Fetching detectable apps (${attempt}/${SYS.FETCH_ATTEMPTS})...`, "info");
                    const res = await apiGet("/applications/detectable");
                    const body = res?.body;
                    raw = Array.isArray(body) ? body : (Array.isArray(body?.applications) ? body.applications : null);
                    if (raw && raw.length) break;
                    lastErr = new Error("empty detectable list");
                    UI.log("[Source] List came back empty, retrying", "warn");
                } catch (e) {
                    lastErr = e;
                    const status = e?.status ?? e?.statusCode;
                    const tail = status === 401 || status === 403
                        ? "token not ready yet, waiting for client"
                        : (e?.message ?? e);
                    UI.log(`[Source] Fetch failed${status ? ` (HTTP ${status})` : ""}: ${tail}`, "warn");
                    if (status === 429) {
                        const seconds = Number(e?.body?.retry_after ?? e?.retryAfter ?? 0);
                        retryDelay = clamp(Math.round((seconds || 5) * 1000), 1000, 60000);
                    }
                }
                if (attempt < SYS.FETCH_ATTEMPTS) {
                    await sleep(retryDelay ?? SYS.RETRY_BASE * attempt);
                }
            }

            if (!raw || !raw.length) {
                const stale = store.read(CONFIG.CACHE_KEY, null);
                if (stale && Array.isArray(stale.data) && stale.data.length) {
                    this.all = stale.data;
                    this.mergeManual();
                    UI.log(`[Source] Network unavailable, using cached ${this.all.length} apps`, "warn");
                    return this.all;
                }
                throw lastErr || new Error("no applications");
            }

            const seen = new Set();
            const out = [];

            for (const a of raw) {
                const g = this.normalize(a);
                if (!g) continue;
                const key = g.name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(g);
            }

            if (!out.length) throw new Error("no playable apps after filtering");

            out.sort((a, b) => a.name.localeCompare(b.name));
            this.all = out;
            store.write(CONFIG.CACHE_KEY, { at: Date.now(), data: out });
            this.mergeManual();
            UI.log(`[Source] ${this.all.length} playable apps indexed`, "success");
            return this.all;
        },

        async addById(raw) {
            const id = String(raw ?? "").trim();
            if (!/^\d{6,}$/.test(id)) throw new Error("id must be numeric");
            const known = this.all.find(g => String(g.id) === id);
            if (known) return known;

            const res = await apiGet(`/applications/public?application_ids=${encodeURIComponent(id)}`);
            const body = res?.body;
            const app = Array.isArray(body) ? body[0] : (body && body.id ? body : null);
            if (!app) throw new Error("application not found");

            const game = this.normalize(app) || {
                id: String(app.id),
                name: String(app.name || `App ${id}`),
                icon: app.icon || null,
                exe: "game.exe",
                steamId: null
            };
            game.manual = true;
            if (!this.manual.some(x => String(x.id) === id)) {
                this.manual.push(game);
                store.write(CONFIG.MANUAL_KEY, this.manual);
            }
            if (!this.all.some(x => String(x.id) === id)) this.all.push(game);
            return game;
        },

        steamOnly() {
            return this.all.filter(g => g.steamId || g.manual);
        },

        browse(steam) {
            return (steam ? this.steamOnly() : this.all.slice())
                .filter(g => !RT.banned.has(String(g.id)));
        },

        pool(steamOnly, strict = false) {
            const base = (steamOnly ? this.steamOnly() : this.all.slice())
                .filter(g => !RT.banned.has(String(g.id)));
            let list = RT.skipPlayed ? base.filter(g => !RT.played.has(String(g.id))) : base.slice();
            if (!list.length && !strict) {
                list = base.slice();
                if (RT.skipPlayed && base.length) {
                    UI.log("[Session] Every game in the pool is already recorded, replaying", "warn");
                }
            }
            if (RT.shuffle) this.shuffle(list);
            return list;
        },

        selected() {
            const ids = RT.selection;
            if (!ids || !ids.size) return null;
            const list = this.all.filter(g => ids.has(String(g.id)) && !RT.banned.has(String(g.id)));
            if (RT.shuffle) this.shuffle(list);
            return list;
        },

        shuffle(list) {
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
            }
            return list;
        }
    };

    const UI = {
        root: null,
        refs: {},
        hotkey: null,
        setupResolve: null,
        againResolve: null,
        live: false,
        search: "",
        selection: new Set(),
        steamMode: true,

        init() {
            document.getElementById("gf-ui")?.remove();
            document.getElementById("gf-styles")?.remove();

            const st = document.createElement("style");
            st.id = "gf-styles";
            st.textContent = `
            @keyframes gfIn { from { opacity:0; transform: translateY(-14px) scale(.98);} to { opacity:1; transform:none; } }
            @keyframes gfPulse { 0%,100% { opacity:.3; } 50% { opacity:1; } }
            #gf-ui {
                position: fixed; top: 26px; right: 20px; width: 396px;
                background: var(--background-base-low, #2b2d31); color: var(--text-default, #dbdee1);
                border: 1px solid var(--border-subtle, rgba(255,255,255,.08)); border-radius: 14px;
                box-shadow: 0 12px 32px rgba(0,0,0,.45); z-index: 10002; overflow: hidden;
                font-family: var(--font-primary, -apple-system, "Segoe UI", Roboto, sans-serif);
                display: flex; flex-direction: column; animation: gfIn .22s ease; user-select: none;
            }
            #gf-ui.mini { width: 258px; }
            #gf-head { padding: 11px 14px; background: var(--background-mod-muted, #232428); display:flex; justify-content:space-between; align-items:center; gap:8px; border-bottom:1px solid rgba(255,255,255,.06); cursor: grab; }
            #gf-head.drag { cursor: grabbing; }
            #gf-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:700; color:#fff; white-space:nowrap; }
            #gf-title svg { color:#1db954; flex-shrink:0; }
            #gf-mini { display:none; flex:1; min-width:0; font-size:12px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            #gf-ui.mini #gf-title { display:none; }
            #gf-ui.mini #gf-mini { display:block; }
            #gf-ui.mini #gf-body, #gf-ui.mini #gf-logs { display:none; }
            .gf-tag { font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px; background:rgba(29,185,84,.18); color:#1db954; letter-spacing:.4px; }
            #gf-controls { display:flex; gap:6px; align-items:center; flex-shrink:0; }
            .gf-btn { font-size:10px; font-weight:800; letter-spacing:.5px; padding:4px 7px; border-radius:5px; cursor:pointer; color:#949ba4; transition:.15s; }
            .gf-btn:hover { color:#fff; background:rgba(255,255,255,.07); }
            .gf-btn.on { color:#1db954; background:rgba(29,185,84,.14); }
            .gf-stop { color:#f04747; border:1px solid #f04747; display:flex; align-items:center; gap:4px; }
            .gf-stop:hover { background:#f04747; color:#fff; }
            #gf-body { padding: 14px; display:flex; flex-direction:column; gap:10px; max-height:62vh; overflow-y:auto; }
            .gf-sec { display:flex; flex-direction:column; gap:7px; padding:10px; border-radius:10px; background:rgba(0,0,0,.16); border:1px solid rgba(255,255,255,.05); }
            .gf-sec-title { display:flex; justify-content:space-between; align-items:center; font-size:10px; font-weight:800; letter-spacing:.8px; color:#7a7f87; text-transform:uppercase; }
            .gf-row { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#b5bac1; }
            .gf-row b { color:#fff; font-weight:700; }
            .gf-field { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px; color:#b5bac1; }
            .gf-field input { width:92px; background:#1e1f22; border:1px solid rgba(255,255,255,.08); border-radius:6px; color:#fff; font-size:12px; padding:5px 8px; text-align:right; outline:none; font-family:inherit; }
            .gf-field input:focus { border-color:#1db954; }
            .gf-search input { width:100%; background:#1e1f22; border:1px solid rgba(255,255,255,.08); border-radius:6px; color:#fff; font-size:12px; padding:6px 9px; outline:none; font-family:inherit; }
            .gf-search input:focus { border-color:#1db954; }
            .gf-toggles { display:flex; flex-wrap:wrap; gap:6px; }
            .gf-chk { display:flex; align-items:center; gap:5px; font-size:11px; color:#b5bac1; background:rgba(255,255,255,.03); padding:4px 8px; border-radius:6px; cursor:pointer; }
            .gf-chk input { accent-color:#1db954; margin:0; }
            .gf-link { color:#1db954; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
            .gf-link:hover { color:#23c05c; }
            .gf-presets { display:flex; gap:5px; }
            .gf-preset { flex:1; padding:5px 0; font-size:10px; font-weight:800; color:#b5bac1; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:5px; cursor:pointer; font-family:inherit; transition:.15s; }
            .gf-preset:hover { color:#fff; border-color:#1db954; }
            .gf-inline { display:flex; gap:6px; align-items:center; }
            .gf-actions { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; }
            .gf-actions.two { grid-template-columns:repeat(2, 1fr); }
            .gf-act { padding:8px 0; font-size:10px; font-weight:800; letter-spacing:.4px; border-radius:6px; cursor:pointer; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); color:#dbdee1; font-family:inherit; transition:.15s; }
            .gf-act:hover { border-color:#1db954; color:#fff; }
            .gf-act.on { background:#1db954; border-color:#1db954; color:#fff; }
            .gf-act.danger:hover { border-color:#f04747; color:#f04747; }
            .gf-list { display:flex; flex-direction:column; gap:3px; max-height:150px; overflow-y:auto; padding-right:2px; }
            .gf-item { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; cursor:pointer; font-size:11.5px; color:#b5bac1; }
            .gf-item:hover { background:rgba(255,255,255,.05); color:#fff; }
            .gf-item input { accent-color:#1db954; margin:0; flex-shrink:0; }
            .gf-item span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .gf-item .gf-id { margin-left:auto; font-size:9px; color:#5c6069; flex-shrink:0; }
            .gf-item.banned span { text-decoration:line-through; color:#5c6069; }
            .gf-empty { font-size:11px; color:#5c6069; text-align:center; padding:8px 0; }
            .gf-hint { font-size:10px; color:#7a7f87; text-align:center; }
            .gf-loading { display:flex; align-items:center; justify-content:center; gap:8px; padding:18px 4px; font-size:12px; color:#b5bac1; }
            #gf-start, #gf-again { width:100%; padding:11px; border:none; border-radius:8px; background:#1db954; color:#fff; font-size:12px; font-weight:800; letter-spacing:.6px; cursor:pointer; transition:.15s; display:flex; align-items:center; justify-content:center; gap:7px; font-family:inherit; }
            #gf-start:hover:not(:disabled), #gf-again:hover:not(:disabled) { background:#18a349; }
            #gf-start:disabled, #gf-again:disabled { opacity:.45; cursor:not-allowed; }
            #gf-again { display:none; margin-top:2px; }

            .gf-current { display:flex; align-items:center; gap:11px; padding:11px 12px; background:#313338; border-radius:10px; border-left:3px solid #1db954; }
            .gf-art { width:42px; height:42px; border-radius:8px; flex-shrink:0; background:rgba(29,185,84,.12); color:#1db954; display:flex; align-items:center; justify-content:center; overflow:hidden; }
            .gf-art img { width:100%; height:100%; object-fit:cover; }
            .gf-meta { flex:1; min-width:0; }
            .gf-name { font-size:13px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .gf-sub { font-size:10px; color:#949ba4; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .gf-clock { font-size:13px; font-weight:800; color:#1db954; font-variant-numeric: tabular-nums; }

            .gf-bar { height:4px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; }
            .gf-bar > i { display:block; height:100%; width:0%; background:linear-gradient(90deg,#1db954,#23a55a); border-radius:99px; transition:width .25s linear; }

            .gf-stats { display:flex; justify-content:space-between; gap:8px; font-size:11px; color:#949ba4; }
            .gf-stats b { color:#fff; }
            .gf-live { display:flex; align-items:center; gap:5px; }
            .gf-dot { width:6px; height:6px; border-radius:50%; background:#1db954; animation: gfPulse 1.6s infinite; }

            #gf-history { display:flex; flex-direction:column; gap:4px; max-height:120px; overflow-y:auto; }
            .gf-hist { display:flex; align-items:center; gap:7px; font-size:11px; color:#b5bac1; padding:3px 2px; }
            .gf-hist svg { color:#23a55a; flex-shrink:0; }
            .gf-hist.skipped svg { color:#faa61a; }
            .gf-hist.timeout svg { color:#faa61a; }
            .gf-hist.banned svg { color:#f04747; }
            .gf-hist span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

            #gf-logs { background:#111214; border-top:1px solid rgba(255,255,255,.06); padding:7px 12px; height:96px; overflow-y:auto; font-family:Consolas,Monaco,monospace; font-size:10.5px; line-height:1.4; scroll-behavior:smooth; }
            .gf-log { display:flex; gap:6px; margin-bottom:3px; }
            .gf-ts { opacity:.45; min-width:44px; }
            .l-info { color:#5865F2; } .l-success { color:#23a55a; } .l-warn { color:#faa61a; } .l-err { color:#f04747; } .l-debug { color:#7a7f87; }
            #gf-ui ::-webkit-scrollbar { width:5px; }
            #gf-ui ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.14); border-radius:4px; }
            #gf-ui ::-webkit-scrollbar-track { background:transparent; }
            `;
            document.head.appendChild(st);

            this.root = document.createElement("div");
            this.root.id = "gf-ui";
            this.root.innerHTML = `
                <div id="gf-head">
                    <span id="gf-title">${ICONS.LOGO} ${CONFIG.NAME}<span class="gf-tag">${CONFIG.VERSION}</span></span>
                    <span id="gf-mini">-</span>
                    <div id="gf-controls">
                        <span class="gf-btn gf-stop" id="gf-stop">${ICONS.STOP} STOP</span>
                        <span class="gf-btn" id="gf-mini-btn">MINI</span>
                        <span class="gf-btn" id="gf-hide">HIDE</span>
                    </div>
                </div>
                <div id="gf-body"></div>
                <div id="gf-logs"></div>`;
            document.body.appendChild(this.root);

            const head = this.root.querySelector("#gf-head");
            head.addEventListener("mousedown", e => {
                if (e.target.closest(".gf-btn")) return;
                head.classList.add("drag");
                const sx = e.clientX, sy = e.clientY;
                const r = this.root.getBoundingClientRect();
                const l0 = r.left, t0 = r.top;
                this.root.style.left = l0 + "px";
                this.root.style.top = t0 + "px";
                this.root.style.right = "auto";
                e.preventDefault();

                const mv = ev => {
                    this.root.style.left = clamp(l0 + ev.clientX - sx, 0, innerWidth - this.root.offsetWidth) + "px";
                    this.root.style.top = clamp(t0 + ev.clientY - sy, 0, innerHeight - 60) + "px";
                };
                const up = () => {
                    head.classList.remove("drag");
                    document.removeEventListener("mousemove", mv);
                    document.removeEventListener("mouseup", up);
                };
                document.addEventListener("mousemove", mv);
                document.addEventListener("mouseup", up);
            });

            this.root.querySelector("#gf-hide").onclick = () => {
                this.root.style.display = this.root.style.display === "none" ? "flex" : "none";
            };

            const miniBtn = this.root.querySelector("#gf-mini-btn");
            miniBtn.onclick = () => {
                const on = this.root.classList.toggle("mini");
                miniBtn.classList.toggle("on", on);
            };

            this.root.querySelector("#gf-stop").onclick = () => this.shutdown();

            this.hotkey = e => {
                const el = document.activeElement;
                const editable = el?.closest?.("[contenteditable]");
                const typing = /INPUT|TEXTAREA|SELECT/.test(el?.tagName || "") ||
                    el?.isContentEditable === true ||
                    (!!editable && editable.getAttribute("contenteditable") !== "false");
                if (e.shiftKey && e.key === "." && !typing) {
                    this.root.style.display = this.root.style.display === "none" ? "flex" : "none";
                    return;
                }
                if (typing || !this.live) return;

                if (e.code === "Space") {
                    e.preventDefault();
                    this.skip();
                } else if (e.key.toLowerCase() === "p") {
                    this.pause();
                } else if (e.key.toLowerCase() === "b") {
                    this.ban();
                } else if (e.key === "+" || e.key === "=") {
                    this.extend(30);
                } else if (e.key.toLowerCase() === "m") {
                    miniBtn.click();
                }
            };
            document.addEventListener("keydown", this.hotkey);
        },

        loading(text) {
            const body = document.getElementById("gf-body");
            if (!body) return;
            body.innerHTML = `<div class="gf-sec"><div class="gf-loading"><span class="gf-dot"></span><span>${esc(text)}</span></div></div>`;
        },

        log(msg, type = "info") {
            const colors = { info: "#5865F2", success: "#23a55a", warn: "#faa61a", err: "#f04747", debug: "#999" };
            console.log(`%c[${CONFIG.NAME}] %c${msg}`, "color:#1db954;font-weight:bold", `color:${colors[type] || colors.info}`);
            const box = document.getElementById("gf-logs");
            if (!box) return;
            const el = document.createElement("div");
            el.className = `gf-log l-${type}`;
            el.innerHTML = `<span class="gf-ts">${new Date().toLocaleTimeString().split(" ")[0]}</span><span>${esc(msg)}</span>`;
            box.appendChild(el);
            box.scrollTop = box.scrollHeight;
            while (box.children.length > CONFIG.MAX_LOG) box.firstChild.remove();
        },

        showSetup(appCount, steamCount) {
            return new Promise(resolve => {
                this.setupResolve = resolve;
                this.live = false;
                this.search = "";
                this.selection = new Set();
                this.steamMode = steamCount > 0;

                const body = document.getElementById("gf-body");
                if (!body) return resolve(false);

                const unplayed = GameSource.browse(this.steamMode)
                    .filter(g => !RT.played.has(String(g.id))).length;

                body.innerHTML = `
                    <div class="gf-sec">
                        <div class="gf-sec-title">Library <span class="gf-link" id="gf-refresh">refresh</span></div>
                        <div class="gf-row"><span>Indexed</span><span><b id="gf-steam-count">${steamCount}</b> steam / <b id="gf-total-count">${appCount}</b></span></div>
                        <div class="gf-row"><span>Recorded before</span><span><b id="gf-played-count">${RT.played.size}</b> <span class="gf-link" id="gf-reset">reset</span></span></div>
                        <div class="gf-row"><span>Unplayed</span><b id="gf-unplayed-count">${unplayed}</b></div>
                        <div class="gf-row"><span>Lifetime</span><span><b id="gf-stat">${RT.stats.played} games, ${Math.round(RT.stats.minutes)}m</b> <span class="gf-link" id="gf-stats-reset">reset</span></span></div>
                        <div class="gf-row"><span>Banned</span><span><b id="gf-ban-count">${RT.banned.size}</b> <span class="gf-link" id="gf-ban-clear">clear</span></span></div>
                    </div>

                    <div class="gf-sec">
                        <div class="gf-sec-title">Session</div>
                        <div class="gf-field"><span>Seconds per game</span><input id="gf-in-dur" type="number" min="${SYS.MIN_DUR}" max="${SYS.MAX_DUR}" value="${RT.duration}"></div>
                        <div class="gf-presets">
                            <button type="button" class="gf-preset" data-v="30">30s</button>
                            <button type="button" class="gf-preset" data-v="60">1m</button>
                            <button type="button" class="gf-preset" data-v="120">2m</button>
                            <button type="button" class="gf-preset" data-v="300">5m</button>
                            <button type="button" class="gf-preset" data-v="600">10m</button>
                        </div>
                        <div class="gf-field"><span>Random up to</span><input id="gf-in-durmax" type="number" min="${SYS.MIN_DUR}" max="${SYS.MAX_DUR}" value="${RT.durationMax}"></div>
                        <div class="gf-field"><span>Games in session</span><input id="gf-in-cnt" type="number" min="1" max="500" value="${RT.target}"></div>
                        <div class="gf-field"><span>Gap between (s)</span><input id="gf-in-gap" type="number" min="0" max="600" value="${RT.gap}"></div>
                        <div class="gf-field"><span>Stop after (min, 0 off)</span><input id="gf-in-max" type="number" min="0" max="1440" value="${RT.maxMinutes}"></div>
                        <div class="gf-toggles">
                            <label class="gf-chk"><input type="checkbox" id="gf-in-rand" ${RT.randomDuration ? "checked" : ""}>Random</label>
                            <label class="gf-chk"><input type="checkbox" id="gf-in-shuffle" ${RT.shuffle ? "checked" : ""}>Shuffle</label>
                            <label class="gf-chk"><input type="checkbox" id="gf-in-skip" ${RT.skipPlayed ? "checked" : ""}>Skip played</label>
                            <label class="gf-chk"><input type="checkbox" id="gf-in-sound" ${RT.sound ? "checked" : ""}>Sound</label>
                            <label class="gf-chk"><input type="checkbox" id="gf-in-notify" ${RT.notify ? "checked" : ""}>Notify</label>
                            <label class="gf-chk"><input type="checkbox" id="gf-in-loop" ${RT.loop ? "checked" : ""}>Loop</label>
                        </div>
                        <div class="gf-row"><span>Estimated</span><b id="gf-est">0m</b></div>
                    </div>

                    <div class="gf-sec">
                        <div class="gf-sec-title">Games <span class="gf-link" id="gf-sel-clear">auto</span></div>
                        <div class="gf-search"><input id="gf-search" type="search" placeholder="Search apps..." autocomplete="off"></div>
                        <div id="gf-list" class="gf-list"></div>
                        <div class="gf-hint" id="gf-list-info"></div>
                        <div class="gf-actions two">
                            <button type="button" class="gf-act" id="gf-sel-all">SELECT ALL</button>
                            <button type="button" class="gf-act" id="gf-sel-none">CLEAR</button>
                        </div>
                        <div class="gf-row"><span>Selected</span><b id="gf-sel-count">auto</b></div>
                    </div>

                    <div class="gf-sec">
                        <div class="gf-sec-title">Manual</div>
                        <div class="gf-field"><span>Add by app id</span><span class="gf-inline"><input id="gf-in-appid" type="text" inputmode="numeric" placeholder="1234567890" style="width:118px;"><span class="gf-link" id="gf-add">add</span></span></div>
                    </div>

                    <div class="gf-sec">
                        <div class="gf-sec-title">Banned <span class="gf-link" id="gf-ban-clear2">clear</span></div>
                        <div id="gf-banlist" class="gf-list"></div>
                    </div>

                    <button id="gf-start">${ICONS.GAME} START SESSION</button>
                    <div class="gf-hint">Space skip, P pause, B ban, M mini, Shift + . hide</div>`;

                const q = id => body.querySelector(id);
                const read = id => parseInt(q(id).value, 10) || 0;

                const counts = () => {
                    const steam = GameSource.steamOnly();
                    const browse = GameSource.browse(this.steamMode);
                    q("#gf-steam-count").textContent = steam.length;
                    q("#gf-total-count").textContent = GameSource.all.length;
                    q("#gf-played-count").textContent = RT.played.size;
                    q("#gf-unplayed-count").textContent = browse
                        .filter(g => !RT.played.has(String(g.id))).length;
                    q("#gf-ban-count").textContent = RT.banned.size;
                    q("#gf-stat").textContent = `${RT.stats.played} games, ${Math.round(RT.stats.minutes)}m`;
                };

                const estimate = () => {
                    const dur = clamp(read("#gf-in-dur") || 90, SYS.MIN_DUR, SYS.MAX_DUR);
                    const max = clamp(read("#gf-in-durmax") || dur, SYS.MIN_DUR, SYS.MAX_DUR);
                    const cnt = clamp(read("#gf-in-cnt") || 50, 1, 500);
                    const gap = clamp(read("#gf-in-gap"), 0, 600);
                    const per = q("#gf-in-rand").checked ? (dur + Math.max(dur, max)) / 2 : dur;
                    let total = cnt * per + Math.max(0, cnt - 1) * gap;
                    const limit = clamp(read("#gf-in-max"), 0, 1440);
                    if (limit > 0) total = Math.min(total, limit * 60);
                    q("#gf-est").textContent = fmt(total);
                };

                for (const id of ["#gf-in-dur", "#gf-in-durmax", "#gf-in-cnt", "#gf-in-gap", "#gf-in-max"]) {
                    q(id).addEventListener("input", estimate);
                }
                q("#gf-in-rand").addEventListener("change", estimate);

                for (const preset of body.querySelectorAll(".gf-preset")) {
                    preset.onclick = () => {
                        q("#gf-in-dur").value = preset.dataset.v;
                        estimate();
                    };
                }

                q("#gf-reset").onclick = () => {
                    RT.played.clear();
                    store.drop(CONFIG.PLAYED_KEY);
                    counts();
                    this.renderList();
                    UI.log("[History] Played list cleared", "info");
                };

                q("#gf-stats-reset").onclick = () => {
                    RT.stats = { played: 0, minutes: 0 };
                    store.write(CONFIG.STATS_KEY, RT.stats);
                    counts();
                    UI.log("[History] Lifetime stats reset", "info");
                };

                let refreshing = false;
                q("#gf-refresh").onclick = async () => {
                    if (refreshing) return;
                    refreshing = true;
                    const backup = GameSource.all.slice();
                    store.drop(CONFIG.CACHE_KEY);
                    UI.log("[Source] Refreshing app list...", "info");
                    try {
                        GameSource.all = [];
                        await GameSource.load();
                    } catch (e) {
                        GameSource.all = backup;
                        UI.log(`[Source] Refresh failed: ${e?.message ?? e}`, "err");
                    } finally {
                        refreshing = false;
                    }
                    this.steamMode = GameSource.steamOnly().length > 0;
                    counts();
                    this.renderList();
                    this.renderBans();
                };

                const clearBans = () => {
                    RT.banned.clear();
                    store.drop(CONFIG.BANNED_KEY);
                    counts();
                    this.renderBans();
                    this.renderList();
                    UI.log("[History] Ban list cleared", "info");
                };
                q("#gf-ban-clear").onclick = clearBans;
                q("#gf-ban-clear2").onclick = clearBans;

                q("#gf-search").addEventListener("input", e => {
                    this.search = e.target.value;
                    this.renderList();
                });

                q("#gf-sel-all").onclick = () => {
                    for (const g of this.filtered()) this.selection.add(String(g.id));
                    this.renderList();
                };

                q("#gf-sel-none").onclick = () => {
                    this.selection.clear();
                    this.renderList();
                };

                q("#gf-sel-clear").onclick = () => {
                    this.selection.clear();
                    this.renderList();
                };

                q("#gf-list").addEventListener("click", e => {
                    const row = e.target.closest(".gf-item");
                    if (!row) return;
                    e.preventDefault();
                    const id = row.dataset.id;
                    if (!id) return;
                    const box = row.querySelector("input");
                    const on = !this.selection.has(id);
                    if (on) this.selection.add(id);
                    else this.selection.delete(id);
                    if (box) box.checked = on;
                    this.updateSelection();
                });

                q("#gf-banlist").addEventListener("click", e => {
                    const row = e.target.closest(".gf-item");
                    if (!row) return;
                    const id = row.dataset.id;
                    if (!id) return;
                    RT.banned.delete(id);
                    store.write(CONFIG.BANNED_KEY, [...RT.banned]);
                    counts();
                    this.renderBans();
                    this.renderList();
                    UI.log(`[History] Unbanned ${id}`, "info");
                });

                q("#gf-add").onclick = async () => {
                    const input = q("#gf-in-appid");
                    const id = String(input.value || "").trim();
                    if (!id) return;
                    try {
                        const game = await GameSource.addById(id);
                        input.value = "";
                        counts();
                        this.renderList();
                        UI.log(`[Source] Added "${game.name}" (${game.id})`, "success");
                    } catch (e) {
                        UI.log(`[Source] Add failed: ${e?.message ?? e}`, "err");
                    }
                };

                q("#gf-start").onclick = () => {
                    if (this.selection.size) {
                        const usable = GameSource.all.some(g =>
                            this.selection.has(String(g.id)) && !RT.banned.has(String(g.id))
                        );
                        if (!usable) {
                            UI.log("[Session] Every selected game is banned", "err");
                            return;
                        }
                    }
                    RT.duration = clamp(read("#gf-in-dur") || 90, SYS.MIN_DUR, SYS.MAX_DUR);
                    RT.durationMax = clamp(read("#gf-in-durmax") || RT.duration, SYS.MIN_DUR, SYS.MAX_DUR);
                    RT.randomDuration = q("#gf-in-rand").checked;
                    RT.target = clamp(read("#gf-in-cnt") || 50, 1, 500);
                    RT.gap = clamp(read("#gf-in-gap"), 0, 600);
                    RT.maxMinutes = clamp(read("#gf-in-max"), 0, 1440);
                    RT.shuffle = q("#gf-in-shuffle").checked;
                    RT.skipPlayed = q("#gf-in-skip").checked;
                    RT.sound = q("#gf-in-sound").checked;
                    RT.notify = q("#gf-in-notify").checked;
                    RT.loop = q("#gf-in-loop").checked;
                    RT.selection = this.selection.size ? new Set(this.selection) : null;
                    saveSettings();
                    this.setupResolve = null;
                    resolve(true);
                };

                this.renderList();
                this.renderBans();
                estimate();
            });
        },

        filtered() {
            const term = this.search.trim().toLowerCase();
            let list = GameSource.browse(this.steamMode);
            if (term) {
                list = list.filter(g => g.name.toLowerCase().includes(term) || String(g.id).includes(term));
            }
            return list;
        },

        updateSelection() {
            const counter = document.getElementById("gf-sel-count");
            if (counter) counter.textContent = this.selection.size ? `${this.selection.size} picked` : "auto";
        },

        renderList() {
            const box = document.getElementById("gf-list");
            if (!box) return;

            const all = this.filtered();
            const items = all.slice(0, SYS.LIST_LIMIT);
            if (!items.length) {
                box.innerHTML = `<div class="gf-empty">no matches</div>`;
            } else {
                box.innerHTML = items.map(g => {
                    const id = String(g.id);
                    const checked = this.selection.has(id) ? "checked" : "";
                    return `<label class="gf-item" data-id="${esc(id)}"><input type="checkbox" ${checked}><span>${esc(g.name)}</span><span class="gf-id">${esc(g.steamId || "")}</span></label>`;
                }).join("");
            }

            const info = document.getElementById("gf-list-info");
            if (info) info.textContent = all.length ? `${items.length} of ${all.length} shown` : "";

            this.updateSelection();
        },

        renderBans() {
            const box = document.getElementById("gf-banlist");
            if (!box) return;

            const ids = [...RT.banned].slice(0, 60);
            if (!ids.length) {
                box.innerHTML = `<div class="gf-empty">none</div>`;
                return;
            }

            const byId = new Map(GameSource.all.map(g => [String(g.id), g]));

            box.innerHTML = ids.map(id => {
                const g = byId.get(id);
                const name = g ? g.name : `App ${id}`;
                return `<label class="gf-item banned" data-id="${esc(id)}" title="click to unban"><span>${esc(name)}</span><span class="gf-id">unban</span></label>`;
            }).join("");
        },

        renderRun() {
            const body = document.getElementById("gf-body");
            if (!body) return;
            this.live = true;
            this.root.classList.remove("mini");
            this.root.querySelector("#gf-mini-btn")?.classList.remove("on");

            body.innerHTML = `
                <div class="gf-current">
                    <div class="gf-art" id="gf-art">${ICONS.GAME}</div>
                    <div class="gf-meta">
                        <div class="gf-name" id="gf-cur-name">Waiting...</div>
                        <div class="gf-sub" id="gf-cur-sub">-</div>
                    </div>
                    <div class="gf-clock" id="gf-clock">--:--</div>
                </div>
                <div class="gf-bar"><i id="gf-bar-fill"></i></div>
                <div class="gf-stats">
                    <span class="gf-live"><span class="gf-dot"></span> <b id="gf-count">0 / 0</b></span>
                    <span>Left <b id="gf-left">-</b></span>
                    <span>Session <b id="gf-elapsed">0m</b></span>
                </div>
                <div class="gf-actions">
                    <button type="button" class="gf-act" id="gf-skip">SKIP</button>
                    <button type="button" class="gf-act" id="gf-pause">PAUSE</button>
                    <button type="button" class="gf-act" id="gf-extend">+30s</button>
                    <button type="button" class="gf-act danger" id="gf-ban">BAN</button>
                </div>
                <div id="gf-history"></div>
                <button type="button" id="gf-again">NEW SETUP</button>`;

            this.refs = {
                art: document.getElementById("gf-art"),
                name: document.getElementById("gf-cur-name"),
                sub: document.getElementById("gf-cur-sub"),
                clock: document.getElementById("gf-clock"),
                bar: document.getElementById("gf-bar-fill"),
                count: document.getElementById("gf-count"),
                left: document.getElementById("gf-left"),
                elapsed: document.getElementById("gf-elapsed"),
                history: document.getElementById("gf-history"),
                pause: document.getElementById("gf-pause"),
                mini: document.getElementById("gf-mini")
            };

            document.getElementById("gf-skip").onclick = () => this.skip();
            document.getElementById("gf-pause").onclick = () => this.pause();
            document.getElementById("gf-extend").onclick = () => this.extend(30);
            document.getElementById("gf-ban").onclick = () => this.ban();
            document.getElementById("gf-again").onclick = () => {
                if (!this.againResolve) return;
                const resolve = this.againResolve;
                this.againResolve = null;
                resolve(true);
            };
        },

        awaitRestart() {
            return new Promise(resolve => {
                this.live = false;
                this.againResolve = resolve;
                this.root?.classList.remove("mini");
                this.root?.querySelector("#gf-mini-btn")?.classList.remove("on");
                const btn = document.getElementById("gf-again");
                if (btn) btn.style.display = "flex";
                this.log("[Session] NEW SETUP for another run or STOP to close.", "info");
            });
        },

        resetControls() {
            CTL.skip = false;
            CTL.paused = false;
            CTL.extend = 0;
            CTL.ban = false;
            if (this.refs.pause) {
                this.refs.pause.textContent = "PAUSE";
                this.refs.pause.classList.remove("on");
            }
        },

        skip() {
            if (!this.live) return;
            CTL.skip = true;
        },

        pause() {
            if (!this.live) return;
            CTL.paused = !CTL.paused;
            if (this.refs.pause) {
                this.refs.pause.textContent = CTL.paused ? "RESUME" : "PAUSE";
                this.refs.pause.classList.toggle("on", CTL.paused);
            }
            this.log(CTL.paused ? "[Control] Paused" : "[Control] Resumed", "info");
        },

        extend(sec) {
            if (!this.live) return;
            CTL.extend += sec;
            this.log(`[Control] +${sec}s on current game`, "info");
        },

        ban() {
            if (!this.live) return;
            CTL.ban = true;
        },

        setCurrent(g, idx, total, seconds) {
            const r = this.refs;
            if (!r.name) return;
            r.name.textContent = g.name;
            r.sub.textContent = `app ${g.id}${g.steamId ? ` ┬╖ steam ${g.steamId}` : ""} ┬╖ ${seconds}s`;
            r.art.innerHTML = g.icon
                ? `<img src="${esc(`https://cdn.discordapp.com/app-icons/${g.id}/${g.icon}.png?size=64`)}" alt="">`
                : ICONS.GAME;
            r.count.textContent = `${idx} / ${total}`;
            r.bar.style.width = "0%";
            if (r.mini) r.mini.textContent = `${g.name} ┬╖ ${clock(seconds)}`;
        },

        tick(ratio, remainSec, elapsedMin, paused, sessionLeft) {
            const r = this.refs;
            if (!r.clock) return;
            const text = clock(remainSec);
            r.clock.textContent = paused ? `|| ${text}` : text;
            r.clock.style.color = paused ? "#faa61a" : "#1db954";
            r.bar.style.width = `${clamp(ratio * 100, 0, 100)}%`;
            r.elapsed.textContent = `${elapsedMin}m`;
            if (r.left) r.left.textContent = sessionLeft === null ? "-" : clock(sessionLeft);
            if (r.mini) {
                const name = this.currentName || "";
                r.mini.textContent = `${name} ┬╖ ${text}`;
            }
        },

        pushHistory(g, status) {
            const r = this.refs;
            if (!r.history) return;
            const row = document.createElement("div");
            row.className = `gf-hist ${status}`;
            const tag = status === "played" ? "" : status === "timeout" ? " (time limit)" : ` (${status})`;
            row.innerHTML = `${status === "played" ? ICONS.CHECK : ICONS.STOP}<span>${esc(g.name)}${tag}</span>`;
            r.history.prepend(row);
            while (r.history.children.length > SYS.HISTORY_LIMIT) r.history.lastChild.remove();
        },

        shutdown() {
            this.live = false;
            if (!RT.running) {
                window.__gfLock = false;
                this.root?.remove();
                document.getElementById("gf-styles")?.remove();
                return;
            }
            RT.running = false;

            if (this.setupResolve) {
                const r = this.setupResolve;
                this.setupResolve = null;
                try { r(false); } catch (_) { }
            }
            if (this.againResolve) {
                const r = this.againResolve;
                this.againResolve = null;
                try { r(false); } catch (_) { }
            }

            this.log("[System] Stopping and restoring stores...", "warn");
            if (this.hotkey) {
                document.removeEventListener("keydown", this.hotkey);
                this.hotkey = null;
            }
            Patcher.clean();
            if (RT.prevShowGame === false) {
                try { Promise.resolve(Mods.ShowCurrentGame?.set(false)).catch(() => { }); } catch (_) { }
            }
            if (RT.prevRecentGames === false) {
                try { Promise.resolve(Mods.RecentGames?.set(false)).catch(() => { }); } catch (_) { }
            }
            window.__gfLock = false;

            const styles = document.getElementById("gf-styles");
            const root = this.root;
            setTimeout(() => { styles?.remove(); root?.remove(); }, 900);
        }
    };

    function notify(title, body) {
        if (!RT.notify) return;
        try {
            if (typeof Notification === "undefined") return;
            if (Notification.permission === "granted") new Notification(title, { body, tag: "steam-game-farmer" });
            else if (Notification.permission === "default") Notification.requestPermission().catch(() => { });
        } catch (_) { }
    }

    async function ensureGameSettings() {
        if (Mods.ShowCurrentGame) {
            try {
                const cur = Mods.ShowCurrentGame.get();
                if (RT.prevShowGame === null && typeof cur === "boolean") RT.prevShowGame = cur;
                if (cur !== true) await Mods.ShowCurrentGame.set(true);
            } catch (_) { }
        }
        if (Mods.RecentGames) {
            try {
                const cur = Mods.RecentGames.get();
                if (RT.prevRecentGames === null && typeof cur === "boolean") RT.prevRecentGames = cur;
                if (cur !== true) await Mods.RecentGames.set(true);
            } catch (_) { }
        }
    }

    function makeGame(g) {
        let pid = rnd(1800, 14000) * 4;
        try {
            const used = new Set((Mods.RunStore?.getRunningGames?.() || []).map(x => x?.pid));
            for (let i = 0; i < 20 && used.has(pid); i++) pid = rnd(1800, 14000) * 4;
        } catch (_) { }
        const safe = g.name.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "game";
        return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            pid,
            pidPath: [pid],
            processName: safe,
            start: Date.now(),
            lastFocused: Math.floor(Date.now() / 1000),
            exeName: g.exe,
            exePath: `c:/program files (x86)/steam/steamapps/common/${safe.toLowerCase().replace(/\s+/g, "")}/${String(g.exe).toLowerCase()}`,
            cmdLine: `"C:\\Program Files (x86)\\Steam\\steamapps\\common\\${safe}\\${g.exe}"`,
            executables: [{ os: "win32", name: g.exe, is_launcher: false }],
            distributor: g.steamId ? "steam" : undefined,
            sku: g.steamId || undefined,
            thirdPartySkus: g.steamId ? [{ distributor: "steam", sku: g.steamId }] : [],
            windowHandle: null,
            fullscreenType: 0,
            overlay: false,
            sandboxed: false,
            hidden: false,
            isLauncher: false
        };
    }

    const sessionLeft = () => RT.maxMinutes > 0
        ? Math.max(0, RT.maxMinutes * 60000 - (Date.now() - RT.sessionStart))
        : null;

    async function playOne(g, idx, total) {
        const game = makeGame(g);
        const seconds = RT.randomDuration
            ? rnd(Math.min(RT.duration, RT.durationMax), Math.max(RT.duration, RT.durationMax))
            : RT.duration;

        UI.resetControls();
        UI.currentName = g.name;

        let totalMs = seconds * 1000;
        let elapsed = 0;
        let last = Date.now();
        let lastBeat = 0;
        let lastPatch = 0;
        let lastSettings = 0;
        let skipped = false;
        let banned = false;
        let timedOut = false;

        Patcher.add(game);

        try {
            if (!Patcher.alive(game.pid)) {
                UI.log(`[Check] Store did not expose fake process for "${g.name}"`, "warn");
            }

            UI.setCurrent(g, idx, total, seconds);

            while (RT.running) {
                await sleep(SYS.TICK);

                const now = Date.now();
                if (!CTL.paused) elapsed += now - last;
                last = now;

                if (CTL.ban) {
                    banned = true;
                    break;
                }
                if (CTL.skip) {
                    skipped = true;
                    break;
                }
                if (CTL.extend) {
                    totalMs += CTL.extend * 1000;
                    CTL.extend = 0;
                }

                if (RT.maxMinutes > 0 && now - RT.sessionStart >= RT.maxMinutes * 60000) {
                    timedOut = true;
                    break;
                }

                const cur = Math.min(elapsed, totalMs);
                UI.tick(cur / totalMs, Math.max(0, (totalMs - cur) / 1000), Math.floor((now - RT.sessionStart) / 60000), CTL.paused, sessionLeft());

                if (cur >= totalMs) break;

                if (now - lastPatch > SYS.PATCH_BEAT) {
                    lastPatch = now;
                    Patcher.apply();
                    if (!Patcher.alive(game.pid)) {
                        Patcher.add(game);
                        UI.log(`[Watchdog] Re-injected "${g.name}"`, "warn");
                    }
                    if (now - lastSettings > SYS.SETTINGS_BEAT) {
                        lastSettings = now;
                        ensureGameSettings();
                    }
                }

                if (now - lastBeat > SYS.PRESENCE_BEAT) {
                    lastBeat = now;
                    Patcher.presence(game);
                }
            }
        } finally {
            Patcher.remove(game);
        }

        if (!RT.running) return "stop";

        if (timedOut) {
            UI.pushHistory(g, "timeout");
            UI.log("[Session] Time limit reached", "warn");
            return "timeout";
        }

        if (banned) {
            RT.banned.add(String(g.id));
            store.write(CONFIG.BANNED_KEY, [...RT.banned]);
            UI.pushHistory(g, "banned");
            UI.log(`[Control] Banned "${g.name}"`, "warn");
            return "banned";
        }

        if (skipped) {
            UI.pushHistory(g, "skipped");
            UI.log(`[Control] Skipped "${g.name}"`, "warn");
            return "skipped";
        }

        RT.played.add(String(g.id));
        store.write(CONFIG.PLAYED_KEY, [...RT.played]);
        RT.stats.played += 1;
        RT.stats.minutes += totalMs / 60000;
        store.write(CONFIG.STATS_KEY, RT.stats);

        UI.pushHistory(g, "played");
        Sound.beep(880, 0.12, 0.28);
        return "played";
    }

    async function runSession(pool) {
        const total = Math.min(RT.target, pool.length);
        if (!total) {
            UI.log("[Session] Nothing to play after filtering", "err");
            return { timeUp: false };
        }

        const batchStart = Date.now();
        const len = RT.randomDuration
            ? `${Math.min(RT.duration, RT.durationMax)}-${Math.max(RT.duration, RT.durationMax)}s`
            : `${RT.duration}s`;
        UI.log(`[Session] ${total} games, ${len} each, gap ${RT.gap}s${RT.maxMinutes ? `, limit ${RT.maxMinutes}m` : ""}`, "info");

        if (RT.notify && typeof Notification !== "undefined" && Notification.permission === "default") {
            try { await Notification.requestPermission(); } catch (_) { }
        }

        let done = 0;
        let skipped = 0;
        let banned = 0;
        let failed = 0;
        let timeUp = false;

        for (let i = 0; i < total && RT.running; i++) {
            UI.log(`[Game ${i + 1}/${total}] ${pool[i].name}`, "debug");

            try {
                const status = await playOne(pool[i], i + 1, total);
                if (status === "stop") break;
                if (status === "timeout") { timeUp = true; break; }
                if (status === "played") done++;
                else if (status === "skipped") skipped++;
                else if (status === "banned") banned++;
            } catch (e) {
                failed++;
                UI.log(`[Game] Failed "${pool[i].name}": ${e?.message ?? e}`, "err");
                try { Patcher.clean(); } catch (_) { }
            }

            if (i < total - 1 && RT.gap > 0 && RT.running) {
                const gapStart = Date.now();
                while (RT.running && Date.now() - gapStart < RT.gap * 1000) {
                    if (RT.maxMinutes > 0 && Date.now() - RT.sessionStart >= RT.maxMinutes * 60000) {
                        timeUp = true;
                        break;
                    }
                    UI.tick(0, RT.gap - (Date.now() - gapStart) / 1000, Math.floor((Date.now() - RT.sessionStart) / 60000), false, sessionLeft());
                    await sleep(SYS.TICK);
                }
            }

            if (timeUp) break;
        }

        if (!RT.running) return { timeUp: false };

        const spent = Math.round((Date.now() - batchStart) / 60000);
        const parts = [`${done} played`];
        if (skipped) parts.push(`${skipped} skipped`);
        if (banned) parts.push(`${banned} banned`);
        if (failed) parts.push(`${failed} failed`);
        parts.push(`${spent}m total`);
        if (timeUp) parts.push("time limit");

        UI.log(`[Session] Done. ${parts.join(", ")}.`, failed || banned || timeUp ? "warn" : "success");
        Sound.beep(523.25, 0.14, 0.45);
        setTimeout(() => Sound.beep(783.99, 0.22, 0.45), 170);
        notify("Steam Game Farmer", `${done} games played, ${spent}m`);
        return { timeUp };
    }

    async function main() {
        UI.init();
        UI.log("[System] Booting...", "info");
        UI.loading("Resolving Discord modules...");

        if (typeof window.DiscordNative === "undefined") {
            UI.log("[System] Browser client detected, game detection needs the desktop app", "warn");
        }

        if (!loadModulesRetry()) {
            UI.log("[System] Failed to resolve Discord modules (Vencord / BD / raw webpack)", "err");
            return UI.shutdown();
        }

        Patcher.init();

        const patched = Object.keys(Patcher.real).length;
        if (!patched) {
            UI.log("[System] RunningGameStore exposes no known methods, client build changed", "err");
            return UI.shutdown();
        }
        UI.log(`[System] Patched ${patched} store methods`, "debug");

        await ensureGameSettings();
        if (!Mods.ShowCurrentGame) {
            UI.log("[System] Could not toggle show current game, enable it manually in profile settings", "warn");
        } else if (RT.prevShowGame === false) {
            UI.log("[System] Enabled show current game for this session", "info");
        }
        if (RT.prevRecentGames === false) {
            UI.log("[System] Enabled recent games for this session", "info");
        }
        UI.loading("Loading app list...");

        try {
            await GameSource.load();
        } catch (e) {
            UI.log(`[System] Game list unavailable: ${e?.message ?? e}`, "err");
            return UI.shutdown();
        }

        while (RT.running) {
            const steamCount = GameSource.steamOnly().length;
            if (!steamCount) {
                UI.log("[System] No Steam-linked apps, falling back to all detectable", "warn");
            }

            const go = await UI.showSetup(GameSource.all.length, steamCount);
            if (!go || !RT.running) break;

            const runSteam = GameSource.steamOnly().length > 0;
            RT.sessionStart = Date.now();
            UI.renderRun();

            const label = runSteam ? "steam only" : "all detectable";
            let batch = 0;

            while (RT.running) {
                if (batch > 0) {
                    if (sessionLeft() === 0) {
                        UI.log("[Session] Time limit reached, stopping loop", "warn");
                        break;
                    }
                    UI.log(`[Session] Next batch ${batch + 1}`, "info");
                    await sleep(1200);
                    if (!RT.running) break;
                }

                const picked = GameSource.selected();
                const pool = picked !== null ? picked : GameSource.pool(runSteam, batch > 0);
                const mode = picked !== null ? "picked" : label;

                if (!pool.length) {
                    if (!batch) {
                        UI.log("[Session] Pool is empty, nothing to play", "err");
                        return UI.shutdown();
                    }
                    UI.log("[Session] No unplayed games left, stopping loop", "success");
                    break;
                }

                if (!batch) {
                    UI.log(`[Session] Pool: ${pool.length} apps (${mode})`, "info");
                }
                if (pool.length < RT.target) {
                    UI.log(`[Session] Only ${pool.length} available, batch capped`, "warn");
                }

                const result = await runSession(pool);
                batch++;

                if (!RT.running) break;
                if (!RT.loop) break;
                if (result?.timeUp) break;
            }

            if (!RT.running) break;

            if (batch > 1) {
                UI.log(`[Session] Loop stopped after ${batch} batches.`, "success");
            }

            const again = await UI.awaitRestart();
            if (!again) break;
        }
    }

    main().catch(e => {
        console.error("[GameFarm]", e);
        try { UI.log(`[FATAL] ${e?.message ?? e}`, "err"); } catch (_) { }
        try { UI.shutdown(); } catch (_) { }
        window.__gfLock = false;
    });
})();
