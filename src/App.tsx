import {
	ExternalLink,
	KeyRound,
	LayoutGrid,
	Search,
	X,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type DailyNews,
	DEFAULT_API_BASE,
	type EpicGame,
	type ExchangeRate,
	endpoints,
	type FuelPrice,
	type GoldPrice,
	normalizeApiBase,
	normalizeApiBaseInput,
	toItems,
	type WeatherForecast,
	type WeatherRealtime,
} from "./api";
import {
	defaultHomeCardLayout,
	normalizeHomeCardLayout,
	type HomeCardLayout,
} from "./cards";
import { EndpointLab } from "./components/EndpointLab";
import { Header } from "./components/Header";
import { HotPage } from "./components/Hot";
import { MarketStrip } from "./components/HomeCards";
import { HomePage } from "./components/HomePage";
import { NewsPage } from "./components/News";
import { PwaStatusBar } from "./components/PwaStatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { ToolWorkspace } from "./components/ToolWorkspace";
import { WeatherPage } from "./components/Weather";
import { Footer } from "./components/ui";
import {
	chromeThemes,
	colorThemes,
	API_DOCS_URL,
	API_REPO_URL,
	defaultHotBoardPreferences,
	defaultQuickFavorites,
	hotBoards,
	hotTabs,
	mobileNavModes,
	quickActions,
	searchProviders,
	STORAGE_KEYS,
	wallpaperOptions,
} from "./config";
import { useApi } from "./hooks/useApi";
import {
	clearStoredPrefix,
	readStoredJson,
	readStoredValue,
	writeStoredJson,
	writeStoredValue,
} from "./storage";
import type {
	ApiState,
	AccentThemeState,
	AvatarState,
	ChromeTheme,
	ColorTheme,
	EndpointFavoriteId,
	HotBoardId,
	MobileNavMode,
	PageId,
	QuickActionDefinition,
	QuickFavoriteId,
	ResolvedColorTheme,
	SearchProviderId,
	SettingsState,
	ToolId,
	WallpaperState,
} from "./types";
import {
	buildSearchTarget,
	getAccentStyle,
	getWallpaperStyle,
} from "./utils";
import {
	applyServiceWorkerUpdate,
	registerServiceWorker,
} from "./pwa";

const DEFAULT_CITY = "上海";
const DEFAULT_SEARCH_PROVIDER: SearchProviderId = "bing";
const DEFAULT_CHROME_THEME: ChromeTheme = "classic";
const DEFAULT_COLOR_THEME: ColorTheme = "system";
const DEFAULT_ACCENT_THEME: AccentThemeState = { mode: "green" };
const DEFAULT_MOBILE_NAV_MODE: MobileNavMode = "auto";
const DEFAULT_SETTINGS_STATE: SettingsState = {
	showSearch: true,
	showWeather: true,
	showHot: true,
	showNews: true,
	autoRefresh: false,
};
const DEFAULT_AVATAR_STATE: AvatarState = { mode: "default" };
const DEFAULT_WALLPAPER_STATE: WallpaperState = { mode: "default" };
const CONFIG_EXPORT_VERSION = 2;
const PAGE_IDS: PageId[] = ["home", "hot", "news", "weather", "tools", "settings"];
const IP_CITY_ENDPOINT = "https://ipwho.is/?lang=zh-CN";

type ConfigActionResult = {
	ok: boolean;
	message: string;
};

type ExportedSettings = {
	apiBase: string;
	city: string;
	searchProvider: SearchProviderId;
	chromeTheme: ChromeTheme;
	colorTheme: ColorTheme;
	accentTheme: AccentThemeState;
	mobileNavMode: MobileNavMode;
	wallpaper: WallpaperState;
	avatar: AvatarState;
	modules: SettingsState;
	homeCardLayout: HomeCardLayout;
	endpointFavorites: EndpointFavoriteId[];
	quickFavorites: QuickFavoriteId[];
	hotBoardPreferences: HotBoardId[];
};

function normalizeEndpointFavorites(value: unknown): EndpointFavoriteId[] {
	if (!Array.isArray(value)) return [];
	const knownIds = new Set(endpoints.map((endpoint) => endpoint.id));
	const assigned = new Set<string>();
	const favorites: EndpointFavoriteId[] = [];

	for (const item of value) {
		if (typeof item !== "string" || !knownIds.has(item) || assigned.has(item)) {
			continue;
		}
		assigned.add(item);
		favorites.push(item);
	}

	return favorites;
}

function normalizeQuickFavorites(
	value: unknown,
	fallback: QuickFavoriteId[] = defaultQuickFavorites,
): QuickFavoriteId[] {
	if (value === undefined || !Array.isArray(value)) return [...fallback];
	const knownIds = new Set(quickActions.map((action) => action.id));
	const assigned = new Set<string>();
	const favorites: QuickFavoriteId[] = [];

	for (const item of value) {
		if (typeof item !== "string") continue;
		const id = item as QuickFavoriteId;
		if (!knownIds.has(id) || assigned.has(id)) {
			continue;
		}
		assigned.add(id);
		favorites.push(id);
	}

	return favorites;
}

function normalizeHotBoardPreferences(
	value: unknown,
	fallback: HotBoardId[] = defaultHotBoardPreferences,
): HotBoardId[] {
	if (value === undefined || !Array.isArray(value)) return [...fallback];
	const knownIds = new Set<HotBoardId>(
		hotBoards.map((board) => board.id),
	);
	const assigned = new Set<string>();
	const preferences: HotBoardId[] = [];

	for (const item of value) {
		if (typeof item !== "string") continue;
		const id = item as HotBoardId;
		if (!knownIds.has(id) || assigned.has(id)) continue;
		assigned.add(id);
		preferences.push(id);
	}

	return preferences.length > 0 ? preferences : [...fallback];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown, fallback: string) {
	return typeof value === "string" ? value : fallback;
}

function getIpLocationCity(payload: unknown) {
	if (!isRecord(payload) || payload.success === false) return "";
	const city =
		readString(payload.city, "").trim() || readString(payload.region, "").trim();
	if (!city || city.length > 32) return "";
	return city.replace(/市$/, "");
}

function readBoolean(value: unknown, fallback: boolean, label: string) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new Error(`${label} 配置格式无效`);
	}
	return value;
}

function readEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	label: string,
) {
	if (value === undefined) return fallback;
	if (typeof value === "string" && allowed.includes(value as T)) return value as T;
	throw new Error(`${label} 配置值无效`);
}

function normalizeChromeTheme(value: unknown): ChromeTheme {
	if (value === "single") return "single";
	if (value === "floating") return "floating";
	return "classic";
}

function getSystemColorTheme(): ResolvedColorTheme {
	if (typeof window === "undefined" || !window.matchMedia) return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function normalizeColorTheme(value: unknown): ColorTheme {
	return colorThemes.some((theme) => theme.id === value)
		? (value as ColorTheme)
		: DEFAULT_COLOR_THEME;
}

function normalizePageId(value: unknown): PageId {
	return typeof value === "string" && PAGE_IDS.includes(value as PageId)
		? (value as PageId)
		: "home";
}

function normalizeSearchProvider(value: unknown): SearchProviderId {
	return searchProviders.some((provider) => provider.id === value)
		? (value as SearchProviderId)
		: DEFAULT_SEARCH_PROVIDER;
}

function normalizeSettingsState(value: unknown): SettingsState {
	if (!isRecord(value)) return DEFAULT_SETTINGS_STATE;
	return {
		showSearch:
			typeof value.showSearch === "boolean"
				? value.showSearch
				: DEFAULT_SETTINGS_STATE.showSearch,
		showWeather:
			typeof value.showWeather === "boolean"
				? value.showWeather
				: DEFAULT_SETTINGS_STATE.showWeather,
		showHot:
			typeof value.showHot === "boolean"
				? value.showHot
				: DEFAULT_SETTINGS_STATE.showHot,
		showNews:
			typeof value.showNews === "boolean"
				? value.showNews
				: DEFAULT_SETTINGS_STATE.showNews,
		autoRefresh:
			typeof value.autoRefresh === "boolean"
				? value.autoRefresh
				: DEFAULT_SETTINGS_STATE.autoRefresh,
	};
}

function readInitialApiBase() {
    return DEFAULT_API_BASE;
}

function normalizeAccentTheme(value: unknown): AccentThemeState {
	if (!isRecord(value)) return DEFAULT_ACCENT_THEME;
	const mode = readEnum(
		value.mode,
		["green", "blue", "coral", "violet", "custom"] as const,
		DEFAULT_ACCENT_THEME.mode,
		"主题色",
	);
	const color = typeof value.color === "string" ? value.color : undefined;
	if (mode === "custom") {
		return /^#?[0-9a-f]{6}$/i.test(color || "")
			? { mode, color: color?.startsWith("#") ? color : `#${color}` }
			: DEFAULT_ACCENT_THEME;
	}
	return { mode };
}

function hasStored60sSettings() {
	if (typeof window === "undefined") return false;
	return Object.keys(window.localStorage).some((key) =>
		key.startsWith("60s-web:"),
	);
}

function readStoredMobileNavMode(): MobileNavMode {
	if (typeof window === "undefined") return DEFAULT_MOBILE_NAV_MODE;
	const value = window.localStorage.getItem(STORAGE_KEYS.mobileNavMode);
	const allowed = mobileNavModes.map((item) => item.id);
	if (value && allowed.includes(value as MobileNavMode)) {
		return value as MobileNavMode;
	}
	return hasStored60sSettings() ? "bottom" : DEFAULT_MOBILE_NAV_MODE;
}

function parseImportedConfig(raw: string): ExportedSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("配置文件不是有效 JSON");
	}
	if (!isRecord(parsed) || parsed.app !== "60s-web") {
		throw new Error("这不是 60s-web 的配置文件");
	}
	if (parsed.version !== 1 && parsed.version !== CONFIG_EXPORT_VERSION) {
		throw new Error("配置文件版本不兼容");
	}
	if (!isRecord(parsed.settings)) {
		throw new Error("配置文件缺少 settings 字段");
	}

	const config = parsed.settings;
	const importedApiBase = readString(config.apiBase, DEFAULT_API_BASE).trim();
	const apiBase = importedApiBase
		? normalizeApiBaseInput(importedApiBase)
		: DEFAULT_API_BASE;
	const wallpaperConfig = isRecord(config.wallpaper) ? config.wallpaper : {};
	const wallpaperMode = readEnum(
		wallpaperConfig.mode,
		wallpaperOptions.map((item) => item.id),
		DEFAULT_WALLPAPER_STATE.mode,
		"壁纸",
	);
	const modules = isRecord(config.modules) ? config.modules : {};

	return {
		apiBase,
		city: readString(config.city, DEFAULT_CITY).trim() || DEFAULT_CITY,
		searchProvider: normalizeSearchProvider(config.searchProvider),
		chromeTheme: normalizeChromeTheme(config.chromeTheme),
		colorTheme: readEnum(
			config.colorTheme,
			colorThemes.map((item) => item.id),
			DEFAULT_COLOR_THEME,
			"明暗主题",
		),
		accentTheme: normalizeAccentTheme(config.accentTheme),
		mobileNavMode: readEnum(
			config.mobileNavMode,
			mobileNavModes.map((item) => item.id),
			DEFAULT_MOBILE_NAV_MODE,
			"导航",
		),
		wallpaper:
			wallpaperMode === "custom" ? DEFAULT_WALLPAPER_STATE : { mode: wallpaperMode },
		avatar: DEFAULT_AVATAR_STATE,
		modules: {
			showSearch: readBoolean(
				modules.showSearch,
				DEFAULT_SETTINGS_STATE.showSearch,
				"搜索栏",
			),
			showWeather: readBoolean(
				modules.showWeather,
				DEFAULT_SETTINGS_STATE.showWeather,
				"天气模块",
			),
			showHot: readBoolean(
				modules.showHot,
				DEFAULT_SETTINGS_STATE.showHot,
				"热榜模块",
			),
			showNews: readBoolean(
				modules.showNews,
				DEFAULT_SETTINGS_STATE.showNews,
				"新闻模块",
			),
			autoRefresh: readBoolean(
				modules.autoRefresh,
				DEFAULT_SETTINGS_STATE.autoRefresh,
				"自动刷新",
			),
		},
		homeCardLayout: normalizeHomeCardLayout(
			isRecord(config.homeCardLayout) ? config.homeCardLayout : undefined,
		),
		endpointFavorites: normalizeEndpointFavorites(config.endpointFavorites),
		quickFavorites: normalizeQuickFavorites(config.quickFavorites),
		hotBoardPreferences: normalizeHotBoardPreferences(config.hotBoardPreferences),
	};
}

export function App() {
	const shouldAutoDetectCity = useRef(
		typeof window !== "undefined" &&
			!window.localStorage.getItem(STORAGE_KEYS.city) &&
			!window.localStorage.getItem(STORAGE_KEYS.cityAutoDetected),
	);
	const [apiBase, setApiBase] = useState(readInitialApiBase);
	const [city, setCity] = useState(() =>
		readStoredValue(STORAGE_KEYS.city, DEFAULT_CITY),
	);
	const [query, setQuery] = useState("");
	const [quickDrawerOpen, setQuickDrawerOpen] = useState(false);
	const quickDrawerCloseTimer = useRef<number | null>(null);
	const [activePage, setActivePage] = useState<PageId>(() =>
		normalizePageId(readStoredValue(STORAGE_KEYS.activePage, "home")),
	);
	const [activeTool, setActiveTool] = useState<ToolId>("translate");
	const [searchProvider, setSearchProvider] = useState<SearchProviderId>(
		() => normalizeSearchProvider(
			readStoredValue(STORAGE_KEYS.searchProvider, DEFAULT_SEARCH_PROVIDER),
		),
	);
	const [chromeTheme, setChromeTheme] = useState<ChromeTheme>(
		() => normalizeChromeTheme(readStoredValue(
			STORAGE_KEYS.chromeTheme,
			DEFAULT_CHROME_THEME,
		)),
	);
	const [colorTheme, setColorTheme] = useState<ColorTheme>(
		() => normalizeColorTheme(readStoredValue(
			STORAGE_KEYS.colorTheme,
			DEFAULT_COLOR_THEME,
		)),
	);
	const [systemColorTheme, setSystemColorTheme] =
		useState<ResolvedColorTheme>(getSystemColorTheme);
	const [accentTheme, setAccentTheme] = useState<AccentThemeState>(() =>
		normalizeAccentTheme(
			readStoredJson(STORAGE_KEYS.accentTheme, DEFAULT_ACCENT_THEME),
		),
	);
	const [mobileNavMode, setMobileNavMode] = useState<MobileNavMode>(
		readStoredMobileNavMode,
	);
	const [hotTab, setHotTab] = useState<(typeof hotTabs)[number]>(hotTabs[0]);
	const [avatar, setAvatar] = useState<AvatarState>(() =>
		readStoredJson(STORAGE_KEYS.avatar, DEFAULT_AVATAR_STATE),
	);
	const [wallpaper, setWallpaper] = useState<WallpaperState>(() =>
		readStoredJson(STORAGE_KEYS.wallpaper, DEFAULT_WALLPAPER_STATE),
	);
	const [settings, setSettings] = useState<SettingsState>(() =>
		normalizeSettingsState(
			readStoredJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS_STATE),
		),
	);
	const [homeCardLayout, setHomeCardLayout] = useState<HomeCardLayout>(() =>
		normalizeHomeCardLayout(
			readStoredJson(STORAGE_KEYS.homeCardLayout, defaultHomeCardLayout),
		),
	);
	const [endpointFavorites, setEndpointFavorites] = useState<
		EndpointFavoriteId[]
	>(() =>
		normalizeEndpointFavorites(
			readStoredJson(STORAGE_KEYS.endpointFavorites, []),
		),
	);
	const [quickFavorites, setQuickFavorites] = useState<QuickFavoriteId[]>(() =>
		normalizeQuickFavorites(
			readStoredJson(STORAGE_KEYS.quickFavorites, defaultQuickFavorites),
		),
	);
	const [hotBoardPreferences, setHotBoardPreferences] = useState<HotBoardId[]>(
		() =>
			normalizeHotBoardPreferences(
				readStoredJson(
					STORAGE_KEYS.hotBoardPreferences,
					defaultHotBoardPreferences,
				),
			),
	);
	const [isOffline, setIsOffline] = useState(() =>
		typeof navigator === "undefined" ? false : !navigator.onLine,
	);
	const [serviceWorkerUpdate, setServiceWorkerUpdate] =
		useState<ServiceWorkerRegistration | null>(null);
	const [showApiGuide, setShowApiGuide] = useState(false);
	const hasApiBase = Boolean(apiBase.trim());
	const hasSearchQuery = Boolean(query.trim());
	const resolvedColorTheme =
		colorTheme === "system" ? systemColorTheme : colorTheme;
	const visibleHotTabs = useMemo(() => {
		const preferenceSet = new Set(hotBoardPreferences);
		return hotTabs.filter((tab) =>
			preferenceSet.has(tab.id as HotBoardId),
		);
	}, [hotBoardPreferences]);

	const clearQuickDrawerClose = () => {
		if (quickDrawerCloseTimer.current === null) return;
		window.clearTimeout(quickDrawerCloseTimer.current);
		quickDrawerCloseTimer.current = null;
	};

	const openQuickDrawer = () => {
		clearQuickDrawerClose();
		setQuickDrawerOpen(true);
	};

	const scheduleQuickDrawerClose = () => {
		clearQuickDrawerClose();
		quickDrawerCloseTimer.current = window.setTimeout(() => {
			setQuickDrawerOpen(false);
			quickDrawerCloseTimer.current = null;
		}, 220);
	};

	useEffect(() => {
		return clearQuickDrawerClose;
	}, []);

	const daily = useApi<DailyNews>(
		apiBase,
		"/60s",
		{},
		settings.showNews && hasApiBase,
	);
	const weather = useApi<WeatherRealtime>(
		apiBase,
		"/weather/realtime",
		{ query: city },
		settings.showWeather && hasApiBase,
	);
	const forecast = useApi<WeatherForecast>(
		apiBase,
		"/weather/forecast",
		{ query: city, days: "7" },
		settings.showWeather && hasApiBase,
	);
	const hot = useApi<unknown>(
		apiBase,
		hotTab.path,
		{},
		settings.showHot && hasApiBase && visibleHotTabs.length > 0,
	);
	const gold = useApi<GoldPrice>(
		apiBase,
		"/gold-price",
		{},
		hasApiBase,
	);
	const fuel = useApi<FuelPrice>(
		apiBase,
		"/fuel-price",
		{ region: city },
		hasApiBase,
	);
	const exchange = useApi<ExchangeRate>(
		apiBase,
		"/exchange-rate",
		{ currency: "CNY" },
		hasApiBase,
	);
	const epic = useApi<EpicGame[]>(
		apiBase,
		"/epic",
		{},
		hasApiBase,
	);
	const maoyan = useApi<unknown>(
		apiBase,
		"/maoyan/realtime/movie",
		{},
		hasApiBase,
	);
	const hitokoto = useApi<unknown>(
		apiBase,
		"/hitokoto",
		{},
		hasApiBase,
	);

	const hotItems = useMemo(() => toItems(hot.data).slice(0, 10), [hot.data]);
	const movieItems = useMemo(
		() => toItems(maoyan.data).slice(0, 4),
		[maoyan.data],
	);



	useEffect(() => {
		if (!apiBase.trim()) return;
		try {
			normalizeApiBase(apiBase);
			setShowApiGuide(false);
		} catch {
			// Keep the guide available until the saved API address is valid.
		}
	}, [apiBase]);

	useEffect(() => {
		if (!shouldAutoDetectCity.current) return;

		let cancelled = false;
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 5000);

		fetch(IP_CITY_ENDPOINT, { signal: controller.signal })
			.then((response) => (response.ok ? response.json() : null))
			.then((payload) => {
				const detectedCity = getIpLocationCity(payload);
				if (!detectedCity) return;
				setCity((current) => {
					const currentCity = current.trim();
					if (currentCity && currentCity !== DEFAULT_CITY) return current;
					return detectedCity;
				});
			})
			.catch(() => {
				// Location lookup is only a convenience; keep the default city on failure.
			})
			.finally(() => {
				window.clearTimeout(timeout);
				if (!cancelled) {
					shouldAutoDetectCity.current = false;
					writeStoredValue(STORAGE_KEYS.cityAutoDetected, "true");
				}
			});

		return () => {
			cancelled = true;
			controller.abort();
			window.clearTimeout(timeout);
		};
	}, []);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.city, city);
	}, [city]);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.activePage, activePage);
	}, [activePage]);

	useEffect(() => {
		writeStoredJson(STORAGE_KEYS.settings, settings);
	}, [settings]);

	useEffect(() => {
		writeStoredJson(STORAGE_KEYS.homeCardLayout, homeCardLayout);
	}, [homeCardLayout]);

	useEffect(() => {
		writeStoredJson(
			STORAGE_KEYS.endpointFavorites,
			normalizeEndpointFavorites(endpointFavorites),
		);
	}, [endpointFavorites]);

	useEffect(() => {
		writeStoredJson(
			STORAGE_KEYS.quickFavorites,
			normalizeQuickFavorites(quickFavorites, []),
		);
	}, [quickFavorites]);

	useEffect(() => {
		writeStoredJson(
			STORAGE_KEYS.hotBoardPreferences,
			normalizeHotBoardPreferences(hotBoardPreferences, []),
		);
	}, [hotBoardPreferences]);

	useEffect(() => {
		writeStoredJson(STORAGE_KEYS.avatar, avatar);
	}, [avatar]);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.searchProvider, searchProvider);
	}, [searchProvider]);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.chromeTheme, chromeTheme);
	}, [chromeTheme]);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.colorTheme, colorTheme);
	}, [colorTheme]);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const syncSystemTheme = () => setSystemColorTheme(getSystemColorTheme());
		syncSystemTheme();
		media.addEventListener("change", syncSystemTheme);
		return () => media.removeEventListener("change", syncSystemTheme);
	}, []);

	useEffect(() => {
		writeStoredJson(STORAGE_KEYS.accentTheme, normalizeAccentTheme(accentTheme));
	}, [accentTheme]);

	useEffect(() => {
		writeStoredValue(STORAGE_KEYS.mobileNavMode, mobileNavMode);
	}, [mobileNavMode]);

	useEffect(() => {
		const updateOnlineState = () => setIsOffline(!navigator.onLine);
		window.addEventListener("online", updateOnlineState);
		window.addEventListener("offline", updateOnlineState);
		updateOnlineState();
		return () => {
			window.removeEventListener("online", updateOnlineState);
			window.removeEventListener("offline", updateOnlineState);
		};
	}, []);

	useEffect(() => registerServiceWorker(setServiceWorkerUpdate), []);

	useEffect(() => {
		const themeColor = resolvedColorTheme === "dark" ? "#07100f" : "#ffffff";
		let meta = document.querySelector<HTMLMetaElement>(
			'meta[name="theme-color"]',
		);
		if (!meta) {
			meta = document.createElement("meta");
			meta.name = "theme-color";
			document.head.appendChild(meta);
		}
		meta.content = themeColor;
	}, [resolvedColorTheme]);

	useEffect(() => {
		if (visibleHotTabs.some((tab) => tab.id === hotTab.id)) return;
		if (visibleHotTabs[0]) setHotTab(visibleHotTabs[0]);
	}, [hotTab.id, visibleHotTabs]);

	useEffect(() => {
		writeStoredJson(STORAGE_KEYS.wallpaper, wallpaper);
	}, [wallpaper]);

	const applyImportedSettings = (config: ExportedSettings) => {
		setApiBase(config.apiBase);
		setCity(config.city);
		setSearchProvider(config.searchProvider);
		setChromeTheme(config.chromeTheme);
		setColorTheme(config.colorTheme);
		setAccentTheme(config.accentTheme);
		setMobileNavMode(config.mobileNavMode);
		setWallpaper(config.wallpaper);
		setAvatar(config.avatar);
		setSettings(config.modules);
		setHomeCardLayout(config.homeCardLayout);
		setEndpointFavorites(config.endpointFavorites);
		setQuickFavorites(config.quickFavorites);
		setHotBoardPreferences(config.hotBoardPreferences);
	};

	const exportConfig = (): ConfigActionResult => {
		const exportWallpaper =
			wallpaper.mode === "custom"
				? DEFAULT_WALLPAPER_STATE
				: { mode: wallpaper.mode };
		const payload = {
			app: "60s-web",
			version: CONFIG_EXPORT_VERSION,
			exportedAt: new Date().toISOString(),
			settings: {
				apiBase,
				city,
				searchProvider,
				chromeTheme,
				colorTheme,
				accentTheme: normalizeAccentTheme(accentTheme),
				mobileNavMode,
				wallpaper: exportWallpaper,
				avatar: DEFAULT_AVATAR_STATE,
				modules: settings,
				homeCardLayout: normalizeHomeCardLayout(homeCardLayout),
				endpointFavorites: normalizeEndpointFavorites(endpointFavorites),
				quickFavorites: normalizeQuickFavorites(quickFavorites, []),
				hotBoardPreferences: normalizeHotBoardPreferences(
					hotBoardPreferences,
					[],
				),
			},
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `60s-web-config-${new Date().toISOString().slice(0, 10)}.json`;
		link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
		return {
			ok: true,
			message: "配置已导出，本地头像、QQ 号和自定义壁纸不会写入文件。",
		};
	};

	const importConfig = (raw: string): ConfigActionResult => {
		try {
			const config = parseImportedConfig(raw);
			applyImportedSettings(config);
			return { ok: true, message: "配置已导入，页面设置已更新。" };
		} catch (error) {
			return {
				ok: false,
				message:
					error instanceof Error ? error.message : "配置导入失败，请检查文件。",
			};
		}
	};

	const resetConfig = (): ConfigActionResult => {
		clearStoredPrefix("60s-web:");
		applyImportedSettings({
			apiBase: DEFAULT_API_BASE,
			city: DEFAULT_CITY,
			searchProvider: DEFAULT_SEARCH_PROVIDER,
			chromeTheme: DEFAULT_CHROME_THEME,
			colorTheme: DEFAULT_COLOR_THEME,
			accentTheme: DEFAULT_ACCENT_THEME,
			mobileNavMode: DEFAULT_MOBILE_NAV_MODE,
			wallpaper: DEFAULT_WALLPAPER_STATE,
			avatar: DEFAULT_AVATAR_STATE,
			modules: DEFAULT_SETTINGS_STATE,
			homeCardLayout: normalizeHomeCardLayout(defaultHomeCardLayout),
			endpointFavorites: [],
			quickFavorites: defaultQuickFavorites,
			hotBoardPreferences: defaultHotBoardPreferences,
		});
		setShowApiGuide(true);
		return { ok: true, message: "已恢复默认设置，并清理本地缓存。" };
	};

	const runQuickAction = (action: QuickActionDefinition) => {
		const target = action.target;
		if (target.page === "hot") {
			const tab = hotTabs.find((item) => item.id === target.hotTabId);
			if (tab) setHotTab(tab);
			setActivePage("hot");
			return;
		}
		if (target.page === "tools") {
			if (target.toolId) setActiveTool(target.toolId);
			setActivePage("tools");
			return;
		}
		setActivePage(target.page);
	};

	const dismissApiGuide = () => {
		setShowApiGuide(false);
	};

	const runSearch = () => {
		const keyword = query.trim();
		if (!keyword) {
			setActivePage("home");
			return;
		}
		window.open(
			buildSearchTarget(searchProvider, keyword),
			"_blank",
			"noopener,noreferrer",
		);
	};

	return (
		<div
			className={`app-shell chrome-${chromeTheme} theme-${resolvedColorTheme} wallpaper-${wallpaper.mode}`}
			style={{
				...getWallpaperStyle(wallpaper, resolvedColorTheme),
				...getAccentStyle(accentTheme),
			}}
		>
			<Header
				activePage={activePage}
				setActivePage={setActivePage}
				avatar={avatar}
				setAvatar={setAvatar}
				colorTheme={colorTheme}
				resolvedColorTheme={resolvedColorTheme}
				setColorTheme={setColorTheme}
			/>
			<PwaStatusBar
				isOffline={isOffline}
				updateReady={Boolean(serviceWorkerUpdate)}
				onApplyUpdate={() => {
					applyServiceWorkerUpdate(serviceWorkerUpdate);
					setServiceWorkerUpdate(null);
				}}
			/>

			<main>
				{settings.showSearch && activePage !== "settings" && (
					<section className="search-band">
						<form
							className="search-box"
							onSubmit={(event) => {
								event.preventDefault();
								runSearch();
							}}
						>
							<Search size={24} />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={`用 ${
									searchProviders.find((item) => item.id === searchProvider)
										?.label
								} 搜索...`}
							/>
							{hasSearchQuery && (
								<button
									type="submit"
									className="search-enter"
									aria-label="按 Enter 搜索"
									title="Enter"
								>
									Enter
								</button>
							)}
						</form>
						<div className="search-meta-row">
							<div className="search-providers" aria-label="搜索目的地">
								{searchProviders.map((provider) => (
									<button
										key={provider.id}
										type="button"
										className={searchProvider === provider.id ? "active" : ""}
										onClick={() => setSearchProvider(provider.id)}
										aria-label={`${provider.label} ${provider.sub}`}
										title={`${provider.label} ${provider.sub}`}
									>
										{provider.label}
									</button>
								))}
							</div>
							<details
								className="quick-drawer"
								open={quickDrawerOpen}
								onPointerEnter={openQuickDrawer}
								onPointerLeave={scheduleQuickDrawerClose}
								onFocus={openQuickDrawer}
								onBlur={(event) => {
									const nextTarget = event.relatedTarget;
									if (
										nextTarget instanceof Node &&
										event.currentTarget.contains(nextTarget)
									) {
										return;
									}
									scheduleQuickDrawerClose();
								}}
							>
								<summary
									onClick={(event) => {
										event.preventDefault();
										openQuickDrawer();
									}}
								>
									<LayoutGrid size={15} />
									快捷
								</summary>
								<QuickChips
									favorites={quickFavorites}
									onAction={(action) => {
										setQuickDrawerOpen(false);
										runQuickAction(action);
									}}
									onManage={() => {
										setQuickDrawerOpen(false);
										setActivePage("settings");
									}}
								/>
							</details>
						</div>
					</section>
				)}

				{activePage === "home" && (
					<HomePage
						apiReady={hasApiBase}
						city={city}
						setCity={setCity}
						settings={settings}
						daily={daily}
						weather={weather}
						forecast={forecast}
						gold={gold}
						fuel={fuel}
						exchange={exchange}
						hotTab={hotTab}
						setHotTab={setHotTab}
						hotTabs={visibleHotTabs}
						hot={hot}
						hotItems={hotItems}
						epic={epic}
						movieItems={movieItems}
						hitokoto={hitokoto.data}
						homeCardLayout={homeCardLayout}
						setHomeCardLayout={setHomeCardLayout}
					/>
				)}
				{activePage === "hot" && (
					<HotPage
						apiBase={apiBase}
						visibleHotBoardIds={hotBoardPreferences}
					/>
				)}
				{activePage === "news" && <NewsPage apiBase={apiBase} daily={daily} />}
				{activePage === "weather" && (
					<WeatherPage
						city={city}
						setCity={setCity}
						realtime={weather}
						forecast={forecast}
					/>
				)}
				{activePage === "tools" && (
					<ToolsPage
						apiBase={apiBase}
						query={query}
						gold={gold}
						fuel={fuel}
						exchange={exchange}
						city={city}
						activeTool={activeTool}
						setActiveTool={setActiveTool}
						endpointFavorites={endpointFavorites}
						setEndpointFavorites={setEndpointFavorites}
					/>
				)}
				{activePage === "settings" && (
					<section className="page-stack">
						<SettingsPanel
							apiBase={apiBase}
							setApiBase={setApiBase}
							city={city}
							setCity={setCity}
							wallpaper={wallpaper}
							setWallpaper={setWallpaper}
							chromeTheme={chromeTheme}
							setChromeTheme={setChromeTheme}
							colorTheme={colorTheme}
							setColorTheme={setColorTheme}
							accentTheme={accentTheme}
							setAccentTheme={setAccentTheme}
							settings={settings}
							setSettings={setSettings}
							onExportConfig={exportConfig}
							onImportConfig={importConfig}
							onResetConfig={resetConfig}
							quickFavorites={quickFavorites}
							setQuickFavorites={setQuickFavorites}
							hotBoardPreferences={hotBoardPreferences}
							setHotBoardPreferences={setHotBoardPreferences}
						/>
					</section>
				)}
			</main>

			<Footer
				apiBase={apiBase}
				updatedAt={daily.updatedAt}
				isOffline={isOffline}
			/>
			{showApiGuide && (
				<ApiSetupGuide
					initialApiBase={apiBase}
					onDismiss={dismissApiGuide}
					onSave={(value) => {
						setApiBase(value);
						setShowApiGuide(false);
					}}
				/>
			)}
		</div>
	);
}

function ApiSetupGuide({
	initialApiBase,
	onDismiss,
	onSave,
}: {
	initialApiBase: string;
	onDismiss: () => void;
	onSave: (value: string) => void;
}) {
	const [draft, setDraft] = useState(initialApiBase);
	const [error, setError] = useState("");

	const save = () => {
		try {
			const value = normalizeApiBaseInput(draft);
			onSave(value);
		} catch (saveError) {
			setError(
				saveError instanceof Error ? saveError.message : "API 地址无效",
			);
		}
	};

	return (
		<div className="api-guide-overlay" role="presentation">
			<div
				className="api-guide-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="api-guide-title"
			>
				<button
					type="button"
					className="api-guide-close"
					aria-label="关闭 API 配置引导"
					onClick={onDismiss}
				>
					<X size={18} />
				</button>
				<div className="api-guide-head">
					<KeyRound size={24} />
					<span>
						<b id="api-guide-title">配置 API</b>
					</span>
				</div>
				<div className="api-guide-copy">
					<div className="api-guide-links">
						<a href={API_REPO_URL} target="_blank" rel="noreferrer">
							自行部署 <ExternalLink size={15} />
						</a>
						<a href={API_DOCS_URL} target="_blank" rel="noreferrer">
							查看公共实例列表 <ExternalLink size={15} />
						</a>
					</div>
				</div>
				<label className="api-guide-field">
					<span>API 地址</span>
					<input
						value={draft}
						onChange={(event) => {
							setDraft(event.target.value);
							setError("");
						}}
						placeholder="example.com/v2"
						autoFocus
					/>
				</label>
				{error && (
					<p className="api-guide-error" role="alert">
						{error}
					</p>
				)}
				<div className="api-guide-actions">
					<button type="button" className="outline-button" onClick={onDismiss}>
						稍后再说
					</button>
					<button type="button" className="primary-subtle" onClick={save}>
						保存 API
					</button>
				</div>
			</div>
		</div>
	);
}

function QuickChips({
	favorites,
	onAction,
	onManage,
}: {
	favorites: QuickFavoriteId[];
	onAction: (action: QuickActionDefinition) => void;
	onManage: () => void;
}) {
	const actions = favorites
		.map((id) => quickActions.find((action) => action.id === id))
		.filter((action): action is QuickActionDefinition => Boolean(action));

	return (
		<div className="quick-chips" aria-label="快捷入口">
			{actions.length > 0 ? (
				actions.map((action) => {
					const Icon = action.icon;
					return (
						<button
							key={action.id}
							type="button"
							onClick={() => onAction(action)}
						>
							{Icon ? (
								<Icon size={17} />
							) : (
								<span className={`chip-symbol ${action.symbolTone || ""}`}>
									{action.symbol}
								</span>
							)}
							{action.label}
						</button>
					);
				})
			) : (
				<button type="button" className="manage-chip" onClick={onManage}>
					<LayoutGrid size={17} /> 管理快捷入口
				</button>
			)}
		</div>
	);
}

function ToolsPage({
	apiBase,
	query,
	gold,
	fuel,
	exchange,
	city,
	activeTool,
	setActiveTool,
	endpointFavorites,
	setEndpointFavorites,
}: {
	apiBase: string;
	query: string;
	gold: ApiState<GoldPrice> & { reload: () => void };
	fuel: ApiState<FuelPrice> & { reload: () => void };
	exchange: ApiState<ExchangeRate> & { reload: () => void };
	city: string;
	activeTool: ToolId;
	setActiveTool: (tool: ToolId) => void;
	endpointFavorites: EndpointFavoriteId[];
	setEndpointFavorites: (favorites: EndpointFavoriteId[]) => void;
}) {
	return (
		<section className="page-stack">
			<MarketStrip gold={gold} fuel={fuel} exchange={exchange} city={city} />
			<ToolWorkspace apiBase={apiBase} activeTool={activeTool} />
			<EndpointLab
				apiBase={apiBase}
				query={query}
				favorites={endpointFavorites}
				setFavorites={setEndpointFavorites}
			/>
		</section>
	);
}
