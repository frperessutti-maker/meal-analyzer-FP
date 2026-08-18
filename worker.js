// Cloudflare Worker — Claude API proxy + user data sync via KV
// KV Namespace binding required: USERDATA

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

    try {
      const body = await request.json();
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
