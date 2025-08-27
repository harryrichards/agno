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

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // This should be your service role key
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

    // Query links table
    const { data: links, error: fetchError } = await supabase
      .from('links')
      .select('url, title, description, thumbnail, price, brand')
      .eq('user_id', userId)
      .limit(20);

    if (fetchError) {
      console.error('Error fetching links:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch links', details: fetchError.message });
    }

    console.log('Found links:', links?.length || 0);
    
    if (!links || links.length === 0) {
      console.log('No links found for user');
      return res.json({ recommendations: [] });
    }

    // Create context from saved items
    const savedItemsContext = links.slice(0, 10).map(item => {
      const parts = [];
      if (item.brand) parts.push(item.brand);
      if (item.title) parts.push(item.title);
      if (item.price) parts.push(`$${item.price}`);
      return parts.join(' - ');
    }).join('\n');

    console.log('Using OpenAI to generate recommendations based on saved items');

    // Use OpenAI to generate recommendations
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: `You're a fashion expert and personal stylist. Based on the user's saved items, suggest 8 real, currently available fashion products they'd like. 
        
        Rules:
        - Suggest real products from real brands that exist today
        - Include a mix of similar items and complementary pieces
        - Vary the price points but stay within the user's apparent range
        - Don't just repeat the same brands they already have - introduce new ones they'd like
        - Focus on current fashion, not outdated items
        
        Return a JSON object with this structure:
        {
          "recommendations": [
            {
              "title": "Specific Product Name",
              "brand": "Real Brand Name",
              "price": "299",
              "category": "sneakers/jacket/sunglasses/etc",
              "reason": "Why this matches their style",
              "search_query": "exact product name brand to search"
            }
          ]
        }`
      }, {
        role: "user",
        content: `Here are the user's saved items:\n${savedItemsContext}\n\nSuggest 8 products they would love based on their style preferences shown above.`
      }],
      response_format: { type: "json_object" },
      temperature: 0.8
    });

    const aiRecommendations = JSON.parse(completion.choices[0].message.content);
    console.log('OpenAI generated', aiRecommendations.recommendations?.length || 0, 'recommendations');

    // Format recommendations for response
    const recommendations = {
      recommendations: (aiRecommendations.recommendations || []).map(rec => ({
        url: '', // We don't have URLs yet - frontend could search for these
        title: rec.title,
        brand: rec.brand,
        price: rec.price,
        image_url: null, // No images yet
        reason: rec.reason,
        search_query: rec.search_query || `${rec.brand} ${rec.title}`
      }))
    };

    // Save to database
    if (recommendations.recommendations.length > 0) {
      const recsToInsert = recommendations.recommendations.map(rec => ({
        user_id: userId,
        url: rec.url || rec.search_query,
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
