// ── Web Search (Brave Search API) ─────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export async function webSearch(query: string, count = 5): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY not configured. Add it to Railway env vars (free at search.brave.com/app/keys).");
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=he&country=IL`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) throw new Error(`Brave Search error: ${res.status} ${res.statusText}`);
  const data = await res.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

// ── Weather (Open-Meteo — free, no API key) ───────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: "שמש מלאה", 1: "בעיקר שמשי", 2: "מעונן חלקית", 3: "מעונן",
  45: "ערפל", 48: "ערפל קפוא",
  51: "טפטוף קל", 53: "טפטוף", 55: "טפטוף כבד",
  61: "גשם קל", 63: "גשם", 65: "גשם כבד",
  71: "שלג קל", 73: "שלג", 75: "שלג כבד",
  80: "מקלחות גשם", 81: "מקלחות גשם חזקות", 82: "מקלחות סוחפות",
  95: "סופת רעמים", 96: "סופת רעמים עם ברד", 99: "סופת רעמים חזקה",
};

const CITIES: Record<string, { lat: number; lon: number; name: string }> = {
  "תל אביב": { lat: 32.0853, lon: 34.7818, name: "תל אביב" },
  "tel aviv": { lat: 32.0853, lon: 34.7818, name: "תל אביב" },
  "ירושלים": { lat: 31.7683, lon: 35.2137, name: "ירושלים" },
  "jerusalem": { lat: 31.7683, lon: 35.2137, name: "ירושלים" },
  "חיפה": { lat: 32.7940, lon: 34.9896, name: "חיפה" },
  "haifa": { lat: 32.7940, lon: 34.9896, name: "חיפה" },
  "באר שבע": { lat: 31.2518, lon: 34.7915, name: "באר שבע" },
  "רחובות": { lat: 31.8969, lon: 34.8186, name: "רחובות" },
  "הרצליה": { lat: 32.1663, lon: 34.8437, name: "הרצליה" },
  "נתניה": { lat: 32.3215, lon: 34.8532, name: "נתניה" },
  "פתח תקווה": { lat: 32.0878, lon: 34.8878, name: "פתח תקווה" },
  "ראשון לציון": { lat: 31.9730, lon: 34.7925, name: "ראשון לציון" },
};

const DEFAULT_CITY = CITIES["תל אביב"];

export interface WeatherForecast {
  city: string;
  current: { temp: number; description: string; windKmh: number };
  today: { maxTemp: number; minTemp: number; description: string; rainMm: number };
  tomorrow: { maxTemp: number; minTemp: number; description: string; rainMm: number };
}

export async function getWeather(city?: string): Promise<WeatherForecast> {
  const location = city
    ? (CITIES[city.toLowerCase()] ?? CITIES[city] ?? DEFAULT_CITY)
    : DEFAULT_CITY;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${location.lat}&longitude=${location.lon}` +
    `&current=temperature_2m,weathercode,windspeed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
    `&timezone=Asia%2FJerusalem&forecast_days=3`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  const d = await res.json() as {
    current: { temperature_2m: number; weathercode: number; windspeed_10m: number };
    daily: {
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      weathercode: number[];
    };
  };

  return {
    city: location.name,
    current: {
      temp: Math.round(d.current.temperature_2m),
      description: WMO_CODES[d.current.weathercode] ?? "לא ידוע",
      windKmh: Math.round(d.current.windspeed_10m),
    },
    today: {
      maxTemp: Math.round(d.daily.temperature_2m_max[0]),
      minTemp: Math.round(d.daily.temperature_2m_min[0]),
      description: WMO_CODES[d.daily.weathercode[0]] ?? "לא ידוע",
      rainMm: Math.round(d.daily.precipitation_sum[0] * 10) / 10,
    },
    tomorrow: {
      maxTemp: Math.round(d.daily.temperature_2m_max[1]),
      minTemp: Math.round(d.daily.temperature_2m_min[1]),
      description: WMO_CODES[d.daily.weathercode[1]] ?? "לא ידוע",
      rainMm: Math.round(d.daily.precipitation_sum[1] * 10) / 10,
    },
  };
}
