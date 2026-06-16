const short = ["zzsp", "3456"].join("");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const body = await request.text();
    const response = await fetch("https://d.yydocx.com/server/front/path/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: short,
      },
      body: body || "{}",
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { data: [], more: false, message: "proxy failed", error: error.message },
      { status: 502, headers: corsHeaders }
    );
  }
};

export const config = {
  path: "/api/list",
};
