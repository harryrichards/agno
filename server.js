const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();

// Configure CORS
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

// Initialize Supabase with service role key (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // This will actually be your service role key
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    }
  }
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Recommendation service is running!' });
});

// Recommendations endpoint
app.post('/api/recommendations', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log('Received request for userId:', userId);
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Query with correct column name: thumbnail
    const { data: savedItems, error: fetchError } = await supabase
      .from('saved_items')
      .select(`
        user_id,
        link_id,
        links (
          url,
          title,
          brand,
          price,
          thumbnail
        )
      `)
      .eq('user_id', userId)
      .limit(20);

    if (fetchError) {
      console.error('Error fetching saved items:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch saved items', details: fetchError.message });
    }

    console.log('Found saved items:', savedItems?.length || 0);
    
    if (!savedItems || savedItems.length === 0) {
      console.log('No saved items found for user');
      return res.json({ recommendations: [] });
    }

    // Debug logging
    console.log('First saved item structure:', JSON.stringify(savedItems[0], null, 2));

    // Extract the link data from the joined query
    const items = savedItems.map(item => item.links).filter(Boolean);
    
    console.log('Extracted items with link data:', items.length);
    
    if (items.length === 0) {
      console.log('No items with valid link data found');
      return res.json({ recommendations: [] });
    }

    console.log('Sample item:', items[0]);

    // Create prompt for OpenAI
    const itemsList = items.map(item => 
      `- ${item.title || 'Untitled'} (${item.brand || 'Unknown brand'}) - $${item.price || 'N/A'}`
    ).join('\n');

    const prompt = `Based on these saved fashion/shopping items:
${itemsList}

Suggest 5-8 similar products they might like. Focus on similar styles, brands, and price ranges.
Return ONLY a JSON object with this exact structure:
{
  "recommendations": [
    {
      "url": "https://example.com/product",
      "title": "Product Name",
      "brand": "Brand Name", 
      "price": "199",
      "image_url": "https://example.com/image.jpg",
      "reason": "Brief explanation why this matches their style"
    }
  ]
}

Make sure to include realistic product URLs and image URLs for each product.`;

    console.log('Calling OpenAI with', items.length, 'saved items...');
    
    // Get recommendations from OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "You are a personal shopping assistant. Recommend real products that match the user's style based on their saved items. Use realistic product names, brands, approximate prices, and include plausible image URLs."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    const recommendations = JSON.parse(completion.choices[0].message.content);
    console.log('Generated recommendations:', recommendations.recommendations?.length || 0);

    // Save to recommendations table
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
        // Continue anyway - we can still return the recommendations
      } else {
        console.log('Successfully saved recommendations to database');
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
