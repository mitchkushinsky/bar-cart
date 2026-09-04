// TEMP DIAGNOSTIC (Session: timing diagnostic): stream passthrough import,
// used only by the branch below. Remove together with that branch when the
// diagnostic instrumentation in src/App.jsx is removed.
import { Readable } from 'node:stream';

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

  try {
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Tools:', JSON.stringify(req.body.tools));
    console.log('Model:', req.body.model);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic error:', errorBody);
      throw new Error(`API error: ${response.status} - ${errorBody}`);
    }

    // ── TEMP DIAGNOSTIC (Session: timing diagnostic) ──────────────────────
    // Streaming pass-through, opt-in via req.body.stream. Only the labeled
    // diagnostic call sites in src/App.jsx (behind the DIAG_ON localStorage
    // flag) ever set stream:true — every other request takes the unchanged
    // non-stream branch below. Remove this whole branch, the Readable
    // import above, and the DIAG_ON instrumentation in src/App.jsx together.
    if (req.body?.stream === true && response.body) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      Readable.fromWeb(response.body).pipe(res);
      return;
    }
    // ── END TEMP DIAGNOSTIC ────────────────────────────────────────────────

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
