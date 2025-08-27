const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

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
  process.env.SUPABASE_ANON_KEY, // This should be your service role key
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    }
  }
);

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

    // Fetch saved items with proper join
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

    // Extract link data
    const items = savedItems.map(item => item.links).filter(Boolean);
    
    console.log('Extracted items with link data:', items.length);
    
    if (items.length === 0) {
      console.log('No items with valid link data found');
      return res.json({ recommendations: [] });
    }

    // Extract brands for search query
    const brands = [...new Set(items.map(item => item.brand).filter(Boolean))].slice(0, 3);
    const searchQuery = brands.length > 0 
      ? `${brands.join(' ')} fashion clothing`
      : 'trending fashion items';

    console.log('Calling Flask discover service with query:', searchQuery);

    // Call Flask service for real products
    try {
      const flaskResponse = await fetch('https://peruze.onrender.com/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery,
          num_results: 10
        })
      });

      if (!flaskResponse.ok) {
        console.error('Flask service error:', flaskResponse.status);
        return res.json({ recommendations: [] });
      }

      const searchResults = await flaskResponse.json();
      console.log('Flask returned', searchResults.results?.length || 0, 'results');

      // Convert Flask results to recommendations format
      const recommendations = {
        recommendations: (searchResults.results || [])
          .slice(0, 8)
          .map(product => {
            // Clean up the image URL - no fake URLs
            let imageUrl = null;
            if (product.thumbnail && 
                !product.thumbnail.includes('1234567') && 
                !product.thumbnail.includes('example.com')) {
              imageUrl = product.thumbnail;
            }

            return {
              url: product.link || product.product_link || '',
              title: product.title || 'Unknown Product',
              brand: product.source || product.brand || 'Unknown Brand',
              price: product.price ? String(product.price).replace(/[^0-9.]/g, '') : '0',
              image_url: imageUrl, // null if no valid image
              reason: brands.length > 0 
                ? `Based on your interest in ${brands.join(', ')}`
                : 'Trending item you might like'
            };
          })
          .filter(rec => rec.url && rec.title) // Only keep valid recommendations
      };

      console.log('Processed', recommendations.recommendations.length, 'valid recommendations');

      // Save to database
      if (recommendations.recommendations.length > 0) {
        const recsToInsert = recommendations.recommendations.map(rec => ({
          user_id: userId,
          url: rec.url,
          title: rec.title,
          brand: rec.brand,
          price: rec.price,
          image_url: rec.image_url, // Will be null if no valid image
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

    } catch (flaskError) {
      console.error('Error calling Flask service:', flaskError);
      return res.json({ recommendations: [] });
    }

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
