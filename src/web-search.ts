// ── Web Search ────────────────────────────────────────────────────────────────
// Primary: DuckDuckGo Instant Answer API (free, no key needed)
// Enhanced: Brave Search API (optional, better results when BRAVE_API_KEY is set)

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function duckDuckGoSearch(query: string, count = 5): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PersonalAssistantBot/1.0)" },
  });
  if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);

  const data = await res.json() as {
    Answer?: string;
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const results: SearchResult[] = [];

  // Instant answer (e.g. currency rates, calculations)
  if (data.Answer) {
    results.push({ title: "תשובה מיידית", url: data.AbstractURL ?? "", description: data.Answer });
  }
  // Abstract (Wikipedia-style summary)
  if (data.AbstractText) {
    results.push({ title: data.Heading ?? query, url: data.AbstractURL ?? "", description: data.AbstractText });
  }
  // Related topics
  for (const topic of data.RelatedTopics ?? []) {
    if (results.length >= count) break;
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 120), url: topic.FirstURL, description: topic.Text });
    }
    // Nested topics
    for (const sub of topic.Topics ?? []) {
      if (results.length >= count) break;
      if (sub.Text && sub.FirstURL) {
        results.push({ title: sub.Text.slice(0, 120), url: sub.FirstURL, description: sub.Text });
      }
    }
  }

  return results.slice(0, count);
}

async function braveSearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
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

export async function webSearch(query: string, count = 5): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;

  // Try Brave first if key is configured
  if (apiKey) {
    try {
      return await braveSearch(query, count, apiKey);
    } catch (err) {
      console.warn("[search] Brave API failed, falling back to DuckDuckGo:", (err as Error).message);
    }
  }

  // Fallback: DuckDuckGo (always available, no key needed)
  return duckDuckGoSearch(query, count);
}

// ── Exchange rates (free, no key) ─────────────────────────────────────────────

export async function getExchangeRate(from: string, to: string): Promise<{ rate: number; from: string; to: string }> {
  const url = `https://open.er-api.com/v6/latest/${from.toUpperCase()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Exchange rate API error: ${res.status}`);
  const data = await res.json() as { rates: Record<string, number>; result: string };
  if (data.result !== "success") throw new Error("Exchange rate fetch failed");
  const rate = data.rates[to.toUpperCase()];
  if (!rate) throw new Error(`Currency ${to} not found`);
  return { rate: Math.round(rate * 1000) / 1000, from: from.toUpperCase(), to: to.toUpperCase() };
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
  "בית חרות": { lat: 32.3667, lon: 34.8833, name: "בית חרות" },
  "beit herut": { lat: 32.3667, lon: 34.8833, name: "בית חרות" },
};

const DEFAULT_CITY = CITIES["בית חרות"];

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
