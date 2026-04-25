/**
 * WeatherNow — app.js
 * Lab Exercise 3 | Chapter 4: AJAX, JSON, Fetch API & jQuery
 *
 * Architecture:
 *  - Task 1: Skeleton loading UI (HTML/CSS)
 *  - Task 2: Fetch API chained geocoding → weather
 *  - Task 3: jQuery $.getJSON() for WorldTimeAPI
 *  - Task 4: Error handling, debounce, AbortController
 *  - Bonus : localStorage recent searches, °C/°F toggle
 */

"use strict";

/* ─────────────────────────────────────────────
   CONSTANTS & STATE
───────────────────────────────────────────── */
const API = {
  geocode:  "https://geocoding-api.open-meteo.com/v1/search",
  weather:  "https://api.open-meteo.com/v1/forecast",
  timezone: "https://worldtimeapi.org/api/timezone",
};

// Application state — no global variables leaked to window
const state = {
  currentTempC: null,   // store raw °C for unit toggle
  currentUnit: "C",     // active unit
  lastSearch: null,     // last successful city object
  abortController: null // for in-flight fetch cancellation
};

/* ─────────────────────────────────────────────
   WEATHER CODE LOOKUP
   WMO Weather interpretation codes → text + emoji
───────────────────────────────────────────── */
const WEATHER_CODES = {
  0:  { desc: "Clear sky",               emoji: "☀️"  },
  1:  { desc: "Mainly clear",            emoji: "🌤️" },
  2:  { desc: "Partly cloudy",           emoji: "⛅"  },
  3:  { desc: "Overcast",                emoji: "☁️"  },
  45: { desc: "Foggy",                   emoji: "🌫️" },
  48: { desc: "Icy fog",                 emoji: "🌫️" },
  51: { desc: "Light drizzle",           emoji: "🌦️" },
  53: { desc: "Moderate drizzle",        emoji: "🌦️" },
  55: { desc: "Dense drizzle",           emoji: "🌧️" },
  61: { desc: "Slight rain",             emoji: "🌧️" },
  63: { desc: "Moderate rain",           emoji: "🌧️" },
  65: { desc: "Heavy rain",              emoji: "🌧️" },
  71: { desc: "Slight snowfall",         emoji: "🌨️" },
  73: { desc: "Moderate snowfall",       emoji: "🌨️" },
  75: { desc: "Heavy snowfall",          emoji: "❄️"  },
  77: { desc: "Snow grains",             emoji: "🌨️" },
  80: { desc: "Slight rain showers",     emoji: "🌦️" },
  81: { desc: "Moderate rain showers",   emoji: "🌧️" },
  82: { desc: "Violent rain showers",    emoji: "⛈️"  },
  85: { desc: "Slight snow showers",     emoji: "🌨️" },
  86: { desc: "Heavy snow showers",      emoji: "❄️"  },
  95: { desc: "Thunderstorm",            emoji: "⛈️"  },
  96: { desc: "Thunderstorm w/ hail",    emoji: "⛈️"  },
  99: { desc: "Thunderstorm, heavy hail",emoji: "⛈️"  },
};

/** Resolve a WMO weathercode to { desc, emoji } */
function decodeWeather(code) {
  return WEATHER_CODES[code] ?? { desc: "Unknown", emoji: "🌡️" };
}

/* ─────────────────────────────────────────────
   SKELETON HELPERS
───────────────────────────────────────────── */
function showSkeletons() {
  ["city-name", "weather-desc", "local-time", "temperature",
   "humidity", "wind-speed"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("skeleton");
  });
  buildForecastSkeletons();
}

function clearSkeletons() {
  document.querySelectorAll(".skeleton").forEach(el =>
    el.classList.remove("skeleton")
  );
}

/** Inject 7 skeleton forecast cards */
function buildForecastSkeletons() {
  const row = document.getElementById("forecast-row");
  row.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    row.innerHTML += `
      <div class="forecast-card">
        <div class="fc-day  skeleton skeleton-line"></div>
        <div class="fc-icon skeleton skeleton-line"></div>
        <div class="fc-high skeleton skeleton-line"></div>
        <div class="fc-low  skeleton skeleton-line"></div>
      </div>`;
  }
}

/* ─────────────────────────────────────────────
   ERROR BANNER
───────────────────────────────────────────── */
function showError(message) {
  const banner = document.getElementById("error-banner");
  document.getElementById("error-msg").textContent = "⚠ " + message;
  banner.classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-banner").classList.add("hidden");
}

/* ─────────────────────────────────────────────
   TASK 2 — FETCH API (Geocoding → Weather)
───────────────────────────────────────────── */

/**
 * Step 1: Geocode city name → { name, latitude, longitude, timezone }
 * Returns null if city not found (does NOT throw — just returns null).
 */
async function geocodeCity(cityName, signal) {
  const url = `${API.geocode}?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
  const response = await fetch(url, { signal });

  // Task 4 #16 — explicit HTTP error handling
  if (!response.ok) {
    throw new Error(`Geocoding API error: HTTP ${response.status}`);
  }

  const data = await response.json();

  // Empty results → no match, return null without throwing
  if (!data.results || data.results.length === 0) {
    return null;
  }

  const city = data.results[0];
  return {
    name:      city.name,
    country:   city.country ?? "",
    latitude:  city.latitude,
    longitude: city.longitude,
    timezone:  city.timezone ?? null,
  };
}

/**
 * Step 2: Fetch weather data for given coordinates.
 * Returns the full Open-Meteo JSON response.
 */
async function fetchWeather(lat, lon, signal) {
  const params = new URLSearchParams({
    latitude:       lat,
    longitude:      lon,
    current_weather: true,
    hourly:         "temperature_2m,relativehumidity_2m,windspeed_10m",
    daily:          "temperature_2m_max,temperature_2m_min,weathercode",
    timezone:       "auto",
    forecast_days:  7,
  });

  const url = `${API.weather}?${params}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Weather API error: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Main search handler — chains geocoding → weather, updates UI.
 */
async function handleSearch(cityQuery) {
  const query = cityQuery.trim();

  // Task 4 #17 — validation
  if (query.length < 2) {
    document.getElementById("validation-msg").classList.remove("hidden");
    return;
  }
  document.getElementById("validation-msg").classList.add("hidden");

  // Cancel any in-flight request
  if (state.abortController) state.abortController.abort();

  // Task 4 #19 — AbortController + 10s timeout
  state.abortController = new AbortController();
  const timeoutId = setTimeout(() => state.abortController.abort(), 10_000);

  hideError();
  showSkeletons();

  try {
    const { signal } = state.abortController;

    // ── Step 1: Geocode ──────────────────────────
    const cityInfo = await geocodeCity(query, signal);

    if (!cityInfo) {
      clearSkeletons();
      showError(`City "${query}" not found. Please try another name.`);
      clearTimeout(timeoutId);
      return;
    }

    state.lastSearch = cityInfo;

    // ── Step 2: Weather ──────────────────────────
    const weatherData = await fetchWeather(cityInfo.latitude, cityInfo.longitude, signal);
    clearTimeout(timeoutId);

    // ── Render ───────────────────────────────────
    renderCurrentWeather(cityInfo, weatherData);
    renderForecast(weatherData);

    // ── Task 3: jQuery WorldTimeAPI ──────────────
    fetchLocalTimeJQuery(cityInfo.timezone);

    // ── Bonus: save to recent searches ───────────
    saveRecentSearch(cityInfo.name);
    renderRecentChips();

  } catch (err) {
    clearTimeout(timeoutId);
    clearSkeletons();

    if (err.name === "AbortError") {
      showError("Request timed out (10 s). Please try again.");
    } else {
      showError(err.message || "Network error. Please check your connection.");
    }
    console.error("[WeatherNow] Fetch error:", err);
  }
}

/* ─────────────────────────────────────────────
   RENDER HELPERS
───────────────────────────────────────────── */

function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) { el.textContent = value; el.classList.add("data-loaded"); }
}

/** Render the current-weather card */
function renderCurrentWeather(cityInfo, data) {
  // Save for Celsius/Fahrenheit toggle re-render (no new API call needed)
  state._lastWeatherData = data;
  const cw   = data.current_weather;
  const code = cw.weathercode;
  const { desc, emoji } = decodeWeather(code);

  // Store raw °C for unit toggle (Bonus)
  state.currentTempC = cw.temperature;

  // Get current hour index to read hourly humidity/wind
  const hourIndex = getCurrentHourIndex(data.hourly.time);
  const humidity  = data.hourly.relativehumidity_2m[hourIndex] ?? "--";
  const wind      = cw.windspeed;

  clearSkeletons();

  setEl("city-name",    `${cityInfo.name}, ${cityInfo.country}`);
  setEl("weather-desc", desc);
  setEl("weather-icon", emoji);
  setEl("temperature",  formatTemp(cw.temperature, state.currentUnit));
  setEl("humidity",     `${humidity}%`);
  setEl("wind-speed",   `${wind} km/h`);
}

/** Find the hourly index closest to the current UTC hour */
function getCurrentHourIndex(timeArray) {
  const now = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const idx = timeArray.findIndex(t => t.startsWith(now));
  return idx >= 0 ? idx : 0;
}

/** Render 7 forecast cards */
function renderForecast(data) {
  const row   = document.getElementById("forecast-row");
  const days  = data.daily.time;
  const maxT  = data.daily.temperature_2m_max;
  const minT  = data.daily.temperature_2m_min;
  const codes = data.daily.weathercode;

  row.innerHTML = "";

  days.forEach((dateStr, i) => {
    const { emoji } = decodeWeather(codes[i]);
    const dayLabel  = i === 0 ? "Today" : getDayName(dateStr);
    const high      = formatTemp(maxT[i], state.currentUnit);
    const low       = formatTemp(minT[i], state.currentUnit);

    const card = document.createElement("div");
    card.className = "forecast-card data-loaded";
    card.innerHTML = `
      <div class="fc-day">${dayLabel}</div>
      <div class="fc-icon">${emoji}</div>
      <div class="fc-high">${high}</div>
      <div class="fc-low">${low}</div>`;
    row.appendChild(card);
  });
}

function getDayName(dateStr) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
}

/* ─────────────────────────────────────────────
   TASK 3 — jQuery AJAX (WorldTimeAPI)
───────────────────────────────────────────── */

/**
 * Fetch local time for the city using jQuery $.getJSON().
 * Uses .done() / .fail() / .always() chaining (no callback style).
 * Falls back to browser local time if timezone unavailable.
 */
function fetchLocalTimeJQuery(timezone) {
  // Fallback immediately if no timezone string
  if (!timezone) {
    displayLocalTime(null);
    return;
  }

  const url = `${API.timezone}/${encodeURIComponent(timezone)}`;

  $.getJSON(url)
    .done(function (data) {
      // data.datetime looks like "2024-07-14T15:23:00.123456+08:00"
      const dt      = new Date(data.datetime);
      const timeStr = dt.toLocaleTimeString("en-US", {
        hour:   "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      setEl("local-time", `🕐 Local time: ${timeStr}`);
    })
    .fail(function (jqXHR, textStatus) {
      // Task 3 #13 — fallback to browser time
      console.warn("[WeatherNow] WorldTimeAPI failed:", textStatus, "— using browser time");
      displayLocalTime(null);
    })
    .always(function () {
      // Task 3 #15 — log a timestamp on every completed request
      console.log(`[WeatherNow] WorldTimeAPI request completed at: ${new Date().toISOString()}`);
    });
}

/** Display browser local time as fallback */
function displayLocalTime(/* unused */) {
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour:   "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  setEl("local-time", `🕐 Local time (browser): ${timeStr}`);
}

/* ─────────────────────────────────────────────
   BONUS — °C / °F TOGGLE (no new API call)
───────────────────────────────────────────── */
function formatTemp(celsius, unit) {
  if (unit === "F") {
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(celsius)}°C`;
}

function switchUnit(unit) {
  if (state.currentTempC === null) return; // no data loaded yet
  state.currentUnit = unit;

  // Highlight active button
  document.getElementById("unit-c").classList.toggle("active", unit === "C");
  document.getElementById("unit-f").classList.toggle("active", unit === "F");

  // Re-render temperatures without a new API call
  if (state.lastSearch) {
    setEl("temperature", formatTemp(state.currentTempC, unit));
    renderForecast(state._lastWeatherData); // re-render forecast cards
  }
}

/* ─────────────────────────────────────────────
   BONUS — RECENT SEARCHES (localStorage)
───────────────────────────────────────────── */
const RECENT_KEY = "weathernow_recent";
const MAX_RECENT = 5;

function saveRecentSearch(cityName) {
  let recent = loadRecent();
  // Remove duplicate
  recent = recent.filter(c => c.toLowerCase() !== cityName.toLowerCase());
  recent.unshift(cityName);
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (_) {}
}

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch (_) {
    return [];
  }
}

function renderRecentChips() {
  const container = document.getElementById("recent-chips");
  const recent    = loadRecent();
  container.innerHTML = "";

  recent.forEach(city => {
    const chip = document.createElement("button");
    chip.className   = "chip";
    chip.textContent = city;
    chip.addEventListener("click", () => {
      document.getElementById("city-input").value = city;
      handleSearch(city);
    });
    container.appendChild(chip);
  });
}

/* ─────────────────────────────────────────────
   TASK 4 — DEBOUNCE
   500ms debounce so rapid typing doesn't fire
   multiple API calls.
───────────────────────────────────────────── */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/* ─────────────────────────────────────────────
   INIT — EVENT LISTENERS
───────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {

  const cityInput = document.getElementById("city-input");
  const searchBtn = document.getElementById("search-btn");

  // Debounced live search (fires 500ms after user stops typing)
  const debouncedSearch = debounce((value) => handleSearch(value), 500);
  cityInput.addEventListener("input", (e) => debouncedSearch(e.target.value));

  // Click / Enter search
  searchBtn.addEventListener("click", () => handleSearch(cityInput.value));
  cityInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch(cityInput.value);
  });

  // Retry button in error banner
  document.getElementById("retry-btn").addEventListener("click", () => {
    hideError();
    if (cityInput.value.trim()) handleSearch(cityInput.value);
  });

  // Close error banner
  document.getElementById("close-error").addEventListener("click", hideError);

  // Unit toggle buttons (Bonus)
  document.getElementById("unit-c").addEventListener("click", () => switchUnit("C"));
  document.getElementById("unit-f").addEventListener("click", () => switchUnit("F"));

  // Store weatherData for unit re-render (attach to state)
  // We monkey-patch handleSearch result storage:
  const _originalFetchWeather = fetchWeather;
  window._patchWeatherStorage = (data) => { state._lastWeatherData = data; };

  // Load recent chips on startup
  renderRecentChips();

  // Load default city on start
  handleSearch("Kuala Lumpur");
});

// state._lastWeatherData is already saved inside renderCurrentWeather above.
// No additional patching needed.