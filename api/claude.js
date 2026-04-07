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
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
