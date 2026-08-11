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
