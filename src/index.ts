interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * NWS MCP — US National Weather Service (no auth)
 *
 * Authoritative US weather + severe-weather alerts straight from the NWS.
 * Pairs with `weather` (Open-Meteo, global) — NWS is faster + more detailed
 * for US queries and is the official source for warnings/watches/advisories.
 *
 * API: https://www.weather.gov/documentation/services-web-api
 * NWS asks every client to send a unique User-Agent identifying the app +
 * contact email. We send one on every request.
 *
 * Tools:
 * - get_forecast:        7-day forecast for a US lat/lon (two-step gridpoint resolve)
 * - get_hourly_forecast: hourly forecast for a US lat/lon
 * - get_alerts:          active watches/warnings/advisories by area or point
 * - get_observation:     latest observation from a weather station
 */


const BASE_URL = 'https://api.weather.gov';
const USER_AGENT = 'Pipeworx-NWS-MCP/0.1 (contact@mojibake.ai)';

const tools: McpToolExport['tools'] = [
  {
    name: 'get_forecast',
    description:
      'Get the 7-day NWS forecast for a US lat/lon. Returns named periods (e.g., "Tonight", "Wednesday") with high/low temperature, wind, and a short text forecast. US locations only.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'US latitude' },
        longitude: { type: 'number', description: 'US longitude' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'get_hourly_forecast',
    description:
      'Get the hourly NWS forecast for a US lat/lon (~168 hours). Useful for short-term planning, severe-weather windows, or precipitation timing.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'US latitude' },
        longitude: { type: 'number', description: 'US longitude' },
        max_hours: { type: 'number', description: 'Cap hours returned (default 24)' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'get_alerts',
    description:
      'Active NWS watches / warnings / advisories. Filter by US state (2-letter code), point (lat,lon), severity, or status. Returns event name, severity, urgency, headline, description, affected areas, and effective/expires times.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: '2-letter US state/territory code (e.g., "CA", "TX")' },
        latitude: { type: 'number', description: 'Latitude (use with longitude for point query)' },
        longitude: { type: 'number', description: 'Longitude (use with latitude for point query)' },
        severity: {
          type: 'string',
          description: 'Extreme | Severe | Moderate | Minor | Unknown',
        },
        urgency: {
          type: 'string',
          description: 'Immediate | Expected | Future | Past | Unknown',
        },
        event: { type: 'string', description: 'Restrict to a specific event type (e.g., "Tornado Warning")' },
        limit: { type: 'number', description: 'Cap alerts returned (default 50, max 500)' },
      },
      required: [],
    },
  },
  {
    name: 'get_observation',
    description:
      'Latest observation from a specific NWS weather station. Returns temperature, humidity, wind, visibility, pressure, and present-weather codes.',
    inputSchema: {
      type: 'object',
      properties: {
        station_id: {
          type: 'string',
          description: '4-character NWS / ICAO station ID (e.g., "KSFO", "KJFK", "KDEN")',
        },
      },
      required: ['station_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_forecast':
      return getForecast(args.latitude as number, args.longitude as number, false, undefined);
    case 'get_hourly_forecast':
      return getForecast(
        args.latitude as number,
        args.longitude as number,
        true,
        (args.max_hours as number) ?? 24,
      );
    case 'get_alerts':
      return getAlerts(args);
    case 'get_observation':
      return getObservation(reqStr(args, 'station_id', '"KSFO"'));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function nwsFetch<T>(path: string, params?: URLSearchParams): Promise<T> {
  const url = `${BASE_URL}${path}${params ? `?${params}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/geo+json,application/json',
    },
  });
  if (res.status === 404) {
    throw new Error('NWS: not found (HTTP 404). NWS only covers US locations.');
  }
  if (res.status === 429) {
    throw new Error('NWS: rate-limit hit (HTTP 429)');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NWS error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface PointResponse {
  properties?: {
    forecast?: string;
    forecastHourly?: string;
    forecastGridData?: string;
    gridId?: string;
    gridX?: number;
    gridY?: number;
    timeZone?: string;
    forecastZone?: string;
    county?: string;
    relativeLocation?: { properties?: { city?: string; state?: string } };
    radarStation?: string;
  };
}

interface ForecastPeriod {
  number?: number;
  name?: string;
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  icon?: string;
  shortForecast?: string;
  detailedForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null; unitCode?: string };
}

interface ForecastResponse {
  properties?: {
    updated?: string;
    generatedAt?: string;
    periods?: ForecastPeriod[];
  };
}

async function getForecast(lat: number, lon: number, hourly: boolean, maxHours?: number) {
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('latitude and longitude (numbers) are required');
  }
  // Step 1: resolve lat/lon to NWS gridpoint
  const point = await nwsFetch<PointResponse>(`/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const props = point.properties;
  if (!props) throw new Error('NWS: empty point response');

  const url = hourly ? props.forecastHourly : props.forecast;
  if (!url) throw new Error('NWS: no forecast URL on gridpoint response');

  // Step 2: fetch the forecast
  const fcRes = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!fcRes.ok) throw new Error(`NWS forecast fetch failed: ${fcRes.status}`);
  const fc = (await fcRes.json()) as ForecastResponse;

  const allPeriods = fc.properties?.periods ?? [];
  const periods = hourly && maxHours ? allPeriods.slice(0, maxHours) : allPeriods;

  return {
    location: {
      latitude: lat,
      longitude: lon,
      city: props.relativeLocation?.properties?.city ?? null,
      state: props.relativeLocation?.properties?.state ?? null,
      timezone: props.timeZone ?? null,
      grid: props.gridId ? `${props.gridId} ${props.gridX},${props.gridY}` : null,
      radar_station: props.radarStation ?? null,
    },
    updated: fc.properties?.updated ?? null,
    period_count: periods.length,
    periods: periods.map((p) => ({
      name: p.name ?? null,
      start: p.startTime ?? null,
      end: p.endTime ?? null,
      is_daytime: p.isDaytime ?? null,
      temperature: p.temperature ?? null,
      temperature_unit: p.temperatureUnit ?? null,
      wind: p.windSpeed && p.windDirection ? `${p.windSpeed} ${p.windDirection}` : (p.windSpeed ?? null),
      precip_chance_pct: p.probabilityOfPrecipitation?.value ?? null,
      short: p.shortForecast ?? null,
      detailed: p.detailedForecast ?? null,
    })),
  };
}

interface AlertResponse {
  features?: {
    properties?: {
      id?: string;
      event?: string;
      severity?: string;
      urgency?: string;
      certainty?: string;
      status?: string;
      messageType?: string;
      category?: string;
      headline?: string;
      description?: string;
      instruction?: string | null;
      sent?: string;
      effective?: string;
      onset?: string;
      expires?: string;
      ends?: string;
      areaDesc?: string;
      senderName?: string;
      response?: string;
    };
  }[];
}

async function getAlerts(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  if (args.area) params.set('area', String(args.area).toUpperCase());
  if (typeof args.latitude === 'number' && typeof args.longitude === 'number') {
    params.set('point', `${(args.latitude as number).toFixed(4)},${(args.longitude as number).toFixed(4)}`);
  }
  if (args.severity) params.set('severity', String(args.severity));
  if (args.urgency) params.set('urgency', String(args.urgency));
  if (args.event) params.set('event', String(args.event));
  const limit = Math.min(500, Math.max(1, (args.limit as number) ?? 50));
  params.set('limit', String(limit));

  const data = await nwsFetch<AlertResponse>('/alerts/active', params);
  const alerts = (data.features ?? []).map((f) => f.properties ?? {});

  return {
    count: alerts.length,
    alerts: alerts.map((a) => ({
      id: a.id ?? null,
      event: a.event ?? null,
      severity: a.severity ?? null,
      urgency: a.urgency ?? null,
      certainty: a.certainty ?? null,
      status: a.status ?? null,
      category: a.category ?? null,
      headline: a.headline ?? null,
      description: a.description ?? null,
      instruction: a.instruction ?? null,
      area: a.areaDesc ?? null,
      sender: a.senderName ?? null,
      response: a.response ?? null,
      sent: a.sent ?? null,
      effective: a.effective ?? null,
      onset: a.onset ?? null,
      expires: a.expires ?? null,
      ends: a.ends ?? null,
    })),
  };
}

interface ObservationResponse {
  properties?: {
    timestamp?: string;
    textDescription?: string;
    temperature?: { value?: number | null; unitCode?: string };
    dewpoint?: { value?: number | null };
    windDirection?: { value?: number | null };
    windSpeed?: { value?: number | null; unitCode?: string };
    windGust?: { value?: number | null };
    barometricPressure?: { value?: number | null };
    seaLevelPressure?: { value?: number | null };
    visibility?: { value?: number | null };
    relativeHumidity?: { value?: number | null };
    heatIndex?: { value?: number | null };
    windChill?: { value?: number | null };
  };
}

function celsiusToF(c: number | null | undefined): number | null {
  return typeof c === 'number' ? Math.round(((c * 9) / 5 + 32) * 10) / 10 : null;
}

function mPerSToMph(v: number | null | undefined): number | null {
  return typeof v === 'number' ? Math.round(v * 2.23694 * 10) / 10 : null;
}

async function getObservation(stationId: string) {
  const data = await nwsFetch<ObservationResponse>(
    `/stations/${encodeURIComponent(stationId)}/observations/latest`,
  );
  const p = data.properties ?? {};
  return {
    station_id: stationId,
    timestamp: p.timestamp ?? null,
    conditions: p.textDescription ?? null,
    temperature_c: p.temperature?.value ?? null,
    temperature_f: celsiusToF(p.temperature?.value),
    dewpoint_c: p.dewpoint?.value ?? null,
    humidity_pct: p.relativeHumidity?.value ?? null,
    wind_speed_mph: mPerSToMph(p.windSpeed?.value),
    wind_gust_mph: mPerSToMph(p.windGust?.value),
    wind_direction_deg: p.windDirection?.value ?? null,
    pressure_pa: p.barometricPressure?.value ?? null,
    sea_level_pressure_pa: p.seaLevelPressure?.value ?? null,
    visibility_m: p.visibility?.value ?? null,
    heat_index_c: p.heatIndex?.value ?? null,
    wind_chill_c: p.windChill?.value ?? null,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
