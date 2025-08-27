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

    // Query links table with all fields
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

    // Create a comprehensive description from all user's saved item data
    const itemDescriptions = links
      .slice(0, 5)
      .map(item => {
        const parts = [];
        if (item.title) parts.push(item.title);
        if (item.brand) parts.push(`by ${item.brand}`);
        if (item.price) parts.push(`$${item.price}`);
        if (item.description) parts.push(item.description.substring(0, 50));
        return parts.join(' ');
      })
      .join('; ');

    // You could also try sending the first item's URL directly
    const contextUrl = links[0]?.url;

    console.log('Using context for Flask:', itemDescriptions.substring(0, 200));

    // Call Flask service - try both URL and description
    try {
      const flaskBody = contextUrl 
        ? { url: contextUrl, max_results: 10 }  // Try with URL first
        : { description: itemDescriptions, max_results: 10 }; // Fallback to description

      const flaskResponse = await fetch('https://peruze.onrender.com/discover', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(flaskBody)
      });

      console.log('Flask response status:', flaskResponse.status);

      if (!flaskResponse.ok) {
        const errorText = await flaskResponse.text();
        console.error('Flask service error:', flaskResponse.status, errorText);
        
        // If URL failed, retry with description
        if (contextUrl && flaskResponse.status === 400) {
          console.log('Retrying with description instead of URL');
          const retryResponse = await fetch('https://peruze.onrender.com/discover', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              description: itemDescriptions,
              max_results: 10
            })
          });
          
          if (retryResponse.ok) {
            const searchResults = await retryResponse.json();
            console.log('Retry successful, got', searchResults.results?.length || 0, 'results');
            // Process results below
          } else {
            return res.json({ recommendations: [] });
          }
        } else {
          return res.json({ recommendations: [] });
        }
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

            // Extract brands from saved items for context
            const userBrands = [...new Set(links.map(l => l.brand).filter(Boolean))].slice(0, 3);

            return {
              url: product.link || product.product_link || '',
              title: product.title || 'Unknown Product',
              brand: product.source || product.brand || 'Unknown Brand',
              price: product.price ? String(product.price).replace(/[^0-9.]/g, '') : '0',
              image_url: imageUrl, // null if no valid image
              reason: userBrands.length > 0 
                ? `Based on your interest in ${userBrands.join(', ')}`
                : 'Based on your saved collection'
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
