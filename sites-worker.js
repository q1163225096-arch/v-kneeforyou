const STATIC_HEADERS = {
  "x-content-type-options": "nosniff"
};

function normalizeAssetRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/index.html";
  }

  return new Request(url, request);
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(normalizeAssetRequest(request));

    if (response.status !== 404) {
      const headers = new Headers(response.headers);
      Object.entries(STATIC_HEADERS).forEach(([key, value]) => headers.set(key, value));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return response;
  }
};
