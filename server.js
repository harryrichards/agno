import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Recommendation service is running!' });
});

// Main recommendation endpoint
app.post('/api/recommendations', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Fetch user's saved items
    const { data: savedItems, error: fetchError } = await supabase
      .from('saved_items')
      .select('url, title, description')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (fetchError) {
      console.error('Error fetching saved items:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch saved items' });
    }

    if (!savedItems || savedItems.length === 0) {
      return res.json({ recommendations: [], message: 'No saved items found' });
    }

    // Create prompt for OpenAI
    const itemsList = savedItems.map(item => 
      `- ${item.title}: ${item.url}`
    ).join('\n');

    const prompt = `Based on these saved items from a user's digital pinboard, suggest 5-10 similar or complementary items they might find interesting:

${itemsList}

Return a JSON object with a "recommendations" array. Each recommendation should have:
- url: a valid URL to the recommended content
- title: a descriptive title
- reason: a brief explanation of why this was recommended based on their interests

Focus on variety and quality. Look for related but not duplicate content.`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful content recommendation assistant. Always return valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const recommendations = JSON.parse(completion.choices[0].message.content);

    // Save recommendations to database
    if (recommendations.recommendations && recommendations.recommendations.length > 0) {
      const recommendationsToSave = recommendations.recommendations.map(rec => ({
        user_id: userId,
        url: rec.url,
        title: rec.title,
        reason: rec.reason,
        created_at: new Date().toISOString()
      }));

      const { error: insertError } = await supabase
        .from('recommendations')
        .insert(recommendationsToSave);

      if (insertError) {
        console.error('Error saving recommendations:', insertError);
        // Continue anyway - we have the recommendations
      }
    }

    res.json(recommendations);
  } catch (error) {
    console.error('Error generating recommendations:', error);
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Recommendation service running on port ${PORT}`);
});
