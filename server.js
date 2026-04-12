require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const systemPrompt = `You are SkiBot, a friendly and knowledgeable ski conditions advisor. 
You help skiers understand snow conditions, trail difficulty, gear recommendations, and 
safety tips. You ask questions to understand their skill level and preferences, then give 
personalized advice. Keep responses concise and conversational. If asked about anything 
unrelated to skiing or snow sports, politely redirect the conversation back to skiing.`;

app.post('/chat', async (req, res) => {
  const { history } = req.body;
  console.log('Received history with', history.length, 'messages');
  try {
    const conversation = history.map(m => `${m.role === 'user' ? 'User' : 'SkiBot'}: ${m.text}`).join('\n');
    const prompt = `${systemPrompt}\n\n${conversation}\nSkiBot:`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    const reply = response.text;
    console.log('Reply:', reply);
    res.json({ reply });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));