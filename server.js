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
  const stopWords = new Set(['workday', 'student', 'walk', 'through', 'does', 'what', 'with', 'that', 'this', 'from', 'have', 'your', 'into', 'will', 'about', 'create', 'using', 'their', 'they', 'when', 'which']);
const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));

  const scored = documents.map(doc => {
    // Clean the filename for better matching
    const cleanedName = doc.name.toLowerCase()
      .replace(/copy of /g, '')
      .replace(/wcu_stu_reg[-_]/gi, '')
      .replace(/wcu_stu[-_]/gi, '')
      .replace(/wcu_fac_reg[-_]/gi, '')
      .replace(/wcu_fac[-_]/gi, '')
      .replace(/wcu_admin[-_]/gi, '')
      .replace(/wcu_/gi, '')
      .replace(/[-_]/g, ' ')
      .replace(/\.docx|\.txt|\.pdf/g, '');

    const contentLower = doc.content.toLowerCase();

    let score = 0;
    queryWords.forEach(word => {
      const stem = word.slice(0, 6);
      if (cleanedName.includes(stem)) score += 300;
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

const systemPrompt = `You are the Legato Knowledge Assistant, an internal tool for Legato Strategic Consulting. You think and respond like an experienced Workday Student consultant. You do not just retrieve information — you analyze it, identify patterns, flag risks, and suggest next steps where relevant.

CRITICAL INSTRUCTION: You MUST use the document content provided below to answer questions. If a document contains relevant information, you MUST use it and cite the filename.  Read every word of the provided documents before deciding they don't contain the answer.

Rules:
- Read ALL provided documents carefully
- If ANY document contains relevant information, use it and cite the source filename
- If the documents do NOT cover the topic, answer using your general Workday Student and higher education consulting knowledge. Acknowledge naturally that you're drawing from general knowledge rather than internal documents, but vary how you say it each time — don't use a fixed phrase. Sound like a knowledgeable consultant, not a disclaimer machine.
- Vary your response style and tone based on the question. Simple questions get concise answers. Complex questions get structured, thorough responses. Match the energy of what's being asked.
- Never sound robotic or repetitive. Write like a smart, helpful colleague who knows Workday deeply.
- Go beyond just answering the question — where relevant, add consulting insight such as common pitfalls, best practices, or what to watch out for
- When citing a source, only mention it ONCE at the very end of your response as a single line like: (Source: filename). Never mention the source filename at the beginning or middle of your response.
- If a question involves a process, walk through it step by step and flag anything that typically causes issues in implementations
- Be clear, confident, and helpful
- This tool is for internal use only`;

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;

  try {
    const relevantDocs = getRelevantDocs(message, allDocuments);
    const docContext = relevantDocs.length > 0
      ? relevantDocs.slice(0, 1).map(d => {
  const content = d.content;
  const queryLower = message.toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 4);
  
  // Find the best starting position within the doc
  let bestPos = 0;
  let bestScore = 0;
  for (let i = 0; i < content.length - 500; i += 200) {
    const chunk = content.slice(i, i + 500).toLowerCase();
    const score = words.reduce((acc, w) => acc + (chunk.includes(w.slice(0,4)) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestPos = i; }
  }
  
  const start = Math.max(0, bestPos - 200);
  return `--- SOURCE: ${d.name.replace(/^Copy of /i, '')} ---\n${content.slice(start, start + 3000)}`;
}).join('\n\n')
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