import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Intervals.icu", version: "1.0.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    this.server.tool(
      "getRecentActivities",
      { days: z.number().optional().describe("Days back, default 14") },
      async ({ days = 14 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/activities?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getWellness",
      { days: z.number().optional().describe("Days back, default 7") },
      async ({ days = 7 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/wellness?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      { days: z.number().optional().describe("Days ahead, default 14") },
      async ({ days = 14 }) => {
        const today = new Date().toISOString().slice(0, 10);
        const newest = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${newest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "createWorkout",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "updateWorkout",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "deleteEvent",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getActivityIntervals",
      "Per-interval (lap/set) data for one activity: distance, time, pace, cadence/stroke rate, " +
        "distance per stroke, HR, power. Pass an activity id from getRecentActivities, e.g. 'i197095279'.",
      { activityId: z.string().describe("intervals.icu activity id, e.g. i197095279") },
      async ({ activityId }) => {
        const data: any = await this.icu(`/activity/${encodeURIComponent(activityId)}/intervals`);
        // keep only non-null scalar fields so the result stays small
        const slim = (o: any) =>
          Object.fromEntries(
            Object.entries(o ?? {}).filter(
              ([, v]) => v !== null && ["number", "string", "boolean"].includes(typeof v),
            ),
          );
        const out = {
          id: data.id ?? activityId,
          intervals: (data.icu_intervals ?? []).map(slim),
          groups: (data.icu_groups ?? []).map(slim),
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      },
    );

    this.server.tool(
      "getCalendarEvents",
      "Upcoming events from Harry's public iCloud calendars (Home, Work, Harry): titles, UK-local times, " +
        "locations, recurring events expanded. Use for training planning.",
      {
        days: z.number().min(1).max(60).optional().describe("Days ahead from today, default 21"),
        calendar: z.string().optional().describe("Only this calendar name, e.g. Home"),
      },
      async ({ days = 21, calendar }) => {
        let urls: Record<string, string>;
        try {
          urls = JSON.parse(this.env.CALENDAR_URLS);
        } catch {
          return {
            content: [{ type: "text", text: "CALENDAR_URLS secret is missing or not valid JSON" }],
            isError: true,
          };
        }
        const from = calTodayStart();
        const to = from + days * CAL_DAY;
        const wanted = Object.entries(urls).filter(
          ([name]) => !calendar || name.toLowerCase() === calendar.toLowerCase(),
        );
        const results = await Promise.all(
          wanted.map(async ([name, url]) => {
            try {
              const res = await fetch(url.replace(/^webcal:\/\//i, "https://"));
              if (!res.ok) return { name, error: `HTTP ${res.status}`, events: [] as any[] };
              return { name, error: "", events: calEventsFromIcs(await res.text(), name, from, to) };
            } catch (e) {
              return { name, error: String(e), events: [] as any[] };
            }
          }),
        );
        const events = results.flatMap((r) => r.events).sort((a, b) => a._t - b._t);
        events.forEach((e) => delete e._t);
        const errors = results.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window: `${calFmt(from, true)} to ${calFmt(to - CAL_DAY, true)}`,
                events,
                ...(errors.length ? { errors } : {}),
              }),
            },
          ],
        };
      },
    );

    this.server.tool(
      "getPoolTimetable",
      "Leys Pools (Oxford) lane-swimming slots for the days ahead, from the More Leisure timetable page " +
        "(~31 days published). Use when planning swims.",
      {
        days: z.number().min(1).max(31).optional().describe("Days ahead, default 14"),
        activity: z.string().optional().describe('Session name filter, default "Lane Swimming"'),
      },
      async ({ days = 14, activity = "Lane Swimming" }) => {
        try {
          const data = await poolTimetable(days, activity);
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `getPoolTimetable failed: ${String(e)}` }], isError: true };
        }
      },
    );

    this.server.tool(
      "getWeather",
      "Daily weather forecast for the Oxford–Harwell commute (Open-Meteo): rain, snow, wind, temps, " +
        "sunrise/sunset, plus 06:00, 08:00 and 18:00 snapshots. Use when deciding commute rides vs KICKR.",
      { days: z.number().min(1).max(16).optional().describe("Days ahead, default 7") },
      async ({ days = 7 }) => {
        try {
          const data = await weatherForecast(days);
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `getWeather failed: ${String(e)}` }], isError: true };
        }
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// ---------------------------------------------------------------------
// Calendar helpers (used by getCalendarEvents)
// Times are held as UK-local wall-clock milliseconds, so recurring events
// keep their local time when the clocks change.
// ---------------------------------------------------------------------
const CAL_DAY = 86400000;

function calLondonParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

function calTodayStart() {
  const now = calLondonParts(new Date());
  return now - (now % CAL_DAY);
}

function calFmt(t: number, dateOnly = false) {
  const s = new Date(t).toISOString();
  return dateOnly ? s.slice(0, 10) : s.slice(0, 16).replace("T", " ");
}

// value like 20261015T183000Z, 20261015T183000, 20261015
function calParseDate(value: string, params: string) {
  const v = value.trim();
  const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
  if (/VALUE=DATE(?!-)/i.test(params) || v.length === 8) {
    return { t: Date.UTC(y, mo, d), allDay: true };
  }
  const h = +v.slice(9, 11), mi = +v.slice(11, 13), s = +v.slice(13, 15) || 0;
  if (v.endsWith("Z")) return { t: calLondonParts(new Date(Date.UTC(y, mo, d, h, mi, s))), allDay: false };
  return { t: Date.UTC(y, mo, d, h, mi, s), allDay: false }; // TZID / floating: taken as UK local
}

function calUnescape(s: string) {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function calEventsFromIcs(text: string, calName: string, from: number, to: number) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const evs: any[] = [];
  let cur: any = null;
  let depth = 0; // >0 while inside a nested block (e.g. VALARM)
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set<number>() }; continue; }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) { depth++; continue; }
    if (line.startsWith("END:") && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (line === "END:VEVENT") { evs.push(cur); cur = null; continue; }
    const c = line.indexOf(":");
    if (c < 0) continue;
    const head = line.slice(0, c), value = line.slice(c + 1);
    const semi = head.indexOf(";");
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? "" : head.slice(semi + 1);
    switch (name) {
      case "UID": cur.uid = value; break;
      case "SUMMARY": cur.summary = calUnescape(value); break;
      case "LOCATION": cur.location = calUnescape(value); break;
      case "STATUS": cur.status = value.toUpperCase(); break;
      case "DTSTART": { const p = calParseDate(value, params); cur.start = p.t; cur.allDay = p.allDay; break; }
      case "DTEND": cur.end = calParseDate(value, params).t; break;
      case "DURATION": cur.durationStr = value; break;
      case "RRULE":
        cur.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=") as [string, string]));
        break;
      case "EXDATE":
        for (const v of value.split(",")) cur.exdates.add(calParseDate(v, params).t);
        break;
      case "RECURRENCE-ID": cur.recurrenceId = calParseDate(value, params).t; break;
    }
  }

  // durations
  for (const e of evs) {
    if (e.start === undefined) continue;
    if (e.end === undefined && e.durationStr) {
      const m = e.durationStr.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
      const ms = m ? (((+m[1] || 0) * 7 + (+m[2] || 0)) * 24 * 3600 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000 : 0;
      e.end = e.start + ms;
    }
    if (e.end === undefined) e.end = e.start + (e.allDay ? CAL_DAY : 0);
  }

  // instances replaced by edited one-offs (RECURRENCE-ID)
  const overridden = new Map<string, Set<number>>();
  for (const e of evs) {
    if (e.recurrenceId !== undefined && e.uid) {
      if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
      overridden.get(e.uid)!.add(e.recurrenceId);
    }
  }

  const out: any[] = [];
  for (const e of evs) {
    if (e.start === undefined || e.status === "CANCELLED") continue;
    const dur = e.end - e.start;
    const skip = (e.recurrenceId === undefined && overridden.get(e.uid)) || new Set<number>();
    for (const t of calExpand(e, from, to)) {
      if (skip.has(t)) continue;
      out.push({
        _t: t,
        calendar: calName,
        title: e.summary ?? "(no title)",
        start: calFmt(t, e.allDay),
        end: e.allDay ? calFmt(t + dur - CAL_DAY, true) : calFmt(t + dur),
        ...(e.allDay ? { allDay: true } : {}),
        ...(e.location ? { location: e.location } : {}),
      });
    }
  }
  return out;
}

function calExpand(e: any, from: number, to: number): number[] {
  const dur = Math.max(e.end - e.start, 1);
  const inWindow = (t: number) => t < to && t + dur > from;
  if (!e.rrule || e.recurrenceId !== undefined) return inWindow(e.start) ? [e.start] : [];

  const r = e.rrule;
  const interval = parseInt(r.INTERVAL || "1", 10);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? calParseDate(r.UNTIL, "").t : Infinity;
  const tod = e.start % CAL_DAY;
  const out: number[] = [];
  let n = 0;
  let stop = false;
  // returns false once the series has ended or passed the window
  const take = (t: number) => {
    if (t < e.start) return true;
    if (t > until || n >= count || t >= to) { stop = true; return false; }
    n++;
    if (!e.exdates.has(t) && inWindow(t)) out.push(t);
    return true;
  };
  const DOW: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }; // Monday-based

  for (let k = 0; k < 5000 && !stop; k++) {
    if (r.FREQ === "DAILY") {
      take(e.start + k * interval * CAL_DAY);
    } else if (r.FREQ === "WEEKLY") {
      const dayStart = e.start - tod;
      const monday = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * CAL_DAY;
      const weekStart = monday + k * interval * 7 * CAL_DAY;
      const days = r.BYDAY
        ? r.BYDAY.split(",").map((d: string) => DOW[d.replace(/[^A-Z]/g, "")]).filter((d: number) => d !== undefined).sort()
        : [(new Date(dayStart).getUTCDay() + 6) % 7];
      for (const d of days) if (!take(weekStart + d * CAL_DAY + tod)) break;
    } else if (r.FREQ === "MONTHLY") {
      const s = new Date(e.start);
      const y = s.getUTCFullYear(), m = s.getUTCMonth() + k * interval;
      const nth = r.BYDAY && r.BYDAY.match(/^(-?\d)([A-Z]{2})$/);
      if (nth) {
        const want = DOW[nth[2]], which = +nth[1];
        let t: number;
        if (which > 0) {
          const first = Date.UTC(y, m, 1);
          const off = (want - ((new Date(first).getUTCDay() + 6) % 7) + 7) % 7;
          t = first + (off + (which - 1) * 7) * CAL_DAY;
        } else {
          const last = Date.UTC(y, m + 1, 0);
          const off = (((new Date(last).getUTCDay() + 6) % 7) - want + 7) % 7;
          t = last - (off + (-which - 1) * 7) * CAL_DAY;
        }
        if (new Date(t).getUTCMonth() === new Date(Date.UTC(y, m, 1)).getUTCMonth()) take(t + tod);
        else if (Date.UTC(y, m, 1) >= to) stop = true;
      } else {
        const t = Date.UTC(y, m, s.getUTCDate()) + tod;
        if (new Date(t).getUTCDate() === s.getUTCDate()) take(t);
        else if (Date.UTC(y, m, 1) >= to) stop = true;
      }
    } else if (r.FREQ === "YEARLY") {
      const s = new Date(e.start);
      take(Date.UTC(s.getUTCFullYear() + k * interval, s.getUTCMonth(), s.getUTCDate()) + tod);
    } else {
      return inWindow(e.start) ? [e.start] : [];
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Pool timetable helpers (used by getPoolTimetable)
// The More Leisure page embeds ~31 days of sessions as JSON in a `data-days`
// attribute on <div data-timetable-component-mount data-title="Swim timetable">.
// ---------------------------------------------------------------------
const LEYS_URL = "https://www.moreleisure.com/leys-pools-leisure-centre/timetables/";

function htmlDecode(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// "6:30 AM" -> "06:30"
function to24h(t: string) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return t;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

async function poolTimetable(days: number, activity: string) {
  const res = await fetch(LEYS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; harry-training-planner)" },
  });
  if (!res.ok) throw new Error(`moreleisure.com returned HTTP ${res.status}`);

  // HTMLRewriter streams the ~1 MB page rather than holding it all as a string.
  const mounts: { title: string; days: string }[] = [];
  await new HTMLRewriter()
    .on("div[data-timetable-component-mount]", {
      element(el) {
        mounts.push({
          title: el.getAttribute("data-title") ?? "",
          days: el.getAttribute("data-days") ?? "[]",
        });
      },
    })
    .transform(res)
    .arrayBuffer();

  const swim = mounts.find((m) => /swim timetable/i.test(m.title));
  if (!swim) throw new Error("Swim timetable block not found on page (layout changed?)");

  const raw = swim.days.includes("&quot;") ? htmlDecode(swim.days) : swim.days;
  const parsed: { date: string; classes: any[] }[] = JSON.parse(raw);
  const from = calTodayStart();
  const today = calFmt(from, true);
  const end = calFmt(from + days * CAL_DAY, true);
  const want = activity.toLowerCase();

  return {
    pool: "Leys Pools & Leisure Centre",
    activity,
    window: `${today} to ${end}`,
    days: parsed
      .filter((d) => d.date >= today && d.date <= end)
      .map((d) => ({
        date: d.date,
        weekday: new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
        slots: (d.classes ?? [])
          .filter((c) => String(c.name ?? "").toLowerCase().includes(want))
          .map((c) => ({ start: to24h(c.timeStart), end: to24h(c.timeEnd), spaces: c.spaces })),
      })),
  };
}

// ---------------------------------------------------------------------
// Weather helpers (used by getWeather) — Open-Meteo, free, no key.
// Centred on Abingdon, midpoint of the Oxford–Harwell commute.
// ---------------------------------------------------------------------
const WX_LAT = 51.67, WX_LON = -1.28;

async function weatherForecast(days: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}` +
    `&timezone=Europe%2FLondon&forecast_days=${Math.min(days, 16)}&wind_speed_unit=kmh` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,` +
    `precipitation_probability_max,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset` +
    `&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,` +
    `snowfall,wind_speed_10m,wind_gusts_10m,wind_direction_10m`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo returned HTTP ${r.status}`);
  const w: any = await r.json();
  const h = w.hourly;

  const at = (date: string, hh: string) => {
    const i = h.time.indexOf(`${date}T${hh}:00`);
    if (i < 0) return null;
    return {
      temp: h.temperature_2m[i],
      feels: h.apparent_temperature[i],
      rain_mm: h.precipitation[i],
      rain_pct: h.precipitation_probability[i],
      snow_cm: h.snowfall[i],
      wind: h.wind_speed_10m[i],
      gusts: h.wind_gusts_10m[i],
      wind_dir: h.wind_direction_10m[i],
    };
  };

  const d = w.daily;
  return {
    location: "Abingdon (Oxford–Harwell commute midpoint)",
    units: "°C, mm, cm, km/h; weather_code is WMO",
    days: d.time.map((date: string, i: number) => ({
      date,
      code: d.weather_code[i],
      tmin: d.temperature_2m_min[i],
      tmax: d.temperature_2m_max[i],
      rain_mm: d.precipitation_sum[i],
      rain_pct: d.precipitation_probability_max[i],
      snow_cm: d.snowfall_sum[i],
      wind_max: d.wind_speed_10m_max[i],
      gust_max: d.wind_gusts_10m_max[i],
      sunrise: String(d.sunrise[i]).slice(11),
      sunset: String(d.sunset[i]).slice(11),
      at_0600: at(date, "06"),
      commute_am_0800: at(date, "08"),
      commute_pm_1800: at(date, "18"),
    })),
  };
}
