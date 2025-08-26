const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();

// IMPORTANT: Configure CORS to allow your Lovable app
app.use(cors({
  origin: [
    'https://preview--peruze.lovable.app',
    'https://peruze.lovable.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Recommendation service is running!' });
});

// Main recommendations endpoint
app.post('/api/recommendations', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Fetch user's saved items
    const { data: savedItems, error: fetchError } = await supabase
      .from('saved_items')
      .select('url, title, brand, price')
      .eq('user_id', userId)
      .limit(20);

    if (fetchError) {
      console.error('Error fetching saved items:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch saved items' });
    }

    if (!savedItems || savedItems.length === 0) {
      return res.json({ recommendations: [] });
    }

    // Create prompt for OpenAI
    const itemsList = savedItems.map(item => 
      `- ${item.title} (${item.brand}) - $${item.price}`
    ).join('\n');

    const prompt = `Based on these saved items from a fashion/shopping app:
${itemsList}

Suggest 5-10 similar products they might like. Return ONLY a JSON object with this exact structure:
{
  "recommendations": [
    {
      "url": "product URL",
      "title": "product name",
      "brand": "brand name",
      "price": "price as string like 299",
      "image_url": "image URL if available",
      "reason": "why this matches their style"
    }
  ]
}`;

    // Get recommendations from OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a personal shopping assistant that recommends products based on user preferences." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    const recommendations = JSON.parse(completion.choices[0].message.content);

    // Save recommendations to database
    if (recommendations.recommendations && recommendations.recommendations.length > 0) {
      const recsToInsert = recommendations.recommendations.map(rec => ({
        user_id: userId,
        url: rec.url,
        title: rec.title,
        brand: rec.brand,
        price: rec.price,
        image_url: rec.image_url,
        reason: rec.reason,
        feedback: null,
        is_saved: false
      }));

      const { error: insertError } = await supabase
        .from('recommendations')
        .insert(recsToInsert);

      if (insertError) {
        console.error('Error saving recommendations:', insertError);
      }
    }

    res.json(recommendations);

  } catch (error) {
    console.error('Error generating recommendations:', error);
    res.status(500).json({ 
      error: 'Failed to generate recommendations',
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
