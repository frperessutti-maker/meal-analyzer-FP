// Cloudflare Worker — Claude API proxy + user data sync via KV
// KV Namespace binding required: USERDATA

// ── Usage safety limits ──────────────────────────────────────────
// These exist to stop runaway cost from bugs, retry loops, or someone
// hitting this URL directly (it's public — it's embedded in index.html).
// Enforcement lives here, not in the client, because client-side checks
// are trivially bypassed by anyone who can see the worker URL.
const DAILY_BUDGET_USD = 1.00;           // hard stop for total spend/day across all users
const MEAL_DAILY_REFILL = 10;            // meal analyses added to the balance each day
const MEAL_MAX_BALANCE = 100;            // ceiling on accumulated (unused) meal analyses
const DAILY_LIFESTYLE_LIMIT = 3;         // lifestyle-suggestion calls per user per day (no rollover)
const MIN_MS_BETWEEN_REQUESTS = 4000;    // per-user cooldown — blunts rapid-fire/agentic loops
const KV_TTL_SECONDS = 172800;           // 2 days — auto-expire daily counters
// A meal balance must outlive gaps in usage, otherwise a user who stops logging for
// a while loses the analyses they were accruing. 60 days is well past the 10 days it
// takes to fill from empty to MEAL_MAX_BALANCE; beyond that the balance resets.
const BALANCE_TTL_SECONDS = 5184000;     // 60 days

// Approximate Claude Sonnet pricing (USD per token). This is a rough estimate
// for budget-capping purposes, not an exact billing reconciliation — check
// console.anthropic.com for your actual rate and adjust these if they drift.
const PRICE_PER_INPUT_TOKEN = 3 / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN = 15 / 1_000_000;

function todayKey() { return new Date().toISOString().slice(0, 10); }
function errorResponse(message, status, corsHeaders) {
  // Same {error:{message}} shape Anthropic uses, so the app's existing
  // `if(d.error) throw new Error(d.error.message)` handling just works.
  return new Response(JSON.stringify({ error: { message } }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
async function getCounter(env, key) {
  const raw = await env.USERDATA.get(key);
  return raw ? parseFloat(raw) || 0 : 0;
}
function daysBetweenISO(fromISO, toISO) {
  const a = Date.parse(fromISO + "T00:00:00Z"), b = Date.parse(toISO + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Meal analyses use a refill bucket rather than a flat daily counter: each calendar
// day adds MEAL_DAILY_REFILL to the balance (capped at MEAL_MAX_BALANCE) and each
// analysis spends one, so unused days accumulate. That lets someone who didn't log
// for a few days go back and fill in their history later.
// Accrual is computed lazily on read — no cron needed.
async function readMealBalance(env, userKey, day) {
  const key = `mealbal:${userKey}`;
  let rec = null;
  try { rec = JSON.parse(await env.USERDATA.get(key)); } catch { rec = null; }
  if (!rec || typeof rec.balance !== "number" || !rec.day) {
    rec = { balance: MEAL_DAILY_REFILL, day };            // new user, or balance aged out
  } else if (rec.day !== day) {
    const elapsed = daysBetweenISO(rec.day, day);
    if (elapsed > 0) {
      rec = { balance: Math.min(MEAL_MAX_BALANCE, rec.balance + elapsed * MEAL_DAILY_REFILL), day };
    }
  }
  return { key, rec };
}
function writeMealBalance(env, key, rec) {
  return env.USERDATA.put(key, JSON.stringify(rec), { expirationTtl: BALANCE_TTL_SECONDS });
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // User data sync endpoints
    if (url.pathname === "/sync") {
      if (!env.USERDATA) {
        return new Response(JSON.stringify({ error: "KV not configured" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return new Response(JSON.stringify({ error: "Missing key" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
        const data = await env.USERDATA.get(key);
        return new Response(data || JSON.stringify(null), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (request.method === "PUT") {
        const body = await request.json();
        if (!body.key || !body.data) return new Response(JSON.stringify({ error: "Missing key or data" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
        await env.USERDATA.put(body.key, JSON.stringify(body.data));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (request.method === "DELETE") {
        const body = await request.json();
        if (!body.key) return new Response(JSON.stringify({ error: "Missing key" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
        await env.USERDATA.delete(body.key);
        return new Response(JSON.stringify({ ok: true, deleted: body.key }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // List all profiles
    if (url.pathname === "/sync/list" && request.method === "GET") {
      if (!env.USERDATA) {
        return new Response(JSON.stringify({ error: "KV not configured" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const list = await env.USERDATA.list();
      const profiles = [];
      for (const key of list.keys) {
        try {
          const raw = await env.USERDATA.get(key.name);
          const data = raw ? JSON.parse(raw) : null;
          profiles.push({
            key: key.name,
            profile: data?.profile || null,
            templates: data?.templates?.length || 0,
            historyDays: data?.history ? Object.keys(data.history).length : 0,
          });
        } catch {
          profiles.push({ key: key.name, profile: null, templates: 0, historyDays: 0 });
        }
      }
      return new Response(JSON.stringify(profiles), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Remaining-quota lookup for the UI counter. Read-only: it applies pending
    // day-rollover accrual and persists that, but never spends an analysis.
    if (url.pathname === "/quota" && request.method === "GET") {
      if (!env.USERDATA) return errorResponse("KV not configured", 500, corsHeaders);
      const qKey = url.searchParams.get("key");
      if (!qKey) return errorResponse("Missing key", 400, corsHeaders);
      const day = todayKey();
      const { key: balKey, rec } = await readMealBalance(env, qKey, day);
      await writeMealBalance(env, balKey, rec);
      const lifeUsed = await getCounter(env, `quota:lifestyle:${qKey}:${day}`);
      return new Response(JSON.stringify({
        meal: { remaining: rec.balance, max: MEAL_MAX_BALANCE, perDay: MEAL_DAILY_REFILL },
        lifestyle: { remaining: Math.max(0, DAILY_LIFESTYLE_LIMIT - lifeUsed), perDay: DAILY_LIFESTYLE_LIMIT }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch URL content (proxy for CORS)
    if (url.pathname === "/fetch-url" && request.method === "GET") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response(JSON.stringify({ error: "Missing url" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
      try {
        const r = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MealAnalyzer/1.0)" }
        });
        const html = await r.text();
        // Extract text content, strip tags, limit size
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000);
        return new Response(JSON.stringify({ text }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // Claude API proxy (existing)
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    if (!env.USERDATA) {
      return errorResponse("Server not configured for usage limits.", 500, corsHeaders);
    }

    try {
      const { userKey, kind, ...anthropicBody } = await request.json();

      if (!userKey || typeof userKey !== "string") {
        return errorResponse("Missing user identity — please log in again.", 400, corsHeaders);
      }

      const day = todayKey();

      // 1. Per-user cooldown — blocks rapid-fire bursts regardless of daily totals
      const rlKey = `rl:${userKey}`;
      const lastTs = await getCounter(env, rlKey);
      const nowTs = Date.now();
      if (nowTs - lastTs < MIN_MS_BETWEEN_REQUESTS) {
        return errorResponse("Too many requests — please wait a few seconds and try again.", 429, corsHeaders);
      }
      await env.USERDATA.put(rlKey, String(nowTs), { expirationTtl: 60 });

      // 2. Global daily budget cap — checked BEFORE spending, so a spike is stopped, not just measured
      const budgetKey = `budget:${day}`;
      const spentSoFar = await getCounter(env, budgetKey);
      if (spentSoFar >= DAILY_BUDGET_USD) {
        return errorResponse("The app has reached its shared daily analysis budget. Please try again tomorrow.", 429, corsHeaders);
      }

      // 3. Per-user quota. Lifestyle suggestions stay a flat daily limit; meal
      //    analyses draw on the accumulating balance (see readMealBalance).
      const isLifestyle = kind === "lifestyle_suggestion";
      const lifestyleKey = `quota:lifestyle:${userKey}:${day}`;
      let lifestyleUsed = 0, mealBal = null;
      if (isLifestyle) {
        lifestyleUsed = await getCounter(env, lifestyleKey);
        if (lifestyleUsed >= DAILY_LIFESTYLE_LIMIT) {
          return errorResponse(`Daily lifestyle-suggestion limit reached (${DAILY_LIFESTYLE_LIMIT}/day). Please try again tomorrow.`, 429, corsHeaders);
        }
      } else {
        mealBal = await readMealBalance(env, userKey, day);
        if (mealBal.rec.balance <= 0) {
          return errorResponse(`You've used all your meal analyses. You get ${MEAL_DAILY_REFILL} more tomorrow — unused ones stack up to ${MEAL_MAX_BALANCE}.`, 429, corsHeaders);
        }
      }

      // 4. Forward to Claude
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      });
      const data = await response.json();

      // 5. Record actual spend/usage — only on a real, successful call
      if (!data.error && data.usage) {
        const cost = (data.usage.input_tokens || 0) * PRICE_PER_INPUT_TOKEN
                   + (data.usage.output_tokens || 0) * PRICE_PER_OUTPUT_TOKEN;
        await env.USERDATA.put(budgetKey, String(spentSoFar + cost), { expirationTtl: KV_TTL_SECONDS });
        if (isLifestyle) {
          await env.USERDATA.put(lifestyleKey, String(lifestyleUsed + 1), { expirationTtl: KV_TTL_SECONDS });
        } else {
          mealBal.rec.balance = Math.max(0, mealBal.rec.balance - 1);
          await writeMealBalance(env, mealBal.key, mealBal.rec);
        }
      }

      // Piggyback the remaining balance so the client can update its counter without
      // a second round-trip. Anthropic never returns a `_quota` field of its own.
      if (!isLifestyle && mealBal) data._quota = { mealRemaining: mealBal.rec.balance, mealMax: MEAL_MAX_BALANCE, mealPerDay: MEAL_DAILY_REFILL };

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return errorResponse(err.message, 500, corsHeaders);
    }
  },
};
