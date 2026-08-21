// Cloudflare Worker — Claude API proxy + user data sync via KV
// KV Namespace binding required: USERDATA

// ── Usage safety limits ──────────────────────────────────────────
// These exist to stop runaway cost from bugs, retry loops, or someone
// hitting this URL directly (it's public — it's embedded in index.html).
// Enforcement lives here, not in the client, because client-side checks
// are trivially bypassed by anyone who can see the worker URL.
const DAILY_BUDGET_USD = 1.00;           // hard stop for total spend/day across all users
const DAILY_MEAL_LIMIT = 10;             // meal analyses per user per day
const DAILY_LIFESTYLE_LIMIT = 3;         // lifestyle-suggestion calls per user per day
const MIN_MS_BETWEEN_REQUESTS = 4000;    // per-user cooldown — blunts rapid-fire/agentic loops
const KV_TTL_SECONDS = 172800;           // 2 days — auto-expire daily counters

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

      // 3. Per-user, per-kind daily quota
      const quotaKind = kind === "lifestyle_suggestion" ? "lifestyle" : "meal";
      const quotaLimit = quotaKind === "lifestyle" ? DAILY_LIFESTYLE_LIMIT : DAILY_MEAL_LIMIT;
      const quotaKey = `quota:${quotaKind}:${userKey}:${day}`;
      const usedSoFar = await getCounter(env, quotaKey);
      if (usedSoFar >= quotaLimit) {
        const label = quotaKind === "lifestyle" ? "lifestyle-suggestion" : "meal analysis";
        return errorResponse(`Daily ${label} limit reached (${quotaLimit}/day). Please try again tomorrow.`, 429, corsHeaders);
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
        await env.USERDATA.put(quotaKey, String(usedSoFar + 1), { expirationTtl: KV_TTL_SECONDS });
      }

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return errorResponse(err.message, 500, corsHeaders);
    }
  },
};
