require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function loadDocuments() {
  const docsPath = path.join(__dirname, 'docs');
  const files = fs.readdirSync(docsPath);
  const documents = [];

  console.log(`Loading ${files.length} documents...`);

  for (const file of files) {
    const filePath = path.join(docsPath, file);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.xlsx') continue;
    let content = '';

    try {
      if (ext === '.txt') {
        content = fs.readFileSync(filePath, 'utf8');
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
      } else if (ext === '.xlsx') {
        const workbook = XLSX.readFile(filePath);
        for (const sheet of workbook.SheetNames) {
          content += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
        }
      }

      if (content.trim()) {
        const cleaned = content
          .replace(/\|.*?\|/g, ' ')
          .replace(/:-+:/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        documents.push({ name: file, content: cleaned });
      }
    } catch (err) {
      console.log(`Could not read ${file}: ${err.message}`);
    }
  }

  console.log(`Loaded ${documents.length} documents successfully.`);
  return documents;
}

function getRelevantDocs(query, documents, topN = 3) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);

  const scored = documents.map(doc => {
    const nameLower = doc.name.toLowerCase()
      .replace(/copy of /g, '')
      .replace(/wcu_/g, '')
      .replace(/[_\-\.]/g, ' ');
    const contentLower = doc.content.toLowerCase();

    // Exact phrase match in filename — strongest signal
    let score = 0;
    queryWords.forEach(word => {
      // Check 4-letter stem against cleaned filename
      const stem = word.slice(0, 4);
      if (nameLower.includes(stem)) score += 300;
      // Content match counts less
      const contentMatches = (contentLower.match(new RegExp(stem, 'g')) || []).length;
      score += Math.min(contentMatches, 10);
    });

    return { ...doc, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .filter(d => d.score > 0);
}

let allDocuments = [];

const systemPrompt = `You are the Legato Knowledge Assistant, an internal tool for Legato Strategic Consulting.

CRITICAL INSTRUCTION: You MUST use the document content provided below to answer questions. If a document contains relevant information, you MUST use it and cite the filename. Do NOT fall back to general knowledge if the documents contain relevant content. Read every word of the provided documents before deciding they don't contain the answer.

Rules:
- Read ALL provided documents carefully
- If ANY document contains relevant information, use it and cite the source filename
- Only say "not in documents" if you have read all provided content and found nothing relevant
- Be clear, concise, and helpful
- This tool is for internal use only`;

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;

  try {
    const relevantDocs = getRelevantDocs(message, allDocuments);
    const docContext = relevantDocs.length > 0
      ? relevantDocs.slice(0, 2).map(d => `--- SOURCE: ${d.name} ---\n${d.content.slice(0, 800)}`).join('\n\n')
      : 'No specific documents found. Use general Workday knowledge.';

    const messages = [
      { role: 'system', content: systemPrompt + '\n\nRELEVANT DOCUMENTS:\n' + docContext },
      ...(history || []).map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.parts[0].text
      })),
      { role: 'user', content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      max_tokens: 1024
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

loadDocuments().then(docs => {
  allDocuments = docs;
  app.listen(3000, () => {
    console.log('Legato Knowledge Assistant running on http://localhost:3000');
  });
});