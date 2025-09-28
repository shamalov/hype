export default {
  async fetch(request, env) {
    let url = new URL(request.url);
    let pathname = url.pathname;
    if (pathname === '/' || pathname === '') {
      pathname = '/client.html';
    }
    const assetUrl = new URL(pathname, request.url);
    const assetRequest = new Request(assetUrl.toString(), request);
    return env.ASSETS.fetch(assetRequest);
  },
};
