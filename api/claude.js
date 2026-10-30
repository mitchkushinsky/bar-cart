export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;

  const headers = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  if (hasTools) {
    headers['anthropic-beta'] = 'web-search-2025-03-05';
  }

  // Session 27: cancels the upstream call when the browser goes away
  // mid-response — a closed tab, or the client aborting its fetch when
  // someone backs out of a screen. Without this, Anthropic keeps generating
  // (and billing) for a response nobody will read. 'close' also fires after
  // a normal finish, hence the writableEnded check. On Vercel this depends
  // on "supportsCancellation": true for this file in vercel.json — without
  // it the platform never tells the function the client left (verified on a
  // preview deployment: no 'close', upstream kept generating). `vercel dev`
  // doesn't forward the disconnect either, so it can't be checked locally.
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('[claude] client disconnected before the response finished; aborting upstream');
      upstream.abort();
    }
  });

  try {
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Tools:', JSON.stringify(req.body.tools));
    console.log('Model:', req.body.model);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: upstream.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic error:', errorBody);
      throw new Error(`API error: ${response.status} - ${errorBody}`);
    }

    // Streaming pass-through, opt-in via req.body.stream. A production path
    // since Session 27 (Help Me Decide streams its pills in); the bc_diag
    // timing instrumentation in src/App.jsx also uses it. Retiring bc_diag
    // must NOT remove this branch. Anthropic's SSE events are forwarded
    // byte-for-byte; the only thing this adds is an `error` event in the
    // same shape Anthropic uses, so a failure partway through reaches the
    // client as an explicit failure instead of a connection that just stops.
    if (req.body?.stream === true && response.body) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      try {
        for await (const chunk of response.body) {
          if (upstream.signal.aborted) break;
          res.write(chunk);
        }
      } catch (streamErr) {
        if (upstream.signal.aborted) return; // client already gone; nothing to tell
        console.error('[claude] upstream stream failed mid-response:', streamErr.message);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'proxy_stream_error', message: streamErr.message } })}\n\n`);
      }
      if (!upstream.signal.aborted) res.end();
      return;
    }

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    if (upstream.signal.aborted) return;
    res.status(500).json({ error: err.message });
  }
}
