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
  process.env.SUPABASE_ANON_KEY,
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

// Helper function to generate embeddings
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    input: text,
    model: "text-embedding-3-small"
  });
  return response.data[0].embedding;
}

// -------------------------
// NEW ENDPOINT: Ingest Link
// -------------------------
app.post('/api/ingest-link', async (req, res) => {
  try {
    const { linkId, userId, url } = req.body;
    if (!linkId || !userId || !url) {
      return res.status(400).json({ error: 'linkId, userId, and url are required' });
    }

    // 1. Call Firecrawl Edge Function
    const { data: scrapeData, error: scrapeError } = await supabase.functions.invoke('firecrawl-scrape', {
      body: { url }
    });

    if (scrapeError) {
      console.error('Firecrawl scrape error:', scrapeError);
      return res.status(500).json({ error: 'Failed to scrape URL' });
    }

    // 2. Extract fields
    const canonicalUrl = scrapeData?.canonicalUrl || url;
    const title = scrapeData?.title || null;
    const brand = scrapeData?.brand || null;
    const price = scrapeData?.priceValue ?? null;
    const currency = scrapeData?.priceCurrency || null;
    const imageUrl = scrapeData?.thumbnail || (scrapeData?.images?.[0] ?? null);
    const website = scrapeData?.siteName || (new URL(canonicalUrl)).hostname;

    // 3. Deduplicate: check if this URL already exists for user
    const { data: existing } = await supabase
      .from('links')
      .select('id')
      .eq('user_id', userId)
      .eq('url', canonicalUrl)
      .maybeSingle();

    if (existing && existing.id !== linkId) {
      console.log('Duplicate link skipped:', canonicalUrl);
      await supabase.from('links').delete().eq('id', linkId); // optional cleanup
      return res.json({ duplicated: true, canonical_url: canonicalUrl });
    }

    // 4. Generate embedding
    const text = [brand, title].filter(Boolean).join(' ');
    const embedding = text ? await generateEmbedding(text) : null;

    // 5. Update link row
    const { error: updateError } = await supabase
      .from('links')
      .update({
        url: canonicalUrl,
        website,
        title,
        brand,
        price,
        currency,
        image_url: imageUrl,
        embedding: embedding ? JSON.stringify(embedding) : null
      })
      .eq('id', linkId);

    if (updateError) {
      console.error('Error updating link:', updateError);
      return res.status(500).json({ error: 'Failed to update link' });
    }

    res.json({
      success: true,
      canonical_url: canonicalUrl,
      brand,
      price,
      currency,
      image_url: imageUrl
    });

  } catch (err) {
    console.error('Error in /api/ingest-link:', err);
    res.status(500).json({ error: 'Unexpected error', details: err.message });
  }
});

// -------------------------
// Recommendations endpoint
// -------------------------
app.post('/api/recommendations', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log('Received request for userId:', userId);
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's saved links
    const { data: userLinks, error: fetchError } = await supabase
      .from('links')
      .select('id, url, title, description, brand, price, thumbnail, embedding')
      .eq('user_id', userId);

    if (fetchError) {
      console.error('Error fetching links:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch links' });
    }

    if (!userLinks || userLinks.length === 0) {
      console.log('No links found for user');
      return res.json({ recommendations: [] });
    }

    console.log(`Found ${userLinks.length} user links`);

    // Create a combined text representation of user's style
    const userStyleText = userLinks.map(item => 
      `${item.brand || ''} ${item.title || ''} ${item.description || ''}`
    ).join(' ');

    console.log('Generating embedding for user style...');
    const userEmbedding = await generateEmbedding(userStyleText);

    // Get all links with embeddings from database (excluding user's own)
    const { data: allLinks } = await supabase
      .from('links')
      .select('id, url, title, brand, price, thumbnail, embedding')
      .neq('user_id', userId)
      .not('embedding', 'is', null)
      .limit(200);

    if (!allLinks || allLinks.length === 0) {
      console.log('No other links with embeddings found - using OpenAI fallback');
      return await generateOpenAIRecommendations(userLinks, userId, res, supabase);
    }

    console.log(`Calculating similarity with ${allLinks.length} items...`);

    const itemsWithSimilarity = allLinks.map(item => {
      const itemEmbedding = typeof item.embedding === 'string' 
        ? JSON.parse(item.embedding) 
        : item.embedding;
      
      const similarity = cosineSimilarity(userEmbedding, itemEmbedding);
      return { ...item, similarity };
    });

    const topRecommendations = itemsWithSimilarity
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);

    console.log(`Found ${topRecommendations.length} similar items`);

    const recommendations = {
      recommendations: topRecommendations.map(item => ({
        url: item.url,
        title: item.title,
        brand: item.brand,
        price: item.price,
        image_url: item.thumbnail,
        reason: `${Math.round(item.similarity * 100)}% style match`,
        similarity_score: item.similarity
      }))
    };

    if (recommendations.recommendations.length > 0) {
      const recsToInsert = recommendations.recommendations.map(rec => ({
        user_id: userId,
        url: rec.url || '',
        title: rec.title || 'Unknown',
        brand: rec.brand || 'Unknown',
        price: rec.price || '0',
        image_url: rec.image_url,
        reason: rec.reason,
        feedback: null,
        is_saved: false
      }));

      const { error: insertError } = await supabase
        .from('recommendations')
        .insert(recsToInsert);

      if (insertError) console.error('Error saving recommendations:', insertError);
    }

    res.json(recommendations);

  } catch (error) {
    console.error('Error generating recommendations:', error);

    if (error.message && error.message.includes('embedding')) {
      const { data: userLinks } = await supabase
        .from('links')
        .select('id, url, title, description, brand, price, thumbnail')
        .eq('user_id', req.body.userId)
        .limit(5);
      
      return await generateOpenAIRecommendations(userLinks, req.body.userId, res, supabase);
    }
    
    res.status(500).json({ 
      error: 'Failed to generate recommendations',
      details: error.message 
    });
  }
});

// Cosine similarity
function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

// OpenAI Fallback
async function generateOpenAIRecommendations(userLinks, userId, res, supabase) {
  console.log('Using OpenAI fallback for recommendations');
  
  const savedItemsContext = userLinks.slice(0, 10).map(item => 
    `${item.brand || ''} ${item.title || ''} ${item.price ? `$${item.price}` : ''}`
  ).join('\n');

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "system",
      content: `You're a fashion personal stylist and online shopping expert. Suggest 8 real products based on the user's style. Return your response as valid JSON format.`
    }, {
      role: "user",
      content: `Based on these saved items:\n${savedItemsContext}\n\nSuggest 8 similar products they would like. Return as JSON with this structure:
{
  "recommendations": [
    {
      "title": "Product Name",
      "brand": "Brand Name",
      "price": "199",
      "reason": "Why this matches their style"
    }
  ]
}`
    }],
    response_format: { type: "json_object" },
    temperature: 0.8
  });

  const aiRecommendations = JSON.parse(completion.choices[0].message.content);
  
  const recommendations = {
    recommendations: (aiRecommendations.recommendations || []).slice(0, 8).map(rec => ({
      url: `https://www.google.com/search?q=${encodeURIComponent(`${rec.brand} ${rec.title} buy`)}`,
      title: rec.title || 'Unknown Product',
      brand: rec.brand || 'Unknown Brand',
      price: rec.price || '0',
      image_url: null,
      reason: rec.reason || 'Matches your style'
    }))
  };

  if (recommendations.recommendations.length > 0) {
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

    await supabase.from('recommendations').insert(recsToInsert);
  }

  return res.json(recommendations);
}

// Generate embedding manually
app.post('/api/generate-embedding', async (req, res) => {
  try {
    const { linkId, title, brand, description } = req.body;
    
    const text = `${brand || ''} ${title || ''} ${description || ''}`.trim();
    if (!text) {
      return res.status(400).json({ error: 'No text to embed' });
    }

    const embedding = await generateEmbedding(text);
    
    const { error } = await supabase
      .from('links')
      .update({ embedding: JSON.stringify(embedding) })
      .eq('id', linkId);

    if (error) {
      console.error('Error saving embedding:', error);
      return res.status(500).json({ error: 'Failed to save embedding' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error generating embedding:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
