const SHARE_CACHE = 'bar-cart-share-v1';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const image = formData.get('image');
        if (image) {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put('/shared-image', new Response(image, {
            headers: { 'Content-Type': image.type || 'image/jpeg' },
          }));
        }
        return Response.redirect('/?shared=1', 303);
      })()
    );
  }
});
